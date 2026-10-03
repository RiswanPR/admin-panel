/**
 * Zeitnah Admin Panel — Community Operations & Analytics Helper
 * Phase 4 — High-performance, read-only operational metrics and aggregations.
 *
 * Implements:
 * - Bounded date-range validation (today, 7d, 30d, 90d, custom)
 * - Community Snapshot metrics (posts, comments, stories, reports, moderation actions)
 * - Date-based activity trend aggregation (Chart.js compatible continuous bins)
 * - Verified engagement metrics (reactions, comments per post, polls)
 * - Moderation workload and health metrics (statuses, entity types, reasons, actions)
 * - Content lifecycle breakdown (active, locked, pinned, expired, soft-deleted)
 * - Unified recent operational activity feed with safe entity links
 * - Zero hard deletes: All queries strictly read-only
 * - Zero NaN / null / undefined: Graceful zero-data states
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const logger = require('./logger');

// ============================================================================
// DATE RANGE PARSER & VALIDATOR
// ============================================================================

/**
 * Parses and validates query date parameters.
 * Enforces bounded maximum range (365 days) and safe fallbacks.
 * Never throws application exceptions.
 */
const parseDateRange = (query = {}) => {
  const rangeKey = String(query.range || '7d').toLowerCase();
  const now = new Date();

  let startDate;
  let endDate = new Date(now.getTime());
  let isValid = true;
  let validationError = null;

  if (rangeKey === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (rangeKey === '30d') {
    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (rangeKey === '90d') {
    startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else if (rangeKey === 'custom') {
    const rawStart = query.startDate ? new Date(query.startDate) : null;
    const rawEnd = query.endDate ? new Date(query.endDate) : null;

    if (!rawStart || isNaN(rawStart.getTime()) || !rawEnd || isNaN(rawEnd.getTime())) {
      isValid = false;
      validationError = 'Please provide valid start and end dates.';
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      endDate = new Date(now.getTime());
    } else if (rawStart.getTime() > rawEnd.getTime()) {
      isValid = false;
      validationError = 'Start date cannot be after end date.';
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      endDate = new Date(now.getTime());
    } else {
      const diffMs = rawEnd.getTime() - rawStart.getTime();
      const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
      const MAX_DAYS = 365;

      if (diffDays > MAX_DAYS) {
        isValid = false;
        validationError = `Date range cannot exceed ${MAX_DAYS} days. Reset to 30 days.`;
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        endDate = new Date(now.getTime());
      } else {
        startDate = new Date(rawStart.setHours(0, 0, 0, 0));
        endDate = new Date(rawEnd.setHours(23, 59, 59, 999));
      }
    }
  } else {
    // Default: '7d'
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }

  const formatDateStr = (d) => {
    try {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    } catch {
      return '';
    }
  };

  const daysDiff = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)));

  return {
    rangeKey: isValid ? (['today', '7d', '30d', '90d', 'custom'].includes(rangeKey) ? rangeKey : '7d') : '7d',
    startDate,
    endDate,
    startDateStr: formatDateStr(startDate),
    endDateStr: formatDateStr(endDate),
    daysDiff,
    isValid,
    validationError
  };
};

/**
 * Builds a query clause matching both native BSON Dates and ISO date strings.
 */
const buildDateFilter = (field = 'createdAt', startDate, endDate) => {
  if (!startDate && !endDate) return {};
  const conds = [];
  if (startDate) {
    conds.push({
      $or: [
        { [field]: { $gte: startDate } },
        { [field]: { $gte: startDate.toISOString() } }
      ]
    });
  }
  if (endDate) {
    conds.push({
      $or: [
        { [field]: { $lte: endDate } },
        { [field]: { $lte: endDate.toISOString() } }
      ]
    });
  }
  if (conds.length === 1) return conds[0];
  return { $and: conds };
};

// ============================================================================
// AUTHOR / USER RESOLUTION HELPER
// ============================================================================

/**
 * Resolves user/admin names safely from students/users collection without leaking secrets
 */
const lookupUserNamesMap = async (database, rawIds) => {
  const ids = [...new Set((rawIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const objectIds = [];
  const stringIds = [];

  for (const id of ids) {
    if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) {
      objectIds.push(new ObjectId(id));
    }
    stringIds.push(id);
  }

  const query = { $or: [] };
  if (objectIds.length) query.$or.push({ _id: { $in: objectIds } });
  if (stringIds.length) query.$or.push({ _id: { $in: stringIds } });

  if (!query.$or.length) return new Map();

  try {
    const users = await database.collection(collection.STUDENTS_COLLECTION)
      .find(query, {
        projection: {
          _id: 1,
          name: 1,
          Name: 1,
          username: 1,
          email: 1,
          Email: 1,
          avatar: 1,
          role: 1
        }
      })
      .toArray();

    const map = new Map();
    for (const u of users) {
      const uId = String(u._id);
      map.set(uId, {
        id: uId,
        name: u.Name || u.name || u.username || 'Community Member',
        username: u.username || 'user',
        avatar: u.avatar || null,
        role: u.role || 'student'
      });
    }
    return map;
  } catch (err) {
    logger.warn('lookupUserNamesMap warning:', err.message);
    return new Map();
  }
};

// ============================================================================
// 1. COMMUNITY SNAPSHOT
// ============================================================================

/**
 * Aggregates core operational snapshot metrics for the selected time window.
 */
const getCommunitySnapshot = async (database, { startDate, endDate }) => {
  const now = new Date();
  const createdDateFilter = buildDateFilter('createdAt', startDate, endDate);
  const updatedDateFilter = buildDateFilter('updatedAt', startDate, endDate);

  try {
    const [
      totalPosts,
      newPosts,
      totalComments,
      newComments,
      activeStories,
      newStories,
      totalReports,
      newReports,
      resolvedReports,
      resolvedInPeriod,
      pendingReports,
      totalModActions,
      actionsInPeriod
    ] = await Promise.all([
      // Posts (active all-time vs new in period)
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .countDocuments({ isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .countDocuments({ isDeleted: { $ne: true }, ...createdDateFilter }),

      // Comments (active all-time vs new in period)
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
        .countDocuments({ isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
        .countDocuments({ isDeleted: { $ne: true }, ...createdDateFilter }),

      // Stories (active currently vs new in period)
      database.collection(collection.COMMUNITY_STORIES_COLLECTION)
        .countDocuments({ expiresAt: { $gt: now }, isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_STORIES_COLLECTION)
        .countDocuments({ isDeleted: { $ne: true }, ...createdDateFilter }),

      // Reports (all-time, in period, resolved, pending)
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .countDocuments({}),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .countDocuments(createdDateFilter),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .countDocuments({ status: { $in: ['resolved', 'dismissed', 'RESOLVED', 'DISMISSED'] } }),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .countDocuments({
          status: { $in: ['resolved', 'dismissed', 'RESOLVED', 'DISMISSED'] },
          ...updatedDateFilter
        }),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .countDocuments({ status: { $in: ['pending', 'investigating', 'PENDING', 'INVESTIGATING'] } }),

      // Moderation Actions (all-time vs in period)
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION)
        .countDocuments({}),
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION)
        .countDocuments(createdDateFilter)
    ]);

    return {
      posts: {
        total: totalPosts || 0,
        newInPeriod: newPosts || 0
      },
      comments: {
        total: totalComments || 0,
        newInPeriod: newComments || 0
      },
      stories: {
        active: activeStories || 0,
        newInPeriod: newStories || 0
      },
      reports: {
        total: totalReports || 0,
        newInPeriod: newReports || 0,
        resolved: resolvedReports || 0,
        resolvedInPeriod: resolvedInPeriod || 0,
        pending: pendingReports || 0
      },
      moderation: {
        totalActions: totalModActions || 0,
        actionsInPeriod: actionsInPeriod || 0
      }
    };
  } catch (err) {
    logger.error('getCommunitySnapshot error:', err.message);
    return {
      posts: { total: 0, newInPeriod: 0 },
      comments: { total: 0, newInPeriod: 0 },
      stories: { active: 0, newInPeriod: 0 },
      reports: { total: 0, newInPeriod: 0, resolved: 0, resolvedInPeriod: 0, pending: 0 },
      moderation: { totalActions: 0, actionsInPeriod: 0 }
    };
  }
};

// ============================================================================
// 2. ACTIVITY TRENDS (CHART.JS CONTINUOUS TIME BINS)
// ============================================================================

/**
 * Builds continuous daily activity trend bins for Posts, Comments, Stories, and Reports.
 * Guarantees zero missing dates, zero NaN, and synchronized array lengths.
 */
const getCommunityActivityTrend = async (database, { startDate, endDate, daysDiff }) => {
  const createdFilter = buildDateFilter('createdAt', startDate, endDate);

  // Generate continuous list of dates
  const dates = [];
  const curr = new Date(startDate.getTime());
  const endLimit = new Date(endDate.getTime());

  while (curr <= endLimit && dates.length <= 366) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, '0');
    const d = String(curr.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    curr.setDate(curr.getDate() + 1);
  }

  // Helper pipeline to group by YYYY-MM-DD
  const runGroupPipeline = async (collName, additionalMatch = {}) => {
    try {
      const matchStage = Object.keys(createdFilter).length
        ? { $and: [additionalMatch, createdFilter] }
        : additionalMatch;

      const results = await database.collection(collName).aggregate([
        { $match: matchStage },
        {
          $project: {
            dateObj: {
              $cond: {
                if: { $eq: [{ $type: '$createdAt' }, 'date'] },
                then: '$createdAt',
                else: { $toDate: '$createdAt' }
              }
            }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$dateObj' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]).toArray();

      const countMap = new Map();
      results.forEach(r => {
        if (r._id) countMap.set(r._id, r.count);
      });
      return countMap;
    } catch (err) {
      logger.warn(`Activity trend aggregation warning on ${collName}:`, err.message);
      return new Map();
    }
  };

  try {
    const [postsMap, commentsMap, storiesMap, reportsMap, actionsMap] = await Promise.all([
      runGroupPipeline(collection.COMMUNITY_POSTS_COLLECTION, { isDeleted: { $ne: true } }),
      runGroupPipeline(collection.COMMUNITY_COMMENTS_COLLECTION, { isDeleted: { $ne: true } }),
      runGroupPipeline(collection.COMMUNITY_STORIES_COLLECTION, { isDeleted: { $ne: true } }),
      runGroupPipeline(collection.COMMUNITY_REPORTS_COLLECTION, {}),
      runGroupPipeline(collection.COMMUNITY_MODERATION_LOGS_COLLECTION, {})
    ]);

    const labels = [];
    const postsData = [];
    const commentsData = [];
    const storiesData = [];
    const reportsData = [];
    const actionsData = [];

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    for (const dateKey of dates) {
      const parts = dateKey.split('-');
      const monthIdx = parseInt(parts[1], 10) - 1;
      const day = parts[2];
      labels.push(`${monthNames[monthIdx] || parts[1]} ${day}`);

      postsData.push(postsMap.get(dateKey) || 0);
      commentsData.push(commentsMap.get(dateKey) || 0);
      storiesData.push(storiesMap.get(dateKey) || 0);
      reportsData.push(reportsMap.get(dateKey) || 0);
      actionsData.push(actionsMap.get(dateKey) || 0);
    }

    const totalPosts = postsData.reduce((a, b) => a + b, 0);
    const totalComments = commentsData.reduce((a, b) => a + b, 0);
    const totalStories = storiesData.reduce((a, b) => a + b, 0);
    const totalReports = reportsData.reduce((a, b) => a + b, 0);
    const totalActions = actionsData.reduce((a, b) => a + b, 0);
    const hasData = (totalPosts + totalComments + totalStories + totalReports + totalActions) > 0;

    return {
      labels,
      datasets: {
        posts: postsData,
        comments: commentsData,
        stories: storiesData,
        reports: reportsData,
        actions: actionsData
      },
      totals: {
        posts: totalPosts,
        comments: totalComments,
        stories: totalStories,
        reports: totalReports,
        actions: totalActions
      },
      hasData
    };
  } catch (err) {
    logger.error('getCommunityActivityTrend error:', err.message);
    return {
      labels: dates.map(d => d.slice(5)),
      datasets: {
        posts: dates.map(() => 0),
        comments: dates.map(() => 0),
        stories: dates.map(() => 0),
        reports: dates.map(() => 0),
        actions: dates.map(() => 0)
      },
      totals: { posts: 0, comments: 0, stories: 0, reports: 0, actions: 0 },
      hasData: false
    };
  }
};

// ============================================================================
// 3. ENGAGEMENT METRICS
// ============================================================================

/**
 * Calculates verified engagement metrics from actual database collections.
 * Explicitly separates verified metrics from unmodeled platform capabilities.
 */
const getCommunityEngagement = async (database, { startDate, endDate, snapshot }) => {
  const dateFilter = buildDateFilter('createdAt', startDate, endDate);

  try {
    const [
      totalReactions,
      reactionsInPeriod,
      totalPolls,
      pollsInPeriod,
      totalPollVotes
    ] = await Promise.all([
      database.collection(collection.COMMUNITY_POST_REACTIONS_COLLECTION).countDocuments({}),
      database.collection(collection.COMMUNITY_POST_REACTIONS_COLLECTION).countDocuments(dateFilter),
      database.collection(collection.COMMUNITY_POLLS_COLLECTION).countDocuments({}),
      database.collection(collection.COMMUNITY_POLLS_COLLECTION).countDocuments(dateFilter),
      database.collection('community_poll_votes').countDocuments({}).catch(() => 0)
    ]);

    const totalPosts = snapshot?.posts?.total || 0;
    const totalComments = snapshot?.comments?.total || 0;

    const commentsPerPost = totalPosts > 0
      ? (totalComments / totalPosts).toFixed(2)
      : '0.00';

    const reactionsPerPost = totalPosts > 0
      ? (totalReactions / totalPosts).toFixed(2)
      : '0.00';

    const totalInteractions = totalComments + totalReactions + (totalPollVotes || 0);

    return {
      reactions: {
        total: totalReactions || 0,
        inPeriod: reactionsInPeriod || 0,
        reactionsPerPost
      },
      commentsRatio: {
        commentsPerPost,
        totalComments
      },
      polls: {
        total: totalPolls || 0,
        inPeriod: pollsInPeriod || 0,
        totalVotes: totalPollVotes || 0
      },
      totalInteractions,
      supportedMetrics: [
        { name: 'Reactions', status: 'Available', collection: collection.COMMUNITY_POST_REACTIONS_COLLECTION },
        { name: 'Comments', status: 'Available', collection: collection.COMMUNITY_COMMENTS_COLLECTION },
        { name: 'Polls & Votes', status: 'Available', collection: collection.COMMUNITY_POLLS_COLLECTION }
      ],
      unavailableMetrics: [
        { name: 'Direct Shares', reason: 'Not modeled in current Community schema' },
        { name: 'Bookmarks / Saves', reason: 'Not modeled in current Community schema' },
        { name: 'Follow Graph Ratios', reason: 'Standalone follower events not tracked as time-series metrics' }
      ]
    };
  } catch (err) {
    logger.error('getCommunityEngagement error:', err.message);
    return {
      reactions: { total: 0, inPeriod: 0, reactionsPerPost: '0.00' },
      commentsRatio: { commentsPerPost: '0.00', totalComments: 0 },
      polls: { total: 0, inPeriod: 0, totalVotes: 0 },
      totalInteractions: 0,
      supportedMetrics: [],
      unavailableMetrics: []
    };
  }
};

// ============================================================================
// 4. MODERATION HEALTH & REPORTS WORKLOAD
// ============================================================================

/**
 * Aggregates reports status distribution, entity type breakdown, reason tallies,
 * and canonical moderation log actions.
 */
const getCommunityModerationMetrics = async (database, { startDate, endDate }) => {
  const reportFilter = buildDateFilter('createdAt', startDate, endDate);
  const modFilter = buildDateFilter('createdAt', startDate, endDate);

  try {
    const [
      statusAggregation,
      entityTypeAggregation,
      reasonAggregation,
      actionsAggregation,
      topModeratorsAggregation
    ] = await Promise.all([
      // Reports by Status (All-time and in period)
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).aggregate([
        {
          $group: {
            _id: { $toLower: { $ifNull: ['$status', 'pending'] } },
            count: { $sum: 1 }
          }
        }
      ]).toArray(),

      // Reports by Entity Type
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).aggregate([
        {
          $group: {
            _id: { $toLower: { $ifNull: ['$entityType', 'unknown'] } },
            count: { $sum: 1 }
          }
        }
      ]).toArray(),

      // Reports by Reason
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).aggregate([
        {
          $group: {
            _id: { $ifNull: ['$reason', 'Unspecified'] },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 8 }
      ]).toArray(),

      // Moderation Actions by Type
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION).aggregate([
        {
          $group: {
            _id: { $toLower: { $ifNull: ['$action', 'action'] } },
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } }
      ]).toArray(),

      // Top Moderators
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION).aggregate([
        {
          $group: {
            _id: '$moderatorId',
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]).toArray()
    ]);

    // Build status map with standard statuses
    const statusMap = {
      pending: 0,
      investigating: 0,
      resolved: 0,
      dismissed: 0
    };
    let totalReports = 0;
    statusAggregation.forEach(s => {
      const key = String(s._id).toLowerCase();
      const count = Number(s.count || 0);
      totalReports += count;
      if (statusMap[key] !== undefined) {
        statusMap[key] += count;
      } else {
        statusMap.pending += count;
      }
    });

    // Build entity type map
    const entityTypeMap = {
      post: 0,
      comment: 0,
      story: 0,
      user: 0,
      other: 0
    };
    entityTypeAggregation.forEach(e => {
      const key = String(e._id).toLowerCase();
      const count = Number(e.count || 0);
      if (entityTypeMap[key] !== undefined) {
        entityTypeMap[key] += count;
      } else {
        entityTypeMap.other += count;
      }
    });

    // Resolution rate calculation (safe against zero division)
    const resolvedTotal = (statusMap.resolved || 0) + (statusMap.dismissed || 0);
    const resolutionRate = totalReports > 0
      ? Math.round((resolvedTotal / totalReports) * 100)
      : 100;

    // Resolve moderator display names safely
    const moderatorIds = topModeratorsAggregation.map(m => m._id).filter(Boolean);
    const userNamesMap = await lookupUserNamesMap(database, moderatorIds);

    const topModerators = topModeratorsAggregation.map(m => {
      const u = userNamesMap.get(String(m._id));
      return {
        id: String(m._id),
        name: u ? u.name : `Admin (${String(m._id).slice(-4)})`,
        count: m.count
      };
    });

    // Actions format mapping
    const actionTypes = actionsAggregation.map(a => {
      const raw = String(a._id || '');
      const formatted = raw.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      return {
        action: raw,
        label: formatted,
        count: a.count
      };
    });

    const reasons = reasonAggregation.map(r => ({
      reason: String(r._id),
      count: r.count
    }));

    return {
      totalReports,
      statusMap,
      resolutionRate,
      entityTypeMap,
      reasons,
      actionTypes,
      topModerators
    };
  } catch (err) {
    logger.error('getCommunityModerationMetrics error:', err.message);
    return {
      totalReports: 0,
      statusMap: { pending: 0, investigating: 0, resolved: 0, dismissed: 0 },
      resolutionRate: 100,
      entityTypeMap: { post: 0, comment: 0, story: 0, user: 0, other: 0 },
      reasons: [],
      actionTypes: [],
      topModerators: []
    };
  }
};

// ============================================================================
// 5. CONTENT STATUS BREAKDOWN
// ============================================================================

/**
 * Computes exact operational status counts across posts, comments, and stories.
 */
const getCommunityContentStatus = async (database) => {
  const now = new Date();

  try {
    const [
      activePosts,
      deletedPosts,
      lockedPosts,
      pinnedPosts,
      activeComments,
      deletedComments,
      activeStories,
      expiredStories,
      deletedStories
    ] = await Promise.all([
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .countDocuments({ isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .countDocuments({ isDeleted: true }),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .countDocuments({ isLocked: true, isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .countDocuments({ isPinned: true, isDeleted: { $ne: true } }),

      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
        .countDocuments({ isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
        .countDocuments({ isDeleted: true }),

      database.collection(collection.COMMUNITY_STORIES_COLLECTION)
        .countDocuments({ expiresAt: { $gt: now }, isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_STORIES_COLLECTION)
        .countDocuments({ expiresAt: { $lte: now }, isDeleted: { $ne: true } }),
      database.collection(collection.COMMUNITY_STORIES_COLLECTION)
        .countDocuments({ isDeleted: true })
    ]);

    return {
      posts: {
        active: activePosts || 0,
        deleted: deletedPosts || 0,
        locked: lockedPosts || 0,
        pinned: pinnedPosts || 0,
        total: (activePosts || 0) + (deletedPosts || 0)
      },
      comments: {
        active: activeComments || 0,
        deleted: deletedComments || 0,
        total: (activeComments || 0) + (deletedComments || 0)
      },
      stories: {
        active: activeStories || 0,
        expired: expiredStories || 0,
        deleted: deletedStories || 0,
        total: (activeStories || 0) + (expiredStories || 0) + (deletedStories || 0)
      }
    };
  } catch (err) {
    logger.error('getCommunityContentStatus error:', err.message);
    return {
      posts: { active: 0, deleted: 0, locked: 0, pinned: 0, total: 0 },
      comments: { active: 0, deleted: 0, total: 0 },
      stories: { active: 0, expired: 0, deleted: 0, total: 0 }
    };
  }
};

// ============================================================================
// 6. RECENT OPERATIONAL ACTIVITY FEED
// ============================================================================

/**
 * Constructs a unified chronological activity feed from posts, comments, reports, and moderation logs.
 * Links directly to existing Admin detail pages without duplicating logic.
 */
const getRecentCommunityActivity = async (database, limit = 8) => {
  try {
    const [recentPosts, recentComments, recentReports, recentLogs] = await Promise.all([
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .find({}, {
          projection: { _id: 1, authorId: 1, content: 1, title: 1, createdAt: 1, isDeleted: 1, isLocked: 1 }
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray(),

      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
        .find({}, {
          projection: { _id: 1, authorId: 1, postId: 1, content: 1, createdAt: 1, isDeleted: 1 }
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray(),

      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .find({}, {
          projection: { _id: 1, entityId: 1, entityType: 1, reason: 1, status: 1, reporterId: 1, createdAt: 1 }
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray(),

      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION)
        .find({}, {
          projection: { _id: 1, moderatorId: 1, action: 1, entityId: 1, entityType: 1, reason: 1, createdAt: 1 }
        })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray()
    ]);

    // Collect all user IDs to resolve names in one round-trip
    const allUserIds = [
      ...recentPosts.map(p => p.authorId),
      ...recentComments.map(c => c.authorId),
      ...recentReports.map(r => r.reporterId),
      ...recentLogs.map(l => l.moderatorId)
    ].filter(Boolean);

    const usersMap = await lookupUserNamesMap(database, allUserIds);

    const items = [];

    // Format Posts
    recentPosts.forEach(p => {
      const author = usersMap.get(String(p.authorId));
      items.push({
        id: String(p._id),
        type: 'post',
        typeLabel: 'Post',
        icon: 'fa-solid fa-signs-post',
        iconColor: '#3b82f6',
        badgeClass: p.isDeleted ? 'badge-status-archived' : 'badge-status-active',
        badgeLabel: p.isDeleted ? 'Deleted' : (p.isLocked ? 'Locked' : 'Active'),
        title: p.title || (p.content ? (p.content.slice(0, 48) + (p.content.length > 48 ? '...' : '')) : `Post #${String(p._id).slice(-6)}`),
        actorName: author ? author.name : 'Community Member',
        detailUrl: `/admin/community/posts/${p._id}`,
        createdAt: p.createdAt ? new Date(p.createdAt) : new Date()
      });
    });

    // Format Comments
    recentComments.forEach(c => {
      const author = usersMap.get(String(c.authorId));
      items.push({
        id: String(c._id),
        type: 'comment',
        typeLabel: 'Comment',
        icon: 'fa-solid fa-comments',
        iconColor: '#10b981',
        badgeClass: c.isDeleted ? 'badge-status-archived' : 'badge-status-active',
        badgeLabel: c.isDeleted ? 'Deleted' : 'Active',
        title: c.content ? (c.content.slice(0, 52) + (c.content.length > 52 ? '...' : '')) : `Comment #${String(c._id).slice(-6)}`,
        actorName: author ? author.name : 'Community Member',
        detailUrl: `/admin/community/comments/${c._id}`,
        createdAt: c.createdAt ? new Date(c.createdAt) : new Date()
      });
    });

    // Format Reports
    recentReports.forEach(r => {
      const reporter = usersMap.get(String(r.reporterId));
      const s = String(r.status || 'pending').toLowerCase();
      let badgeClass = 'badge-status-scheduled';
      if (s === 'resolved') badgeClass = 'badge-status-active';
      else if (s === 'dismissed') badgeClass = 'badge-status-draft';

      items.push({
        id: String(r._id),
        type: 'report',
        typeLabel: 'Report',
        icon: 'fa-solid fa-flag',
        iconColor: '#ef4444',
        badgeClass,
        badgeLabel: s.toUpperCase(),
        title: `Report on ${r.entityType || 'entity'}: ${r.reason || 'Flagged content'}`,
        actorName: reporter ? reporter.name : 'User',
        detailUrl: `/admin/community/reports/${r._id}`,
        createdAt: r.createdAt ? new Date(r.createdAt) : new Date()
      });
    });

    // Format Moderation Logs
    recentLogs.forEach(l => {
      const moderator = usersMap.get(String(l.moderatorId));
      const actionName = String(l.action || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

      let targetUrl = '#';
      if (l.entityType === 'post') targetUrl = `/admin/community/posts/${l.entityId}`;
      else if (l.entityType === 'comment') targetUrl = `/admin/community/comments/${l.entityId}`;
      else if (l.entityType === 'story') targetUrl = `/admin/community/stories/${l.entityId}`;
      else if (l.entityType === 'report') targetUrl = `/admin/community/reports/${l.entityId}`;

      items.push({
        id: String(l._id),
        type: 'moderation',
        typeLabel: 'Moderation',
        icon: 'fa-solid fa-shield-halved',
        iconColor: '#8b5cf6',
        badgeClass: 'badge-priority-normal',
        badgeLabel: 'Audit',
        title: `${actionName}: ${l.entityType || 'item'} (${l.reason || 'Staff action'})`,
        actorName: moderator ? moderator.name : 'Admin Moderator',
        detailUrl: targetUrl,
        createdAt: l.createdAt ? new Date(l.createdAt) : new Date()
      });
    });

    // Sort all combined items descending by date
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return items.slice(0, limit);
  } catch (err) {
    logger.error('getRecentCommunityActivity error:', err.message);
    return [];
  }
};

// ============================================================================
// 7. COMPREHENSIVE OVERVIEW AGGREGATOR
// ============================================================================

/**
 * Unified entry-point for Community Overview dashboard.
 * Coordinates all sub-queries and returns a complete, Handlebars-ready data structure.
 */
const getCommunityOverview = async (query = {}) => {
  const database = db.get();
  if (!database) {
    return {
      dateRange: parseDateRange(query),
      snapshot: {
        posts: { total: 0, newInPeriod: 0 },
        comments: { total: 0, newInPeriod: 0 },
        stories: { active: 0, newInPeriod: 0 },
        reports: { total: 0, newInPeriod: 0, resolved: 0, resolvedInPeriod: 0, pending: 0 },
        moderation: { totalActions: 0, actionsInPeriod: 0 }
      },
      trends: {
        labels: [],
        datasets: { posts: [], comments: [], stories: [], reports: [], actions: [] },
        totals: { posts: 0, comments: 0, stories: 0, reports: 0, actions: 0 },
        hasData: false
      },
      engagement: {
        reactions: { total: 0, inPeriod: 0, reactionsPerPost: '0.00' },
        commentsRatio: { commentsPerPost: '0.00', totalComments: 0 },
        polls: { total: 0, inPeriod: 0, totalVotes: 0 },
        totalInteractions: 0,
        supportedMetrics: [],
        unavailableMetrics: []
      },
      moderation: {
        totalReports: 0,
        statusMap: { pending: 0, investigating: 0, resolved: 0, dismissed: 0 },
        resolutionRate: 100,
        entityTypeMap: { post: 0, comment: 0, story: 0, user: 0, other: 0 },
        reasons: [],
        actionTypes: [],
        topModerators: []
      },
      contentStatus: {
        posts: { active: 0, deleted: 0, locked: 0, pinned: 0, total: 0 },
        comments: { active: 0, deleted: 0, total: 0 },
        stories: { active: 0, expired: 0, deleted: 0, total: 0 }
      },
      recentActivity: [],
      rulesPolicy: {
        hasModel: false,
        message: 'No standalone Community Rules collection exists in database schema. Platform rules are governed via general Terms & Conditions.'
      },
      error: 'Database connection unavailable'
    };
  }

  const dateRange = parseDateRange(query);

  try {
    const [
      snapshot,
      contentStatus,
      moderation,
      recentActivity
    ] = await Promise.all([
      getCommunitySnapshot(database, dateRange),
      getCommunityContentStatus(database),
      getCommunityModerationMetrics(database, dateRange),
      getRecentCommunityActivity(database, 10)
    ]);

    const [trends, engagement] = await Promise.all([
      getCommunityActivityTrend(database, {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        daysDiff: dateRange.daysDiff
      }),
      getCommunityEngagement(database, {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        snapshot
      })
    ]);

    return {
      dateRange,
      snapshot,
      trends,
      engagement,
      moderation,
      contentStatus,
      recentActivity,
      rulesPolicy: {
        hasModel: false,
        title: 'Community Rules & Platform Policy',
        message: 'No standalone Community Rules or Policies collection exists in the platform database schema. Community standards are currently managed through platform-wide terms of service.',
        recommendation: 'To enable dynamic in-admin rule editing, create a schema for community_rules with versioning and audit trails in a future database migration.'
      },
      error: dateRange.validationError || null
    };
  } catch (err) {
    logger.error('getCommunityOverview error:', err.message);
    return {
      dateRange,
      snapshot: {
        posts: { total: 0, newInPeriod: 0 },
        comments: { total: 0, newInPeriod: 0 },
        stories: { active: 0, newInPeriod: 0 },
        reports: { total: 0, newInPeriod: 0, resolved: 0, resolvedInPeriod: 0, pending: 0 },
        moderation: { totalActions: 0, actionsInPeriod: 0 }
      },
      trends: {
        labels: [],
        datasets: { posts: [], comments: [], stories: [], reports: [], actions: [] },
        totals: { posts: 0, comments: 0, stories: 0, reports: 0, actions: 0 },
        hasData: false
      },
      engagement: {
        reactions: { total: 0, inPeriod: 0, reactionsPerPost: '0.00' },
        commentsRatio: { commentsPerPost: '0.00', totalComments: 0 },
        polls: { total: 0, inPeriod: 0, totalVotes: 0 },
        totalInteractions: 0,
        supportedMetrics: [],
        unavailableMetrics: []
      },
      moderation: {
        totalReports: 0,
        statusMap: { pending: 0, investigating: 0, resolved: 0, dismissed: 0 },
        resolutionRate: 100,
        entityTypeMap: { post: 0, comment: 0, story: 0, user: 0, other: 0 },
        reasons: [],
        actionTypes: [],
        topModerators: []
      },
      contentStatus: {
        posts: { active: 0, deleted: 0, locked: 0, pinned: 0, total: 0 },
        comments: { active: 0, deleted: 0, total: 0 },
        stories: { active: 0, expired: 0, deleted: 0, total: 0 }
      },
      recentActivity: [],
      rulesPolicy: {
        hasModel: false,
        message: 'No standalone Community Rules collection exists in database schema.'
      },
      error: err.message
    };
  }
};

module.exports = {
  parseDateRange,
  buildDateFilter,
  getCommunitySnapshot,
  getCommunityActivityTrend,
  getCommunityEngagement,
  getCommunityModerationMetrics,
  getCommunityContentStatus,
  getRecentCommunityActivity,
  getCommunityOverview
};
