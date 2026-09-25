/**
 * Zeitnah Admin Panel — Moderation Center Helper
 * Handles moderation reports for users, organizations, opportunities, and discussions.
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getReports = async (filters = {}) => {
  const database = db.get();
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 15), 100);
  const skip = (page - 1) * limit;

  const tab = (filters.tab || 'open').toLowerCase();
  const targetType = (filters.targetType || 'all').toUpperCase();
  const search = (filters.search || '').trim();

  const query = {};

  if (tab === 'open') {
    query.status = { $in: ['PENDING', 'pending', 'open'] };
  } else if (tab === 'under_review') {
    query.status = { $in: ['REVIEWED', 'reviewed', 'under_review'] };
  } else if (tab === 'resolved') {
    query.status = { $in: ['RESOLVED', 'resolved'] };
  } else if (tab === 'dismissed') {
    query.status = { $in: ['DISMISSED', 'dismissed'] };
  }

  if (targetType !== 'ALL') {
    query.targetType = targetType;
  }

  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    query.$or = [
      { reason: sRegex },
      { details: sRegex },
      { targetId: sRegex }
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

  // Batch lookup target names where possible
  const enrichedRecords = await Promise.all(rawRecords.map(async (r) => {
    const reporter = reporterMap.get(String(r.reporterId)) || null;
    let targetName = `Target #${r.targetId}`;

    try {
      if (r.targetType === 'USER' && ObjectId.isValid(r.targetId)) {
        const u = await database.collection(collection.STUDENTS_COLLECTION).findOne(
          { _id: new ObjectId(r.targetId) },
          { projection: { name: 1, Name: 1, username: 1 } }
        );
        if (u) targetName = `${u.name || u.Name || 'User'} (@${u.username || ''})`;
      } else if (r.targetType === 'ORGANIZATION' && ObjectId.isValid(r.targetId)) {
        const o = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne(
          { _id: new ObjectId(r.targetId) },
          { projection: { name: 1 } }
        );
        if (o) targetName = o.name;
      } else if (r.targetType === 'OPPORTUNITY' && ObjectId.isValid(r.targetId)) {
        const j = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne(
          { _id: new ObjectId(r.targetId) },
          { projection: { title: 1 } }
        );
        if (j) targetName = j.title;
      }
    } catch (e) {}

    return {
      ...r,
      reporterName: reporter ? (reporter.name || reporter.Name || reporter.username) : 'Community Member',
      reporterEmail: reporter ? reporter.email : '',
      targetName,
      statusNormalized: String(r.status || 'PENDING').toUpperCase()
    };
  }));

  return {
    records: enrichedRecords,
    total,
    page,
    totalPages: Math.ceil(total / limit) || 1,
    stats,
    tab,
    targetType
  };
};

const getModerationStats = async () => {
  const database = db.get();
  try {
    const [total, open, underReview, resolved, dismissed] = await Promise.all([
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({}),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['PENDING', 'pending', 'open'] } }),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['REVIEWED', 'reviewed', 'under_review'] } }),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['RESOLVED', 'resolved'] } }),
      database.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['DISMISSED', 'dismissed'] } })
    ]);
    return { total, open, underReview, resolved, dismissed };
  } catch (e) {
    return { total: 0, open: 0, underReview: 0, resolved: 0, dismissed: 0 };
  }
};

const updateReportStatus = async (reportId, { status, moderatorNotes = '', actionTaken = '' }, actor, req) => {
  if (!ObjectId.isValid(reportId)) throw new Error('Invalid report ID.');

  const validStatuses = ['PENDING', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
  const normalizedStatus = String(status || '').toUpperCase();
  if (!validStatuses.includes(normalizedStatus)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}.`);
  }

  const database = db.get();
  const report = await database.collection(collection.MODERATION_REPORTS_COLLECTION).findOne({ _id: new ObjectId(reportId) });
  if (!report) throw new Error('Report not found.');

  await database.collection(collection.MODERATION_REPORTS_COLLECTION).updateOne(
    { _id: new ObjectId(reportId) },
    {
      $set: {
        status: normalizedStatus,
        moderatorNotes: moderatorNotes.trim(),
        actionTaken: actionTaken.trim(),
        moderatedBy: actor?._id ? new ObjectId(actor._id) : null,
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
    message: `Moderation report marked as ${normalizedStatus}. Action taken: ${actionTaken || 'None'}`,
    metadata: {
      actor: actor?.Name || actor?.Email || 'Admin',
      reportId: String(reportId),
      targetType: report.targetType,
      targetId: report.targetId,
      actionTaken,
      moderatorNotes,
      status: normalizedStatus
    }
  });

  return { success: true, status: normalizedStatus };
};

module.exports = {
  getReports,
  getModerationStats,
  updateReportStatus
};
