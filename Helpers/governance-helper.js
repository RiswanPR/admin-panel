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

const CANONICAL_ROLES = ['STUDENT', 'EDUCATOR', 'PROFESSIONAL', 'MENTOR', 'RECRUITER', 'FOUNDER'];
const ALLOWED_PROFILE_ROLES = CANONICAL_ROLES;

const CANONICAL_CAPABILITIES = {
  ACCESS_COURSES: 'ACCESS_COURSES',
  ACCESS_JOBS: 'ACCESS_JOBS',
  MANAGE_BUSINESS: 'MANAGE_BUSINESS',
  POST_OPPORTUNITIES: 'POST_OPPORTUNITIES',
  ACCESS_PORTFOLIO: 'ACCESS_PORTFOLIO',
  ACCESS_CAREER_INTELLIGENCE: 'ACCESS_CAREER_INTELLIGENCE',
  OFFER_MENTORSHIP: 'OFFER_MENTORSHIP',
  CONDUCT_CLASSES: 'CONDUCT_CLASSES'
};

const CAPABILITY_METADATA = {
  ACCESS_COURSES: {
    id: 'ACCESS_COURSES',
    name: 'Course Learning',
    description: 'Access curriculum, lectures, coursework, and progress tracking',
    category: 'Learning'
  },
  ACCESS_JOBS: {
    id: 'ACCESS_JOBS',
    name: 'Infrastructure Jobs',
    description: 'Explore, search, and submit applications for infrastructure roles',
    category: 'Opportunities'
  },
  MANAGE_BUSINESS: {
    id: 'MANAGE_BUSINESS',
    name: 'Business Management',
    description: 'Manage verified company entity, team roster, and corporate branding',
    category: 'Business',
    requiresAuthorizedOrg: true
  },
  POST_OPPORTUNITIES: {
    id: 'POST_OPPORTUNITIES',
    name: 'Post Opportunities',
    description: 'Create, publish, and manage hiring listings on behalf of an authorized business',
    category: 'Recruitment',
    requiresAuthorizedOrg: true
  },
  ACCESS_PORTFOLIO: {
    id: 'ACCESS_PORTFOLIO',
    name: 'Professional Portfolio',
    description: 'Curate project deliverables, technical credentials, and public showcase',
    category: 'Professional'
  },
  ACCESS_CAREER_INTELLIGENCE: {
    id: 'ACCESS_CAREER_INTELLIGENCE',
    name: 'Career Intelligence',
    description: 'Inspect industry market trends, skill taxonomies, and salary progressions',
    category: 'Intelligence'
  },
  OFFER_MENTORSHIP: {
    id: 'OFFER_MENTORSHIP',
    name: 'Mentorship',
    description: 'Host mentorship slots and guide emerging engineering talent',
    category: 'Community'
  },
  CONDUCT_CLASSES: {
    id: 'CONDUCT_CLASSES',
    name: 'Academic Instruction',
    description: 'Conduct coursework, grade assignments, and author learning modules',
    category: 'Education'
  }
};

const ROLE_DEFAULT_CAPABILITIES = {
  STUDENT: [
    CANONICAL_CAPABILITIES.ACCESS_COURSES,
    CANONICAL_CAPABILITIES.ACCESS_JOBS,
    CANONICAL_CAPABILITIES.ACCESS_CAREER_INTELLIGENCE
  ],
  PROFESSIONAL: [
    CANONICAL_CAPABILITIES.ACCESS_COURSES,
    CANONICAL_CAPABILITIES.ACCESS_JOBS,
    CANONICAL_CAPABILITIES.ACCESS_PORTFOLIO,
    CANONICAL_CAPABILITIES.ACCESS_CAREER_INTELLIGENCE
  ],
  MENTOR: [
    CANONICAL_CAPABILITIES.ACCESS_COURSES,
    CANONICAL_CAPABILITIES.ACCESS_JOBS,
    CANONICAL_CAPABILITIES.ACCESS_PORTFOLIO,
    CANONICAL_CAPABILITIES.ACCESS_CAREER_INTELLIGENCE,
    CANONICAL_CAPABILITIES.OFFER_MENTORSHIP
  ],
  FOUNDER: [
    CANONICAL_CAPABILITIES.ACCESS_COURSES,
    CANONICAL_CAPABILITIES.ACCESS_JOBS,
    CANONICAL_CAPABILITIES.ACCESS_PORTFOLIO,
    CANONICAL_CAPABILITIES.ACCESS_CAREER_INTELLIGENCE,
    CANONICAL_CAPABILITIES.MANAGE_BUSINESS,
    CANONICAL_CAPABILITIES.POST_OPPORTUNITIES
  ],
  RECRUITER: [
    CANONICAL_CAPABILITIES.ACCESS_COURSES,
    CANONICAL_CAPABILITIES.ACCESS_JOBS,
    CANONICAL_CAPABILITIES.ACCESS_CAREER_INTELLIGENCE,
    CANONICAL_CAPABILITIES.MANAGE_BUSINESS,
    CANONICAL_CAPABILITIES.POST_OPPORTUNITIES
  ],
  EDUCATOR: [
    CANONICAL_CAPABILITIES.ACCESS_COURSES,
    CANONICAL_CAPABILITIES.ACCESS_JOBS,
    CANONICAL_CAPABILITIES.ACCESS_CAREER_INTELLIGENCE,
    CANONICAL_CAPABILITIES.CONDUCT_CLASSES
  ]
};

/**
 * Resolves a user's canonical multi-role identity without destructive mutations.
 */
const resolveCanonicalUserRoles = (user) => {
  if (!user) {
    return {
      primaryRole: 'STUDENT',
      roles: ['STUDENT'],
      secondaryRoles: [],
      legacyRole: 'student',
      malformedCapabilitiesDetected: []
    };
  }

  // 1. Resolve Primary Role
  let rawPrimary = user.primaryRole;
  if (!rawPrimary && user.role) {
    const roleUpper = String(user.role).trim().toUpperCase();
    if (CANONICAL_ROLES.includes(roleUpper)) {
      rawPrimary = roleUpper;
    }
  }
  const primaryRole = (rawPrimary && CANONICAL_ROLES.includes(String(rawPrimary).trim().toUpperCase()))
    ? String(rawPrimary).trim().toUpperCase()
    : 'STUDENT';

  // 2. Resolve Multi-Role Array
  const rawRoles = Array.isArray(user.roles) ? user.roles : [];
  const normalizedSet = new Set();
  normalizedSet.add(primaryRole);

  rawRoles.forEach(r => {
    const clean = String(r || '').trim().toUpperCase();
    if (CANONICAL_ROLES.includes(clean)) {
      normalizedSet.add(clean);
    }
  });

  const roles = Array.from(normalizedSet);
  const secondaryRoles = roles.filter(r => r !== primaryRole);

  // 3. Detect malformed capabilities that look like roles
  const malformedCapabilitiesDetected = [];
  if (Array.isArray(user.capabilities)) {
    user.capabilities.forEach(cap => {
      const capUpper = String(cap || '').trim().toUpperCase();
      if (CANONICAL_ROLES.includes(capUpper)) {
        malformedCapabilitiesDetected.push(capUpper);
      }
    });
  }

  return {
    primaryRole,
    roles,
    secondaryRoles,
    legacyRole: primaryRole.toLowerCase(),
    malformedCapabilitiesDetected
  };
};

/**
 * Strict server-side business authorization evaluation.
 * Does NOT equate FOUNDER or RECRUITER role alone with business management access.
 */
const evaluateBusinessAuthorization = (user, memberships = [], organizations = []) => {
  const userIdStr = user?._id ? String(user._id) : '';
  const { roles } = resolveCanonicalUserRoles(user);
  const hasBusinessRole = roles.includes('FOUNDER') || roles.includes('RECRUITER') || roles.includes('PROFESSIONAL');

  const orgMap = {};
  organizations.forEach(o => {
    if (o && o._id) orgMap[String(o._id)] = o;
  });

  const authorizedOrganizations = [];
  const validBusinessRoles = ['OWNER', 'ADMIN', 'RECRUITER', 'MANAGER'];

  memberships.forEach(m => {
    const orgId = m.organizationId ? String(m.organizationId) : '';
    const org = orgMap[orgId];
    if (org && org.status === 'APPROVED') {
      const memRole = String(m.role || '').toUpperCase();
      const isActive = m.status !== 'SUSPENDED';
      if (isActive && (validBusinessRoles.includes(memRole) || memRole === 'OWNER')) {
        authorizedOrganizations.push({
          organizationId: orgId,
          name: org.name,
          slug: org.slug,
          membershipRole: m.role || 'Member',
          status: org.status,
          verificationStatus: org.verificationStatus,
          isOwner: Boolean(org.ownerId && String(org.ownerId) === userIdStr) || Boolean(org.createdBy && String(org.createdBy) === userIdStr)
        });
      }
    }
  });

  // Check direct ownership of approved organizations
  organizations.forEach(org => {
    if (org && org.status === 'APPROVED') {
      const orgId = String(org._id);
      const isOwner = Boolean(org.ownerId && String(org.ownerId) === userIdStr) || Boolean(org.createdBy && String(org.createdBy) === userIdStr);
      if (isOwner && !authorizedOrganizations.some(ao => ao.organizationId === orgId)) {
        authorizedOrganizations.push({
          organizationId: orgId,
          name: org.name,
          slug: org.slug,
          membershipRole: 'Owner',
          status: org.status,
          verificationStatus: org.verificationStatus,
          isOwner: true
        });
      }
    }
  });

  // Students and Professionals without authorized business cannot manage businesses
  const isAuthorized = hasBusinessRole && authorizedOrganizations.length > 0;
  const unattachedRoles = [];
  if (roles.includes('FOUNDER') && authorizedOrganizations.length === 0) unattachedRoles.push('FOUNDER');
  if (roles.includes('RECRUITER') && authorizedOrganizations.length === 0) unattachedRoles.push('RECRUITER');

  return {
    isAuthorized,
    canManageBusiness: isAuthorized,
    canPostOpportunities: isAuthorized && (roles.includes('FOUNDER') || roles.includes('RECRUITER')),
    authorizedOrganizations,
    unattachedRoles,
    hasBusinessRole,
    reason: !hasBusinessRole
      ? 'User does not hold a business-capable role (FOUNDER, RECRUITER, PROFESSIONAL).'
      : (authorizedOrganizations.length === 0 ? 'No approved organization ownership or management membership found.' : 'Authorized business entity active.')
  };
};

/**
 * Dynamically computes a user's functional capabilities based on held roles,
 * course enrollments, and business authorization gates.
 */
const computeUserCapabilities = (user, { memberships = [], organizations = [] } = {}) => {
  const { roles } = resolveCanonicalUserRoles(user);
  const businessAuth = evaluateBusinessAuthorization(user, memberships, organizations);

  const capabilitySet = new Set();
  const capabilityDetails = [];

  // 1. Gather base capabilities from all held roles
  roles.forEach(role => {
    const defaults = ROLE_DEFAULT_CAPABILITIES[role] || [];
    defaults.forEach(cap => capabilitySet.add(cap));
  });

  // 2. Ensure course access if user has course enrollments (decoupled from role)
  if (Array.isArray(user?.course) && user.course.length > 0) {
    capabilitySet.add(CANONICAL_CAPABILITIES.ACCESS_COURSES);
  }

  // 3. Process capabilities against authorization gates
  Object.values(CANONICAL_CAPABILITIES).forEach(capId => {
    const meta = CAPABILITY_METADATA[capId] || { id: capId, name: capId, description: '', category: 'General' };
    const isGrantedByRole = capabilitySet.has(capId);

    let active = isGrantedByRole;
    let gateReason = null;

    if (meta.requiresAuthorizedOrg) {
      if (!businessAuth.isAuthorized) {
        active = false;
        gateReason = businessAuth.reason;
      }
    }

    if (active) {
      capabilityDetails.push({
        id: capId,
        capability: capId,
        name: meta.name,
        label: meta.name,
        description: meta.description,
        category: meta.category,
        active: true,
        granted: true,
        sourceRoles: roles.filter(r => (ROLE_DEFAULT_CAPABILITIES[r] || []).includes(capId)),
        requiresAuthorizedOrg: Boolean(meta.requiresAuthorizedOrg),
        requiresBusinessApproval: Boolean(meta.requiresAuthorizedOrg),
        isGateSatisfied: true,
        businessGated: false
      });
    } else if (isGrantedByRole) {
      // Role assigned but gated due to lack of approved organization
      capabilityDetails.push({
        id: capId,
        capability: capId,
        name: meta.name,
        label: meta.name,
        description: meta.description,
        category: meta.category,
        active: false,
        granted: false,
        sourceRoles: roles.filter(r => (ROLE_DEFAULT_CAPABILITIES[r] || []).includes(capId)),
        requiresAuthorizedOrg: Boolean(meta.requiresAuthorizedOrg),
        requiresBusinessApproval: Boolean(meta.requiresAuthorizedOrg),
        isGateSatisfied: false,
        businessGated: Boolean(meta.requiresAuthorizedOrg),
        gateReason
      });
    }
  });

  const activeCapabilities = capabilityDetails.filter(c => c.active).map(c => c.id);

  return {
    capabilities: activeCapabilities,
    capabilityDetails,
    businessAuthorization: businessAuth
  };
};

/**
 * Changes a user's primary role while preserving all secondary roles and existing context.
 */
const setPrimaryRole = async (userId, newPrimaryRole, actor, req, reason = '') => {
  if (!isValidObjectId(userId)) throw new Error('Valid user ID is required.');
  if (actor?._id && String(actor._id) === String(userId)) {
    throw new Error('Action rejected: You cannot change your own roles.');
  }

  const normalized = String(newPrimaryRole || '').trim().toUpperCase();
  if (!CANONICAL_ROLES.includes(normalized)) {
    throw new Error(`Invalid role: ${newPrimaryRole}. Must be one of: ${CANONICAL_ROLES.join(', ')}.`);
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw new Error('A governance reason is mandatory for primary role changes.');
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
  if (!user) throw new Error('User not found.');

  const resolved = resolveCanonicalUserRoles(user);
  const previousPrimaryRole = resolved.primaryRole;
  const previousRoles = [...resolved.roles];

  if (previousPrimaryRole === normalized) {
    return {
      success: true,
      message: `User already has role ${normalized}`,
      previousRole: previousPrimaryRole,
      previousPrimaryRole,
      newRole: normalized,
      newPrimaryRole: normalized,
      role: normalized,
      roles: previousRoles
    };
  }

  // Guard Educator role modifications
  const isEducatorChange = normalized === 'EDUCATOR' || previousPrimaryRole === 'EDUCATOR';
  if (isEducatorChange && !permissionsHelper.hasCapability(actor, 'assign_educator')) {
    throw new Error('Permission denied: assign_educator capability is required to modify the Educator role.');
  }

  // Non-destructive: new roles array includes newPrimaryRole and retains secondary roles
  const newRolesSet = new Set(previousRoles);
  newRolesSet.add(normalized);
  const updatedRoles = Array.from(newRolesSet);

  const updateDoc = {
    $set: {
      primaryRole: normalized,
      role: normalized.toLowerCase(),
      roles: updatedRoles,
      updatedAt: new Date()
    }
  };

  if (normalized === 'EDUCATOR') {
    if (!user.educatorContext) {
      updateDoc.$set.educatorContext = {
        assignedBy: actor?._id ? String(actor._id) : 'admin',
        assignedAt: new Date(),
        verifiedByAdmin: true
      };
    }
    updateDoc.$set['account_Status.isVerified'] = true;
  }

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    updateDoc
  );

  // Synchronize community profile if exists
  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).updateOne(
    { userId: new ObjectId(userId) },
    { $set: { primaryRole: normalized, role: normalized.toLowerCase(), roles: updatedRoles, updatedAt: new Date() } }
  ).catch(() => {});

  // AUDIT LOG: PRIMARY_ROLE_CHANGED
  await auditHelper.logAction({
    req,
    action: 'PRIMARY_ROLE_CHANGED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `Admin changed primary role to ${normalized} (previous: ${previousPrimaryRole}). Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      target: 'user',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      previousPrimaryRole,
      newPrimaryRole: normalized,
      previousRoles,
      newRoles: updatedRoles,
      reason: cleanReason,
      isEducatorChange,
      timestamp: new Date()
    }
  });

  // Also log legacy USER_ROLE_ASSIGNED for backwards compatibility
  await auditHelper.logAction({
    req,
    action: 'USER_ROLE_ASSIGNED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `Admin assigned role ${normalized} to user (previous: ${previousPrimaryRole}). Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      target: 'user',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      role: normalized,
      previousRole: previousPrimaryRole,
      newRole: normalized,
      reason: cleanReason,
      isEducatorChange,
      timestamp: new Date()
    }
  }).catch(() => {});

  return {
    success: true,
    previousRole: previousPrimaryRole,
    previousPrimaryRole,
    newRole: normalized,
    newPrimaryRole: normalized,
    role: normalized,
    roles: updatedRoles,
    reason: cleanReason
  };
};

/**
 * Adds a secondary ecosystem role to a user without modifying the primary role or wiping data.
 */
const addSecondaryRole = async (userId, secondaryRole, actor, req, reason = '') => {
  if (!isValidObjectId(userId)) throw new Error('Valid user ID is required.');
  if (actor?._id && String(actor._id) === String(userId)) {
    throw new Error('Action rejected: You cannot change your own roles.');
  }

  const normalized = String(secondaryRole || '').trim().toUpperCase();
  if (!CANONICAL_ROLES.includes(normalized)) {
    throw new Error(`Invalid role: ${secondaryRole}. Must be one of: ${CANONICAL_ROLES.join(', ')}.`);
  }

  // EDUCATOR protection
  if (normalized === 'EDUCATOR' && !permissionsHelper.hasCapability(actor, 'assign_educator')) {
    throw new Error('Permission denied: assign_educator capability is required to assign the Educator role.');
  }

  const database = db.get();
  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) throw new Error('User not found.');

  const resolved = resolveCanonicalUserRoles(user);
  if (resolved.roles.includes(normalized)) {
    throw new Error(`User already holds role: ${normalized}`);
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw new Error('A governance reason is mandatory for adding a secondary role.');
  }

  const updatedRoles = [...resolved.roles, normalized];

  const updateDoc = {
    $addToSet: { roles: normalized },
    $set: { updatedAt: new Date() }
  };

  if (normalized === 'EDUCATOR') {
    if (!user.educatorContext) {
      updateDoc.$set.educatorContext = {
        assignedBy: actor?._id ? String(actor._id) : 'admin',
        assignedAt: new Date(),
        verifiedByAdmin: true
      };
    }
    updateDoc.$set['account_Status.isVerified'] = true;
  }

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    updateDoc
  );

  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).updateOne(
    { userId: new ObjectId(userId) },
    { $addToSet: { roles: normalized }, $set: { updatedAt: new Date() } }
  ).catch(() => {});

  // AUDIT LOG: ROLE_ADDED
  await auditHelper.logAction({
    req,
    action: 'ROLE_ADDED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `Admin added secondary role ${normalized} to user. Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      target: 'user',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      roleAdded: normalized,
      previousRoles: resolved.roles,
      newRoles: updatedRoles,
      reason: cleanReason,
      timestamp: new Date()
    }
  });

  return {
    success: true,
    roleAdded: normalized,
    primaryRole: resolved.primaryRole,
    roles: updatedRoles,
    reason: cleanReason
  };
};

/**
 * Removes an existing secondary role from a user.
 * Cannot remove the primary role via this method.
 */
const removeSecondaryRole = async (userId, secondaryRole, actor, req, reason = '') => {
  if (!isValidObjectId(userId)) throw new Error('Valid user ID is required.');
  if (actor?._id && String(actor._id) === String(userId)) {
    throw new Error('Action rejected: You cannot change your own roles.');
  }

  const normalized = String(secondaryRole || '').trim().toUpperCase();
  const database = db.get();
  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) throw new Error('User not found.');

  const resolved = resolveCanonicalUserRoles(user);

  if (resolved.primaryRole === normalized) {
    throw new Error(`Cannot remove primary role ${normalized}. Change the user's primary role first.`);
  }

  if (!resolved.secondaryRoles.includes(normalized)) {
    throw new Error(`User does not have secondary role: ${normalized}`);
  }

  // EDUCATOR protection
  if (normalized === 'EDUCATOR' && !permissionsHelper.hasCapability(actor, 'assign_educator')) {
    throw new Error('Permission denied: assign_educator capability is required to remove the Educator role.');
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw new Error('A governance reason is mandatory for removing a secondary role.');
  }

  const updatedRoles = resolved.roles.filter(r => r !== normalized);

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    {
      $pull: { roles: normalized },
      $set: { updatedAt: new Date() }
    }
  );

  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).updateOne(
    { userId: new ObjectId(userId) },
    { $pull: { roles: normalized }, $set: { updatedAt: new Date() } }
  ).catch(() => {});

  // AUDIT LOG: ROLE_REMOVED
  await auditHelper.logAction({
    req,
    action: 'ROLE_REMOVED',
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `Admin removed secondary role ${normalized} from user. Reason: ${cleanReason}`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      target: 'user',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      roleRemoved: normalized,
      previousRoles: resolved.roles,
      newRoles: updatedRoles,
      reason: cleanReason,
      timestamp: new Date()
    }
  });

  return {
    success: true,
    roleRemoved: normalized,
    primaryRole: resolved.primaryRole,
    roles: updatedRoles,
    reason: cleanReason
  };
};

/**
 * Backward-compatible role assignment (invokes setPrimaryRole).
 */
const assignUserRole = async (userId, newRole, actor, req, reason = '') => {
  return await setPrimaryRole(userId, newRole, actor, req, reason || 'Role assigned via administrative governance');
};

/**
 * Retrieves audit log history of role mutations for a user.
 */
const getUserRoleHistory = async (userId) => {
  if (!isValidObjectId(userId)) return [];
  const database = db.get();
  const idStr = String(userId);

  const logs = await database.collection(collection.AUDIT_LOG_COLLECTION).find({
    $or: [
      { entityId: idStr, action: { $in: ['PRIMARY_ROLE_CHANGED', 'ROLE_ADDED', 'ROLE_REMOVED', 'USER_ROLE_ASSIGNED', 'CAPABILITIES_RECOMPUTED'] } },
      { 'metadata.targetUserId': idStr, action: { $in: ['PRIMARY_ROLE_CHANGED', 'ROLE_ADDED', 'ROLE_REMOVED', 'USER_ROLE_ASSIGNED', 'CAPABILITIES_RECOMPUTED'] } }
    ]
  }).sort({ timestamp: -1 }).limit(30).toArray().catch(() => []);

  return logs.map(l => ({
    _id: l._id,
    action: l.action,
    message: l.message,
    actor: l.metadata?.actor || 'Admin',
    actorId: l.metadata?.actorId || '',
    previousState: l.metadata?.previousPrimaryRole || l.metadata?.previousRole || (Array.isArray(l.metadata?.previousRoles) ? l.metadata.previousRoles.join(', ') : ''),
    newState: l.metadata?.newPrimaryRole || l.metadata?.newRole || l.metadata?.roleAdded || l.metadata?.roleRemoved || (Array.isArray(l.metadata?.newRoles) ? l.metadata.newRoles.join(', ') : ''),
    reason: l.metadata?.reason || '',
    timestamp: l.timestamp || l.createdAt
  }));
};

/**
 * Comprehensive diagnostic tool for detecting multi-role and capability semantic inconsistencies.
 */
const auditUserRoleConsistency = async (targetUserId = null) => {
  const database = db.get();

  const userQuery = targetUserId ? { _id: new ObjectId(targetUserId) } : {};
  const users = await database.collection(collection.STUDENTS_COLLECTION).find(userQuery).toArray().catch(() => []);

  const allMemberships = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).find({}).toArray().catch(() => []);
  const allOrgs = await database.collection(collection.ORGANIZATIONS_COLLECTION).find({}).toArray().catch(() => []);

  const orgMap = {};
  allOrgs.forEach(o => { orgMap[String(o._id)] = o; });

  const membershipsByUser = {};
  allMemberships.forEach(m => {
    const uid = String(m.userId);
    membershipsByUser[uid] = membershipsByUser[uid] || [];
    membershipsByUser[uid].push(m);
  });

  const reports = users.map(user => {
    const uid = String(user._id);
    const userMems = membershipsByUser[uid] || [];
    const inconsistencies = [];

    // 1. Missing or invalid primaryRole
    if (!user.primaryRole) {
      inconsistencies.push({
        code: 'PRIMARY_ROLE_MISSING',
        severity: 'WARNING',
        field: 'primaryRole',
        message: 'User is missing an explicit primaryRole (defaulting canonically).',
        currentValue: user.primaryRole,
        recommendedValue: user.role ? String(user.role).toUpperCase() : 'STUDENT'
      });
    } else if (!CANONICAL_ROLES.includes(String(user.primaryRole).toUpperCase())) {
      inconsistencies.push({
        code: 'INVALID_PRIMARY_ROLE',
        severity: 'ERROR',
        field: 'primaryRole',
        message: `Primary role '${user.primaryRole}' is not an authorized ecosystem role.`,
        currentValue: user.primaryRole,
        recommendedValue: 'STUDENT'
      });
    }

    // 2. Invalid role in roles array & duplicates
    if (Array.isArray(user.roles)) {
      const invalidRoles = user.roles.filter(r => !CANONICAL_ROLES.includes(String(r).toUpperCase()));
      if (invalidRoles.length > 0) {
        inconsistencies.push({
          code: 'INVALID_ROLE_IN_ROLES',
          severity: 'ERROR',
          field: 'roles',
          message: `Roles array contains unrecognized role(s): ${invalidRoles.join(', ')}.`,
          currentValue: user.roles,
          recommendedValue: user.roles.filter(r => CANONICAL_ROLES.includes(String(r).toUpperCase()))
        });
      }

      const roleCounts = {};
      user.roles.forEach(r => {
        const up = String(r).toUpperCase();
        roleCounts[up] = (roleCounts[up] || 0) + 1;
      });
      const duplicates = Object.keys(roleCounts).filter(k => roleCounts[k] > 1);
      if (duplicates.length > 0) {
        inconsistencies.push({
          code: 'DUPLICATE_ROLES',
          severity: 'WARNING',
          field: 'roles',
          message: `Roles array contains duplicate entry for: ${duplicates.join(', ')}.`,
          currentValue: user.roles,
          recommendedValue: Array.from(new Set(user.roles.map(r => String(r).toUpperCase())))
        });
      }
    }

    // 3. Capabilities array containing role names
    if (Array.isArray(user.capabilities)) {
      const roleLikeCaps = user.capabilities.filter(c => CANONICAL_ROLES.includes(String(c).toUpperCase()));
      if (roleLikeCaps.length > 0) {
        inconsistencies.push({
          code: 'CAPABILITY_CONTAINS_ROLE',
          severity: 'ERROR',
          field: 'capabilities',
          message: `Capabilities array contains role name(s) [${roleLikeCaps.join(', ')}] instead of functional permission identifiers.`,
          currentValue: user.capabilities,
          recommendedValue: computeUserCapabilities(user, { memberships: userMems, organizations: allOrgs }).capabilities
        });
      }
    }

    // 4. Orphan organization membership
    userMems.forEach(m => {
      const orgId = String(m.organizationId);
      if (!orgMap[orgId]) {
        inconsistencies.push({
          code: 'ORPHAN_MEMBERSHIP',
          severity: 'ERROR',
          field: 'organizationMemberships',
          message: `Membership ${m._id} references non-existent organization ID: ${orgId}.`,
          currentValue: orgId,
          recommendedValue: null
        });
      }
    });

    // 5. Unattached business role
    const resolved = resolveCanonicalUserRoles(user);
    const hasFounderOrRecruiter = resolved.roles.includes('FOUNDER') || resolved.roles.includes('RECRUITER');
    const hasOrg = userMems.some(m => orgMap[String(m.organizationId)] && orgMap[String(m.organizationId)].status === 'APPROVED');
    const ownsOrg = allOrgs.some(o => o.status === 'APPROVED' && (String(o.ownerId) === uid || String(o.createdBy) === uid));
    if (hasFounderOrRecruiter && !hasOrg && !ownsOrg) {
      inconsistencies.push({
        code: 'UNATTACHED_BUSINESS_ROLE',
        severity: 'WARNING',
        field: 'roles',
        message: `User holds role [${resolved.roles.filter(r => ['FOUNDER', 'RECRUITER'].includes(r)).join(', ')}] but has no approved organization affiliation.`,
        currentValue: resolved.roles,
        recommendedValue: 'Attach to approved business or adjust role'
      });
    }

    // 6. Educator without admin verification metadata
    if (resolved.roles.includes('EDUCATOR')) {
      const hasAdminMeta = Boolean(user.educatorContext?.verifiedByAdmin);
      if (!hasAdminMeta) {
        inconsistencies.push({
          code: 'EDUCATOR_WITHOUT_ADMIN_METADATA',
          severity: 'ERROR',
          field: 'educatorContext',
          message: 'User holds EDUCATOR role but is missing admin assignment/verification metadata.',
          currentValue: user.educatorContext || null,
          recommendedValue: { assignedBy: 'admin', verifiedByAdmin: true }
        });
      }
    }

    // 7. Role out of sync with primaryRole
    if (user.role && user.primaryRole && String(user.role).toUpperCase() !== String(user.primaryRole).toUpperCase()) {
      inconsistencies.push({
        code: 'ROLE_FIELD_OUT_OF_SYNC',
        severity: 'WARNING',
        field: 'role',
        message: `Legacy role '${user.role}' does not match primaryRole '${user.primaryRole}'.`,
        currentValue: user.role,
        recommendedValue: String(user.primaryRole).toLowerCase()
      });
    }

    const normalized = {
      primaryRole: resolved.primaryRole,
      roles: resolved.roles,
      capabilities: computeUserCapabilities(user, { memberships: userMems, organizations: allOrgs }).capabilities
    };

    return {
      userId: uid,
      username: user.username || 'user',
      displayName: user.Name || user.name || user.email || 'User',
      email: user.email || user.Email || '',
      currentPrimaryRole: user.primaryRole || user.role || 'STUDENT',
      currentRoles: user.roles || [user.primaryRole || user.role || 'STUDENT'],
      currentCapabilities: user.capabilities || [],
      isConsistent: inconsistencies.length === 0,
      inconsistencies,
      normalizedProposal: normalized,
      confidence: inconsistencies.length === 0 ? 'HIGH' : (inconsistencies.some(i => i.severity === 'ERROR') ? 'MEDIUM' : 'HIGH'),
      recommendedAction: inconsistencies.length === 0 ? 'NO_ACTION' : 'CANONICAL_NORMALIZATION'
    };
  });

  return {
    totalScanned: reports.length,
    consistentCount: reports.filter(r => r.isConsistent).length,
    inconsistentCount: reports.filter(r => !r.isConsistent).length,
    reports
  };
};

/**
 * Prepares the canonical contract for User Panel consumption (strictly excludes secrets/PII).
 */
const getCanonicalUserContract = async (userId) => {
  if (!isValidObjectId(userId)) return null;
  const database = db.get();
  const objId = new ObjectId(userId);
  const idStr = String(userId);

  const rawUser = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: objId });
  if (!rawUser) return null;

  const user = sanitizeUserForAdmin(rawUser);

  const memberships = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).find({
    $or: [{ userId: objId }, { userId: idStr }]
  }).toArray().catch(() => []);

  const orgIds = memberships.map(m => m.organizationId).filter(id => id && ObjectId.isValid(id)).map(id => new ObjectId(id));
  const orgs = orgIds.length ? await database.collection(collection.ORGANIZATIONS_COLLECTION).find({ _id: { $in: orgIds } }).toArray().catch(() => []) : [];

  const commProfile = await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).findOne({
    $or: [{ userId: objId }, { userId: idStr }]
  }).catch(() => null) || {};

  const rolesResolution = resolveCanonicalUserRoles(user);
  const capResolution = computeUserCapabilities(user, { memberships, organizations: orgs });

  // Get enrolled courses
  const courseIds = Array.isArray(user.course) ? user.course.map(c => (c && c.courseId ? c.courseId : c)).filter(Boolean) : [];
  let enrolledCourses = [];
  if (courseIds.length) {
    const validCourseObjIds = courseIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
    enrolledCourses = await database.collection(collection.COURSE_COLLECTION).find(
      { _id: { $in: validCourseObjIds } },
      { projection: { _id: 1, courseName: 1, title: 1, category: 1, duration: 1, image: 1 } }
    ).toArray().catch(() => []);
  }

  // Safe businesses
  const businesses = capResolution.businessAuthorization.authorizedOrganizations.map(o => ({
    organizationId: o.organizationId,
    name: o.name,
    slug: o.slug,
    membershipRole: o.membershipRole,
    isOwner: o.isOwner
  }));

  // Sanitized contract
  return {
    userId: String(user._id),
    username: user.username,
    displayName: user.Name || user.name || 'User',
    primaryRole: rolesResolution.primaryRole,
    roles: rolesResolution.roles,
    capabilities: capResolution.capabilities,
    capabilityDetails: capResolution.capabilityDetails,
    businessAccess: {
      hasBusinessManagement: capResolution.businessAuthorization.canManageBusiness,
      canPostOpportunities: capResolution.businessAuthorization.canPostOpportunities,
      authorizedOrganizationsCount: businesses.length,
      unattachedRoles: capResolution.businessAuthorization.unattachedRoles
    },
    businesses,
    learningContext: {
      isEnrolled: enrolledCourses.length > 0,
      enrolledCoursesCount: enrolledCourses.length,
      enrolledCourses: enrolledCourses.map(c => ({
        id: String(c._id),
        title: c.courseName || c.title || 'Course',
        category: c.category || 'Engineering'
      }))
    },
    professionalContext: {
      headline: commProfile.headline || user.headline || '',
      discipline: commProfile.discipline || user.discipline || '',
      infrastructureSector: commProfile.infrastructureSector || user.infrastructureSector || '',
      skills: commProfile.skills || user.skills || [],
      software: commProfile.software || [],
      experienceCount: (commProfile.experience || user.experience || []).length,
      educationCount: (commProfile.education || user.education || []).length
    },
    verification: {
      identity: user.account_Status?.isVerified ? 'VERIFIED' : 'UNVERIFIED',
      professional: commProfile.verification?.professional || 'UNVERIFIED',
      businessAffiliation: businesses.length > 0 ? 'VERIFIED' : 'UNVERIFIED',
      educator: rolesResolution.roles.includes('EDUCATOR') && user.educatorContext?.verifiedByAdmin ? 'VERIFIED' : 'UNVERIFIED'
    }
  };
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

  // Multi-Role & Capability Architecture Resolution
  const roleResolution = resolveCanonicalUserRoles(user);
  const capResolution = computeUserCapabilities(user, { memberships, organizations: orgs });
  const roleHistory = await getUserRoleHistory(userId);
  const availableRolesToAdd = CANONICAL_ROLES.filter(r => !roleResolution.roles.includes(r));

  // Diagnostic consistency audit for this user
  let consistencyIssues = [];
  try {
    const consistencyCheck = await auditUserRoleConsistency(userId);
    consistencyIssues = consistencyCheck.reports?.[0]?.inconsistencies || [];
  } catch (err) {
    // Non-blocking diagnostic catch
  }

  // Course Participation (Independent of Role)
  const courseIds = Array.isArray(user.course) ? user.course.map(c => (c && c.courseId ? c.courseId : c)).filter(Boolean) : [];
  let enrolledCourses = [];
  if (courseIds.length) {
    const validCourseObjIds = courseIds.filter(id => isValidObjectId(id)).map(id => new ObjectId(id));
    if (validCourseObjIds.length) {
      enrolledCourses = await database.collection(collection.COURSE_COLLECTION).find(
        { _id: { $in: validCourseObjIds } }
      ).toArray().catch(() => []);
    }
  }

  const learningContext = {
    isEnrolled: enrolledCourses.length > 0,
    coursesCount: enrolledCourses.length,
    enrolledCourses: enrolledCourses.map(c => ({
      _id: c._id,
      courseName: c.courseName || c.title || 'Course',
      title: c.courseName || c.title || 'Course',
      category: c.category || 'General',
      duration: c.duration || null,
      image: c.image || '/img/placeholders/course-cover.svg',
      detailUrl: `/admin/courses/${c._id}`
    }))
  };

  return {
    user,
    userType,
    displayName: user.Name || user.name || 'User',
    username: user.username || (user.email ? user.email.split('@')[0] : 'user'),
    primaryRole: roleResolution.primaryRole,
    roles: roleResolution.roles,
    secondaryRoles: roleResolution.secondaryRoles,
    availableRolesToAdd,
    allCanonicalRoles: CANONICAL_ROLES,
    capabilities: capResolution.capabilities,
    capabilityDetails: capResolution.capabilityDetails,
    businessAuthorization: capResolution.businessAuthorization,
    learningContext,
    roleHistory,
    consistencyIssues,
    consistencyCount: consistencyIssues.length,
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
  CANONICAL_ROLES,
  ALLOWED_PROFILE_ROLES,
  CANONICAL_CAPABILITIES,
  CAPABILITY_METADATA,
  ROLE_DEFAULT_CAPABILITIES,
  resolveCanonicalUserRoles,
  evaluateBusinessAuthorization,
  computeUserCapabilities,
  setPrimaryRole,
  addSecondaryRole,
  removeSecondaryRole,
  getUserRoleHistory,
  auditUserRoleConsistency,
  getCanonicalUserContract,
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
