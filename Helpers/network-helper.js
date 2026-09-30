const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const governanceHelper = require('./governance-helper');
const logger = require('./logger');
const { decorateProfileImage } = require('./image-url-helper');

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─────────────────────────────────────────────────────────
// NETWORK STATS
// ─────────────────────────────────────────────────────────

const getNetworkStats = async () => {
  try {
    const database = db.get();

    const [totalUsers, totalTeachers, totalAdmins] = await Promise.all([
      database.collection(collection.STUDENTS_COLLECTION).countDocuments({ 'account_Status.isDeleted': { $ne: true } }),
      database.collection(collection.TEACHER_COLLECTION).countDocuments({}),
      database.collection(collection.ADMIN_COLLECTION).countDocuments({})
    ]);

    const enrolledStudents = await database.collection(collection.STUDENTS_COLLECTION).countDocuments({
      'account_Status.isDeleted': { $ne: true },
      'course.0': { $exists: true }
    });

    const registeredOnly = totalUsers - enrolledStudents;

    const blockedCount = await database.collection(collection.STUDENTS_COLLECTION).countDocuments({
      'account_Status.isBlocked': true
    });

    return {
      totalPeople: totalUsers + totalTeachers + totalAdmins,
      enrolledStudents,
      registeredOnly,
      totalTeachers,
      totalAdmins,
      blockedCount
    };
  } catch (err) {
    logger.error('getNetworkStats Error:', err.message);
    return {
      totalPeople: 0,
      enrolledStudents: 0,
      registeredOnly: 0,
      totalTeachers: 0,
      totalAdmins: 0,
      blockedCount: 0
    };
  }
};

// ─────────────────────────────────────────────────────────
// DIRECTORY SEARCH & PAGINATION
// ─────────────────────────────────────────────────────────

const getNetworkUsers = async (filters = {}, pageArg = null, limitArg = null) => {
  const database = db.get();
  const page = Math.max(1, Number(pageArg !== null ? pageArg : filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(limitArg !== null ? limitArg : filters.limit) || 20), 100);
  const skip = (page - 1) * limit;

  const role = filters.role || 'all';
  const search = (filters.search || '').trim();
  const cleanSearch = search.replace(/^@+/, '').trim();
  const searchRegex = search ? new RegExp(escapeRegex(search), 'i') : null;
  const cleanSearchRegex = cleanSearch ? new RegExp(escapeRegex(cleanSearch), 'i') : null;

  // Space filter: if spaceId is provided, get member userIds first from platform memberships or legacy
  let spaceUserIds = null;
  if (filters.spaceId && ObjectId.isValid(filters.spaceId)) {
    const space = await database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: new ObjectId(filters.spaceId) });
    let memberDocs = [];
    if (space && space.communityId) {
      memberDocs = await database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
        .find({ communityId: space.communityId, status: 'active' }, { projection: { userId: 1 } })
        .toArray();
    }
    if (!memberDocs.length) {
      memberDocs = await database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
        .find({ spaceId: new ObjectId(filters.spaceId), status: 'active' }, { projection: { userId: 1 } })
        .toArray();
    }
    spaceUserIds = memberDocs.map(m => m.userId).filter(Boolean);
  }

  // If role is specific to Teacher
  if (role === 'teacher') {
    const query = {};
    if (searchRegex) {
      query.$or = [{ name: searchRegex }, { email: searchRegex }, { designation: searchRegex }];
    }
    if (filters.status === 'active') query.status = 'active';
    if (filters.status === 'blocked') query.status = 'blocked';

    const total = await database.collection(collection.TEACHER_COLLECTION).countDocuments(query);
    const teachers = await database.collection(collection.TEACHER_COLLECTION)
      .find(query, {
        projection: {
          _id: 1,
          name: 1,
          email: 1,
          designation: 1,
          status: 1,
          profileImage: 1,
          createdAt: 1
        }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    await Promise.all(teachers.map(t => decorateProfileImage(t, 'profileImage')));

    const records = teachers.map(t => ({
      _id: t._id,
      name: t.name,
      email: t.email,
      username: t.email.split('@')[0],
      role: 'teacher',
      roleBadge: 'Teacher',
      status: t.status || 'active',
      isVerified: true,
      isBlocked: t.status === 'blocked',
      avatar: t.profileImageUrl || '/img/placeholders/profile.svg',
      joinedAt: t.createdAt,
      detailLink: `/network/user/${t._id}?role=teacher`
    }));

    return { records, users: records, total, totalUsers: total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  // If role is specific to Admin
  if (role === 'admin') {
    const query = {};
    if (searchRegex) {
      query.$or = [{ Name: searchRegex }, { Email: searchRegex }];
    }

    const total = await database.collection(collection.ADMIN_COLLECTION).countDocuments(query);
    const admins = await database.collection(collection.ADMIN_COLLECTION)
      .find(query, {
        projection: {
          _id: 1,
          Name: 1,
          Email: 1,
          role: 1,
          createdAt: 1
        }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const records = admins.map(a => ({
      _id: a._id,
      name: a.Name || 'Admin',
      email: a.Email,
      username: a.Email ? a.Email.split('@')[0] : 'admin',
      role: a.role === 'superuser' ? 'superuser' : 'admin',
      roleBadge: a.role === 'superuser' ? 'Superuser' : 'Admin',
      status: 'active',
      isVerified: true,
      isBlocked: false,
      avatar: '/images/logo.png',
      joinedAt: a.createdAt,
      detailLink: `/network/user/${a._id}?role=admin`
    }));

    return { records, users: records, total, totalUsers: total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  }

  // For Students / Registered / Professional Roles / All:
  // Base query on STUDENTS_COLLECTION ('users')
  const userQuery = {
    'account_Status.isDeleted': { $ne: true }
  };

  const normalizedRole = role.toLowerCase();
  if (['educator', 'professional', 'mentor', 'recruiter', 'founder'].includes(normalizedRole)) {
    userQuery.$or = [
      { primaryRole: normalizedRole.toUpperCase() },
      { roles: normalizedRole.toUpperCase() },
      { role: normalizedRole }
    ];
  } else if (normalizedRole === 'student') {
    userQuery.$or = [
      { primaryRole: 'STUDENT' },
      { roles: 'STUDENT' },
      { role: 'student' }
    ];
  } else if (normalizedRole === 'registered') {
    userQuery.$or = [
      { course: { $exists: false } },
      { course: { $eq: [] } }
    ];
  }

  if (searchRegex) {
    const searchConditions = [
      { Name: searchRegex },
      { name: searchRegex },
      { email: searchRegex },
      { username: searchRegex },
      { Phone_Number: searchRegex }
    ];
    if (cleanSearchRegex && cleanSearch !== search) {
      searchConditions.push({ username: cleanSearchRegex });
      searchConditions.push({ Name: cleanSearchRegex });
      searchConditions.push({ name: cleanSearchRegex });
    }
    if (ObjectId.isValid(cleanSearch)) {
      searchConditions.push({ _id: new ObjectId(cleanSearch) });
    } else if (ObjectId.isValid(search)) {
      searchConditions.push({ _id: new ObjectId(search) });
    }
    userQuery.$and = userQuery.$and || [];
    userQuery.$and.push({ $or: searchConditions });
  }

  if (filters.status === 'active') {
    userQuery['account_Status.isBlocked'] = { $ne: true };
  } else if (filters.status === 'blocked' || filters.status === 'suspended') {
    userQuery['account_Status.isBlocked'] = true;
  } else if (filters.status === 'restricted') {
    userQuery['account_Status.restrictions.0'] = { $exists: true };
  }

  if (filters.verified === 'verified' || filters.isVerified === 'true' || filters.isVerified === true) {
    userQuery.$and = userQuery.$and || [];
    userQuery.$and.push({
      $or: [
        { isVerified: true },
        { 'account_Status.isVerified': true },
        { verificationStatus: 'VERIFIED' }
      ]
    });
  } else if (filters.verified === 'unverified' || filters.isVerified === 'false' || filters.isVerified === false) {
    userQuery.$and = userQuery.$and || [];
    userQuery.$and.push({
      $and: [
        { isVerified: { $ne: true } },
        { 'account_Status.isVerified': { $ne: true } },
        { verificationStatus: { $ne: 'VERIFIED' } }
      ]
    });
  }

  if (filters.discipline && filters.discipline !== 'all') {
    userQuery.discipline = filters.discipline;
  }

  if (filters.sector && filters.sector !== 'all') {
    userQuery.infrastructureSector = filters.sector;
  }

  if (filters.usernameState === 'claimed') {
    userQuery.usernameClaimed = true;
  } else if (filters.usernameState === 'auto') {
    userQuery.usernameClaimed = { $ne: true };
  }

  if (filters.courseId && ObjectId.isValid(filters.courseId)) {
    userQuery['course.courseId'] = String(filters.courseId);
  }

  if (spaceUserIds) {
    userQuery._id = { $in: spaceUserIds };
  }

  const total = await database.collection(collection.STUDENTS_COLLECTION).countDocuments(userQuery);
  const users = await database.collection(collection.STUDENTS_COLLECTION)
    .find(userQuery, {
      projection: {
        _id: 1,
        Name: 1,
        name: 1,
        email: 1,
        username: 1,
        Phone_Number: 1,
        primaryRole: 1,
        role: 1,
        discipline: 1,
        infrastructureSector: 1,
        course: 1,
        account_Status: 1,
        isVerified: 1,
        verificationStatus: 1,
        usernameClaimed: 1,
        profileImage: 1,
        createdAt: 1
      }
    })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  await Promise.all(users.map(u => decorateProfileImage(u, 'profileImage')));

  // Single-query batch lookup for community profiles (prevents N+1 database queries)
  const userIds = users.map(u => u._id);
  const commProfiles = userIds.length ? await database.collection(collection.COMMUNITY_PROFILES_COLLECTION)
    .find({ $or: [{ userId: { $in: userIds } }, { userId: { $in: userIds.map(String) } }] })
    .toArray()
    .catch(() => []) : [];

  const commProfileMap = {};
  commProfiles.forEach(p => {
    commProfileMap[String(p.userId)] = p;
  });

  const records = users.map(u => {
    const isEnrolled = Array.isArray(u.course) && u.course.length > 0;
    const isBlocked = Boolean(u.account_Status?.isBlocked);
    const isVerified = Boolean(u.isVerified || u.account_Status?.isVerified || u.verificationStatus === 'VERIFIED');
    const isRestricted = Boolean(u.account_Status?.restrictions && u.account_Status.restrictions.length);
    const commProfile = commProfileMap[String(u._id)] || {};

    const roleResolution = governanceHelper.resolveCanonicalUserRoles(u);
    const primaryRole = roleResolution.primaryRole;
    const roles = roleResolution.roles;
    const secondaryRoles = roleResolution.secondaryRoles;
    const capabilities = governanceHelper.computeUserCapabilities(u).capabilities;

    return {
      _id: u._id,
      name: u.Name || u.name || 'Learner',
      email: u.email,
      username: u.username || (u.email ? u.email.split('@')[0] : 'user'),
      usernameClaimed: Boolean(u.usernameClaimed),
      primaryRole,
      roles,
      secondaryRoles,
      capabilities,
      capabilitiesCount: capabilities.length,
      isEnrolled,
      role: primaryRole.toLowerCase(),
      roleBadge: primaryRole === 'EDUCATOR' ? 'Educator (Protected)' : (primaryRole.charAt(0) + primaryRole.slice(1).toLowerCase()),
      discipline: u.discipline || commProfile.discipline || null,
      infrastructureSector: u.infrastructureSector || commProfile.infrastructureSector || null,
      status: isBlocked ? 'suspended' : (isRestricted ? 'restricted' : (u.account_Status?.isActive === false ? 'inactive' : 'active')),
      accountStatus: isBlocked ? 'suspended' : (isRestricted ? 'restricted' : (u.account_Status?.isActive === false ? 'inactive' : 'active')),
      isVerified,
      verificationStatus: u.verificationStatus || (isVerified ? 'VERIFIED' : 'UNVERIFIED'),
      isBlocked,
      isSuspended: isBlocked,
      isRestricted,
      coursesCount: isEnrolled ? u.course.length : 0,
      avatar: u.profileImageUrl || '/img/placeholders/profile.svg',
      joinedAt: u.createdAt,
      createdAt: u.createdAt,
      lastSeen: u.account_Status?.lastSeen || null,
      detailLink: `/admin/network/users/${u._id}`
    };
  });

  return { records, users: records, total, totalUsers: total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
};

// ─────────────────────────────────────────────────────────
// DETAILED USER VIEW
// ─────────────────────────────────────────────────────────

const getNetworkUserDetails = async (userId, roleHint = '') => {
  if (!userId || !ObjectId.isValid(userId)) return null;

  const database = db.get();
  const objId = new ObjectId(userId);
  const idStr = String(userId);

  const safeProjection = {
    Password: 0,
    password: 0,
    Password_Hash: 0,
    password_hash: 0,
    tokens: 0,
    otp: 0,
    otpExpires: 0,
    passwordResetToken: 0,
    passwordResetExpires: 0,
    jwtSecret: 0,
    refreshToken: 0
  };

  // 1. Check in STUDENTS_COLLECTION ('users')
  let user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: objId }, { projection: safeProjection });
  let userType = 'user';

  // 2. If not found or roleHint is teacher, check in TEACHER_COLLECTION
  if (!user && (roleHint === 'teacher' || !roleHint)) {
    user = await database.collection(collection.TEACHER_COLLECTION).findOne({ _id: objId }, { projection: safeProjection });
    if (user) userType = 'teacher';
  }

  // 3. If not found or roleHint is admin, check in ADMIN_COLLECTION
  if (!user && (roleHint === 'admin' || !roleHint)) {
    user = await database.collection(collection.ADMIN_COLLECTION).findOne({ _id: objId }, { projection: safeProjection });
    if (user) userType = 'admin';
  }

  if (!user) return null;

  // Extra safety: sanitize user object in memory
  delete user.Password;
  delete user.password;
  delete user.Password_Hash;
  delete user.password_hash;
  delete user.tokens;
  delete user.otp;
  delete user.jwtSecret;
  delete user.refreshToken;

  await decorateProfileImage(user, 'profileImage');

  let enrolledCourses = [];
  let spaces = [];
  let followers = [];
  let following = [];
  let communityProfile = null;

  if (userType === 'user') {
    enrolledCourses = user.course || [];

    // Find learning spaces member of via network_community_memberships and legacy
    try {
      const [commMemberships, legacyMemberships] = await Promise.all([
        database.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION)
          .find({ userId: objId, status: 'active' })
          .toArray(),
        database.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION)
          .find({ userId: objId, status: 'active' })
          .toArray()
      ]);

      const commIds = commMemberships.map(m => m.communityId).filter(Boolean);
      const legacySpaceIds = legacyMemberships.map(m => m.spaceId).filter(Boolean);

      const [commSpaces, legacySpaces] = await Promise.all([
        commIds.length ? database.collection(collection.LEARNING_SPACES_COLLECTION).find({ communityId: { $in: commIds } }).toArray() : [],
        legacySpaceIds.length ? database.collection(collection.LEARNING_SPACES_COLLECTION).find({ _id: { $in: legacySpaceIds } }).toArray() : []
      ]);

      const allSpacesMap = {};
      commSpaces.forEach(s => { allSpacesMap[s._id.toString()] = s; });
      legacySpaces.forEach(s => { allSpacesMap[s._id.toString()] = s; });

      const spaceEntries = [];
      commMemberships.forEach(m => {
        const space = commSpaces.find(s => s.communityId && s.communityId.toString() === m.communityId.toString());
        if (space) {
          spaceEntries.push({
            spaceId: space._id,
            name: space.name || 'Learning Space',
            code: space.code || '',
            role: m.role || 'member',
            status: m.status || 'active',
            joinedAt: m.joinedAt
          });
        }
      });

      legacyMemberships.forEach(m => {
        const space = allSpacesMap[m.spaceId.toString()];
        if (space && !spaceEntries.some(e => e.spaceId.toString() === space._id.toString())) {
          spaceEntries.push({
            spaceId: space._id,
            name: space.name || 'Learning Space',
            code: space.code || '',
            role: m.role || 'member',
            status: m.status || 'active',
            joinedAt: m.joinedAt
          });
        }
      });
      spaces = spaceEntries;
    } catch (spaceErr) {
      logger.warn(`Error resolving user spaces: ${spaceErr.message}`);
    }

    // Followers & Following from network_connections (canonical) and community_followers (legacy)
    try {
      const connections = await database.collection(collection.NETWORK_CONNECTIONS_COLLECTION)
        .find({
          $or: [
            { requesterId: objId },
            { recipientId: objId },
            { userLow: objId },
            { userHigh: objId }
          ],
          status: 'accepted'
        })
        .limit(50)
        .toArray();

      const [followerDocs, followingDocs] = await Promise.all([
        database.collection(collection.COMMUNITY_FOLLOWERS_COLLECTION)
          .find({ userId: idStr })
          .limit(50)
          .toArray(),
        database.collection(collection.COMMUNITY_FOLLOWERS_COLLECTION)
          .find({ followerId: idStr })
          .limit(50)
          .toArray()
      ]);

      const otherConnUserIds = connections.map(c => {
        if (c.requesterId && c.requesterId.toString() === idStr) return c.recipientId;
        if (c.recipientId && c.recipientId.toString() === idStr) return c.requesterId;
        if (c.userLow && c.userLow.toString() === idStr) return c.userHigh;
        return c.userLow;
      }).filter(id => id && ObjectId.isValid(id));

      const legacyFollowerIds = followerDocs.map(f => f.followerId).filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
      const legacyFollowingIds = followingDocs.map(f => f.userId).filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));

      const allTargetUserIds = [...new Set([
        ...otherConnUserIds.map(String),
        ...legacyFollowerIds.map(String),
        ...legacyFollowingIds.map(String)
      ])].map(id => new ObjectId(id));

      const otherUsers = allTargetUserIds.length ? await database.collection(collection.STUDENTS_COLLECTION)
        .find({ _id: { $in: allTargetUserIds } }, { projection: { _id: 1, Name: 1, name: 1, username: 1, email: 1 } })
        .toArray() : [];

      const userMap = {};
      otherUsers.forEach(u => { userMap[u._id.toString()] = u; });

      if (connections.length > 0) {
        followers = connections.map(c => {
          const otherId = (c.requesterId && c.requesterId.toString() === idStr)
            ? c.recipientId
            : ((c.recipientId && c.recipientId.toString() === idStr)
              ? c.requesterId
              : (c.userLow && c.userLow.toString() === idStr ? c.userHigh : c.userLow));
          const u = userMap[otherId.toString()];
          return {
            followerId: otherId.toString(),
            name: u?.Name || u?.name || 'Learner',
            username: u?.username || (u?.email ? u.email.split('@')[0] : 'user'),
            createdAt: c.createdAt
          };
        });
        following = followers;
      } else {
        followers = followerDocs.map(f => {
          const u = userMap[f.followerId];
          return {
            followerId: f.followerId,
            name: u?.Name || u?.name || 'Learner',
            username: u?.username || (u?.email ? u.email.split('@')[0] : 'user'),
            createdAt: f.createdAt
          };
        });

        following = followingDocs.map(f => {
          const u = userMap[f.userId];
          return {
            userId: f.userId,
            name: u?.Name || u?.name || 'Learner',
            username: u?.username || (u?.email ? u.email.split('@')[0] : 'user'),
            createdAt: f.createdAt
          };
        });
      }
    } catch (e) {
      logger.warn(`Error resolving connections: ${e.message}`);
    }

    // Community Profile
    try {
      communityProfile = await database.collection(collection.COMMUNITY_PROFILES_COLLECTION)
        .findOne({ userId: idStr });
    } catch (e) {}
  } else if (userType === 'teacher') {
    // Resolve teacher assigned courses
    const assignedIds = (user.assignedCourses || []).filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
    if (assignedIds.length) {
      enrolledCourses = await database.collection(collection.COURSE_COLLECTION)
        .find({ _id: { $in: assignedIds } }, { projection: { _id: 1, name: 1, Total_Fees: 1 } })
        .toArray();
    }

    // Resolve learning spaces assigned
    spaces = await database.collection(collection.LEARNING_SPACES_COLLECTION)
      .find({ teachers: objId }, { projection: { _id: 1, name: 1, code: 1, status: 1 } })
      .toArray();
  }

  return {
    user,
    userType,
    isEnrolled: Array.isArray(user.course) && user.course.length > 0,
    enrolledCourses,
    spaces,
    followers,
    following,
    communityProfile
  };
};

// ─────────────────────────────────────────────────────────
// ACCOUNT STATUS & ROLE MANAGEMENT
// ─────────────────────────────────────────────────────────

const updateUserAccountStatus = async (userId, { isBlocked, isActive }, actor, req = null) => {
  if (!userId || !ObjectId.isValid(userId)) throw new Error('Invalid User ID.');

  const database = db.get();
  const objId = new ObjectId(userId);

  // Self-protection guard: Never allow an administrator to block or deactivate themselves!
  if (actor?._id && String(actor._id) === String(userId)) {
    throw new Error('Action rejected: You cannot block or deactivate your own account.');
  }

  // Protect administrator accounts from modification via network management
  const adminUser = await database.collection(collection.ADMIN_COLLECTION).findOne({ _id: objId });
  if (adminUser) {
    throw new Error('Action rejected: Administrator accounts cannot be modified through network management.');
  }

  // Check in users collection
  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: objId });
  if (user) {
    const update = {};
    if (isBlocked !== undefined) {
      update['account_Status.isBlocked'] = Boolean(isBlocked);
    }
    if (isActive !== undefined) {
      update['account_Status.isActive'] = Boolean(isActive);
    }
    update.updatedAt = new Date();

    await database.collection(collection.STUDENTS_COLLECTION).updateOne({ _id: objId }, { $set: update });

    await auditHelper.logAction({
      req,
      action: isBlocked ? 'USER_BLOCK' : (isActive === false ? 'USER_DEACTIVATE' : 'USER_ACTIVATE'),
      entityType: 'user',
      entityId: String(userId),
      entityName: user.Name || user.name || user.email,
      status: 'success',
      message: `Account status updated for ${user.email} (isBlocked: ${isBlocked}, isActive: ${isActive}).`,
      metadata: { isBlocked, isActive }
    });

    return true;
  }

  // Check in teachers collection
  const teacher = await database.collection(collection.TEACHER_COLLECTION).findOne({ _id: objId });
  if (teacher) {
    const newStatus = isBlocked ? 'blocked' : (isActive === false ? 'inactive' : 'active');
    await database.collection(collection.TEACHER_COLLECTION).updateOne(
      { _id: objId },
      { $set: { status: newStatus, updatedAt: new Date() } }
    );

    await auditHelper.logAction({
      req,
      action: isBlocked ? 'TEACHER_BLOCK' : 'TEACHER_STATUS_UPDATE',
      entityType: 'teacher',
      entityId: String(userId),
      entityName: teacher.name || teacher.email,
      status: 'success',
      message: `Teacher status updated to ${newStatus}.`,
      metadata: { status: newStatus }
    });

    return true;
  }

  throw new Error('User not found.');
};

const removeRelationship = async ({ userId, targetId, relationshipType }, actor, req = null) => {
  if (!userId || !targetId || !ObjectId.isValid(userId) || !ObjectId.isValid(targetId)) {
    throw new Error('Valid user IDs are required.');
  }
  if (!['follower', 'following'].includes(relationshipType)) {
    throw new Error('Invalid relationship type. Must be follower or following.');
  }

  const database = db.get();
  const u1 = new ObjectId(userId);
  const u2 = new ObjectId(targetId);
  const s1 = u1.toString();
  const s2 = u2.toString();
  const [userLow, userHigh] = s1 < s2 ? [u1, u2] : [u2, u1];

  // 1. Remove from platform network_connections
  await database.collection(collection.NETWORK_CONNECTIONS_COLLECTION).deleteOne({
    userLow,
    userHigh
  });

  // 2. Remove from legacy community_followers
  if (relationshipType === 'follower') {
    // userId is being followed by targetId
    await database.collection(collection.COMMUNITY_FOLLOWERS_COLLECTION).deleteOne({
      userId: String(userId),
      followerId: String(targetId)
    });
  } else if (relationshipType === 'following') {
    // userId is following targetId
    await database.collection(collection.COMMUNITY_FOLLOWERS_COLLECTION).deleteOne({
      userId: String(targetId),
      followerId: String(userId)
    });
  }

  await auditHelper.logAction({
    req,
    action: 'NETWORK_RELATIONSHIP_REMOVE',
    entityType: 'relationship',
    entityId: `${userId}_${targetId}`,
    entityName: relationshipType,
    status: 'success',
    message: `Relationship ${relationshipType} removed between ${userId} and ${targetId}.`,
    metadata: { userId, targetId, relationshipType }
  });

  return true;
};

module.exports = {
  getNetworkStats,
  getNetworkUsers,
  getNetworkUserDetails,
  updateUserAccountStatus,
  removeRelationship
};
