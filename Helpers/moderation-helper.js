/**
 * Zeitnah Admin Panel — Moderation Center Helper
 * Handles moderation reports for users, profiles, messages, jobs, businesses, portfolios, and verification issues.
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');

const MODERATION_TARGET_TYPES = [
  'USER',
  'PROFILE',
  'MESSAGE',
  'JOB',
  'BUSINESS',
  'PORTFOLIO',
  'VERIFICATION_ISSUE'
];

const MODERATION_LIFECYCLE_STATUSES = [
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED',
  'DISMISSED'
];

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeTargetType = (type) => {
  const t = String(type || '').toUpperCase();
  if (t === 'ORGANIZATION') return 'BUSINESS';
  if (t === 'OPPORTUNITY') return 'JOB';
  return t;
};

const getReports = async (filters = {}) => {
  const database = db.get();
  if (!database) {
    return { records: [], total: 0, page: 1, limit: 15, totalPages: 1, stats: getEmptyStats(), tab: 'open', targetType: 'all' };
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 15), 100);
  const skip = (page - 1) * limit;

  const tab = (filters.tab || 'open').toLowerCase();
  const rawTargetType = (filters.targetType || 'all').toUpperCase();
  const search = (filters.search || '').trim();

  const query = {};

  if (tab === 'open') {
    query.status = { $in: ['PENDING', 'pending', 'open', 'OPEN'] };
  } else if (tab === 'under_review') {
    query.status = { $in: ['REVIEWED', 'reviewed', 'under_review', 'UNDER_REVIEW'] };
  } else if (tab === 'resolved') {
    query.status = { $in: ['RESOLVED', 'resolved'] };
  } else if (tab === 'dismissed') {
    query.status = { $in: ['DISMISSED', 'dismissed'] };
  }

  if (rawTargetType !== 'ALL') {
    if (rawTargetType === 'BUSINESS') {
      query.targetType = { $in: ['BUSINESS', 'ORGANIZATION'] };
    } else if (rawTargetType === 'JOB') {
      query.targetType = { $in: ['JOB', 'OPPORTUNITY'] };
    } else {
      query.targetType = rawTargetType;
    }
  }

  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    query.$or = [
      { reason: sRegex },
      { details: sRegex },
      { targetId: sRegex },
      { targetName: sRegex }
    ];
  }

  const [total, rawRecords, stats] = await Promise.all([
    database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments(query),
    database.collection(collection.MODERATION_REPORTS_COLLECTION)
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    getModerationStats()
  ]);

  // Enrich with reporter information and target name
  const reporterIds = rawRecords.map(r => r.reporterId).filter(Boolean).map(id => {
    try { return new ObjectId(id); } catch(e) { return null; }
  }).filter(Boolean);

  const reporters = reporterIds.length ? await database.collection(collection.STUDENTS_COLLECTION)
    .find({ _id: { $in: reporterIds } }, { projection: { _id: 1, name: 1, Name: 1, username: 1, email: 1 } })
    .toArray() : [];

  const reporterMap = new Map(reporters.map(r => [String(r._id), r]));

  // Batch lookup target names across categories
  const enrichedRecords = await Promise.all(rawRecords.map(async (r) => {
    const reporter = reporterMap.get(String(r.reporterId)) || null;
    const normalizedType = normalizeTargetType(r.targetType);
    let targetName = r.targetName || `Target #${r.targetId}`;

    try {
      if ((normalizedType === 'USER' || normalizedType === 'PROFILE') && ObjectId.isValid(r.targetId)) {
        const u = await database.collection(collection.STUDENTS_COLLECTION).findOne(
          { _id: new ObjectId(r.targetId) },
          { projection: { name: 1, Name: 1, username: 1, email: 1 } }
        );
        if (u) targetName = `${u.name || u.Name || 'User'} (@${u.username || 'user'})`;
      } else if (normalizedType === 'BUSINESS' && ObjectId.isValid(r.targetId)) {
        const o = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne(
          { _id: new ObjectId(r.targetId) },
          { projection: { name: 1 } }
        );
        if (o) targetName = o.name;
      } else if (normalizedType === 'JOB' && ObjectId.isValid(r.targetId)) {
        const j = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne(
          { _id: new ObjectId(r.targetId) },
          { projection: { title: 1 } }
        );
        if (j) targetName = j.title;
      } else if (normalizedType === 'PORTFOLIO' && ObjectId.isValid(r.targetId)) {
        targetName = `Portfolio Item #${r.targetId.slice(-6)}`;
      } else if (normalizedType === 'MESSAGE') {
        targetName = `Direct Message Thread #${String(r.targetId).slice(-6)}`;
      } else if (normalizedType === 'VERIFICATION_ISSUE') {
        targetName = `Verification Discrepancy #${String(r.targetId).slice(-6)}`;
      }
    } catch (e) {}

    let normalizedStatus = 'OPEN';
    const rawStatus = String(r.status || '').toUpperCase();
    if (['PENDING', 'OPEN'].includes(rawStatus)) normalizedStatus = 'OPEN';
    else if (['REVIEWED', 'UNDER_REVIEW'].includes(rawStatus)) normalizedStatus = 'UNDER_REVIEW';
    else if (rawStatus === 'RESOLVED') normalizedStatus = 'RESOLVED';
    else if (rawStatus === 'DISMISSED') normalizedStatus = 'DISMISSED';

    return {
      ...r,
      targetType: normalizedType,
      reporterName: reporter ? (reporter.name || reporter.Name || reporter.username) : (r.reporterName || 'Community Member'),
      reporterEmail: reporter ? reporter.email : '',
      targetName,
      statusNormalized: normalizedStatus
    };
  }));

  return {
    records: enrichedRecords,
    total,
    page,
    totalPages: Math.ceil(total / limit) || 1,
    stats,
    tab,
    targetType: rawTargetType,
    targetTypes: MODERATION_TARGET_TYPES
  };
};

const getModerationStats = async () => {
  const database = db.get();
  if (!database) return getEmptyStats();

  try {
    const [total, open, underReview, resolved, dismissed] = await Promise.all([
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({}),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['PENDING', 'pending', 'open', 'OPEN'] } }),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['REVIEWED', 'reviewed', 'under_review', 'UNDER_REVIEW'] } }),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['RESOLVED', 'resolved'] } }),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['DISMISSED', 'dismissed'] } })
    ]);
    return { total, open, underReview, resolved, dismissed };
  } catch (e) {
    return getEmptyStats();
  }
};

const getEmptyStats = () => ({
  total: 0,
  open: 0,
  underReview: 0,
  resolved: 0,
  dismissed: 0
});

const updateReportStatus = async (reportId, { status, moderatorNotes = '', actionTaken = '' }, actor, req) => {
  if (!ObjectId.isValid(reportId)) throw new Error('Invalid report ID.');

  const validStatuses = ['OPEN', 'PENDING', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
  const normalizedStatus = String(status || '').toUpperCase();
  if (!validStatuses.includes(normalizedStatus)) {
    throw new Error(`Invalid status: ${status}. Must be one of: OPEN, UNDER_REVIEW, RESOLVED, DISMISSED.`);
  }

  const database = db.get();
  const report = await database.collection(collection.MODERATION_REPORTS_COLLECTION).findOne({ _id: new ObjectId(reportId) });
  if (!report) throw new Error('Report not found.');

  const canonicalStatus = normalizedStatus === 'PENDING' ? 'OPEN' : normalizedStatus;

  await database.collection(collection.MODERATION_REPORTS_COLLECTION).updateOne(
    { _id: new ObjectId(reportId) },
    {
      $set: {
        status: canonicalStatus,
        moderatorNotes: moderatorNotes.trim(),
        actionTaken: actionTaken.trim(),
        moderatedBy: actor?._id ? new ObjectId(actor._id) : null,
        moderatorName: actor?.Name || actor?.Email || 'Admin',
        moderatedAt: new Date(),
        updatedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'MODERATION_ACTION',
    entityType: 'MODERATION_REPORT',
    entityId: String(reportId),
    entityName: `Report on ${report.targetType} #${report.targetId}`,
    status: 'success',
    message: `Moderation report marked as ${canonicalStatus}. Action taken: ${actionTaken || 'None'}`,
    metadata: {
      actor: actor?.Name || actor?.Email || 'Admin',
      reportId: String(reportId),
      targetType: report.targetType,
      targetId: report.targetId,
      actionTaken,
      moderatorNotes,
      status: canonicalStatus
    }
  });

  return { success: true, status: canonicalStatus };
};

module.exports = {
  MODERATION_TARGET_TYPES,
  MODERATION_LIFECYCLE_STATUSES,
  getReports,
  getModerationStats,
  updateReportStatus
};
