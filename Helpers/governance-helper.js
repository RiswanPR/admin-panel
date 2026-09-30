/**
 * Zeitnah Admin Panel — Governance Helper
 * Handles Network User Roles, Verification, Business Review, Integrity Signals, and Job Moderation.
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');
const permissionsHelper = require('./permissions-helper');
const usernameHelper = require('./username-helper');
const verificationHelper = require('./verification-helper');
// Lazy-load to avoid circular deps; call via getter
let _teacherHelper = null;
const teacherHelper = () => {
  if (!_teacherHelper) _teacherHelper = require('./teacher-helper');
  return _teacherHelper;
};

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidObjectId = (id) => {
  if (!id) return false;
  if (id instanceof ObjectId) return true;
  if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) return true;
  return false;
};

const SENSITIVE_KEYS = new Set([
  'password', 'Password', 'Password_Hash', 'password_hash', 'hash', 'salt',
  'tokens', 'refreshToken', 'accessToken', 'jwtToken', 'jwtSecret', 'otp',
  'otpHash', 'otpExpires', 'passwordResetToken', 'passwordResetExpires',
  'deviceSecrets', 'deviceToken', 'authSecrets', 'sessionSecret', 'secret'
]);

const recursiveSanitize = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(recursiveSanitize);
  }
  const clean = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (val && typeof val === 'object' && !(val instanceof Date) && !(val instanceof ObjectId)) {
      clean[key] = recursiveSanitize(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
};

/**
 * Sanitizes a raw MongoDB user document, stripping all authentication secrets and hashes.
 */
const sanitizeUserForAdmin = (user) => {
  if (!user || typeof user !== 'object') return null;
  return recursiveSanitize(user);
};

// ─────────────────────────────────────────────────────────
// 1. NETWORK USER & ROLE ADMINISTRATION
// ─────────────────────────────────────────────────────────

const ALLOWED_PROFILE_ROLES = ['STUDENT', 'EDUCATOR', 'PROFESSIONAL', 'MENTOR', 'RECRUITER', 'FOUNDER'];

const assignUserRole = async (userId, newRole, actor, req, reason = '') => {
  if (!isValidObjectId(userId)) {
    throw new Error('Valid user ID is required.');
  }

  // Self-protection guard: Cannot change own role
  if (actor?._id && String(actor._id) === String(userId)) {
    throw new Error('Action rejected: You cannot change your own role.');
  }

  const normalizedRole = String(newRole || '').toUpperCase();
  if (!ALLOWED_PROFILE_ROLES.includes(normalizedRole)) {
    throw new Error(`Invalid role: ${newRole}. Must be one of: ${ALLOWED_PROFILE_ROLES.join(', ')}.`);
  }

  const database = db.get();

  // Prevent modifying administrator accounts via network role governance
  const adminTarget = await database.collection(collection.ADMIN_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (adminTarget) {
    if (actor?.role !== 'superuser') {
      throw new Error('Action rejected: Only superusers can modify roles of administrative accounts.');
    }
  }

  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) {
    throw new Error('User not found.');
  }

  const previousRole = String(user.primaryRole || user.role || 'STUDENT').toUpperCase();
  if (previousRole === normalizedRole) {
    return { success: true, message: `User already has role ${normalizedRole}`, previousRole, newRole: normalizedRole, role: normalizedRole };
  }

  // Enforce server-side educator guard
  const isEducatorChange = normalizedRole === 'EDUCATOR' || previousRole === 'EDUCATOR';
  if (isEducatorChange && !permissionsHelper.hasCapability(actor, 'assign_educator')) {
    throw new Error('Permission denied: assign_educator capability is required to modify the Educator role.');
  }

  const actionType = 'USER_ROLE_ASSIGNED';

  const updateDoc = {
    $set: {
      primaryRole: normalizedRole,
      role: normalizedRole.toLowerCase(),
      updatedAt: new Date()
    }
  };

  // If assigning educator, initialize educator context if missing and mark verified
  if (normalizedRole === 'EDUCATOR') {
    if (!user.educatorContext) {
      updateDoc.$set.educatorContext = {
        assignedBy: actor?._id ? String(actor._id) : 'admin',
        assignedAt: new Date(),
        verifiedByAdmin: true
      };
    }
    updateDoc.$set['account_Status.isVerified'] = true;

    // Bridge with TEACHER_COLLECTION: link or create instructor profile deterministically
    try {
      if (user.email) {
        const existingTeacher = await database.collection(collection.TEACHER_COLLECTION).findOne({ email: user.email.toLowerCase().trim() });
        if (existingTeacher) {
          if (!existingTeacher.userId) {
            await database.collection(collection.TEACHER_COLLECTION).updateOne(
              { _id: existingTeacher._id },
              { $set: { userId: new ObjectId(userId), updatedAt: new Date() } }
            );
          }
          updateDoc.$set['educatorContext.teacherId'] = existingTeacher._id;
        } else {
          const newTeacher = {
            userId: new ObjectId(userId),
            name: user.name || user.Name || 'Educator',
            email: user.email.toLowerCase().trim(),
            mobile: user.Phone_Number || '',
            password: user.Password || user.password || '',
            profileImage: user.profileImage || '/img/placeholders/profile.svg',
            designation: 'Educator',
            bio: user.bio || '',
            role: 'teacher',
            assignedCourses: [],
            status: 'active',
            isBridged: true,
            createdAt: new Date()
          };
          const ins = await database.collection(collection.TEACHER_COLLECTION).insertOne(newTeacher);
          updateDoc.$set['educatorContext.teacherId'] = ins.insertedId;
        }
      }
    } catch (bridgeErr) {
      logger.warn('Educator teacher bridge warning:', bridgeErr.message);
    }
  }

  // If revoking educator role, disable the teacher bridge to prevent stale portal access
  if (previousRole === 'EDUCATOR' && normalizedRole !== 'EDUCATOR') {
    try {
      const revokeResult = await teacherHelper().revokeTeacherBridgeForUser(
        String(userId),
        actor?._id ? String(actor._id) : 'admin'
      );
      if (revokeResult.revoked) {
        updateDoc.$set['educatorContext.revokedAt'] = new Date();
        updateDoc.$set['educatorContext.revokedBy'] = actor?._id ? String(actor._id) : 'admin';
        logger.info(`Educator bridge revoked: userId=${userId}, teacherId=${revokeResult.teacherId}`);
      }
    } catch (revokeErr) {
      logger.warn('Educator bridge revocation warning:', revokeErr.message);
    }
  }

  // Also invalidate any active teacher sessions for this user when revoking educator
  if (previousRole === 'EDUCATOR' && normalizedRole !== 'EDUCATOR') {
    try {
      // Teacher sessions have req.session.teacher set; find by teacherId reference
      // Sessions are deleted based on pattern matching userId or teacher email
      const platformUser = await database.collection(collection.STUDENTS_COLLECTION).findOne(
        { _id: new ObjectId(userId) }, { projection: { email: 1 } }
      );
      if (platformUser && platformUser.email) {
        const emailStr = String(platformUser.email);
        await database.collection('sessions').deleteMany({
          $or: [
            { session: { $regex: emailStr } },
            { 'session.teacher.email': emailStr },
            { 'session.teacher.Email': emailStr }
          ]
        }).catch(() => {});
      }
    } catch (sessErr) {
      logger.warn(`Could not clear teacher sessions on educator revocation for userId=${userId}: ${sessErr.message}`);
    }
  }

  // Persist role change to platform user record
  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    updateDoc
  );

  // Synchronize community profile if exists
  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).updateOne(
    { userId: new ObjectId(userId) },
    { $set: { primaryRole: normalizedRole, role: normalizedRole.toLowerCase(), updatedAt: new Date() } }
  ).catch(() => {});

  const cleanReason = String(reason || (normalizedRole === 'EDUCATOR' ? 'Promoted to Educator' : 'Role updated via admin governance')).trim();

  // AUDIT LOGGING (Strictly Required)
  await auditHelper.logAction({
    req,
    action: actionType,
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `Admin assigned role ${normalizedRole} to user (previous: ${previousRole}). Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      target: 'user',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      role: normalizedRole,
      previousRole,
      newRole: normalizedRole,
      reason: cleanReason,
      isEducatorChange,
      timestamp: new Date()
    }
  });

  return { success: true, previousRole, newRole: normalizedRole, role: normalizedRole, reason: cleanReason };
};

const suspendUser = async (userId, { reason, restrictions = [] }, actor, req) => {
  if (!isValidObjectId(userId)) {
    throw new Error('Valid user ID is required.');
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length < 3) {
    throw new Error('A valid administrative reason (minimum 3 characters) is mandatory to suspend a user.');
  }

  // Self-protection guard
  if (actor?._id && String(actor._id) === String(userId)) {
    throw new Error('Action rejected: Self-suspension is prohibited.');
  }

  const database = db.get();

  // Admin protection guard
  const adminTarget = await database.collection(collection.ADMIN_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (adminTarget) {
    if (actor?.role !== 'superuser') {
      throw new Error('Action rejected: Only superusers can suspend administrative accounts.');
    }
  }

  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) {
    throw new Error('User not found.');
  }

  const previousState = {
    isBlocked: user.account_Status?.isBlocked || false,
    isActive: user.account_Status?.isActive !== false,
    restrictions: user.account_Status?.restrictions || []
  };

  const appliedRestrictions = Array.isArray(restrictions) && restrictions.length ? restrictions : ['account_suspended', 'no_messaging', 'no_applications'];

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        'account_Status.isBlocked': true,
        'account_Status.isActive': false,
        'account_Status.suspendedAt': new Date(),
        'account_Status.suspendedReason': cleanReason,
        'account_Status.suspendedBy': actor?._id ? new ObjectId(actor._id) : 'admin',
        'account_Status.restrictions': appliedRestrictions,
        updatedAt: new Date()
      }
    }
  );

  // Terminate active sessions for this user in sessions collection
  try {
    const idStr = String(userId);
    const regex = new RegExp(idStr);
    await database.collection('sessions').deleteMany({
      $or: [
        { 'session.userId': idStr },
        { 'session.user._id': idStr },
        { 'session.user._id': new ObjectId(userId) },
        { session: { $regex: regex } }
      ]
    });
  } catch (sessErr) {
    logger.warn(`Could not clear active sessions for suspended user ${userId}: ${sessErr.message}`);
  }

  await auditHelper.logAction({
    req,
    action: 'USER_SUSPENDED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `User account suspended. Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      reason: cleanReason,
      restrictions: appliedRestrictions,
      previousState,
      newState: { isBlocked: true, isActive: false, restrictions: appliedRestrictions }
    }
  });

  return { success: true, message: 'User account suspended successfully.', status: 'suspended', reason: cleanReason };
};

const restoreUser = async (userId, { reason = '' }, actor, req) => {
  if (!isValidObjectId(userId)) {
    throw new Error('Valid user ID is required.');
  }

  const database = db.get();
  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) {
    throw new Error('User not found.');
  }

  const previousState = {
    isBlocked: user.account_Status?.isBlocked || false,
    isActive: user.account_Status?.isActive !== false,
    restrictions: user.account_Status?.restrictions || []
  };

  const cleanReason = String(reason || 'Restored by administrator').trim();

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        'account_Status.isBlocked': false,
        'account_Status.isActive': true,
        'account_Status.restoredAt': new Date(),
        'account_Status.restoredBy': actor?._id ? new ObjectId(actor._id) : 'admin',
        'account_Status.restrictions': [],
        updatedAt: new Date()
      },
      $unset: {
        'account_Status.suspendedReason': '',
        'account_Status.suspendedAt': ''
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'USER_RESTORED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `User account restored. Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      reason: cleanReason,
      previousState,
      newState: { isBlocked: false, isActive: true, restrictions: [] }
    }
  });

  return { success: true, message: 'User account restored successfully.', status: 'active', reason: cleanReason };
};

const restrictUser = async (userId, { restrictions = [], reason = '' }, actor, req) => {
  if (!isValidObjectId(userId)) {
    throw new Error('Valid user ID is required.');
  }

  const cleanReason = String(reason || 'Administrative restriction applied').trim();
  const appliedRestrictions = Array.isArray(restrictions) ? restrictions : (restrictions ? [String(restrictions)] : []);

  const database = db.get();
  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) {
    throw new Error('User not found.');
  }

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        'account_Status.restrictions': appliedRestrictions,
        'account_Status.restrictionReason': cleanReason,
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'USER_RESTRICTED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `User restrictions updated: ${appliedRestrictions.join(', ') || 'None'}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      targetUserId: String(userId),
      restrictions: appliedRestrictions,
      reason: cleanReason
    }
  });

  return { success: true, restrictions: appliedRestrictions };
};

const getUserSessions = async (userId, actor, req = null) => {
  if (!isValidObjectId(userId)) return [];

  const database = db.get();
  const idStr = String(userId);
  const regex = new RegExp(idStr);

  const rawDocs = await database.collection('sessions').find({
    $or: [
      { 'session.userId': idStr },
      { 'session.user._id': idStr },
      { 'session.user._id': new ObjectId(userId) },
      { session: { $regex: regex } }
    ]
  }).toArray().catch(() => []);

  const sessions = [];
  for (const doc of rawDocs) {
    let sessData = doc.session;
    if (typeof sessData === 'string') {
      try {
        sessData = JSON.parse(sessData);
      } catch (e) {
        sessData = {};
      }
    }

    const ua = sessData?.userAgent || sessData?.cookie?.userAgent || req?.headers?.['user-agent'] || 'Web Client';
    let deviceType = 'Desktop';
    if (/mobile/i.test(ua)) deviceType = 'Mobile';
    else if (/ipad|tablet/i.test(ua)) deviceType = 'Tablet';

    let browser = 'Web Browser';
    if (/chrome/i.test(ua) && !/edg/i.test(ua)) browser = 'Chrome';
    else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
    else if (/firefox/i.test(ua)) browser = 'Firefox';
    else if (/edg/i.test(ua)) browser = 'Edge';

    let os = 'Unknown OS';
    if (/mac os/i.test(ua) || /macintosh/i.test(ua)) os = 'macOS';
    else if (/windows/i.test(ua)) os = 'Windows';
    else if (/android/i.test(ua)) os = 'Android';
    else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
    else if (/linux/i.test(ua)) os = 'Linux';

    const rawIp = sessData?.ip || sessData?.ipAddress || req?.ip || '127.0.0.1';
    const maskedIp = String(rawIp).replace(/\.\d+$/, '.***');

    const sid = String(doc._id);
    const maskedSid = sid.length > 12 ? `${sid.slice(0, 6)}...${sid.slice(-4)}` : sid;

    sessions.push({
      sessionId: sid,
      maskedSessionId: maskedSid,
      deviceType,
      browser,
      os,
      ipAddress: maskedIp,
      createdAt: doc.expires ? new Date(new Date(doc.expires).getTime() - 86400000) : new Date(),
      lastActive: doc.expires ? new Date(new Date(doc.expires).getTime() - 3600000) : new Date(),
      expiresAt: doc.expires || new Date(),
      isCurrentSession: Boolean(req && req.sessionID === sid)
    });
  }

  return sessions;
};

const revokeUserSession = async (userId, sessionId, actor, req) => {
  if (!isValidObjectId(userId) || !sessionId) {
    throw new Error('Valid user ID and session ID are required.');
  }

  if (req && req.sessionID === String(sessionId)) {
    throw new Error('Action rejected: You cannot revoke your own active administrative session.');
  }

  const database = db.get();
  const result = await database.collection('sessions').deleteOne({ _id: String(sessionId) });

  await auditHelper.logAction({
    req,
    action: 'USER_SESSION_REVOKED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: 'User Session',
    status: 'success',
    message: `Session ${sessionId.slice(0, 8)}... revoked by administrator.`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      targetUserId: String(userId),
      sessionId: String(sessionId)
    }
  });

  return { success: true, message: 'Session successfully revoked.', modifiedCount: result.deletedCount };
};

const revokeAllUserSessions = async (userId, actor, req) => {
  if (!isValidObjectId(userId)) {
    throw new Error('Valid user ID is required.');
  }

  const database = db.get();
  const idStr = String(userId);
  const regex = new RegExp(idStr);

  const query = {
    $or: [
      { 'session.userId': idStr },
      { 'session.user._id': idStr },
      { 'session.user._id': new ObjectId(userId) },
      { session: { $regex: regex } }
    ]
  };

  if (req?.sessionID) {
    query._id = { $ne: req.sessionID };
  }

  const result = await database.collection('sessions').deleteMany(query);

  await auditHelper.logAction({
    req,
    action: 'USER_ALL_SESSIONS_REVOKED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: 'User Sessions',
    status: 'success',
    message: `All sessions revoked for user ${userId}. Count: ${result.deletedCount}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      targetUserId: String(userId),
      revokedCount: result.deletedCount
    }
  });

  return { success: true, message: `All active sessions (${result.deletedCount}) successfully revoked.`, revokedCount: result.deletedCount };
};

const changeUserUsername = async (userId, { newUsername, reason = '' }, actor, req) => {
  if (!isValidObjectId(userId)) {
    throw new Error('Valid user ID is required.');
  }

  const cleanReason = String(reason || 'Administrative username adjustment').trim();
  const normalized = usernameHelper.normalizeUsername(newUsername);

  if (!normalized) {
    throw new Error('New username is required.');
  }

  const validator = usernameHelper.validateUsernameFormat || usernameHelper.validateUsername;
  const validation = validator(normalized);
  if (!validation.isValid) {
    throw new Error(validation.error || 'Username does not meet platform requirements (3-30 lowercase alphanumeric, underscore, hyphen, or dot).');
  }

  const isReservedRes = await (usernameHelper.isUsernameReserved || usernameHelper.isReservedUsername)(normalized);
  const isReserved = isReservedRes?.isReserved === true || isReservedRes === true ||
    (usernameHelper.SYSTEM_RESERVED_USERNAMES && usernameHelper.SYSTEM_RESERVED_USERNAMES.includes(normalized));
  if (isReserved) {
    throw new Error(`Username @${normalized} is reserved by the platform.`);
  }

  const database = db.get();
  const existing = await database.collection(collection.STUDENTS_COLLECTION).findOne({
    username: normalized,
    _id: { $ne: new ObjectId(userId) }
  });
  if (existing) {
    throw new Error(`Username @${normalized} is already claimed by another user.`);
  }

  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) {
    throw new Error('User not found.');
  }

  const previousUsername = user.username || '';
  if (previousUsername.toLowerCase() === normalized) {
    return { success: true, message: `Username is already @${normalized}`, username: normalized };
  }

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        username: normalized,
        usernameClaimed: true,
        usernameChangedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).updateOne(
    { userId: new ObjectId(userId) },
    { $set: { username: normalized, updatedAt: new Date() } }
  ).catch(() => {});

  await auditHelper.logAction({
    req,
    action: 'USERNAME_CHANGED_BY_ADMIN',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || 'User',
    status: 'success',
    message: `Admin changed username from @${previousUsername || 'none'} to @${normalized}. Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      targetUserId: String(userId),
      previousUsername,
      newUsername: normalized,
      reason: cleanReason
    }
  });

  return { success: true, previousUsername, newUsername: normalized, reason: cleanReason };
};

const getUserGovernanceDossier = async (userId, actor, req = null) => {
  if (!isValidObjectId(userId)) return null;

  const database = db.get();
  const objId = new ObjectId(userId);
  const idStr = String(userId);

  let rawUser = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: objId });
  let userType = 'user';

  if (!rawUser) {
    rawUser = await database.collection(collection.TEACHER_COLLECTION).findOne({ _id: objId });
    if (rawUser) userType = 'teacher';
  }

  if (!rawUser) {
    rawUser = await database.collection(collection.ADMIN_COLLECTION).findOne({ _id: objId });
    if (rawUser) userType = 'admin';
  }

  if (!rawUser) return null;

  const user = sanitizeUserForAdmin(rawUser);

  const communityProfile = await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).findOne({
    $or: [{ userId: objId }, { userId: idStr }]
  }) || {};

  const verifRequests = await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).find({
    $or: [{ userId: objId }, { userId: idStr }]
  }).sort({ createdAt: -1 }).toArray().catch(() => []);

  const canViewEvidence = permissionsHelper.hasCapability(actor, 'view_verification_evidence');

  const verificationCategories = ['IDENTITY', 'PROFESSIONAL', 'BUSINESS_AFFILIATION', 'CERTIFICATION', 'EDUCATOR'];
  const verificationBreakdown = verificationCategories.map(cat => {
    const reqs = verifRequests.filter(r => r.category === cat);
    const latest = reqs[0] || null;
    let safeReq = null;
    if (latest) {
      safeReq = {
        _id: latest._id,
        category: latest.category,
        status: latest.status || 'UNVERIFIED',
        createdAt: latest.createdAt,
        reviewedAt: latest.reviewedAt,
        notes: latest.notes,
        evidenceRedacted: !canViewEvidence,
        evidenceUrl: canViewEvidence ? latest.evidenceUrl : null,
        idNumber: canViewEvidence ? latest.idNumber : (latest.idNumber ? `${latest.idNumber.slice(0, 2)}******${latest.idNumber.slice(-2)}` : null)
      };
    }
    return {
      category: cat,
      label: cat.replace(/_/g, ' '),
      status: latest ? (latest.status || 'UNVERIFIED') : (cat === 'IDENTITY' && user.account_Status?.isVerified ? 'VERIFIED' : 'UNVERIFIED'),
      latestRequest: safeReq,
      isVerified: latest ? latest.status === 'VERIFIED' : (cat === 'IDENTITY' && Boolean(user.account_Status?.isVerified))
    };
  });

  const memberships = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).find({
    $or: [{ userId: objId }, { userId: idStr }]
  }).toArray().catch(() => []);

  const orgIds = memberships.map(m => m.organizationId).filter(id => id && ObjectId.isValid(id)).map(id => new ObjectId(id));
  const orgs = orgIds.length ? await database.collection(collection.ORGANIZATIONS_COLLECTION).find({ _id: { $in: orgIds } }).toArray().catch(() => []) : [];
  const orgMap = {};
  orgs.forEach(o => { orgMap[String(o._id)] = o; });

  const businessAffiliations = memberships.map(m => {
    const org = orgMap[String(m.organizationId)] || {};
    return {
      membershipId: m._id,
      organizationId: m.organizationId,
      organizationName: org.name || 'Organization',
      organizationLogo: org.logo || '/img/placeholders/business.svg',
      membershipRole: m.role || 'Member',
      isVerified: org.status === 'APPROVED' || m.verified === true,
      joinedAt: m.createdAt || m.joinedAt
    };
  });

  const sessions = await getUserSessions(userId, actor, req);

  const connectionsCount = await database.collection(collection.NETWORK_CONNECTIONS_COLLECTION).countDocuments({
    $or: [
      { requesterId: objId, status: 'accepted' },
      { recipientId: objId, status: 'accepted' },
      { userLow: objId, status: 'accepted' },
      { userHigh: objId, status: 'accepted' }
    ]
  }).catch(() => 0);

  const reportsAgainstCount = await database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({
    $or: [{ targetId: idStr }, { targetId: objId }]
  }).catch(() => 0);

  const recentAuditLogs = await database.collection(collection.AUDIT_LOG_COLLECTION).find({
    $or: [
      { entityId: idStr },
      { 'metadata.targetUserId': idStr }
    ]
  }).sort({ timestamp: -1 }).limit(10).toArray().catch(() => []);

  const skills = communityProfile.skills || [];
  const software = communityProfile.software || [];
  const experience = communityProfile.experience || [];
  const education = communityProfile.education || [];
  const certifications = communityProfile.certifications || [];
  const projects = communityProfile.projects || [];

  const isBlocked = Boolean(user.account_Status?.isBlocked);
  const isSuspended = isBlocked;
  const isRestricted = Boolean(user.account_Status?.restrictions && user.account_Status.restrictions.length);
  const accountState = isSuspended ? 'suspended' : (isRestricted ? 'restricted' : (user.account_Status?.isActive === false ? 'inactive' : 'active'));

  return {
    user,
    userType,
    displayName: user.Name || user.name || 'User',
    username: user.username || (user.email ? user.email.split('@')[0] : 'user'),
    primaryRole: String(user.primaryRole || user.role || 'STUDENT').toUpperCase(),
    discipline: communityProfile.discipline || user.discipline || null,
    infrastructureSector: communityProfile.infrastructureSector || user.infrastructureSector || null,
    specialization: communityProfile.specialization || null,
    headline: communityProfile.headline || null,
    bio: communityProfile.bio || null,
    skills,
    software,
    experience,
    education,
    certifications,
    projects,
    verificationBreakdown,
    businessAffiliations,
    sessions,
    connectionsCount,
    reportsAgainstCount,
    recentAuditLogs,
    accountState,
    isSuspended,
    isRestricted,
    canViewEvidence,
    canAssignEducator: permissionsHelper.hasCapability(actor, 'assign_educator'),
    canManageAccountStatus: permissionsHelper.hasCapability(actor, 'manage_account_status'),
    canManageSessions: permissionsHelper.hasCapability(actor, 'manage_user_sessions'),
    canManageUsernames: permissionsHelper.hasCapability(actor, 'manage_usernames'),
    isSelf: Boolean(actor?._id && String(actor._id) === idStr)
  };
};

const updateUserVerification = async (userId, { status, notes = '' }, actor, req) => {
  if (!ObjectId.isValid(userId)) {
    throw new Error('Invalid user ID.');
  }

  const validStatuses = ['UNVERIFIED', 'PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'];
  const normalizedStatus = String(status || '').toUpperCase();
  if (!validStatuses.includes(normalizedStatus)) {
    throw new Error(`Invalid verification status: ${status}. Must be one of: ${validStatuses.join(', ')}.`);
  }

  const database = db.get();
  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) {
    throw new Error('User not found.');
  }

  const isVerified = normalizedStatus === 'VERIFIED';
  const previousStatus = user.verificationStatus || (user.isVerified ? 'VERIFIED' : 'UNVERIFIED');

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        verificationStatus: normalizedStatus,
        isVerified,
        'account_Status.isVerified': isVerified,
        verificationNotes: notes,
        verifiedBy: actor?._id ? new ObjectId(actor._id) : null,
        verifiedAt: isVerified ? new Date() : null,
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'USER_VERIFICATION_UPDATED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.username || 'User',
    status: 'success',
    message: `User verification updated to ${normalizedStatus}`,
    metadata: {
      previousStatus,
      newStatus: normalizedStatus,
      isVerified,
      notes,
      reviewedBy: actor?.Name || actor?.name || actor?.Email || 'Admin'
    }
  });

  return { success: true, verificationStatus: normalizedStatus, isVerified };
};

// ─────────────────────────────────────────────────────────
// 2. BUSINESS GOVERNANCE & REVIEW CENTER
// ─────────────────────────────────────────────────────────

const getBusinesses = async (filters = {}) => {
  const database = db.get();
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 15), 100);
  const skip = (page - 1) * limit;

  const tab = (filters.tab || 'all').toLowerCase();
  const search = (filters.search || '').trim();

  const query = {};

  if (tab === 'pending') {
    query.status = { $in: ['PENDING', 'pending', 'PENDING_REVIEW'] };
  } else if (tab === 'approved') {
    query.status = { $in: ['APPROVED', 'approved'] };
  } else if (tab === 'rejected') {
    query.status = { $in: ['REJECTED', 'rejected'] };
  } else if (tab === 'suspended') {
    query.status = { $in: ['SUSPENDED', 'suspended'] };
  }

  if (filters.verification && filters.verification !== 'all') {
    query.verificationStatus = new RegExp(`^${escapeRegex(filters.verification)}$`, 'i');
  }

  if (filters.industry && filters.industry !== 'all') {
    query.industry = new RegExp(`^${escapeRegex(filters.industry)}$`, 'i');
  }

  if (filters.sector && filters.sector !== 'all') {
    query.infrastructureSpecializations = filters.sector;
  }

  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');

    // Find users matching search by name, username, or email to allow owner/member search
    const matchingUsers = await database.collection(collection.STUDENTS_COLLECTION)
      .find({
        $or: [
          { name: sRegex },
          { Name: sRegex },
          { username: sRegex },
          { email: sRegex },
          { Email: sRegex }
        ]
      }, { projection: { _id: 1 } })
      .limit(50)
      .toArray()
      .catch(() => []);

    const matchedUserIds = matchingUsers.map(u => u._id);
    const matchedUserIdStrings = matchingUsers.map(u => String(u._id));

    // Find organizations where matching users are members
    let matchedOrgIds = [];
    if (matchedUserIds.length) {
      const matchingMemberships = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION)
        .find({
          userId: { $in: [...matchedUserIds, ...matchedUserIdStrings] }
        }, { projection: { organizationId: 1 } })
        .limit(100)
        .toArray()
        .catch(() => []);

      matchedOrgIds = matchingMemberships
        .map(m => m.organizationId)
        .filter(isValidObjectId)
        .map(id => new ObjectId(id));
    }

    const orConditions = [
      { name: sRegex },
      { slug: sRegex },
      { industry: sRegex },
      { location: sRegex },
      { businessEmail: sRegex }
    ];

    if (matchedUserIds.length) {
      orConditions.push({ createdBy: { $in: [...matchedUserIds, ...matchedUserIdStrings] } });
    }
    if (matchedOrgIds.length) {
      orConditions.push({ _id: { $in: matchedOrgIds } });
    }

    query.$or = orConditions;
  }

  const [total, records, stats] = await Promise.all([
    database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments(query),
    database.collection(collection.ORGANIZATIONS_COLLECTION)
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    getBusinessStats()
  ]);

  // Gather owner IDs
  const ownerIds = records.map(b => b.createdBy).filter(isValidObjectId).map(id => new ObjectId(id));
  const owners = ownerIds.length ? await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: ownerIds } }, { projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1, role: 1 } })
    .toArray() : [];

  const ownerMap = new Map(owners.map(o => [String(o._id), o]));

  // Batch query membership counts, open jobs counts, and active reports counts
  const recordIds = records.map(r => r._id);
  const [membershipCounts, openJobCounts, reportCounts] = await Promise.all([
    database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).aggregate([
      { $match: { organizationId: { $in: recordIds } } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } }
    ]).toArray().catch(() => []),

    database.collection(collection.OPPORTUNITIES_COLLECTION).aggregate([
      { $match: { organizationId: { $in: recordIds }, status: { $in: ['PUBLISHED', 'published'] } } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } }
    ]).toArray().catch(() => []),

    database.collection(collection.MODERATION_REPORTS_COLLECTION).aggregate([
      {
        $match: {
          targetType: { $in: ['BUSINESS', 'ORGANIZATION'] },
          status: { $in: ['OPEN', 'PENDING', 'pending', 'open', 'UNDER_REVIEW', 'under_review'] }
        }
      },
      { $group: { _id: '$targetId', count: { $sum: 1 } } }
    ]).toArray().catch(() => [])
  ]);

  const memberMap = new Map(membershipCounts.map(m => [String(m._id), m.count]));
  const jobMap = new Map(openJobCounts.map(j => [String(j._id), j.count]));
  const reportMap = new Map(reportCounts.map(r => [String(r._id), r.count]));

  const enrichedRecords = records.map(b => {
    const owner = ownerMap.get(String(b.createdBy)) || null;
    const bIdStr = String(b._id);
    return {
      ...b,
      ownerName: owner ? (owner.name || owner.Name || owner.username) : 'Platform User',
      ownerEmail: owner ? (owner.email || owner.Email) : '',
      ownerRole: owner ? (owner.primaryRole || owner.role || 'Recruiter') : 'Member',
      membersCount: memberMap.get(bIdStr) || 0,
      openJobsCount: jobMap.get(bIdStr) || 0,
      reportsCount: reportMap.get(bIdStr) || 0,
      statusNormalized: String(b.status || 'PENDING').toUpperCase(),
      verificationStatusNormalized: String(b.verificationStatus || 'UNVERIFIED').toUpperCase()
    };
  });

  return {
    records: enrichedRecords,
    total,
    page,
    totalPages: Math.ceil(total / limit) || 1,
    stats,
    tab
  };
};

const getBusinessStats = async () => {
  const database = db.get();
  try {
    const [total, pending, approved, rejected, suspended] = await Promise.all([
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({}),
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['PENDING', 'pending', 'PENDING_REVIEW'] } }),
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['APPROVED', 'approved'] } }),
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['REJECTED', 'rejected'] } }),
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['SUSPENDED', 'suspended'] } })
    ]);
    return { total, pending, approved, rejected, suspended };
  } catch (e) {
    return { total: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 };
  }
};

const getBusinessById = async (id, admin = null) => {
  if (!isValidObjectId(id)) return null;
  const database = db.get();
  const objId = new ObjectId(id);

  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: objId });
  if (!business) return null;

  // 1. Fetch Owner details
  let owner = null;
  if (business.createdBy && isValidObjectId(business.createdBy)) {
    owner = await database.collection(collection.STUDENTS_COLLECTION).findOne(
      { _id: new ObjectId(business.createdBy) },
      { projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1, role: 1, Phone_Number: 1, createdAt: 1, account_Status: 1 } }
    );
  }

  // 2. Fetch all Members from ORGANIZATION_MEMBERSHIPS_COLLECTION
  const memberships = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).find({
    $or: [{ organizationId: objId }, { organizationId: String(id) }]
  }).toArray().catch(() => []);

  const memberUserIds = memberships.map(m => m.userId).filter(isValidObjectId).map(uid => new ObjectId(uid));
  const memberUsers = memberUserIds.length ? await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: memberUserIds } }, {
      projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1, role: 1, account_Status: 1, avatar: 1 }
    })
    .toArray() : [];

  const memberUserMap = new Map(memberUsers.map(u => [String(u._id), u]));

  const allMembers = memberships.map(m => {
    const u = memberUserMap.get(String(m.userId)) || null;
    return {
      membershipId: m._id,
      userId: m.userId,
      role: (m.role || 'member').toLowerCase(),
      roleDisplay: (m.role || 'Member').toUpperCase(),
      verified: Boolean(m.verified),
      joinedAt: m.joinedAt || m.createdAt || new Date(),
      status: m.status || 'ACTIVE',
      user: u ? {
        _id: u._id,
        name: u.name || u.Name || u.username || 'User',
        username: u.username || 'user',
        email: u.email || u.Email || '',
        primaryRole: u.primaryRole || u.role || 'Member',
        accountStatus: u.account_Status?.status || 'active'
      } : { _id: m.userId, name: 'Unknown Member', username: 'member', email: '', primaryRole: 'Member', accountStatus: 'unknown' }
    };
  });

  const founders = allMembers.filter(m => ['founder', 'owner'].includes(m.role));
  const recruiters = allMembers.filter(m => m.role === 'recruiter');

  // 3. Verification requests & evidence redaction
  const canViewEvidence = permissionsHelper.hasCapability(admin, 'view_verification_evidence');
  const rawVerificationRequests = await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).find({
    $or: [
      { targetId: String(id) },
      { targetId: objId },
      { targetName: business.name }
    ]
  }).sort({ submittedAt: -1, createdAt: -1 }).toArray().catch(() => []);

  const verificationRequests = rawVerificationRequests.map(vr => {
    const redacted = verificationHelper.redactEvidence(vr, canViewEvidence);
    return {
      ...redacted,
      canViewEvidence,
      statusNormalized: String(redacted.status || 'PENDING').toUpperCase()
    };
  });

  // 4. Jobs segmented by status
  const allJobs = await database.collection(collection.OPPORTUNITIES_COLLECTION).find({
    $or: [{ organizationId: objId }, { organizationId: String(id) }]
  }).sort({ createdAt: -1 }).toArray().catch(() => []);

  const activeJobs = allJobs.filter(j => ['PUBLISHED', 'published'].includes(j.status));
  const draftJobs = allJobs.filter(j => ['DRAFT', 'draft'].includes(j.status));
  const pendingJobs = allJobs.filter(j => ['PENDING_REVIEW', 'pending_review'].includes(j.status));
  const closedJobs = allJobs.filter(j => ['CLOSED', 'closed', 'ARCHIVED', 'archived'].includes(j.status));
  const suspendedJobs = allJobs.filter(j => ['SUSPENDED', 'suspended'].includes(j.status));

  // 5. Compliance & Moderation reports
  const moderationReports = await database.collection(collection.MODERATION_REPORTS_COLLECTION).find({
    targetType: { $in: ['BUSINESS', 'ORGANIZATION', 'business', 'organization'] },
    $or: [{ targetId: String(id) }, { targetId: objId }]
  }).sort({ createdAt: -1 }).toArray().catch(() => []);

  // 6. Recent Audit History
  const auditLogs = await database.collection(collection.AUDIT_LOG_COLLECTION)
    .find({ entityType: 'BUSINESS', entityId: String(id) })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  // 7. Fraud and integrity signals
  const integritySignals = await calculateBusinessIntegritySignals(business);

  return {
    business: {
      ...business,
      statusNormalized: String(business.status || 'PENDING').toUpperCase(),
      verificationStatusNormalized: String(business.verificationStatus || 'UNVERIFIED').toUpperCase()
    },
    owner,
    founders,
    recruiters,
    members: allMembers,
    verificationRequests,
    verification: verificationRequests[0] || null,
    canViewEvidence,
    jobs: {
      active: activeJobs,
      draft: draftJobs,
      pending: pendingJobs,
      closed: closedJobs,
      suspended: suspendedJobs,
      total: allJobs.length
    },
    jobsCount: allJobs.length,
    moderationReports,
    auditLogs,
    integritySignals
  };
};

const calculateBusinessIntegritySignals = async (business) => {
  const database = db.get();
  const signals = [];

  try {
    // 1. Check duplicate business names
    const duplicateCount = await database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({
      name: new RegExp(`^${escapeRegex(business.name.trim())}$`, 'i'),
      _id: { $ne: business._id }
    });
    if (duplicateCount > 0) {
      signals.push({
        severity: 'warning',
        type: 'DUPLICATE_NAME',
        message: `Identical business name matches ${duplicateCount} other organization profile(s).`
      });
    }

    // 2. Check if owner has multiple businesses
    if (business.createdBy) {
      const ownerOrgsCount = await database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({
        createdBy: business.createdBy,
        _id: { $ne: business._id }
      });
      if (ownerOrgsCount >= 3) {
        signals.push({
          severity: 'info',
          type: 'MULTIPLE_ACCOUNTS',
          message: `Owner manages ${ownerOrgsCount} other business entity profiles.`
        });
      }
    }

    // 3. Repeated rejections
    if (business.rejectionHistory && business.rejectionHistory.length > 1) {
      signals.push({
        severity: 'warning',
        type: 'REPEATED_REJECTIONS',
        message: `Business was previously rejected ${business.rejectionHistory.length} times.`
      });
    }

    // 4. Missing critical profile fields
    if (!business.website && !business.businessEmail) {
      signals.push({
        severity: 'info',
        type: 'INCOMPLETE_DATA',
        message: 'No official corporate website or business email provided.'
      });
    }
  } catch (err) {
    logger.warn('Integrity check warning:', err.message);
  }

  return signals;
};

const approveBusiness = async (id, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid business ID.');
  const database = db.get();
  const objId = new ObjectId(id);

  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: objId });
  if (!business) throw new Error('Business not found.');

  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'APPROVED',
        verificationStatus: 'VERIFIED',
        reviewedBy: actor?._id ? new ObjectId(actor._id) : null,
        reviewedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'BUSINESS_APPROVED',
    entityType: 'BUSINESS',
    entityId: String(id),
    entityName: business.name,
    status: 'success',
    message: `Business approved by administrator`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      businessId: String(id),
      businessName: business.name,
      previousStatus: business.status,
      newStatus: 'APPROVED'
    }
  });

  return { success: true, status: 'APPROVED' };
};

const rejectBusiness = async (id, reason, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid business ID.');
  if (!reason || !reason.trim()) throw new Error('Rejection reason is mandatory.');

  const database = db.get();
  const objId = new ObjectId(id);
  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: objId });
  if (!business) throw new Error('Business not found.');

  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'REJECTED',
        verificationStatus: 'REJECTED',
        rejectionReason: reason.trim(),
        reviewedBy: actor?._id ? new ObjectId(actor._id) : null,
        reviewedAt: new Date(),
        updatedAt: new Date()
      },
      $push: {
        rejectionHistory: {
          reason: reason.trim(),
          rejectedBy: actor?.Name || actor?.name || actor?.Email || 'Admin',
          rejectedAt: new Date()
        }
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'BUSINESS_REJECTED',
    entityType: 'BUSINESS',
    entityId: String(id),
    entityName: business.name,
    status: 'success',
    message: `Business rejected by administrator. Reason: ${reason.trim()}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      businessId: String(id),
      businessName: business.name,
      reason: reason.trim(),
      previousStatus: business.status,
      newStatus: 'REJECTED'
    }
  });

  return { success: true, status: 'REJECTED' };
};

const suspendBusiness = async (id, reason, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid business ID.');
  if (!reason || !reason.trim()) throw new Error('Suspension reason is mandatory.');

  const database = db.get();
  const objId = new ObjectId(id);
  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: objId });
  if (!business) throw new Error('Business not found.');

  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'SUSPENDED',
        verificationStatus: 'REVOKED',
        suspensionReason: reason.trim(),
        reviewedBy: actor?._id ? new ObjectId(actor._id) : null,
        reviewedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  // Unpublish active jobs belonging to suspended business
  const updateJobsResult = await database.collection(collection.OPPORTUNITIES_COLLECTION).updateMany(
    {
      $or: [{ organizationId: objId }, { organizationId: String(id) }],
      status: { $in: ['PUBLISHED', 'published'] }
    },
    { $set: { status: 'PAUSED', pausedReason: 'Business suspended by administration', updatedAt: new Date() } }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'BUSINESS_SUSPENDED',
    entityType: 'BUSINESS',
    entityId: String(id),
    entityName: business.name,
    status: 'success',
    message: `Business suspended by administrator. Reason: ${reason.trim()}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      businessId: String(id),
      businessName: business.name,
      reason: reason.trim(),
      previousStatus: business.status,
      newStatus: 'SUSPENDED',
      pausedJobsCount: updateJobsResult.modifiedCount || 0
    }
  });

  return { success: true, status: 'SUSPENDED', pausedJobsCount: updateJobsResult.modifiedCount || 0 };
};

const restoreBusiness = async (id, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid business ID.');
  const database = db.get();
  const objId = new ObjectId(id);

  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: objId });
  if (!business) throw new Error('Business not found.');

  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'APPROVED',
        verificationStatus: 'VERIFIED',
        suspensionReason: null,
        rejectionReason: null,
        reviewedBy: actor?._id ? new ObjectId(actor._id) : null,
        reviewedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  // Restore paused jobs belonging to this business that were paused due to suspension
  const restoreJobsResult = await database.collection(collection.OPPORTUNITIES_COLLECTION).updateMany(
    {
      $or: [{ organizationId: objId }, { organizationId: String(id) }],
      status: 'PAUSED',
      pausedReason: 'Business suspended by administration'
    },
    { $set: { status: 'PUBLISHED', pausedReason: null, updatedAt: new Date() } }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'BUSINESS_RESTORED',
    entityType: 'BUSINESS',
    entityId: String(id),
    entityName: business.name,
    status: 'success',
    message: `Business restored by administrator`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      businessId: String(id),
      businessName: business.name,
      previousStatus: business.status,
      newStatus: 'APPROVED',
      restoredJobsCount: restoreJobsResult.modifiedCount || 0
    }
  });

  return { success: true, status: 'APPROVED', restoredJobsCount: restoreJobsResult.modifiedCount || 0 };
};

const transferBusinessOwnership = async (businessId, newOwnerId, reason, actor, req) => {
  if (!isValidObjectId(businessId)) throw new Error('Invalid business ID.');
  if (!isValidObjectId(newOwnerId)) throw new Error('Invalid new owner user ID.');
  if (!reason || !reason.trim()) throw new Error('Reason for ownership transfer is mandatory.');

  const database = db.get();
  const bObjId = new ObjectId(businessId);
  const uObjId = new ObjectId(newOwnerId);

  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: bObjId });
  if (!business) throw new Error('Business not found.');

  const newOwner = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: uObjId });
  if (!newOwner) throw new Error('Designated new owner account not found.');

  if (String(business.createdBy) === String(newOwnerId)) {
    throw new Error('User is already the registered primary owner of this business.');
  }

  const previousOwnerId = String(business.createdBy || '');

  // 1. Update primary ownership on organization document
  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: bObjId },
    { $set: { createdBy: uObjId, updatedAt: new Date() } }
  );

  // 2. Ensure new owner has membership with 'owner' role
  await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).updateOne(
    { organizationId: bObjId, userId: uObjId },
    {
      $set: { role: 'owner', verified: true, updatedAt: new Date() },
      $setOnInsert: { joinedAt: new Date(), status: 'ACTIVE' }
    },
    { upsert: true }
  );

  // 3. Downgrade previous owner's membership to 'admin'
  if (previousOwnerId && isValidObjectId(previousOwnerId)) {
    await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).updateOne(
      { organizationId: bObjId, userId: new ObjectId(previousOwnerId) },
      { $set: { role: 'admin', updatedAt: new Date() } }
    );
  }

  await auditHelper.logAction({
    actor,
    req,
    action: 'BUSINESS_OWNERSHIP_TRANSFERRED',
    entityType: 'BUSINESS',
    entityId: String(businessId),
    entityName: business.name,
    status: 'success',
    message: `Business ownership transferred by administrator. Reason: ${reason.trim()}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      businessId: String(businessId),
      businessName: business.name,
      previousOwnerId,
      newOwnerId: String(newOwnerId),
      newOwnerName: newOwner.name || newOwner.Name || newOwner.username,
      reason: reason.trim()
    }
  });

  return { success: true, message: 'Ownership transferred successfully.', previousOwner: previousOwnerId, newOwner: String(newOwnerId) };
};

const updateBusinessMemberRole = async (businessId, memberId, newRole, reason, actor, req) => {
  if (!isValidObjectId(businessId)) throw new Error('Invalid business ID.');
  if (!isValidObjectId(memberId)) throw new Error('Invalid member ID.');

  const allowedRoles = ['owner', 'admin', 'recruiter', 'member'];
  const targetRole = String(newRole || '').toLowerCase().trim();
  if (!allowedRoles.includes(targetRole)) {
    throw new Error(`Invalid role. Must be one of: ${allowedRoles.join(', ')}.`);
  }

  const database = db.get();
  const bObjId = new ObjectId(businessId);
  const mObjId = new ObjectId(memberId);

  const membership = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).findOne({
    _id: mObjId,
    $or: [{ organizationId: bObjId }, { organizationId: String(businessId) }]
  });

  if (!membership) throw new Error('Organization membership not found.');

  // If changing to 'owner', delegate to transferBusinessOwnership
  if (targetRole === 'owner') {
    if (!permissionsHelper.hasCapability(actor, 'transfer_business_ownership')) {
      throw new Error('Permission denied: transfer_business_ownership capability required to designate new owner.');
    }
    return await transferBusinessOwnership(businessId, membership.userId, reason || 'Designated owner via membership governance', actor, req);
  }

  const previousRole = membership.role || 'member';

  await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).updateOne(
    { _id: mObjId },
    { $set: { role: targetRole, updatedAt: new Date() } }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'MEMBER_ROLE_CHANGED',
    entityType: 'BUSINESS',
    entityId: String(businessId),
    entityName: `Member #${memberId}`,
    status: 'success',
    message: `Member role changed from ${previousRole} to ${targetRole}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      businessId: String(businessId),
      memberId: String(memberId),
      userId: String(membership.userId),
      previousRole,
      newRole: targetRole,
      reason: (reason || '').trim()
    }
  });

  return { success: true, newRole: targetRole, message: `Member role successfully updated to ${targetRole}.` };
};

// ─────────────────────────────────────────────────────────
// 3. JOB GOVERNANCE & MODERATION
// ─────────────────────────────────────────────────────────

const getJobs = async (filters = {}) => {
  const database = db.get();
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 15), 100);
  const skip = (page - 1) * limit;

  const tab = (filters.tab || 'all').toLowerCase();
  const search = (filters.search || '').trim();

  const query = {};

  if (tab === 'published') {
    query.status = { $in: ['PUBLISHED', 'published'] };
  } else if (tab === 'draft') {
    query.status = { $in: ['DRAFT', 'draft'] };
  } else if (tab === 'pending' || tab === 'pending_review') {
    query.status = { $in: ['PENDING_REVIEW', 'pending_review', 'PENDING', 'pending'] };
  } else if (tab === 'closed') {
    query.status = { $in: ['CLOSED', 'closed', 'ARCHIVED', 'archived'] };
  } else if (tab === 'suspended') {
    query.status = { $in: ['SUSPENDED', 'suspended'] };
  } else if (tab === 'flagged') {
    query.$or = [
      { moderationStatus: 'FLAGGED' },
      { isFlagged: true }
    ];
  } else if (tab === 'reported') {
    // Check jobs with active reports
    const reportTargetIds = await database.collection(collection.MODERATION_REPORTS_COLLECTION)
      .distinct('targetId', {
        targetType: { $in: ['OPPORTUNITY', 'JOB', 'opportunity', 'job'] },
        status: { $in: ['PENDING', 'pending', 'open', 'OPEN', 'UNDER_REVIEW', 'under_review'] }
      });
    const objectIds = reportTargetIds.filter(isValidObjectId).map(id => new ObjectId(id));
    query._id = { $in: objectIds };
  }

  if (filters.discipline && filters.discipline !== 'all') {
    query.discipline = filters.discipline;
  }
  if (filters.sector && filters.sector !== 'all') {
    query.infrastructureSector = filters.sector;
  }
  if (filters.businessId && isValidObjectId(filters.businessId)) {
    query.organizationId = new ObjectId(filters.businessId);
  }

  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');

    // Search for matching organizations by name or slug
    const matchingOrgs = await database.collection(collection.ORGANIZATIONS_COLLECTION)
      .find({
        $or: [{ name: sRegex }, { slug: sRegex }]
      }, { projection: { _id: 1 } })
      .limit(50)
      .toArray()
      .catch(() => []);

    const matchedOrgIds = matchingOrgs.map(o => o._id);

    const orConditions = [
      { title: sRegex },
      { discipline: sRegex },
      { infrastructureSector: sRegex },
      { location: sRegex }
    ];

    if (matchedOrgIds.length) {
      orConditions.push({ organizationId: { $in: matchedOrgIds } });
    }

    query.$or = orConditions;
  }

  const [total, records, stats] = await Promise.all([
    database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments(query),
    database.collection(collection.OPPORTUNITIES_COLLECTION)
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    getJobStats()
  ]);

  // Populate organization details
  const orgIds = records.map(j => j.organizationId).filter(isValidObjectId).map(id => new ObjectId(id));
  const orgs = orgIds.length ? await database.collection(collection.ORGANIZATIONS_COLLECTION)
    .find({ _id: { $in: orgIds } }, { projection: { _id: 1, name: 1, logo: 1, status: 1, verificationStatus: 1 } })
    .toArray() : [];

  const orgMap = new Map(orgs.map(o => [String(o._id), o]));

  // Populate creator details
  const creatorIds = records.map(j => j.createdBy).filter(isValidObjectId).map(id => new ObjectId(id));
  const creators = creatorIds.length ? await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: creatorIds } }, { projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1 } })
    .toArray() : [];

  const creatorMap = new Map(creators.map(c => [String(c._id), c]));

  const enrichedRecords = records.map(j => {
    const org = orgMap.get(String(j.organizationId)) || null;
    const creator = creatorMap.get(String(j.createdBy)) || null;
    return {
      ...j,
      businessName: org ? org.name : 'Unknown Business',
      businessStatus: org ? org.status : 'UNKNOWN',
      businessVerified: org ? org.verificationStatus === 'VERIFIED' : false,
      businessLogo: org ? org.logo : null,
      creatorName: creator ? (creator.name || creator.Name || creator.username) : 'Employer',
      creatorEmail: creator ? (creator.email || creator.Email) : '',
      statusNormalized: String(j.status || 'PUBLISHED').toUpperCase()
    };
  });

  return {
    records: enrichedRecords,
    total,
    page,
    totalPages: Math.ceil(total / limit) || 1,
    stats,
    tab
  };
};

const getJobStats = async () => {
  const database = db.get();
  try {
    const [total, published, draft, pending, closed, suspended, flagged] = await Promise.all([
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({}),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['PUBLISHED', 'published'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['DRAFT', 'draft'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['PENDING_REVIEW', 'pending_review', 'PENDING', 'pending'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['CLOSED', 'closed', 'ARCHIVED', 'archived'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['SUSPENDED', 'suspended'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ $or: [{ moderationStatus: 'FLAGGED' }, { isFlagged: true }] })
    ]);
    return { total, published, draft, pending, closed, suspended, flagged };
  } catch (e) {
    return { total: 0, published: 0, draft: 0, pending: 0, closed: 0, suspended: 0, flagged: 0 };
  }
};

const getJobById = async (id) => {
  if (!isValidObjectId(id)) return null;
  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) return null;

  // 1. Fetch business info
  let business = null;
  if (job.organizationId && isValidObjectId(job.organizationId)) {
    business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(job.organizationId) });
  }

  // 2. Fetch creator info
  let creator = null;
  if (job.createdBy && isValidObjectId(job.createdBy)) {
    creator = await database.collection(collection.STUDENTS_COLLECTION).findOne(
      { _id: new ObjectId(job.createdBy) },
      { projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1, role: 1 } }
    );
  }

  // 3. Check creator recruiter authority in parent business
  let creatorMembership = null;
  if (job.createdBy && job.organizationId && isValidObjectId(job.createdBy) && isValidObjectId(job.organizationId)) {
    creatorMembership = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).findOne({
      organizationId: new ObjectId(job.organizationId),
      userId: new ObjectId(job.createdBy)
    });
  }

  // 4. Aggregate application data (Privacy preserving: aggregate metrics only)
  const applicationStats = await getJobApplicationsAggregate(id);

  // 5. Match metrics from JOB_TALENT_MATCHES_COLLECTION
  const matchesCount = await database.collection(collection.JOB_TALENT_MATCHES_COLLECTION).countDocuments({
    $or: [{ jobId: objId }, { jobId: String(id) }]
  });

  // 6. Moderation reports against this job
  const moderationReports = await database.collection(collection.MODERATION_REPORTS_COLLECTION).find({
    targetType: { $in: ['JOB', 'OPPORTUNITY', 'job', 'opportunity'] },
    $or: [{ targetId: String(id) }, { targetId: objId }]
  }).sort({ createdAt: -1 }).toArray().catch(() => []);

  // 7. Audit history for this job
  const auditLogs = await database.collection(collection.AUDIT_LOG_COLLECTION).find({
    entityType: 'JOB',
    entityId: String(id)
  }).sort({ createdAt: -1 }).limit(15).toArray().catch(() => []);

  // 8. Quality & Moderation audit signals
  const isEmployerApproved = business ? (business.status === 'APPROVED' || business.status === 'approved') : false;
  const isEmployerVerified = business ? (business.verificationStatus === 'VERIFIED') : false;
  const isCreatorAuthorized = Boolean(creatorMembership && ['owner', 'admin', 'recruiter'].includes(creatorMembership.role));

  const moderationSignals = {
    missingDescription: !job.description || job.description.length < 50,
    noSkillsListed: (!job.requiredSkills || job.requiredSkills.length === 0) && (!job.skills || job.skills.length === 0),
    noSoftwareListed: !job.requiredSoftware || job.requiredSoftware.length === 0,
    isBusinessUnverified: !isEmployerApproved || !isEmployerVerified,
    isCreatorAuthorized,
    isFlagged: job.moderationStatus === 'FLAGGED' || job.isFlagged === true,
    isSuspended: job.status === 'SUSPENDED'
  };

  return {
    job: {
      ...job,
      statusNormalized: String(job.status || 'PUBLISHED').toUpperCase()
    },
    business,
    creator,
    creatorMembership,
    applicationStats,
    matchesCount,
    moderationReports,
    auditLogs,
    moderationSignals
  };
};

const getJobApplicationsAggregate = async (jobId) => {
  if (!isValidObjectId(jobId)) return { total: 0, statuses: {}, withdrawals: 0 };
  const database = db.get();
  const objId = new ObjectId(jobId);

  try {
    const aggr = await database.collection(collection.JOB_APPLICATIONS_COLLECTION).aggregate([
      { $match: { $or: [{ jobId: objId }, { jobId: String(jobId) }] } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray();

    let total = 0;
    const statuses = {};
    aggr.forEach(item => {
      const s = item._id || 'submitted';
      statuses[s] = item.count;
      total += item.count;
    });

    const withdrawals = await database.collection(collection.JOB_APPLICATIONS_COLLECTION).countDocuments({
      $or: [{ jobId: objId }, { jobId: String(jobId) }],
      isWithdrawn: true
    });

    return {
      total,
      statuses,
      withdrawals
    };
  } catch (err) {
    return { total: 0, statuses: {}, withdrawals: 0 };
  }
};

const approveJob = async (id, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid job ID.');
  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) throw new Error('Job not found.');

  // Validate parent organization status
  if (job.organizationId && isValidObjectId(job.organizationId)) {
    const org = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(job.organizationId) });
    if (!org || org.status !== 'APPROVED') {
      if (org && org.status === 'SUSPENDED') {
        throw new Error('Cannot publish job: Parent organization is suspended by administration.');
      }
      throw new Error('Cannot publish job: Employer organization must be approved by administration first.');
    }
  }

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        isFlagged: false,
        publishedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'JOB_APPROVED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job approved for publication by administrator`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      organizationId: String(job.organizationId || ''),
      previousStatus: job.status,
      newStatus: 'PUBLISHED'
    }
  });

  return { success: true, status: 'PUBLISHED' };
};

const rejectJob = async (id, reason, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid job ID.');
  if (!reason || !reason.trim()) throw new Error('Rejection reason is required and mandatory.');

  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'REJECTED',
        moderationStatus: 'REJECTED_BY_ADMIN',
        rejectionReason: reason.trim(),
        adminNotes: reason.trim(),
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'JOB_REJECTED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job rejected by administrator. Reason: ${reason.trim()}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason: reason.trim(),
      previousStatus: job.status,
      newStatus: 'REJECTED'
    }
  });

  return { success: true, status: 'REJECTED' };
};

const unpublishJob = async (id, reason = '', actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid job ID.');
  if (!reason || !reason.trim()) throw new Error('Unpublish reason is required and mandatory.');

  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'PAUSED',
        moderationStatus: 'UNPUBLISHED_BY_ADMIN',
        adminNotes: reason.trim(),
        pausedReason: reason.trim() || 'Administrative action',
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'JOB_UNPUBLISHED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job unpublished by admin. Reason: ${reason.trim() || 'Administrative action'}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason: reason.trim(),
      previousStatus: job.status,
      newStatus: 'PAUSED'
    }
  });

  return { success: true, status: 'PAUSED' };
};

const closeJob = async (id, reason = '', actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid job ID.');
  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedByAdmin: true,
        adminNotes: reason,
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'JOB_CLOSED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job closed by admin`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason,
      previousStatus: job.status,
      newStatus: 'CLOSED'
    }
  });

  return { success: true, status: 'CLOSED' };
};

const suspendJob = async (id, reason, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid job ID.');
  if (!reason || !reason.trim()) throw new Error('Suspension reason is required and mandatory.');

  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'SUSPENDED',
        moderationStatus: 'SUSPENDED_BY_ADMIN',
        suspensionReason: reason.trim(),
        adminNotes: reason.trim(),
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'JOB_SUSPENDED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job suspended by administrator. Reason: ${reason.trim()}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason: reason.trim(),
      previousStatus: job.status,
      newStatus: 'SUSPENDED'
    }
  });

  return { success: true, status: 'SUSPENDED' };
};

const restoreJob = async (id, actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid job ID.');
  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) throw new Error('Job not found.');

  // Validate parent organization if job was paused specifically due to business suspension
  if (job.pausedReason === 'Business suspended by administration') {
    if (job.organizationId && isValidObjectId(job.organizationId)) {
      const org = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(job.organizationId) });
      if (org && org.status === 'SUSPENDED') {
        throw new Error('Cannot restore job: Parent organization is currently suspended.');
      }
    }
  }

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        isFlagged: false,
        suspensionReason: null,
        pausedReason: null,
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    actor,
    req,
    action: 'JOB_RESTORED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job restored to published state by admin`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      previousStatus: job.status,
      newStatus: 'PUBLISHED'
    }
  });

  return { success: true, status: 'PUBLISHED' };
};

const flagJob = async (id, reason = '', actor, req) => {
  if (!isValidObjectId(id)) throw new Error('Invalid job ID.');
  const database = db.get();
  const objId = new ObjectId(id);

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: objId });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: objId },
    {
      $set: {
        moderationStatus: 'FLAGGED',
        isFlagged: true,
        flaggedReason: reason || 'Flagged by administration for review',
        flaggedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'JOB_FLAGGED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job flagged for review by admin. Reason: ${reason || 'N/A'}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason
    }
  });

  return { success: true };
};

module.exports = {
  isValidObjectId,
  ALLOWED_PROFILE_ROLES,
  sanitizeUserForAdmin,
  assignUserRole,
  suspendUser,
  restoreUser,
  restrictUser,
  getUserSessions,
  revokeUserSession,
  revokeAllUserSessions,
  changeUserUsername,
  getUserGovernanceDossier,
  updateUserVerification,
  getBusinesses,
  getBusinessStats,
  getBusinessById,
  calculateBusinessIntegritySignals,
  approveBusiness,
  rejectBusiness,
  suspendBusiness,
  restoreBusiness,
  transferBusinessOwnership,
  updateBusinessMemberRole,
  getJobs,
  getJobStats,
  getJobById,
  getJobApplicationsAggregate,
  approveJob,
  rejectJob,
  unpublishJob,
  closeJob,
  suspendJob,
  restoreJob,
  flagJob
};
