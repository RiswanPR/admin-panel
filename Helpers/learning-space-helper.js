const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');
const { generateUniqueSlug, toObjectId } = require('./migration-helper');

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─────────────────────────────────────────────────────────
// COMMUNITY BRIDGE HELPER
// ─────────────────────────────────────────────────────────

const ensureSpaceCommunity = async (database, space) => {
  if (space.communityId && ObjectId.isValid(space.communityId)) {
    const existing = await database
      .collection(collection.NETWORK_COMMUNITIES_COLLECTION)
      .findOne({ _id: new ObjectId(space.communityId) });
    if (existing) return existing;
  }

  const spaceName = space.name || space.title || 'Learning Space';
  const slug = await generateUniqueSlug(database, spaceName, space.communityId);
  const now = new Date();
  const communityDoc = {
    name: spaceName,
    slug,
    description: space.description || '',
    type: space.courseId ? 'COURSE' : 'GENERAL',
    courseId: space.courseId ? toObjectId(space.courseId) : null,
    memberCount: Number(space.memberCount || 0),
    discussionCount: 0,
    visibility: space.isPrivate ? 'private' : (space.accessMode === 'open' ? 'public' : 'restricted'),
    status: space.status === 'archived' ? 'archived' : 'active',
    creatorId: toObjectId(space.ownerId) || toObjectId(space.createdBy) || null,
    rules: [],
    topics: Array.isArray(space.tags) ? space.tags : [],
    createdAt: space.createdAt ? new Date(space.createdAt) : now,
    updatedAt: now,
  };

  const insertResult = await database
    .collection(collection.NETWORK_COMMUNITIES_COLLECTION)
    .insertOne(communityDoc);
  const communityId = insertResult.insertedId;

  await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .updateOne({ _id: space._id }, { $set: { communityId, updatedAt: now } });

  space.communityId = communityId;
  return { ...communityDoc, _id: communityId };
};

// ─────────────────────────────────────────────────────────
// CODE GENERATOR / SLUGIFY
// ─────────────────────────────────────────────────────────

const generateSpaceCode = async (name) => {
  const base = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 16) || 'SPACE';

  let code = `${base}-${Date.now().toString().slice(-4)}`;
  const existing = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ code });

  if (existing) {
    code = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  return code;
};

// ─────────────────────────────────────────────────────────
// CRUD FOR LEARNING SPACES
// ─────────────────────────────────────────────────────────

const createLearningSpace = async (data, actor, req = null) => {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Learning Space name is required.');

  const description = String(data.description || '').trim();
  const category = String(data.category || 'Batch').trim();
  const status = ['draft', 'active', 'archived'].includes(data.status) ? data.status : 'active';
  const accessMode = ['open', 'invite_only', 'restricted'].includes(data.accessMode) ? data.accessMode : 'invite_only';

  const startDate = data.startDate ? new Date(data.startDate) : null;
  const endDate = data.endDate ? new Date(data.endDate) : null;
  if (startDate && endDate && endDate < startDate) {
    throw new Error('End date cannot be earlier than start date.');
  }

  const code = data.code ? String(data.code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '') : await generateSpaceCode(name);

  // Check code uniqueness
  const existingCode = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ code });

  if (existingCode) {
    throw new Error(`Learning Space code "${code}" already exists. Please choose a different code.`);
  }

  // Teacher IDs verification: Must be valid ObjectIds and exist in TEACHER_COLLECTION
  let teacherIds = [];
  if (data.teachers) {
    const rawIds = Array.isArray(data.teachers) ? data.teachers : [data.teachers];
    const validIds = rawIds.filter(id => id && ObjectId.isValid(id)).map(id => new ObjectId(id));

    if (validIds.length) {
      const verifiedTeachers = await db.get()
        .collection(collection.TEACHER_COLLECTION)
        .find({ _id: { $in: validIds } }, { projection: { _id: 1 } })
        .toArray();

      teacherIds = verifiedTeachers.map(t => t._id);
    }
  }

  const database = db.get();
  const now = new Date();

  // Create linked network_communities document
  const slug = await generateUniqueSlug(database, name);
  const communityDoc = {
    name,
    slug,
    description,
    type: data.courseId && ObjectId.isValid(data.courseId) ? 'COURSE' : 'GENERAL',
    courseId: data.courseId && ObjectId.isValid(data.courseId) ? new ObjectId(data.courseId) : null,
    memberCount: 0,
    discussionCount: 0,
    visibility: accessMode === 'open' ? 'public' : 'restricted',
    status: status === 'archived' ? 'archived' : 'active',
    creatorId: actor?._id && ObjectId.isValid(actor._id) ? new ObjectId(actor._id) : null,
    rules: [],
    topics: Array.isArray(data.tags) ? data.tags : [],
    createdAt: now,
    updatedAt: now
  };

  const commResult = await database.collection(collection.NETWORK_COMMUNITIES_COLLECTION).insertOne(communityDoc);
  const communityId = commResult.insertedId;

  const spaceDoc = {
    name,
    code,
    description,
    category,
    coverImage: data.coverImage || '/img/placeholders/course-cover.svg',
    status,
    accessMode,
    communityId,
    ownerId: actor?._id && ObjectId.isValid(actor._id) ? new ObjectId(actor._id) : null,
    ownerType: actor?.role === 'teacher' ? 'teacher' : 'admin',
    teachers: teacherIds,
    startDate,
    endDate,
    maxMembers: Number(data.maxMembers) || 0,
    memberCount: 0,
    createdAt: now,
    updatedAt: now
  };

  const result = await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .insertOne(spaceDoc);

  const spaceId = result.insertedId;

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_CREATE',
    entityType: 'learning_space',
    entityId: spaceId.toString(),
    entityName: name,
    status: 'success',
    message: `Learning space "${name}" (${code}) created and bridged to community ${communityId}.`,
    metadata: { code, category, status, communityId: communityId.toString(), teachersCount: teacherIds.length }
  });

  return { ...spaceDoc, _id: spaceId };
};

const updateLearningSpace = async (id, data, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid Learning Space ID.');

  const database = db.get();
  const existing = await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!existing) throw new Error('Learning Space not found.');

  const name = data.name !== undefined ? String(data.name).trim() : existing.name;
  if (!name) throw new Error('Learning Space name cannot be empty.');

  const description = data.description !== undefined ? String(data.description).trim() : existing.description;
  const category = data.category || existing.category;
  const status = ['draft', 'active', 'archived'].includes(data.status) ? data.status : existing.status;
  const accessMode = ['open', 'invite_only', 'restricted'].includes(data.accessMode) ? data.accessMode : existing.accessMode;

  let code = existing.code;
  if (data.code && data.code !== existing.code) {
    code = String(data.code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const codeConflict = await database
      .collection(collection.LEARNING_SPACES_COLLECTION)
      .findOne({ code, _id: { $ne: existing._id } });

    if (codeConflict) {
      throw new Error(`Learning Space code "${code}" already exists.`);
    }
  }

  const startDate = data.startDate ? new Date(data.startDate) : existing.startDate;
  const endDate = data.endDate ? new Date(data.endDate) : existing.endDate;
  if (startDate && endDate && endDate < startDate) {
    throw new Error('End date cannot be earlier than start date.');
  }

  const updateFields = {
    name,
    code,
    description,
    category,
    status,
    accessMode,
    startDate,
    endDate,
    maxMembers: data.maxMembers !== undefined ? (Number(data.maxMembers) || 0) : existing.maxMembers,
    updatedAt: new Date()
  };

  if (data.coverImage) {
    updateFields.coverImage = data.coverImage;
  }

  // Ensure community is linked and synchronize community metadata
  const community = await ensureSpaceCommunity(database, existing);
  if (community) {
    await database.collection(collection.NETWORK_COMMUNITIES_COLLECTION).updateOne(
      { _id: community._id },
      {
        $set: {
          name,
          description,
          status: status === 'archived' ? 'archived' : 'active',
          visibility: accessMode === 'open' ? 'public' : 'restricted',
          updatedAt: new Date()
        }
      }
    );
  }

  await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: updateFields });

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_EDIT',
    entityType: 'learning_space',
    entityId: id.toString(),
    entityName: name,
    status: 'success',
    message: `Learning space "${name}" updated.`,
    metadata: { status, category }
  });

  return { ...existing, ...updateFields, communityId: existing.communityId || community?._id };
};

const getLearningSpaceById = async (id) => {
  if (!ObjectId.isValid(id)) return null;

  const database = db.get();
  const space = await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!space) return null;

  // Ensure community is linked
  const community = await ensureSpaceCommunity(database, space);

  // Resolve teachers
  const teacherIds = (space.teachers || []).filter(tId => ObjectId.isValid(tId)).map(tId => new ObjectId(tId));
  if (teacherIds.length) {
    space.teacherDocs = await database
      .collection(collection.TEACHER_COLLECTION)
      .find({ _id: { $in: teacherIds } }, { projection: { _id: 1, name: 1, email: 1, designation: 1, profileImage: 1 } })
      .toArray();
  } else {
    space.teacherDocs = [];
  }

  // Count active members accurately from network_community_memberships (primary)
  let activeMemberCount = 0;
  if (space.communityId) {
    activeMemberCount = await database
      .collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
      .countDocuments({ communityId: space.communityId, status: 'active' });
  }

  // Fallback check on legacy collection if count is 0
  if (activeMemberCount === 0) {
    const legacyCount = await database
      .collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
      .countDocuments({ spaceId: space._id, status: 'active' });
    if (legacyCount > 0) {
      activeMemberCount = legacyCount;
    }
  }

  space.memberCount = activeMemberCount;
  space.community = community;

  return space;
};

const getLearningSpaces = async (filters = {}) => {
  const query = {};

  if (filters.search) {
    const regex = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [
      { name: regex },
      { code: regex },
      { description: regex },
      { category: regex }
    ];
  }

  if (filters.status && filters.status !== 'all') {
    query.status = filters.status;
  }

  if (filters.category && filters.category !== 'all') {
    query.category = filters.category;
  }

  // Teacher scoping: filter spaces assigned to teacher
  if (filters.teacherId && ObjectId.isValid(filters.teacherId)) {
    const tId = new ObjectId(filters.teacherId);
    query.$or = [
      { teachers: tId },
      { teachers: String(filters.teacherId) },
      { ownerId: tId }
    ];
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 12), 100);
  const skip = (page - 1) * limit;

  const total = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .countDocuments(query);

  const spaces = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  // Resolve teachers and member counts
  const allTeacherIds = [...new Set(spaces.flatMap(s => s.teachers || []).filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id)))];
  const teacherDocs = allTeacherIds.length ? await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .find({ _id: { $in: allTeacherIds } }, { projection: { _id: 1, name: 1, email: 1 } })
    .toArray() : [];

  const teacherMap = {};
  teacherDocs.forEach(t => { teacherMap[t._id.toString()] = t; });

  spaces.forEach(s => {
    s.teacherDocs = (s.teachers || []).map(tId => teacherMap[tId.toString()]).filter(Boolean);
  });

  return {
    spaces,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1
  };
};

const archiveLearningSpace = async (id, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid space ID.');

  const database = db.get();
  const space = await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!space) throw new Error('Learning Space not found.');

  const newStatus = space.status === 'archived' ? 'active' : 'archived';

  await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: { status: newStatus, updatedAt: new Date() } });

  const community = await ensureSpaceCommunity(database, space);
  if (community) {
    await database.collection(collection.NETWORK_COMMUNITIES_COLLECTION).updateOne(
      { _id: community._id },
      { $set: { status: newStatus, updatedAt: new Date() } }
    );
  }

  await auditHelper.logAction({
    req,
    action: newStatus === 'archived' ? 'LEARNING_SPACE_ARCHIVE' : 'LEARNING_SPACE_ACTIVATE',
    entityType: 'learning_space',
    entityId: id.toString(),
    entityName: space.name,
    status: 'success',
    message: `Learning space "${space.name}" status changed to ${newStatus}.`
  });

  return newStatus;
};

const deleteLearningSpace = async (id, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid space ID.');

  const database = db.get();
  const space = await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!space) throw new Error('Learning Space not found.');

  // Delete / archive linked community and memberships
  if (space.communityId) {
    await database
      .collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
      .deleteMany({ communityId: space.communityId });

    await database
      .collection(collection.NETWORK_COMMUNITIES_COLLECTION)
      .deleteOne({ _id: space.communityId });
  }

  // Delete legacy space members
  await database
    .collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .deleteMany({ spaceId: new ObjectId(id) });

  // Delete space
  await database
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .deleteOne({ _id: new ObjectId(id) });

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_DELETE',
    entityType: 'learning_space',
    entityId: id.toString(),
    entityName: space.name,
    status: 'success',
    message: `Learning space "${space.name}" deleted along with member records and community.`
  });

  return true;
};

// ─────────────────────────────────────────────────────────
// MEMBER MANAGEMENT
// ─────────────────────────────────────────────────────────

const addMemberToSpace = async (spaceId, userId, role = 'member', actor = null, req = null) => {
  if (!ObjectId.isValid(spaceId)) throw new Error('Invalid Learning Space ID.');
  if (!ObjectId.isValid(userId)) throw new Error('Invalid User ID.');

  const database = db.get();
  const sId = new ObjectId(spaceId);
  const uId = new ObjectId(userId);

  const [space, user] = await Promise.all([
    database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: sId }),
    database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: uId })
  ]);

  if (!space) throw new Error('Learning Space not found.');
  if (!user) throw new Error('User not found in system.');

  // Ensure linked community exists
  const community = await ensureSpaceCommunity(database, space);
  const cId = community._id;

  const normalizedRole = ['owner', 'moderator', 'member'].includes(role)
    ? role
    : (role === 'lead' || role === 'admin' ? 'owner' : (role === 'moderator' ? 'moderator' : 'member'));

  // Check existing in NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION
  const existingCommMember = await database
    .collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
    .findOne({ communityId: cId, userId: uId });

  // Also check legacy
  const existingLegacy = await database
    .collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .findOne({ spaceId: sId, userId: uId });

  if (existingCommMember && existingCommMember.status === 'active') {
    throw new Error('User is already a member of this learning space.');
  }

  const now = new Date();

  // If removed, reactivate
  if ((existingCommMember && existingCommMember.status === 'removed') || (existingLegacy && existingLegacy.status === 'removed')) {
    await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION).updateOne(
      { communityId: cId, userId: uId },
      { $set: { status: 'active', role: normalizedRole, updatedAt: now } },
      { upsert: true }
    );

    await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).updateOne(
      { spaceId: sId, userId: uId },
      { $set: { status: 'active', role, updatedAt: now } },
      { upsert: true }
    );

    await Promise.all([
      database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne({ _id: sId }, { $inc: { memberCount: 1 } }),
      database.collection(collection.NETWORK_COMMUNITIES_COLLECTION).updateOne({ _id: cId }, { $inc: { memberCount: 1 } })
    ]);

    return { success: true, reactivated: true };
  }

  // Insert new membership
  await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION).insertOne({
    communityId: cId,
    userId: uId,
    role: normalizedRole,
    status: 'active',
    joinedAt: now,
    createdAt: now,
    updatedAt: now
  });

  // Sync to legacy collection
  await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).insertOne({
    spaceId: sId,
    userId: uId,
    role: ['member', 'moderator', 'lead'].includes(role) ? role : 'member',
    status: 'active',
    joinedAt: now,
    addedBy: actor?._id ? new ObjectId(actor._id) : null,
    addedByRole: actor?.role || 'admin',
    createdAt: now,
    updatedAt: now
  });

  await Promise.all([
    database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne({ _id: sId }, { $inc: { memberCount: 1 } }),
    database.collection(collection.NETWORK_COMMUNITIES_COLLECTION).updateOne({ _id: cId }, { $inc: { memberCount: 1 } })
  ]);

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_MEMBER_ADD',
    entityType: 'learning_space_member',
    entityId: `${spaceId}_${userId}`,
    entityName: user.Name || user.name || user.email,
    status: 'success',
    message: `Added user ${user.email} to space "${space.name}".`,
    metadata: { spaceId: spaceId.toString(), userId: userId.toString(), role: normalizedRole, communityId: cId.toString() }
  });

  return { success: true };
};

const addBulkMembersToSpace = async (spaceId, userIds, actor = null, req = null) => {
  if (!ObjectId.isValid(spaceId)) throw new Error('Invalid Space ID.');
  if (!Array.isArray(userIds) || !userIds.length) throw new Error('No user IDs provided.');

  const sId = new ObjectId(spaceId);
  const database = db.get();

  const space = await database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: sId });
  if (!space) throw new Error('Learning Space not found.');

  const community = await ensureSpaceCommunity(database, space);
  const cId = community._id;

  const validUIds = [...new Set(userIds.filter(id => id && ObjectId.isValid(id)).map(String))].map(id => new ObjectId(id));
  if (!validUIds.length) throw new Error('No valid user IDs found.');

  // Find users that actually exist
  const existingUsers = await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: validUIds } }, { projection: { _id: 1 } })
    .toArray();

  const realUserIds = existingUsers.map(u => u._id);

  // Find already existing memberships in network_community_memberships
  const currentMembers = await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
    .find({ communityId: cId, userId: { $in: realUserIds } }, { projection: { userId: 1, status: 1 } })
    .toArray();

  const currentMemberMap = {};
  currentMembers.forEach(m => { currentMemberMap[m.userId.toString()] = m.status; });

  const toInsertComm = [];
  const toInsertLegacy = [];
  const toReactivate = [];

  const now = new Date();
  realUserIds.forEach(uId => {
    const idStr = uId.toString();
    if (currentMemberMap[idStr] === 'active') {
      return;
    }
    if (currentMemberMap[idStr] === 'removed') {
      toReactivate.push(uId);
    } else {
      toInsertComm.push({
        communityId: cId,
        userId: uId,
        role: 'member',
        status: 'active',
        joinedAt: now,
        createdAt: now,
        updatedAt: now
      });
      toInsertLegacy.push({
        spaceId: sId,
        userId: uId,
        role: 'member',
        status: 'active',
        joinedAt: now,
        addedBy: actor?._id ? new ObjectId(actor._id) : null,
        addedByRole: actor?.role || 'admin',
        createdAt: now,
        updatedAt: now
      });
    }
  });

  if (toInsertComm.length) {
    await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION).insertMany(toInsertComm);
    await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).insertMany(toInsertLegacy);
  }

  if (toReactivate.length) {
    await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION).updateMany(
      { communityId: cId, userId: { $in: toReactivate } },
      { $set: { status: 'active', updatedAt: now } }
    );
    await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).updateMany(
      { spaceId: sId, userId: { $in: toReactivate } },
      { $set: { status: 'active', updatedAt: now } }
    );
  }

  const addedCount = toInsertComm.length + toReactivate.length;
  if (addedCount > 0) {
    await Promise.all([
      database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne({ _id: sId }, { $inc: { memberCount: addedCount } }),
      database.collection(collection.NETWORK_COMMUNITIES_COLLECTION).updateOne({ _id: cId }, { $inc: { memberCount: addedCount } })
    ]);

    await auditHelper.logAction({
      req,
      action: 'LEARNING_SPACE_BULK_MEMBER_ADD',
      entityType: 'learning_space',
      entityId: spaceId.toString(),
      entityName: space.name,
      status: 'success',
      message: `Added ${addedCount} members to space "${space.name}".`,
      metadata: { addedCount }
    });
  }

  return { success: true, addedCount, skippedCount: validUIds.length - addedCount };
};

const removeMemberFromSpace = async (spaceId, userId, actor = null, req = null) => {
  if (!ObjectId.isValid(spaceId) || !ObjectId.isValid(userId)) {
    throw new Error('Valid space and user IDs are required.');
  }

  const database = db.get();
  const sId = new ObjectId(spaceId);
  const uId = new ObjectId(userId);

  const space = await database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: sId });
  if (!space) throw new Error('Learning Space not found.');

  const community = await ensureSpaceCommunity(database, space);
  const cId = community._id;

  const now = new Date();

  // Check in community memberships
  const commMember = await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
    .findOne({ communityId: cId, userId: uId, status: 'active' });

  // Also check legacy
  const legacyMember = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .findOne({ spaceId: sId, userId: uId, status: 'active' });

  if (!commMember && !legacyMember) {
    throw new Error('Member not found in this space.');
  }

  if (commMember) {
    await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION).updateOne(
      { _id: commMember._id },
      { $set: { status: 'removed', updatedAt: now } }
    );
  }

  if (legacyMember) {
    await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).updateOne(
      { _id: legacyMember._id },
      { $set: { status: 'removed', removedAt: now, updatedAt: now } }
    );
  }

  await Promise.all([
    database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
      { _id: sId, memberCount: { $gt: 0 } },
      { $inc: { memberCount: -1 } }
    ),
    database.collection(collection.NETWORK_COMMUNITIES_COLLECTION).updateOne(
      { _id: cId, memberCount: { $gt: 0 } },
      { $inc: { memberCount: -1 } }
    )
  ]);

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_MEMBER_REMOVE',
    entityType: 'learning_space_member',
    entityId: `${spaceId}_${userId}`,
    entityName: 'Member',
    status: 'success',
    message: `Removed user ${userId} from space ${spaceId}.`
  });

  return true;
};

const getSpaceMembers = async (spaceId, filters = {}) => {
  if (!ObjectId.isValid(spaceId)) throw new Error('Invalid Space ID.');

  const database = db.get();
  const sId = new ObjectId(spaceId);

  const space = await database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: sId });
  if (!space) throw new Error('Learning Space not found.');

  const community = await ensureSpaceCommunity(database, space);
  const cId = community._id;

  const status = filters.status && filters.status !== 'all' ? filters.status : 'active';
  const query = { communityId: cId, status };

  if (filters.role && filters.role !== 'all') {
    query.role = filters.role;
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 20), 100);
  const skip = (page - 1) * limit;

  let total = await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION).countDocuments(query);
  let memberships = [];

  if (total > 0) {
    memberships = await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
      .find(query)
      .sort({ joinedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  } else {
    // Fallback to legacy collection if community memberships haven't been populated yet
    const legacyQuery = { spaceId: sId, status };
    if (filters.role && filters.role !== 'all') legacyQuery.role = filters.role;
    total = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).countDocuments(legacyQuery);
    memberships = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
      .find(legacyQuery)
      .sort({ joinedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  const userIds = memberships.map(m => m.userId).filter(Boolean);
  const userDocs = userIds.length ? await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: userIds } }, {
      projection: {
        _id: 1,
        Name: 1,
        name: 1,
        email: 1,
        username: 1,
        Phone_Number: 1,
        course: 1,
        profileImage: 1
      }
    })
    .toArray() : [];

  const userMap = {};
  userDocs.forEach(u => { userMap[u._id.toString()] = u; });

  const members = memberships.map(m => {
    const u = userMap[m.userId.toString()];
    return {
      _id: m._id,
      userId: m.userId,
      role: m.role,
      status: m.status,
      joinedAt: m.joinedAt,
      name: u?.Name || u?.name || 'Learner',
      email: u?.email || '',
      username: u?.username || '',
      phone: u?.Phone_Number || '',
      isEnrolled: Array.isArray(u?.course) && u.course.length > 0,
      avatar: u?.profileImage || '/img/placeholders/profile.svg'
    };
  });

  return {
    members,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1
  };
};

// ─────────────────────────────────────────────────────────
// TEACHER ASSIGNMENTS
// ─────────────────────────────────────────────────────────

const assignTeacherToSpace = async (spaceId, teacherId, actor = null, req = null) => {
  if (!ObjectId.isValid(spaceId) || !ObjectId.isValid(teacherId)) {
    throw new Error('Valid space and teacher IDs are required.');
  }

  const database = db.get();
  const sId = new ObjectId(spaceId);
  const tId = new ObjectId(teacherId);

  const [space, teacher] = await Promise.all([
    database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: sId }),
    database.collection(collection.TEACHER_COLLECTION).findOne({ _id: tId })
  ]);

  if (!space) throw new Error('Learning Space not found.');
  if (!teacher) throw new Error('Teacher verification failed: Selected user is not a registered teacher.');

  // Prevent duplicate assignment
  const currentTeachers = (space.teachers || []).map(String);
  if (currentTeachers.includes(teacherId.toString())) {
    throw new Error('Teacher is already assigned to this learning space.');
  }

  await database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
    { _id: sId },
    { $addToSet: { teachers: tId }, $set: { updatedAt: new Date() } }
  );

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_TEACHER_ASSIGN',
    entityType: 'learning_space',
    entityId: spaceId.toString(),
    entityName: space.name,
    status: 'success',
    message: `Assigned teacher ${teacher.name} (${teacher.email}) to space "${space.name}".`,
    metadata: { teacherId: teacherId.toString() }
  });

  return true;
};

const removeTeacherFromSpace = async (spaceId, teacherId, actor = null, req = null) => {
  if (!ObjectId.isValid(spaceId) || !ObjectId.isValid(teacherId)) {
    throw new Error('Valid space and teacher IDs are required.');
  }

  const database = db.get();
  const sId = new ObjectId(spaceId);
  const tId = new ObjectId(teacherId);

  const space = await database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: sId });
  if (!space) throw new Error('Learning Space not found.');

  await database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
    { _id: sId },
    { $pull: { teachers: tId }, $set: { updatedAt: new Date() } }
  );

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_TEACHER_REMOVE',
    entityType: 'learning_space',
    entityId: spaceId.toString(),
    entityName: space.name,
    status: 'success',
    message: `Removed teacher ${teacherId} from space "${space.name}".`
  });

  return true;
};

const isTeacherAssignedToSpace = async (teacherId, spaceId) => {
  if (!ObjectId.isValid(teacherId) || !ObjectId.isValid(spaceId)) return false;

  const space = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({
      _id: new ObjectId(spaceId),
      $or: [
        { teachers: new ObjectId(teacherId) },
        { teachers: String(teacherId) },
        { ownerId: new ObjectId(teacherId) }
      ]
    });

  return Boolean(space);
};

const getSpacesForTeacher = async (teacherId) => {
  if (!ObjectId.isValid(teacherId)) return [];

  const tId = new ObjectId(teacherId);
  return await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .find({
      $or: [
        { teachers: tId },
        { teachers: String(teacherId) },
        { ownerId: tId }
      ],
      status: { $ne: 'archived' }
    })
    .sort({ createdAt: -1 })
    .toArray();
};

module.exports = {
  createLearningSpace,
  updateLearningSpace,
  getLearningSpaceById,
  getLearningSpaces,
  archiveLearningSpace,
  deleteLearningSpace,
  addMemberToSpace,
  addBulkMembersToSpace,
  removeMemberFromSpace,
  getSpaceMembers,
  assignTeacherToSpace,
  removeTeacherFromSpace,
  isTeacherAssignedToSpace,
  getSpacesForTeacher
};
