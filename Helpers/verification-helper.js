/**
 * Zeitnah Admin Panel — Verification Governance Helper
 * Manages verification requests across 5 categories with evidence protection and auditability.
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const permissionsHelper = require('./permissions-helper');

const VERIFICATION_CATEGORIES = [
  'IDENTITY',
  'PROFESSIONAL',
  'BUSINESS_AFFILIATION',
  'CERTIFICATION',
  'EDUCATOR'
];

const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'EXPIRED'
];

const redactEvidence = (doc, canViewEvidence) => {
  if (!doc) return null;
  const clone = { ...doc };

  if (!canViewEvidence) {
    clone.evidenceRedacted = true;
    if (clone.evidenceUrl) clone.evidenceUrl = null;
    if (clone.documentUrl) clone.documentUrl = null;
    if (clone.attachments && Array.isArray(clone.attachments)) {
      clone.attachments = clone.attachments.map(att => ({
        name: att.name || 'Document',
        type: att.type || 'file',
        url: null,
        isProtected: true
      }));
    }
    if (clone.idNumber) {
      clone.idNumber = clone.idNumber.slice(0, 2) + '******' + clone.idNumber.slice(-2);
    }
  } else {
    clone.evidenceRedacted = false;
  }

  return clone;
};

const getVerificationRequests = async (filters = {}, admin = null) => {
  const database = db.get();
  if (!database) {
    return { records: [], total: 0, page: 1, limit: 15, totalPages: 1, stats: getEmptyStats() };
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(Number(filters.limit) || 15, 1), 100);
  const skip = (page - 1) * limit;

  const category = (filters.category || 'all').toUpperCase();
  const status = (filters.status || 'all').toUpperCase();
  const search = (filters.search || '').trim();

  const query = {};

  if (category !== 'ALL' && VERIFICATION_CATEGORIES.includes(category)) {
    query.category = category;
  }

  if (status !== 'ALL' && VERIFICATION_STATUSES.includes(status)) {
    query.status = status;
  }

  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { targetName: { $regex: escaped, $options: 'i' } },
      { targetEmail: { $regex: escaped, $options: 'i' } },
      { targetHandle: { $regex: escaped, $options: 'i' } },
      { referenceNumber: { $regex: escaped, $options: 'i' } },
      { notes: { $regex: escaped, $options: 'i' } }
    ];
  }

  const canViewEvidence = permissionsHelper.hasCapability(admin, 'view_verification_evidence');

  const [total, rawRecords, stats] = await Promise.all([
    database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments(query),
    database.collection(collection.VERIFICATION_REQUESTS_COLLECTION)
      .find(query)
      .sort({ submittedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    getVerificationStats()
  ]);

  const records = rawRecords.map(r => {
    const sanitized = redactEvidence(r, canViewEvidence);
    return {
      ...sanitized,
      canViewEvidence,
      statusClass: getStatusBadgeClass(sanitized.status),
      categoryLabel: formatCategoryLabel(sanitized.category)
    };
  });

  return {
    records,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    stats,
    canViewEvidence,
    categories: VERIFICATION_CATEGORIES,
    statuses: VERIFICATION_STATUSES,
    filters: {
      category: filters.category || 'all',
      status: filters.status || 'all',
      search: filters.search || ''
    }
  };
};

const getVerificationStats = async () => {
  const database = db.get();
  if (!database) return getEmptyStats();

  try {
    const [
      total,
      pending,
      verified,
      rejected,
      expired,
      identityCount,
      professionalCount,
      businessCount,
      certificationCount,
      educatorCount
    ] = await Promise.all([
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({}),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ status: 'PENDING' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ status: 'VERIFIED' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ status: 'REJECTED' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ status: 'EXPIRED' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ category: 'IDENTITY' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ category: 'PROFESSIONAL' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ category: 'BUSINESS_AFFILIATION' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ category: 'CERTIFICATION' }),
      database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ category: 'EDUCATOR' })
    ]);

    return {
      total,
      pending,
      verified,
      rejected,
      expired,
      byCategory: {
        IDENTITY: identityCount,
        PROFESSIONAL: professionalCount,
        BUSINESS_AFFILIATION: businessCount,
        CERTIFICATION: certificationCount,
        EDUCATOR: educatorCount
      }
    };
  } catch (err) {
    return getEmptyStats();
  }
};

const getEmptyStats = () => ({
  total: 0,
  pending: 0,
  verified: 0,
  rejected: 0,
  expired: 0,
  byCategory: {
    IDENTITY: 0,
    PROFESSIONAL: 0,
    BUSINESS_AFFILIATION: 0,
    CERTIFICATION: 0,
    EDUCATOR: 0
  }
});

const getVerificationById = async (id, admin = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid verification request ID.');
  const database = db.get();
  const request = await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!request) return null;

  const canViewEvidence = permissionsHelper.hasCapability(admin, 'view_verification_evidence');
  return {
    ...redactEvidence(request, canViewEvidence),
    canViewEvidence,
    statusClass: getStatusBadgeClass(request.status),
    categoryLabel: formatCategoryLabel(request.category)
  };
};

const reviewVerification = async (id, { status, notes = '', rejectionReason = '' }, admin, req) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid verification request ID.');
  const normalizedStatus = String(status || '').toUpperCase();
  if (!VERIFICATION_STATUSES.includes(normalizedStatus)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VERIFICATION_STATUSES.join(', ')}.`);
  }

  if (normalizedStatus === 'REJECTED' && !rejectionReason.trim()) {
    throw new Error('A rejection reason is mandatory when rejecting verification.');
  }

  const database = db.get();
  const request = await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).findOne({ _id: new ObjectId(id) });
  if (!request) throw new Error('Verification request not found.');

  const previousStatus = request.status || 'PENDING';
  const now = new Date();

  await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        status: normalizedStatus,
        reviewerNotes: notes,
        rejectionReason: normalizedStatus === 'REJECTED' ? rejectionReason : null,
        reviewedBy: {
          id: admin?._id ? String(admin._id) : '',
          name: admin?.Name || admin?.Email || 'Admin',
          role: admin?.role || 'admin'
        },
        reviewedAt: now,
        updatedAt: now
      }
    }
  );

  // Synchronize target entity (user or organization)
  if (request.targetType === 'USER' && request.targetId && ObjectId.isValid(request.targetId)) {
    const isVerified = normalizedStatus === 'VERIFIED';
    await database.collection(collection.STUDENTS_COLLECTION).updateOne(
      { _id: new ObjectId(request.targetId) },
      {
        $set: {
          verificationStatus: normalizedStatus,
          isVerified,
          'account_Status.isVerified': isVerified,
          verificationNotes: notes,
          verifiedAt: isVerified ? now : null
        }
      }
    );
  } else if (request.targetType === 'ORGANIZATION' && request.targetId && ObjectId.isValid(request.targetId)) {
    const isVerified = normalizedStatus === 'VERIFIED';
    await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
      { _id: new ObjectId(request.targetId) },
      {
        $set: {
          verificationStatus: normalizedStatus,
          verified: isVerified,
          verifiedAt: isVerified ? now : null
        }
      }
    );
  }

  await auditHelper.logAction({
    req,
    action: 'VERIFICATION_REVIEWED',
    entityType: 'VERIFICATION_REQUEST',
    entityId: String(id),
    entityName: `${request.category} Verification: ${request.targetName}`,
    status: 'success',
    message: `Verification request #${id} marked as ${normalizedStatus}`,
    metadata: {
      previousStatus,
      newStatus: normalizedStatus,
      category: request.category,
      targetId: request.targetId,
      targetType: request.targetType,
      notes,
      rejectionReason: normalizedStatus === 'REJECTED' ? rejectionReason : null,
      reviewer: admin?.Name || admin?.Email || 'Admin'
    }
  });

  return { success: true, status: normalizedStatus };
};

const getStatusBadgeClass = (status) => {
  const s = String(status || '').toUpperCase();
  switch (s) {
    case 'VERIFIED': return 'badge-status-active';
    case 'PENDING': return 'badge-status-scheduled';
    case 'REJECTED': return 'badge-status-archived';
    case 'EXPIRED': return 'badge-status-archived';
    default: return 'badge-status-draft';
  }
};

const formatCategoryLabel = (category) => {
  const c = String(category || '').toUpperCase();
  switch (c) {
    case 'IDENTITY': return 'Identity Document';
    case 'PROFESSIONAL': return 'Professional Standing';
    case 'BUSINESS_AFFILIATION': return 'Corporate Affiliation';
    case 'CERTIFICATION': return 'Accredited Certification';
    case 'EDUCATOR': return 'Educator Endorsement';
    default: return c;
  }
};

module.exports = {
  VERIFICATION_CATEGORIES,
  VERIFICATION_STATUSES,
  redactEvidence,
  getVerificationRequests,
  getVerificationStats,
  getVerificationById,
  reviewVerification,
  getStatusBadgeClass,
  formatCategoryLabel
};
