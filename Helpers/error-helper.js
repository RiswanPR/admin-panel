/**
 * Zeitnah Admin Panel — Error Reporting & Health Telemetry Helper
 * Provides error classification, deduplication, secret scrubbing, and administrative monitoring.
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const crypto = require('crypto');
const auditHelper = require('./audit-helper');

const SENSITIVE_KEY_REGEX = /(password|token|otp|secret|authorization|credential|cookie|session)/i;

const scrubString = (str) => {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, '$1[REDACTED]')
    .replace(/(password|token|otp|secret|key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/("password"|"token"|"otp"|"secret")\s*:\s*"[^"]+"/gi, '$1:"[REDACTED]"');
};

const classifyError = (error, status = 500) => {
  const code = Number(status) || 500;
  const msg = String(error?.message || error || '').toLowerCase();
  const stack = String(error?.stack || '').toLowerCase();

  if (code === 400 || code === 422 || msg.includes('validation') || msg.includes('invalid identifier')) {
    return 'Expected';
  }
  if (code === 401 || code === 403 || code === 429 || msg.includes('rate limit') || msg.includes('unauthorized') || msg.includes('access denied')) {
    return 'User Action';
  }
  if (msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('socket hang up') || msg.includes('aws') || msg.includes('resend')) {
    return 'Network';
  }
  if (msg.includes('websocket') || msg.includes('socket.io') || msg.includes('ws error')) {
    return 'WebSocket';
  }
  if (msg.includes('retry') || msg.includes('temporary') || msg.includes('timeout') && code < 500) {
    return 'Recoverable';
  }
  return 'Application';
};

const hashErrorSignature = (method, route, message) => {
  const normalizedRoute = (route || '/').split('?')[0].replace(/[0-9a-fA-F]{24}/g, ':id');
  const normalizedMsg = (message || '').slice(0, 100).toLowerCase().trim();
  return crypto.createHash('sha256').update(`${method}:${normalizedRoute}:${normalizedMsg}`).digest('hex');
};

const recordError = async ({ req = null, error, category = null, status = 500 }) => {
  try {
    const database = db.get();
    if (!database) return null;

    const message = scrubString(error?.message || String(error || 'Unknown Application Error'));
    const stack = scrubString(error?.stack || '');
    const route = req?.originalUrl || req?.path || 'background_job';
    const method = req?.method || 'INTERNAL';
    const determinedCategory = category || classifyError(error, status);
    const signature = hashErrorSignature(method, route, message);

    const actor = req?.session?.admin || req?.session?.teacher || null;
    const actorId = actor?._id ? String(actor._id) : null;
    const actorEmail = actor?.Email || actor?.email || null;

    const existing = await database.collection(collection.ERROR_REPORTS_COLLECTION).findOne({
      signature,
      status: { $in: ['UNRESOLVED', 'INVESTIGATING'] }
    });

    const now = new Date();

    if (existing) {
      const affectedSet = new Set(existing.affectedUserIds || []);
      if (actorId) affectedSet.add(actorId);

      await database.collection(collection.ERROR_REPORTS_COLLECTION).updateOne(
        { _id: existing._id },
        {
          $inc: { frequency: 1 },
          $set: {
            lastOccurred: now,
            latestStatus: Number(status) || 500,
            affectedUsersCount: affectedSet.size,
            affectedUserIds: Array.from(affectedSet).slice(0, 50)
          }
        }
      );
      return existing._id;
    }

    const report = {
      signature,
      category: determinedCategory,
      route,
      method,
      message,
      stack,
      statusCode: Number(status) || 500,
      frequency: 1,
      affectedUsersCount: actorId ? 1 : 0,
      affectedUserIds: actorId ? [actorId] : [],
      lastActorEmail: actorEmail,
      status: 'UNRESOLVED',
      firstOccurred: now,
      lastOccurred: now,
      createdAt: now
    };

    const result = await database.collection(collection.ERROR_REPORTS_COLLECTION).insertOne(report);
    return result.insertedId;
  } catch (err) {
    // Fail safely so error recording never crashes the application
    return null;
  }
};

const getErrorReports = async (filters = {}) => {
  try {
    const database = db.get();
    if (!database) {
      return { records: [], total: 0, page: 1, limit: 20, totalPages: 1, stats: getEmptyStats() };
    }

    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(Math.max(Number(filters.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const category = (filters.category || 'all').toLowerCase();
    const status = (filters.status || 'all').toUpperCase();
    const search = (filters.search || '').trim();

    const query = {};

    if (category !== 'all') {
      query.category = { $regex: new RegExp(`^${category}$`, 'i') };
    }

    if (status !== 'ALL') {
      query.status = status;
    }

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { message: { $regex: escaped, $options: 'i' } },
        { route: { $regex: escaped, $options: 'i' } },
        { category: { $regex: escaped, $options: 'i' } }
      ];
    }

    const [total, records, stats] = await Promise.all([
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments(query),
      database.collection(collection.ERROR_REPORTS_COLLECTION)
        .find(query)
        .sort({ lastOccurred: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      getErrorStats()
    ]);

    return {
      records: records.map(r => ({
        ...r,
        relativeTime: formatRelativeTime(r.lastOccurred),
        isApplicationCritical: r.category === 'Application' && r.statusCode >= 500
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      stats,
      filters: {
        category: filters.category || 'all',
        status: filters.status || 'all',
        search: filters.search || ''
      }
    };
  } catch (err) {
    return { records: [], total: 0, page: 1, limit: 20, totalPages: 1, stats: getEmptyStats() };
  }
};

const getErrorStats = async () => {
  try {
    const database = db.get();
    if (!database) return getEmptyStats();

    const [total, unresolved, application, network, userAction, recoverable, expected] = await Promise.all([
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({}),
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ status: 'UNRESOLVED' }),
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ category: 'Application' }),
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ category: 'Network' }),
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ category: 'User Action' }),
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ category: 'Recoverable' }),
      database.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ category: 'Expected' })
    ]);

    return { total, unresolved, application, network, userAction, recoverable, expected };
  } catch (err) {
    return getEmptyStats();
  }
};

const getEmptyStats = () => ({
  total: 0,
  unresolved: 0,
  application: 0,
  network: 0,
  userAction: 0,
  recoverable: 0,
  expected: 0
});

const formatRelativeTime = (date) => {
  if (!date) return 'Recently';
  const diffSec = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

const updateErrorStatus = async (reportId, newStatus, admin, req) => {
  if (!ObjectId.isValid(reportId)) throw new Error('Invalid error report ID.');
  const validStatuses = ['UNRESOLVED', 'INVESTIGATING', 'RESOLVED', 'IGNORED'];
  const statusUpper = String(newStatus || '').toUpperCase();
  if (!validStatuses.includes(statusUpper)) {
    throw new Error(`Invalid error status: ${newStatus}. Must be one of: ${validStatuses.join(', ')}.`);
  }

  const database = db.get();
  const report = await database.collection(collection.ERROR_REPORTS_COLLECTION).findOne({ _id: new ObjectId(reportId) });
  if (!report) throw new Error('Error report not found.');

  await database.collection(collection.ERROR_REPORTS_COLLECTION).updateOne(
    { _id: new ObjectId(reportId) },
    {
      $set: {
        status: statusUpper,
        resolvedBy: admin?.Name || admin?.Email || 'Admin',
        resolvedAt: new Date()
      }
    }
  );

  await auditHelper.logAction({
    req,
    action: 'ERROR_REPORT_STATUS_UPDATED',
    entityType: 'ERROR_REPORT',
    entityId: String(reportId),
    entityName: report.route || 'Application Error',
    status: 'success',
    message: `Error report #${reportId} status updated to ${statusUpper}`,
    metadata: {
      previousStatus: report.status,
      newStatus: statusUpper,
      route: report.route,
      category: report.category
    }
  });

  return { success: true, status: statusUpper };
};

const validateObjectIds = (paramNames) => {
  return (req, res, next) => {
    for (const name of paramNames) {
      const value = req.params?.[name] || req.body?.[name] || req.query?.[name];
      if (value && !ObjectId.isValid(value)) {
        if (req.xhr || req.headers?.accept?.indexOf('json') > -1 || req.method === 'POST') {
          return res.status(400).json({ success: false, message: `Invalid parameter: ${name}`, error: `Invalid ID format for ${name}` });
        }
        return res.status(400).render('error', { message: `Invalid identifier: ${name}` });
      }
    }
    next();
  };
};

module.exports = {
  classifyError,
  hashErrorSignature,
  recordError,
  getErrorReports,
  getErrorStats,
  updateErrorStatus,
  validateObjectIds
};
