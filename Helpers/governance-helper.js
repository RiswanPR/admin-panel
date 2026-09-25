/**
 * Zeitnah Admin Panel — Governance Helper
 * Handles Network User Roles, Verification, Business Review, Integrity Signals, and Job Moderation.
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─────────────────────────────────────────────────────────
// 1. NETWORK USER & ROLE ADMINISTRATION
// ─────────────────────────────────────────────────────────

const ALLOWED_PROFILE_ROLES = ['STUDENT', 'EDUCATOR', 'PROFESSIONAL', 'MENTOR', 'RECRUITER', 'FOUNDER'];

const assignUserRole = async (userId, newRole, actor, req) => {
  if (!ObjectId.isValid(userId)) {
    throw new Error('Invalid user ID.');
  }

  const normalizedRole = String(newRole || '').toUpperCase();
  if (!ALLOWED_PROFILE_ROLES.includes(normalizedRole)) {
    throw new Error(`Invalid role: ${newRole}. Must be one of: ${ALLOWED_PROFILE_ROLES.join(', ')}.`);
  }

  const database = db.get();
  const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(userId) });
  if (!user) {
    throw new Error('User not found.');
  }

  const previousRole = String(user.primaryRole || user.role || 'STUDENT').toUpperCase();
  if (previousRole === normalizedRole) {
    return { success: true, message: `User is already ${normalizedRole}`, user };
  }

  // Enforce server-side educator guard
  const isEducatorChange = normalizedRole === 'EDUCATOR' || previousRole === 'EDUCATOR';
  const actionType = normalizedRole === 'EDUCATOR' ? 'USER_ROLE_ASSIGNED' : (previousRole === 'EDUCATOR' ? 'USER_ROLE_REVOKED' : 'USER_ROLE_UPDATED');

  const updateDoc = {
    $set: {
      primaryRole: normalizedRole,
      role: normalizedRole.toLowerCase(),
      updatedAt: new Date()
    }
  };

  // If assigning educator, initialize educator context if missing
  if (normalizedRole === 'EDUCATOR' && !user.educatorContext) {
    updateDoc.$set.educatorContext = {
      assignedBy: actor?._id ? String(actor._id) : 'admin',
      assignedAt: new Date(),
      verifiedByAdmin: true
    };
  }

  await database.collection(collection.STUDENTS_COLLECTION).updateOne(
    { _id: new ObjectId(userId) },
    updateDoc
  );

  // Synchronize community profile if exists
  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).updateOne(
    { userId: new ObjectId(userId) },
    { $set: { primaryRole: normalizedRole, role: normalizedRole.toLowerCase(), updatedAt: new Date() } }
  ).catch(() => {});

  // AUDIT LOGGING (Strictly Required)
  await auditHelper.logAction({
    req,
    action: actionType,
    entityType: 'USER',
    entityId: String(userId),
    entityName: user.name || user.Name || user.username || 'User',
    status: 'success',
    message: `Admin assigned role ${normalizedRole} to user (previous: ${previousRole})`,
    metadata: {
      actor: actor?.Name || actor?.name || actor?.Email || 'Admin',
      actorId: actor?._id ? String(actor._id) : '',
      target: 'user',
      targetUserId: String(userId),
      targetUsername: user.username || '',
      role: normalizedRole,
      previousRole,
      isEducatorChange,
      timestamp: new Date()
    }
  });

  return { success: true, previousRole, newRole: normalizedRole };
};

const updateUserVerification = async (userId, { status, notes = '' }, actor, req) => {
  if (!ObjectId.isValid(userId)) {
    throw new Error('Invalid user ID.');
  }

  const validStatuses = ['UNVERIFIED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'];
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
      reviewedBy: actor?.Name || actor?.Email || 'Admin'
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
    query.status = { $in: ['PENDING', 'pending'] };
  } else if (tab === 'approved') {
    query.status = { $in: ['APPROVED', 'approved'] };
  } else if (tab === 'rejected') {
    query.status = { $in: ['REJECTED', 'rejected'] };
  } else if (tab === 'suspended') {
    query.status = { $in: ['SUSPENDED', 'suspended'] };
  }

  if (filters.industry && filters.industry !== 'all') {
    query.industry = filters.industry;
  }

  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    query.$or = [
      { name: sRegex },
      { slug: sRegex },
      { industry: sRegex },
      { location: sRegex },
      { businessEmail: sRegex }
    ];
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

  // Populate owner details for each business
  const ownerIds = records.map(b => b.createdBy).filter(Boolean).map(id => {
    try { return new ObjectId(id); } catch(e) { return null; }
  }).filter(Boolean);

  const owners = ownerIds.length ? await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: ownerIds } }, { projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1, role: 1 } })
    .toArray() : [];

  const ownerMap = new Map(owners.map(o => [String(o._id), o]));

  const enrichedRecords = records.map(b => {
    const owner = ownerMap.get(String(b.createdBy)) || null;
    return {
      ...b,
      ownerName: owner ? (owner.name || owner.Name || owner.username) : 'Platform User',
      ownerEmail: owner ? (owner.email || owner.Email) : '',
      ownerRole: owner ? (owner.primaryRole || owner.role || 'Recruiter') : 'Member',
      statusNormalized: String(b.status || 'PENDING').toUpperCase()
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
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['PENDING', 'pending'] } }),
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['APPROVED', 'approved'] } }),
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['REJECTED', 'rejected'] } }),
      database.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['SUSPENDED', 'suspended'] } })
    ]);
    return { total, pending, approved, rejected, suspended };
  } catch (e) {
    return { total: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 };
  }
};

const getBusinessById = async (id) => {
  if (!ObjectId.isValid(id)) return null;
  const database = db.get();

  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!business) return null;

  // Fetch owner
  let owner = null;
  if (business.createdBy && ObjectId.isValid(business.createdBy)) {
    owner = await database.collection(collection.STUDENTS_COLLECTION).findOne(
      { _id: new ObjectId(business.createdBy) },
      { projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1, role: 1, Phone_Number: 1, createdAt: 1 } }
    );
  }

  // Fetch jobs count for this business
  const jobsCount = await database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({
    organizationId: new ObjectId(id)
  });

  // Fetch audit history for this business
  const auditLogs = await database.collection(collection.AUDIT_LOG_COLLECTION)
    .find({ entityType: 'BUSINESS', entityId: String(id) })
    .sort({ createdAt: -1 })
    .limit(15)
    .toArray();

  // Fraud and integrity signals
  const integritySignals = await calculateBusinessIntegritySignals(business);

  return {
    business: {
      ...business,
      statusNormalized: String(business.status || 'PENDING').toUpperCase()
    },
    owner,
    jobsCount,
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
        message: `Identical business name matches ${duplicateCount} other organization(s).`
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
  if (!ObjectId.isValid(id)) throw new Error('Invalid business ID.');
  const database = db.get();

  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!business) throw new Error('Business not found.');

  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
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

  return { success: true };
};

const rejectBusiness = async (id, reason, actor, req) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid business ID.');
  if (!reason || !reason.trim()) throw new Error('Rejection reason is mandatory.');

  const database = db.get();
  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!business) throw new Error('Business not found.');

  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
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
          rejectedBy: actor?.Name || actor?.Email || 'Admin',
          rejectedAt: new Date()
        }
      }
    }
  );

  await auditHelper.logAction({
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

  return { success: true };
};

const suspendBusiness = async (id, reason, actor, req) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid business ID.');
  if (!reason || !reason.trim()) throw new Error('Suspension reason is mandatory.');

  const database = db.get();
  const business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!business) throw new Error('Business not found.');

  await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
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
  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateMany(
    { organizationId: new ObjectId(id), status: 'PUBLISHED' },
    { $set: { status: 'PAUSED', pausedReason: 'Business suspended by administration' } }
  );

  await auditHelper.logAction({
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
      newStatus: 'SUSPENDED'
    }
  });

  return { success: true };
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
  } else if (tab === 'closed') {
    query.status = { $in: ['CLOSED', 'closed', 'ARCHIVED', 'archived'] };
  } else if (tab === 'flagged') {
    query.$or = [
      { moderationStatus: 'FLAGGED' },
      { isFlagged: true }
    ];
  } else if (tab === 'reported') {
    // Check jobs with active reports
    const reportTargetIds = await database.collection(collection.MODERATION_REPORTS_COLLECTION)
      .distinct('targetId', { targetType: 'OPPORTUNITY', status: { $in: ['PENDING', 'pending', 'open'] } });
    const objectIds = reportTargetIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
    query._id = { $in: objectIds };
  }

  if (filters.discipline && filters.discipline !== 'all') {
    query.discipline = filters.discipline;
  }
  if (filters.sector && filters.sector !== 'all') {
    query.infrastructureSector = filters.sector;
  }

  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    query.$or = [
      { title: sRegex },
      { discipline: sRegex },
      { infrastructureSector: sRegex },
      { location: sRegex }
    ];
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

  // Populate organization name for jobs
  const orgIds = records.map(j => j.organizationId).filter(Boolean).map(id => {
    try { return new ObjectId(id); } catch(e) { return null; }
  }).filter(Boolean);

  const orgs = orgIds.length ? await database.collection(collection.ORGANIZATIONS_COLLECTION)
    .find({ _id: { $in: orgIds } }, { projection: { _id: 1, name: 1, logo: 1, status: 1 } })
    .toArray() : [];

  const orgMap = new Map(orgs.map(o => [String(o._id), o]));

  const enrichedRecords = records.map(j => {
    const org = orgMap.get(String(j.organizationId)) || null;
    return {
      ...j,
      businessName: org ? org.name : 'Unknown Business',
      businessStatus: org ? org.status : 'UNKNOWN',
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
    const [total, published, draft, closed, flagged] = await Promise.all([
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({}),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['PUBLISHED', 'published'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['DRAFT', 'draft'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['CLOSED', 'closed', 'ARCHIVED', 'archived'] } }),
      database.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ $or: [{ moderationStatus: 'FLAGGED' }, { isFlagged: true }] })
    ]);
    return { total, published, draft, closed, flagged };
  } catch(e) {
    return { total: 0, published: 0, draft: 0, closed: 0, flagged: 0 };
  }
};

const getJobById = async (id) => {
  if (!ObjectId.isValid(id)) return null;
  const database = db.get();

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!job) return null;

  // Fetch business info
  let business = null;
  if (job.organizationId && ObjectId.isValid(job.organizationId)) {
    business = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: new ObjectId(job.organizationId) });
  }

  // Fetch creator info
  let creator = null;
  if (job.createdBy && ObjectId.isValid(job.createdBy)) {
    creator = await database.collection(collection.STUDENTS_COLLECTION).findOne(
      { _id: new ObjectId(job.createdBy) },
      { projection: { _id: 1, name: 1, Name: 1, email: 1, Email: 1, username: 1, primaryRole: 1 } }
    );
  }

  // Aggregate application data (Privacy preserving: aggregate metrics only)
  const applicationStats = await getJobApplicationsAggregate(id);

  // Match metrics
  const matchesCount = await database.collection(collection.JOB_TALENT_MATCHES_COLLECTION).countDocuments({
    jobId: new ObjectId(id)
  });

  // Moderation checklist signals
  const moderationSignals = {
    missingDescription: !job.description || job.description.length < 50,
    noSkillsListed: (!job.requiredSkills || job.requiredSkills.length === 0) && (!job.skills || job.skills.length === 0),
    noSoftwareListed: !job.requiredSoftware || job.requiredSoftware.length === 0,
    isBusinessUnverified: business && business.status !== 'APPROVED',
    isFlagged: job.moderationStatus === 'FLAGGED' || job.isFlagged === true
  };

  return {
    job: {
      ...job,
      statusNormalized: String(job.status || 'PUBLISHED').toUpperCase()
    },
    business,
    creator,
    applicationStats,
    matchesCount,
    moderationSignals
  };
};

const getJobApplicationsAggregate = async (jobId) => {
  if (!ObjectId.isValid(jobId)) return { total: 0, statuses: {} };
  const database = db.get();

  try {
    const aggr = await database.collection(collection.JOB_APPLICATIONS_COLLECTION).aggregate([
      { $match: { jobId: new ObjectId(jobId) } },
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
      jobId: new ObjectId(jobId),
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

const unpublishJob = async (id, reason = '', actor, req) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid job ID.');
  const database = db.get();

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        status: 'PAUSED',
        moderationStatus: 'UNPUBLISHED_BY_ADMIN',
        adminNotes: reason,
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'JOB_UNPUBLISHED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job unpublished by admin. Reason: ${reason || 'Administrative action'}`,
    metadata: {
      actor: actor?.Name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason,
      previousStatus: job.status
    }
  });

  return { success: true };
};

const closeJob = async (id, reason = '', actor, req) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid job ID.');
  const database = db.get();

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
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
    req,
    action: 'JOB_CLOSED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job closed by admin`,
    metadata: {
      actor: actor?.Name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason
    }
  });

  return { success: true };
};

const restoreJob = async (id, actor, req) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid job ID.');
  const database = db.get();

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        isFlagged: false,
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'JOB_RESTORED',
    entityType: 'JOB',
    entityId: String(id),
    entityName: job.title,
    status: 'success',
    message: `Job restored to published state by admin`,
    metadata: {
      actor: actor?.Name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title
    }
  });

  return { success: true };
};

const flagJob = async (id, reason = '', actor, req) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid job ID.');
  const database = db.get();

  const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!job) throw new Error('Job not found.');

  await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
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
      actor: actor?.Name || actor?.Email || 'Admin',
      jobId: String(id),
      jobTitle: job.title,
      reason
    }
  });

  return { success: true };
};

module.exports = {
  assignUserRole,
  updateUserVerification,
  getBusinesses,
  getBusinessStats,
  getBusinessById,
  calculateBusinessIntegritySignals,
  approveBusiness,
  rejectBusiness,
  suspendBusiness,
  getJobs,
  getJobStats,
  getJobById,
  getJobApplicationsAggregate,
  unpublishJob,
  closeJob,
  restoreJob,
  flagJob
};
