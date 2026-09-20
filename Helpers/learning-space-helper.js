const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  const now = new Date();
  const spaceDoc = {
    name,
    code,
    description,
    category,
    coverImage: data.coverImage || '/img/placeholders/course-cover.svg',
    status,
    accessMode,
    ownerId: new ObjectId(actor._id),
    ownerType: actor.role === 'teacher' ? 'teacher' : 'admin',
    teachers: teacherIds,
    startDate,
    endDate,
    maxMembers: Number(data.maxMembers) || 0,
    memberCount: 0,
    createdAt: now,
    updatedAt: now
  };

  const result = await db.get()
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
    message: `Learning space "${name}" (${code}) created.`,
    metadata: { code, category, status, teachersCount: teacherIds.length }
  });

  return { ...spaceDoc, _id: spaceId };
};

const updateLearningSpace = async (id, data, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid Learning Space ID.');

  const existing = await db.get()
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
    const codeConflict = await db.get()
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

  await db.get()
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

  return { ...existing, ...updateFields };
};

const getLearningSpaceById = async (id) => {
  if (!ObjectId.isValid(id)) return null;

  const space = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!space) return null;

  // Resolve teachers
  const teacherIds = (space.teachers || []).filter(tId => ObjectId.isValid(tId)).map(tId => new ObjectId(tId));
  if (teacherIds.length) {
    space.teacherDocs = await db.get()
      .collection(collection.TEACHER_COLLECTION)
      .find({ _id: { $in: teacherIds } }, { projection: { _id: 1, name: 1, email: 1, designation: 1, profileImage: 1 } })
      .toArray();
  } else {
    space.teacherDocs = [];
  }

  // Count active members accurately
  space.memberCount = await db.get()
    .collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .countDocuments({ spaceId: space._id, status: 'active' });

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

  const space = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!space) throw new Error('Learning Space not found.');

  const newStatus = space.status === 'archived' ? 'active' : 'archived';

  await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: { status: newStatus, updatedAt: new Date() } });

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

  const space = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!space) throw new Error('Learning Space not found.');

  // Delete space members
  await db.get()
    .collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .deleteMany({ spaceId: new ObjectId(id) });

  // Delete space
  await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .deleteOne({ _id: new ObjectId(id) });

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_DELETE',
    entityType: 'learning_space',
    entityId: id.toString(),
    entityName: space.name,
    status: 'success',
    message: `Learning space "${space.name}" deleted along with member records.`
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

  // Check duplicate membership
  const existing = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .findOne({ spaceId: sId, userId: uId });

  if (existing) {
    if (existing.status === 'removed') {
      // Re-activate member atomically
      const updateResult = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).updateOne(
        { _id: existing._id, status: 'removed' },
        { $set: { status: 'active', role, updatedAt: new Date() } }
      );
      if (updateResult.modifiedCount > 0) {
        await database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
          { _id: sId },
          { $inc: { memberCount: 1 } }
        );
      }
      return { success: true, reactivated: true };
    }
    throw new Error('User is already a member of this learning space.');
  }

  const memberDoc = {
    spaceId: sId,
    userId: uId,
    role: ['member', 'moderator', 'lead'].includes(role) ? role : 'member',
    status: 'active',
    joinedAt: new Date(),
    addedBy: actor?._id ? new ObjectId(actor._id) : null,
    addedByRole: actor?.role || 'admin',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).insertOne(memberDoc);

  await database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
    { _id: sId },
    { $inc: { memberCount: 1 } }
  );

  await auditHelper.logAction({
    req,
    action: 'LEARNING_SPACE_MEMBER_ADD',
    entityType: 'learning_space_member',
    entityId: `${spaceId}_${userId}`,
    entityName: user.Name || user.name || user.email,
    status: 'success',
    message: `Added user ${user.email} to space "${space.name}".`,
    metadata: { spaceId: spaceId.toString(), userId: userId.toString(), role }
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

  const validUIds = [...new Set(userIds.filter(id => id && ObjectId.isValid(id)).map(String))].map(id => new ObjectId(id));
  if (!validUIds.length) throw new Error('No valid user IDs found.');

  // Find users that actually exist
  const existingUsers = await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: validUIds } }, { projection: { _id: 1 } })
    .toArray();

  const realUserIds = existingUsers.map(u => u._id);

  // Find already existing memberships
  const currentMembers = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .find({ spaceId: sId, userId: { $in: realUserIds } }, { projection: { userId: 1, status: 1 } })
    .toArray();

  const currentMemberMap = {};
  currentMembers.forEach(m => { currentMemberMap[m.userId.toString()] = m.status; });

  const toInsert = [];
  const toReactivate = [];

  const now = new Date();
  realUserIds.forEach(uId => {
    const idStr = uId.toString();
    if (currentMemberMap[idStr] === 'active') {
      // already active, skip
      return;
    }
    if (currentMemberMap[idStr] === 'removed') {
      toReactivate.push(uId);
    } else {
      toInsert.push({
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

  if (toInsert.length) {
    await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).insertMany(toInsert);
  }

  if (toReactivate.length) {
    await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).updateMany(
      { spaceId: sId, userId: { $in: toReactivate } },
      { $set: { status: 'active', updatedAt: now } }
    );
  }

  const addedCount = toInsert.length + toReactivate.length;
  if (addedCount > 0) {
    await database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
      { _id: sId },
      { $inc: { memberCount: addedCount } }
    );

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

  const existing = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .findOne({ spaceId: sId, userId: uId, status: 'active' });

  if (!existing) throw new Error('Member not found in this space.');

  const updateResult = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).updateOne(
    { _id: existing._id, status: 'active' },
    { $set: { status: 'removed', removedAt: new Date(), updatedAt: new Date() } }
  );

  if (updateResult.modifiedCount > 0) {
    await database.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
      { _id: sId, memberCount: { $gt: 0 } },
      { $inc: { memberCount: -1 } }
    );
  }

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

  const query = { spaceId: sId };
  if (filters.status && filters.status !== 'all') {
    query.status = filters.status;
  } else {
    query.status = 'active';
  }

  if (filters.role && filters.role !== 'all') {
    query.role = filters.role;
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 20), 100);
  const skip = (page - 1) * limit;

  const total = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).countDocuments(query);
  const memberships = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
    .find(query)
    .sort({ joinedAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const userIds = memberships.map(m => m.userId);
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
