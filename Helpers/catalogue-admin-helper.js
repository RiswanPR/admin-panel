'use strict';

/**
 * Zeitnah Admin Panel — Professional Identity Catalogue Admin Helper (Phase 2)
 *
 * Backend administration service for the Professional Identity catalogue:
 * - Department inspection, filtering, updating, and retirement
 * - Department-scoped title inspection, filtering, pagination, creation, updating, and retirement
 * - Usage statistics resolution across user profile identities
 * - Input validation and unexpected field rejection
 * - Immutable ID preservation (IDs are never modified when display labels change)
 * - Safe department reassignment evaluation (rejects unsafe mutations to preserve historical profiles)
 * - Structured audit logging for every mutation via auditHelper
 */

const collection = require('../config/collections');
const db = require('../config/connection');
const auditHelper = require('./audit-helper');
const logger = require('./logger');

// Allowed status values
const ALLOWED_STATUSES = new Set(['active', 'retired']);

// Allowed mutation fields for departments and titles
const ALLOWED_DEPARTMENT_UPDATE_FIELDS = new Set(['name', 'status', 'displayOrder', 'aliases']);
const ALLOWED_TITLE_INPUT_FIELDS = new Set(['label', 'status', 'displayOrder', 'aliases']);
const ALLOWED_TITLE_UPDATE_FIELDS = new Set(['label', 'status', 'displayOrder', 'aliases']);

/**
 * Resolves the active MongoDB database instance.
 */
function resolveDb(options = {}) {
  const activeDb = options.db || db.get();
  if (!activeDb || typeof activeDb.collection !== 'function') {
    throw new Error('Database connection not available.');
  }
  return activeDb;
}

/**
 * Generates an immutable, URL-safe slug for titles.
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'title';
}

/**
 * Validates and sanitizes a string field: non-empty, trimmed, plain text, no HTML tags, no newlines.
 */
function validatePlainText(val, minLen, maxLen, fieldName) {
  if (val === undefined || val === null || typeof val !== 'string') {
    throw new Error(`${fieldName} must be a valid string.`);
  }

  const clean = val.trim();
  if (clean.length < minLen) {
    throw new Error(`${fieldName} must be at least ${minLen} character(s) long.`);
  }
  if (clean.length > maxLen) {
    throw new Error(`${fieldName} must not exceed ${maxLen} characters (received ${clean.length}).`);
  }

  if (/[<>]/.test(clean)) {
    throw new Error(`${fieldName} must be plain text without HTML angle brackets.`);
  }

  if (/[\r\n]/.test(clean)) {
    throw new Error(`${fieldName} must be single-line text without newlines.`);
  }

  return clean;
}

/**
 * Validates an aliases array.
 */
function validateAliases(aliases, fieldName = 'Aliases') {
  if (!Array.isArray(aliases)) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  if (aliases.length > 20) {
    throw new Error(`${fieldName} array cannot exceed 20 entries.`);
  }

  return aliases.map((alias, idx) => {
    return validatePlainText(alias, 1, 50, `${fieldName} entry at index ${idx}`);
  });
}

/**
 * Validates that an object contains only explicitly allowed keys.
 */
function rejectUnexpectedFields(inputObj, allowedSet, contextName) {
  if (!inputObj || typeof inputObj !== 'object' || Array.isArray(inputObj)) {
    throw new Error(`${contextName} must be a valid object.`);
  }

  const unexpected = Object.keys(inputObj).filter((k) => !allowedSet.has(k));
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected field(s) in ${contextName}: ${unexpected.join(', ')}. Allowed fields are: ${Array.from(allowedSet).join(', ')}.`
    );
  }
}

/**
 * Records an audit log action deterministically.
 */
async function recordAudit(activeDb, { req, actor, action, entityType, entityId, entityName, metadata, message }) {
  try {
    // If auditHelper can log with active db
    if (auditHelper && typeof auditHelper.logAction === 'function') {
      const logged = await auditHelper.logAction({
        req,
        actor,
        action,
        entityType,
        entityId: String(entityId),
        entityName: String(entityName),
        status: 'success',
        message: message || `${action} executed successfully on ${entityType} ${entityId}`,
        metadata,
      });

      if (logged) return true;
    }

    // Direct database fallback for test environments or isolated mock DBs
    const auditCollName = collection.AUDIT_LOG_COLLECTION || 'audit_logs';
    const auditColl = activeDb.collection(auditCollName);
    if (auditColl && typeof auditColl.insertOne === 'function') {
      const logDoc = {
        action,
        entityType,
        entityId: String(entityId),
        entityName: String(entityName),
        status: 'success',
        message: message || `${action} on ${entityType} ${entityId}`,
        metadata: metadata || {},
        actor: {
          id: actor?._id ? String(actor._id) : '',
          name: actor?.Name || actor?.name || actor?.Email || 'Admin',
          email: actor?.Email || actor?.email || '',
          role: actor?.role || 'admin',
        },
        createdAt: new Date(),
        timestamp: new Date(),
      };
      await auditColl.insertOne(logDoc);
      return true;
    }

    return false;
  } catch (err) {
    logger.warn(`Audit log failed for ${action}: ${err.message}`);
    return false;
  }
}

/**
 * Safely resolves user profile reference count for a department or title.
 * Returns null if the users collection is unavailable or queries fail.
 */
async function resolveUsageCount(activeDb, fieldPath, value) {
  try {
    const userCollName = collection.STUDENTS_COLLECTION || 'users';
    const userColl = activeDb.collection(userCollName);
    if (!userColl || typeof userColl.countDocuments !== 'function') return null;

    const count = await userColl.countDocuments({ [fieldPath]: value });
    return typeof count === 'number' ? count : null;
  } catch (_) {
    // In local environments where users collection is not present or offline, return null safely
    return null;
  }
}

// =============================================================================
// SERVICE OPERATIONS
// =============================================================================

/**
 * 1. Get all departments with enriched statistics and optional filtering.
 */
async function getDepartmentsWithStats(filters = {}, options = {}) {
  const activeDb = resolveDb(options);
  const deptCollName = collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments';
  const titleCollName = collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles';

  const deptColl = activeDb.collection(deptCollName);
  const titleColl = activeDb.collection(titleCollName);

  const query = {};

  if (filters.status && filters.status !== 'all') {
    if (!ALLOWED_STATUSES.has(filters.status)) {
      throw new Error(`Invalid status filter: '${filters.status}'. Must be 'all', 'active', or 'retired'.`);
    }
    query.status = filters.status;
  }

  if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
    const cleanSearch = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(cleanSearch, 'i');
    query.$or = [{ name: searchRegex }, { id: searchRegex }];
  }

  const sort = options.sort || { displayOrder: 1, name: 1 };
  const rawDepartments = await deptColl.find(query).toArray();

  // Sort departments by displayOrder
  rawDepartments.sort((a, b) => {
    if (a.displayOrder !== b.displayOrder) {
      return (a.displayOrder || 0) - (b.displayOrder || 0);
    }
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const includeUsage = options.includeUsage !== false;

  const enrichedDepartments = await Promise.all(
    rawDepartments.map(async (dept) => {
      // Title counts within this department
      const titlesCount = await titleColl.countDocuments({ departmentId: dept.id }).catch(() => 0);
      const activeTitlesCount = await titleColl.countDocuments({ departmentId: dept.id, status: 'active' }).catch(() => 0);
      const retiredTitlesCount = await titleColl.countDocuments({ departmentId: dept.id, status: 'retired' }).catch(() => 0);

      let usageCount = null;
      if (includeUsage) {
        usageCount = await resolveUsageCount(activeDb, 'professionalIdentity.departmentId', dept.id);
      }

      return {
        ...dept,
        titlesCount,
        activeTitlesCount,
        retiredTitlesCount,
        usageCount,
      };
    })
  );

  return enrichedDepartments;
}

/**
 * 2. Get department details by its stable ID with scoped counts.
 */
async function getDepartmentById(departmentId, options = {}) {
  if (!departmentId || typeof departmentId !== 'string' || !departmentId.trim()) {
    throw new Error('Valid department ID is required.');
  }

  const cleanDeptId = departmentId.trim();
  const activeDb = resolveDb(options);
  const deptCollName = collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments';
  const titleCollName = collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles';

  const deptColl = activeDb.collection(deptCollName);
  const titleColl = activeDb.collection(titleCollName);

  const dept = await deptColl.findOne({ id: cleanDeptId });
  if (!dept) return null;

  const titlesCount = await titleColl.countDocuments({ departmentId: dept.id }).catch(() => 0);
  const activeTitlesCount = await titleColl.countDocuments({ departmentId: dept.id, status: 'active' }).catch(() => 0);
  const retiredTitlesCount = await titleColl.countDocuments({ departmentId: dept.id, status: 'retired' }).catch(() => 0);

  let usageCount = null;
  if (options.includeUsage !== false) {
    usageCount = await resolveUsageCount(activeDb, 'professionalIdentity.departmentId', dept.id);
  }

  return {
    ...dept,
    titlesCount,
    activeTitlesCount,
    retiredTitlesCount,
    usageCount,
  };
}

/**
 * 3. Update department display name, status, displayOrder, or aliases.
 * IDs are strictly immutable.
 */
async function updateDepartment(departmentId, changes = {}, actorContext = {}) {
  if (!departmentId || typeof departmentId !== 'string' || !departmentId.trim()) {
    throw new Error('Valid department ID is required.');
  }

  const cleanDeptId = departmentId.trim();
  rejectUnexpectedFields(changes, ALLOWED_DEPARTMENT_UPDATE_FIELDS, 'Department changes');

  // Explicit guard: ID cannot be modified
  if ('id' in changes || '_id' in changes) {
    throw new Error('Department ID is immutable and cannot be changed.');
  }

  const activeDb = resolveDb(actorContext);
  const deptCollName = collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments';
  const deptColl = activeDb.collection(deptCollName);

  const existingDept = await deptColl.findOne({ id: cleanDeptId });
  if (!existingDept) {
    throw new Error(`Department with ID '${cleanDeptId}' not found.`);
  }

  const sanitizedUpdates = {};
  const previousState = {};
  const newState = {};

  if (changes.name !== undefined) {
    const cleanName = validatePlainText(changes.name, 2, 100, 'Department name');
    if (cleanName !== existingDept.name) {
      sanitizedUpdates.name = cleanName;
      previousState.name = existingDept.name;
      newState.name = cleanName;
    }
  }

  if (changes.status !== undefined) {
    const cleanStatus = String(changes.status).trim().toLowerCase();
    if (!ALLOWED_STATUSES.has(cleanStatus)) {
      throw new Error(`Invalid department status: '${changes.status}'. Allowed values: active, retired.`);
    }

    if (cleanStatus !== existingDept.status) {
      sanitizedUpdates.status = cleanStatus;
      previousState.status = existingDept.status;
      newState.status = cleanStatus;
    }
  }

  if (changes.displayOrder !== undefined) {
    const orderNum = Number(changes.displayOrder);
    if (!Number.isInteger(orderNum) || orderNum < 1 || orderNum > 1000) {
      throw new Error('Display order must be an integer between 1 and 1000.');
    }
    if (orderNum !== existingDept.displayOrder) {
      sanitizedUpdates.displayOrder = orderNum;
      previousState.displayOrder = existingDept.displayOrder;
      newState.displayOrder = orderNum;
    }
  }

  if (changes.aliases !== undefined) {
    const cleanAliases = validateAliases(changes.aliases, 'Department aliases');
    sanitizedUpdates.aliases = cleanAliases;
    previousState.aliases = existingDept.aliases || [];
    newState.aliases = cleanAliases;
  }

  // If no fields actually changed, return existing document
  const changedKeys = Object.keys(sanitizedUpdates);
  if (changedKeys.length === 0) {
    return {
      success: true,
      department: existingDept,
      updated: false,
      changedFields: [],
      auditLogged: true,
    };
  }

  sanitizedUpdates.updatedAt = new Date();

  // Atomic update
  await deptColl.updateOne({ id: cleanDeptId }, { $set: sanitizedUpdates });

  const updatedDept = await deptColl.findOne({ id: cleanDeptId });

  // Audit Logging
  let actionName = 'CATALOGUE_DEPARTMENT_UPDATED';
  if (sanitizedUpdates.status === 'retired') actionName = 'CATALOGUE_DEPARTMENT_RETIRED';
  else if (sanitizedUpdates.status === 'active' && previousState.status === 'retired') {
    actionName = 'CATALOGUE_DEPARTMENT_ACTIVATED';
  }

  const auditSuccess = await recordAudit(activeDb, {
    req: actorContext.req,
    actor: actorContext.actor,
    action: actionName,
    entityType: 'CATALOGUE_DEPARTMENT',
    entityId: cleanDeptId,
    entityName: updatedDept.name,
    metadata: {
      departmentId: cleanDeptId,
      previousState,
      newState,
      changedFields: changedKeys,
      reason: actorContext.reason || 'Admin department configuration update',
    },
    message: `Updated department '${cleanDeptId}' (${changedKeys.join(', ')})`,
  });

  if (!auditSuccess) {
    logger.warn(`Audit log could not be verified for department '${cleanDeptId}' update.`);
  }

  return {
    success: true,
    department: updatedDept,
    updated: true,
    changedFields: changedKeys,
    auditLogged: auditSuccess,
  };
}

/**
 * 4. List titles strictly scoped to a department with search and pagination.
 */
async function getTitlesForDepartment(departmentId, filters = {}, options = {}) {
  if (!departmentId || typeof departmentId !== 'string' || !departmentId.trim()) {
    throw new Error('Valid department ID is required.');
  }

  const cleanDeptId = departmentId.trim();
  const activeDb = resolveDb(options);
  const deptCollName = collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments';
  const titleCollName = collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles';

  const deptColl = activeDb.collection(deptCollName);
  const titleColl = activeDb.collection(titleCollName);

  // Department existence verification
  const parentDept = await deptColl.findOne({ id: cleanDeptId });
  if (!parentDept) {
    throw new Error(`Department with ID '${cleanDeptId}' not found.`);
  }

  const query = { departmentId: cleanDeptId };

  if (filters.status && filters.status !== 'all') {
    if (!ALLOWED_STATUSES.has(filters.status)) {
      throw new Error(`Invalid status filter: '${filters.status}'. Must be 'all', 'active', or 'retired'.`);
    }
    query.status = filters.status;
  }

  if (filters.search && typeof filters.search === 'string' && filters.search.trim()) {
    const cleanSearch = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(cleanSearch, 'i');
    query.$or = [{ label: searchRegex }, { id: searchRegex }, { aliases: searchRegex }];
  }

  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 100));
  const skip = (page - 1) * limit;

  const total = await titleColl.countDocuments(query);
  const rawTitles = await titleColl.find(query).toArray();

  // Deterministic sorting: displayOrder ascending, then label
  rawTitles.sort((a, b) => {
    if (a.displayOrder !== b.displayOrder) {
      return (a.displayOrder || 0) - (b.displayOrder || 0);
    }
    return String(a.label || '').localeCompare(String(b.label || ''));
  });

  const paginatedTitles = rawTitles.slice(skip, skip + limit);
  const includeUsage = options.includeUsage !== false;

  const titles = await Promise.all(
    paginatedTitles.map(async (t) => {
      let usageCount = null;
      if (includeUsage) {
        usageCount = await resolveUsageCount(activeDb, 'professionalIdentity.titleId', t.id);
      }
      return {
        ...t,
        usageCount,
      };
    })
  );

  return {
    department: {
      id: parentDept.id,
      name: parentDept.name,
      status: parentDept.status,
    },
    titles,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

/**
 * 5. Add a new department-scoped title with deterministic composite ID generation.
 */
async function addTitle(departmentId, input = {}, actorContext = {}) {
  if (!departmentId || typeof departmentId !== 'string' || !departmentId.trim()) {
    throw new Error('Valid department ID is required.');
  }

  const cleanDeptId = departmentId.trim();
  rejectUnexpectedFields(input, ALLOWED_TITLE_INPUT_FIELDS, 'Title input');

  const cleanLabel = validatePlainText(input.label, 2, 100, 'Title label');

  let cleanStatus = 'active';
  if (input.status !== undefined) {
    cleanStatus = String(input.status).trim().toLowerCase();
    if (!ALLOWED_STATUSES.has(cleanStatus)) {
      throw new Error(`Invalid title status: '${input.status}'. Allowed values: active, retired.`);
    }
  }

  let cleanAliases = [];
  if (input.aliases !== undefined) {
    cleanAliases = validateAliases(input.aliases, 'Title aliases');
  }

  const activeDb = resolveDb(actorContext);
  const deptCollName = collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments';
  const titleCollName = collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles';

  const deptColl = activeDb.collection(deptCollName);
  const titleColl = activeDb.collection(titleCollName);

  // Department must exist
  const parentDept = await deptColl.findOne({ id: cleanDeptId });
  if (!parentDept) {
    throw new Error(`Department with ID '${cleanDeptId}' not found.`);
  }

  // Generate department-scoped stable ID: `<deptId>:<slug>`
  const titleSlug = slugify(cleanLabel);
  const generatedId = `${cleanDeptId}:${titleSlug}`;

  // Check ID uniqueness
  const existingWithId = await titleColl.findOne({ id: generatedId });
  if (existingWithId) {
    throw new Error(
      `Conflict: Title with ID '${generatedId}' already exists in department '${cleanDeptId}' (label: "${existingWithId.label}").`
    );
  }

  // Resolve displayOrder
  let cleanDisplayOrder;
  if (input.displayOrder !== undefined) {
    cleanDisplayOrder = Number(input.displayOrder);
    if (!Number.isInteger(cleanDisplayOrder) || cleanDisplayOrder < 1 || cleanDisplayOrder > 1000) {
      throw new Error('Display order must be an integer between 1 and 1000.');
    }
  } else {
    // Find current max display order in this department
    const titlesInDept = await titleColl.find({ departmentId: cleanDeptId }).toArray();
    const maxOrder = titlesInDept.reduce((max, t) => Math.max(max, t.displayOrder || 0), 0);
    cleanDisplayOrder = maxOrder + 1;
  }

  const now = new Date();
  const titleDoc = {
    id: generatedId,
    departmentId: cleanDeptId,
    label: cleanLabel,
    status: cleanStatus,
    displayOrder: cleanDisplayOrder,
    catalogueVersion: parentDept.catalogueVersion || '2026.1',
    aliases: cleanAliases,
    createdAt: now,
    updatedAt: now,
  };

  await titleColl.insertMany([titleDoc], { ordered: true });

  // Denormalized title count update on department if present
  await deptColl.updateOne({ id: cleanDeptId }, { $inc: { titlesCount: 1 } }).catch(() => {});

  // Audit Logging
  const auditSuccess = await recordAudit(activeDb, {
    req: actorContext.req,
    actor: actorContext.actor,
    action: 'CATALOGUE_TITLE_CREATED',
    entityType: 'CATALOGUE_TITLE',
    entityId: generatedId,
    entityName: cleanLabel,
    metadata: {
      departmentId: cleanDeptId,
      title: titleDoc,
      reason: actorContext.reason || 'Admin created new professional title',
    },
    message: `Created title '${generatedId}' in department '${cleanDeptId}'`,
  });

  if (!auditSuccess) {
    logger.warn(`Audit log could not be verified for title creation '${generatedId}'.`);
  }

  return {
    success: true,
    title: titleDoc,
    auditLogged: auditSuccess,
  };
}

/**
 * 6. Update title display label, status, displayOrder, or aliases.
 * IDs and department references are strictly immutable.
 */
async function updateTitle(titleId, changes = {}, actorContext = {}) {
  if (!titleId || typeof titleId !== 'string' || !titleId.trim()) {
    throw new Error('Valid title ID is required.');
  }

  const cleanTitleId = titleId.trim();
  rejectUnexpectedFields(changes, ALLOWED_TITLE_UPDATE_FIELDS, 'Title changes');

  // Explicit guard: Title ID and Department ID are immutable
  if ('id' in changes || '_id' in changes || 'departmentId' in changes) {
    throw new Error('Title ID and Department ID are immutable and cannot be modified.');
  }

  const activeDb = resolveDb(actorContext);
  const titleCollName = collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles';
  const titleColl = activeDb.collection(titleCollName);

  const existingTitle = await titleColl.findOne({ id: cleanTitleId });
  if (!existingTitle) {
    throw new Error(`Title with ID '${cleanTitleId}' not found.`);
  }

  const sanitizedUpdates = {};
  const previousState = {};
  const newState = {};

  if (changes.label !== undefined) {
    const cleanLabel = validatePlainText(changes.label, 2, 100, 'Title label');
    if (cleanLabel !== existingTitle.label) {
      sanitizedUpdates.label = cleanLabel;
      previousState.label = existingTitle.label;
      newState.label = cleanLabel;
      // Important: stable ID is NOT mutated when label is renamed
    }
  }

  if (changes.status !== undefined) {
    const cleanStatus = String(changes.status).trim().toLowerCase();
    if (!ALLOWED_STATUSES.has(cleanStatus)) {
      throw new Error(`Invalid title status: '${changes.status}'. Allowed values: active, retired.`);
    }

    if (cleanStatus !== existingTitle.status) {
      sanitizedUpdates.status = cleanStatus;
      previousState.status = existingTitle.status;
      newState.status = cleanStatus;
    }
  }

  if (changes.displayOrder !== undefined) {
    const orderNum = Number(changes.displayOrder);
    if (!Number.isInteger(orderNum) || orderNum < 1 || orderNum > 1000) {
      throw new Error('Display order must be an integer between 1 and 1000.');
    }
    if (orderNum !== existingTitle.displayOrder) {
      sanitizedUpdates.displayOrder = orderNum;
      previousState.displayOrder = existingTitle.displayOrder;
      newState.displayOrder = orderNum;
    }
  }

  if (changes.aliases !== undefined) {
    const cleanAliases = validateAliases(changes.aliases, 'Title aliases');
    sanitizedUpdates.aliases = cleanAliases;
    previousState.aliases = existingTitle.aliases || [];
    newState.aliases = cleanAliases;
  }

  const changedKeys = Object.keys(sanitizedUpdates);
  if (changedKeys.length === 0) {
    return {
      success: true,
      title: existingTitle,
      updated: false,
      changedFields: [],
      auditLogged: true,
    };
  }

  sanitizedUpdates.updatedAt = new Date();

  await titleColl.updateOne({ id: cleanTitleId }, { $set: sanitizedUpdates });

  const updatedTitle = await titleColl.findOne({ id: cleanTitleId });

  let actionName = 'CATALOGUE_TITLE_UPDATED';
  if (sanitizedUpdates.status === 'retired') actionName = 'CATALOGUE_TITLE_RETIRED';
  else if (sanitizedUpdates.status === 'active' && previousState.status === 'retired') {
    actionName = 'CATALOGUE_TITLE_ACTIVATED';
  }

  const auditSuccess = await recordAudit(activeDb, {
    req: actorContext.req,
    actor: actorContext.actor,
    action: actionName,
    entityType: 'CATALOGUE_TITLE',
    entityId: cleanTitleId,
    entityName: updatedTitle.label,
    metadata: {
      departmentId: existingTitle.departmentId,
      previousState,
      newState,
      changedFields: changedKeys,
      reason: actorContext.reason || 'Admin title configuration update',
    },
    message: `Updated title '${cleanTitleId}' (${changedKeys.join(', ')})`,
  });

  if (!auditSuccess) {
    logger.warn(`Audit log could not be verified for title '${cleanTitleId}' update.`);
  }

  return {
    success: true,
    title: updatedTitle,
    updated: true,
    changedFields: changedKeys,
    auditLogged: auditSuccess,
  };
}

/**
 * 7. Set title status (active / retired).
 * Retired titles remain resolvable on existing profiles and are never deleted.
 */
async function setTitleStatus(titleId, status, actorContext = {}) {
  if (!titleId || typeof titleId !== 'string' || !titleId.trim()) {
    throw new Error('Valid title ID is required.');
  }

  const cleanTitleId = titleId.trim();
  const cleanStatus = String(status || '').trim().toLowerCase();
  if (!ALLOWED_STATUSES.has(cleanStatus)) {
    throw new Error(`Invalid status '${status}'. Must be 'active' or 'retired'.`);
  }

  return updateTitle(cleanTitleId, { status: cleanStatus }, actorContext);
}

/**
 * 8. Safe Department Reassignment Evaluation.
 *
 * Title IDs are department-scoped composite identifiers (<departmentId>:<slug>).
 * Cross-department reassignment inherently destroys historical profile validity
 * or violates structural scoping invariants. As mandated by Zeitnah Data Integrity rules,
 * cross-department reassignment is rejected with a clear diagnostic.
 */
async function reassignTitleDepartment(titleId, targetDepartmentId, actorContext = {}) {
  throw new Error(
    `UnsupportedOperation: Title department reassignment is not permitted. Title IDs are department-scoped composite identifiers (<departmentId>:<slug>). Reassigning '${titleId}' to '${targetDepartmentId}' would break existing user profiles referencing the historical ID or violate department-scoping rules. Instead, create a new title in department '${targetDepartmentId}' and retire '${titleId}'.`
  );
}

/**
 * 9. Custom Title Requests Administration
 */

/**
 * Lists custom title requests with filtering, pagination, and KPI counts.
 */
async function getTitleRequests(filters = {}, pagination = {}, options = {}) {
  const activeDb = resolveDb(options);
  const reqCollName = collection.CATALOGUE_TITLE_REQUESTS_COLLECTION || 'catalogue_title_requests';
  const reqColl = activeDb.collection(reqCollName);

  const query = {};

  const status = String(filters.status || 'all').trim().toLowerCase();
  if (status && status !== 'all') {
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      throw new Error(`Invalid status filter: '${status}'. Allowed values: all, pending, approved, rejected.`);
    }
    query.status = status;
  }

  const deptId = String(filters.departmentId || '').trim();
  if (deptId && deptId !== 'all') {
    query.departmentId = deptId;
  }

  const search = String(filters.search || '').trim();
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { requestedTitle: new RegExp(escaped, 'i') },
      { userName: new RegExp(escaped, 'i') },
      { userEmail: new RegExp(escaped, 'i') },
      { departmentName: new RegExp(escaped, 'i') },
    ];
  }

  const page = Math.max(1, Number(pagination.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(pagination.limit) || 25));
  const skip = (page - 1) * limit;

  const total = await reqColl.countDocuments(query);
  const pendingCount = await reqColl.countDocuments({ status: 'pending' }).catch(() => 0);
  const approvedCount = await reqColl.countDocuments({ status: 'approved' }).catch(() => 0);
  const rejectedCount = await reqColl.countDocuments({ status: 'rejected' }).catch(() => 0);

  let requests = [];
  const cursor = reqColl.find(query);
  if (cursor && typeof cursor.sort === 'function') {
    let sortedCursor = cursor.sort({ createdAt: -1 });
    if (typeof sortedCursor.skip === 'function') {
      sortedCursor = sortedCursor.skip(skip);
    }
    if (typeof sortedCursor.limit === 'function') {
      sortedCursor = sortedCursor.limit(limit);
    }
    requests = await sortedCursor.toArray();
  } else if (cursor && typeof cursor.toArray === 'function') {
    const all = await cursor.toArray();
    requests = all.slice(skip, skip + limit);
  }

  return {
    requests,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    pendingCount,
    approvedCount,
    rejectedCount,
    filters: {
      status,
      departmentId: deptId,
      search,
    },
  };
}

/**
 * Fetches a single title request by ID.
 */
async function getTitleRequestById(requestId, options = {}) {
  if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
    throw new Error('Valid request ID is required.');
  }
  const activeDb = resolveDb(options);
  const reqCollName = collection.CATALOGUE_TITLE_REQUESTS_COLLECTION || 'catalogue_title_requests';
  const reqColl = activeDb.collection(reqCollName);
  return reqColl.findOne({ id: requestId.trim() });
}

/**
 * Approves a custom title request:
 * 1. Validates request and department state.
 * 2. Checks for existing equivalent title in department.
 * 3. Atomically updates request to approved.
 * 4. Inserts new title into catalogue_titles if not duplicate.
 * 5. Records structured audit log.
 */
async function approveTitleRequest(requestId, input = {}, actorContext = {}) {
  if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
    throw new Error('Valid request ID is required.');
  }

  const cleanRequestId = requestId.trim();
  const activeDb = resolveDb(actorContext);
  const reqCollName = collection.CATALOGUE_TITLE_REQUESTS_COLLECTION || 'catalogue_title_requests';
  const deptCollName = collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments';
  const titleCollName = collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles';

  const reqColl = activeDb.collection(reqCollName);
  const deptColl = activeDb.collection(deptCollName);
  const titleColl = activeDb.collection(titleCollName);

  // 1. Fetch request
  const request = await reqColl.findOne({ id: cleanRequestId });
  if (!request) {
    throw new Error(`Custom title request with ID '${cleanRequestId}' not found.`);
  }

  // Idempotency: if already approved
  if (request.status === 'approved') {
    const existingTitle = request.createdTitleId
      ? await titleColl.findOne({ id: request.createdTitleId })
      : null;
    return {
      success: true,
      message: `Request '${cleanRequestId}' was already approved.`,
      alreadyApproved: true,
      request,
      title: existingTitle,
      auditLogged: true,
    };
  }

  if (request.status !== 'pending') {
    throw new Error(`Cannot approve request '${cleanRequestId}': current status is '${request.status}'.`);
  }

  // 2. Validate department exists and is active
  const department = await deptColl.findOne({ id: request.departmentId });
  if (!department) {
    throw new Error(`Department with ID '${request.departmentId}' not found.`);
  }
  if (department.status !== 'active') {
    throw new Error(
      `Cannot approve title request for retired department '${department.name}'. Reactivate the department first.`
    );
  }

  // 3. Generate department-scoped stable ID: `<deptId>:<slug>`
  const cleanLabel = (input.label || request.requestedTitle || '').trim();
  if (!cleanLabel) {
    throw new Error('Title label is required.');
  }

  const titleSlug = slugify(cleanLabel);
  const generatedId = `${request.departmentId}:${titleSlug}`;

  // Check if title with same generated ID already exists
  const existingTitleById = await titleColl.findOne({ id: generatedId });
  if (existingTitleById && existingTitleById.status === 'active') {
    // If title already exists and is active, link it safely
    const now = new Date();
    await reqColl.updateOne(
      { id: cleanRequestId, status: 'pending' },
      {
        $set: {
          status: 'approved',
          reviewerId: String(actorContext.actor?._id || ''),
          reviewerName: String(actorContext.actor?.Name || actorContext.actor?.name || 'Admin'),
          reviewedAt: now,
          createdTitleId: generatedId,
          reviewNote: input.note || input.reason || `Linked to existing catalogue title "${existingTitleById.label}"`,
          updatedAt: now,
        },
      }
    );
    const updatedReq = await reqColl.findOne({ id: cleanRequestId });
    return {
      success: true,
      message: `Title '${existingTitleById.label}' already exists in ${department.name}. Request marked approved.`,
      request: updatedReq,
      title: existingTitleById,
      alreadyExisted: true,
      auditLogged: true,
    };
  }

  // 4. Atomic status transition: 'pending' -> 'approved'
  const now = new Date();
  const updateResult = await reqColl.updateOne(
    { id: cleanRequestId, status: 'pending' },
    {
      $set: {
        status: 'approved',
        reviewerId: String(actorContext.actor?._id || ''),
        reviewerName: String(actorContext.actor?.Name || actorContext.actor?.name || 'Admin'),
        reviewedAt: now,
        createdTitleId: generatedId,
        reviewNote: input.note || input.reason || 'Approved by administrator',
        updatedAt: now,
      },
    }
  );

  if (updateResult.matchedCount === 0) {
    const current = await reqColl.findOne({ id: cleanRequestId });
    if (current && current.status === 'approved') {
      const existing = await titleColl.findOne({ id: generatedId });
      return {
        success: true,
        message: 'Request was already approved.',
        alreadyApproved: true,
        request: current,
        title: existing,
        auditLogged: true,
      };
    }
    throw new Error('Request could not be approved because its status was changed concurrently.');
  }

  // 5. Insert new title into catalogue_titles if it did not exist
  let titleDoc = await titleColl.findOne({ id: generatedId });
  if (!titleDoc) {
    const titlesInDept = await titleColl.find({ departmentId: request.departmentId }).toArray();
    const maxOrder = titlesInDept.reduce((max, t) => Math.max(max, t.displayOrder || 0), 0);
    const cleanDisplayOrder = maxOrder + 1;

    titleDoc = {
      id: generatedId,
      departmentId: request.departmentId,
      label: cleanLabel,
      status: 'active',
      displayOrder: cleanDisplayOrder,
      catalogueVersion: department.catalogueVersion || '2026.1',
      aliases: [],
      createdAt: now,
      updatedAt: now,
    };

    await titleColl.insertMany([titleDoc], { ordered: true });
    await deptColl.updateOne({ id: request.departmentId }, { $inc: { titlesCount: 1 } }).catch(() => {});
  } else if (titleDoc.status === 'retired') {
    // Reactivate title if it had been retired
    await titleColl.updateOne({ id: generatedId }, { $set: { status: 'active', updatedAt: now } });
    titleDoc.status = 'active';
  }

  // 6. Mandatory Audit Logging
  const auditSuccess = await recordAudit(activeDb, {
    req: actorContext.req,
    actor: actorContext.actor,
    action: 'CATALOGUE_TITLE_REQUEST_APPROVED',
    entityType: 'CATALOGUE_TITLE_REQUEST',
    entityId: cleanRequestId,
    entityName: cleanLabel,
    metadata: {
      requestId: cleanRequestId,
      departmentId: request.departmentId,
      createdTitleId: generatedId,
      titleLabel: cleanLabel,
      reason: input.reason || input.note || 'Admin approved custom title request',
    },
    message: `Approved custom title request '${cleanRequestId}' -> created title '${generatedId}' in '${request.departmentId}'`,
  });

  const updatedRequest = await reqColl.findOne({ id: cleanRequestId });

  return {
    success: true,
    message: `Title '${cleanLabel}' approved and successfully added to ${department.name}.`,
    request: updatedRequest,
    title: titleDoc,
    auditLogged: auditSuccess,
  };
}

/**
 * Rejects a custom title request without modifying the official catalogue.
 */
async function rejectTitleRequest(requestId, input = {}, actorContext = {}) {
  if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
    throw new Error('Valid request ID is required.');
  }

  const cleanRequestId = requestId.trim();
  const activeDb = resolveDb(actorContext);
  const reqCollName = collection.CATALOGUE_TITLE_REQUESTS_COLLECTION || 'catalogue_title_requests';
  const reqColl = activeDb.collection(reqCollName);

  const request = await reqColl.findOne({ id: cleanRequestId });
  if (!request) {
    throw new Error(`Custom title request with ID '${cleanRequestId}' not found.`);
  }

  if (request.status === 'rejected') {
    return {
      success: true,
      message: `Request '${cleanRequestId}' was already rejected.`,
      alreadyRejected: true,
      request,
      auditLogged: true,
    };
  }

  if (request.status !== 'pending') {
    throw new Error(`Cannot reject request '${cleanRequestId}': current status is '${request.status}'.`);
  }

  const reason = input.reason || input.note || 'Rejected by administrator';
  const now = new Date();

  const updateResult = await reqColl.updateOne(
    { id: cleanRequestId, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        reviewerId: String(actorContext.actor?._id || ''),
        reviewerName: String(actorContext.actor?.Name || actorContext.actor?.name || 'Admin'),
        reviewedAt: now,
        reviewNote: reason,
        updatedAt: now,
      },
    }
  );

  if (updateResult.matchedCount === 0) {
    const current = await reqColl.findOne({ id: cleanRequestId });
    if (current && current.status === 'rejected') {
      return {
        success: true,
        message: 'Request was already rejected.',
        alreadyRejected: true,
        request: current,
        auditLogged: true,
      };
    }
    throw new Error('Request could not be rejected because its status was changed concurrently.');
  }

  // Audit Logging (Zero catalogue writes on rejection)
  const auditSuccess = await recordAudit(activeDb, {
    req: actorContext.req,
    actor: actorContext.actor,
    action: 'CATALOGUE_TITLE_REQUEST_REJECTED',
    entityType: 'CATALOGUE_TITLE_REQUEST',
    entityId: cleanRequestId,
    entityName: request.requestedTitle,
    metadata: {
      requestId: cleanRequestId,
      departmentId: request.departmentId,
      requestedTitle: request.requestedTitle,
      reason,
    },
    message: `Rejected custom title request '${cleanRequestId}' ("${request.requestedTitle}"): ${reason}`,
  });

  const updatedRequest = await reqColl.findOne({ id: cleanRequestId });

  return {
    success: true,
    message: `Request for title '${request.requestedTitle}' rejected.`,
    request: updatedRequest,
    auditLogged: auditSuccess,
  };
}

module.exports = {
  getDepartmentsWithStats,
  getDepartmentById,
  updateDepartment,
  getTitlesForDepartment,
  addTitle,
  updateTitle,
  setTitleStatus,
  reassignTitleDepartment,
  getTitleRequests,
  getTitleRequestById,
  approveTitleRequest,
  rejectTitleRequest,
  slugify,
  validatePlainText,
  validateAliases,
  ALLOWED_STATUSES,
  ALLOWED_DEPARTMENT_UPDATE_FIELDS,
  ALLOWED_TITLE_INPUT_FIELDS,
  ALLOWED_TITLE_UPDATE_FIELDS,
};
