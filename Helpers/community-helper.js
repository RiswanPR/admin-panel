/**
 * Zeitnah Admin Panel — Community Content Management Helper
 * Implements safe queries, pagination, author resolution, filtering,
 * moderation state mutations, and audit logging for Community Posts, Comments, and Stories.
 */

const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');

const escapeRegex = (str) => String(str || '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Sanitizes URLs to prevent javascript: or malformed URI protocols.
 * Allows safe relative paths and http/https schemes only.
 */
const sanitizeUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed;
  }
  return '';
};

/**
 * Validates Community entity ID (UUID v4 or standard alphanumeric slug)
 * Never throws BSON TypeError.
 */
const isValidCommunityId = (id) => {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length < 3 || trimmed.length > 128) return false;
  return /^[0-9a-zA-Z_-]+$/.test(trimmed);
};

/**
 * Safe user lookup map resolving both ObjectId and String representations
 */
const lookupUsersMap = async (database, rawIds) => {
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

  const query = {
    $or: []
  };
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
          role: 1,
          primaryRole: 1,
          account_Status: 1
        }
      })
      .toArray();

    const map = new Map();
    for (const u of users) {
      const uId = String(u._id);
      map.set(uId, {
        _id: uId,
        name: u.Name || u.name || u.username || 'Community Member',
        username: u.username || 'user',
        email: u.Email || u.email || '',
        avatar: u.avatar || null,
        role: u.primaryRole || u.role || 'student',
        isBlocked: !!(u.account_Status?.isBlocked)
      });
    }
    return map;
  } catch (err) {
    logger.warn('Community author lookup warning:', err.message);
    return new Map();
  }
};

/**
 * Report counts map for community entities
 */
const lookupReportCountsMap = async (database, entityIds) => {
  const ids = [...new Set((entityIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  try {
    const reports = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
      .aggregate([
        { $match: { entityId: { $in: ids } } },
        {
          $group: {
            _id: '$entityId',
            total: { $sum: 1 },
            pending: {
              $sum: {
                $cond: [{ $in: ['$status', ['pending', 'PENDING', 'open', 'OPEN']] }, 1, 0]
              }
            }
          }
        }
      ])
      .toArray();

    const map = new Map();
    for (const r of reports) {
      map.set(String(r._id), {
        total: r.total || 0,
        pending: r.pending || 0
      });
    }
    return map;
  } catch (err) {
    return new Map();
  }
};

/**
 * Dual write to community_moderation_logs for user-panel alignment
 */
const logCommunityModeration = async (database, { moderator, action, entityId, entityType, reason, metadata }) => {
  try {
    const crypto = require('crypto');
    const logId = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substr(2, 5));
    await database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION).insertOne({
      _id: logId,
      moderatorId: String(moderator?._id || moderator?.id || 'admin'),
      action: String(action).toLowerCase(),
      entityId: String(entityId),
      entityType: String(entityType).toLowerCase(),
      reason: String(reason || '').trim(),
      metadata: metadata || {},
      createdAt: new Date(),
      updatedAt: new Date()
    });
  } catch (err) {
    // Non-fatal, audit_logs is canonical
    logger.warn('community_moderation_logs write warning:', err.message);
  }
};

// ============================================================================
// STATS / OVERVIEW
// ============================================================================

const getCommunityStats = async () => {
  const database = db.get();
  if (!database) {
    return {
      totalPosts: 0,
      activePosts: 0,
      deletedPosts: 0,
      lockedPosts: 0,
      totalComments: 0,
      deletedComments: 0,
      activeStories: 0,
      expiredStories: 0,
      deletedStories: 0,
      totalReports: 0,
      pendingReports: 0
    };
  }

  const now = new Date();

  try {
    const [
      totalPosts,
      deletedPosts,
      lockedPosts,
      totalComments,
      deletedComments,
      totalStories,
      deletedStories,
      activeStories,
      totalReports,
      pendingReports
    ] = await Promise.all([
      database.collection(collection.COMMUNITY_POSTS_COLLECTION).countDocuments({}),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION).countDocuments({ isDeleted: true }),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION).countDocuments({ isLocked: true }),
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).countDocuments({}),
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).countDocuments({ isDeleted: true }),
      database.collection(collection.COMMUNITY_STORIES_COLLECTION).countDocuments({}),
      database.collection(collection.COMMUNITY_STORIES_COLLECTION).countDocuments({ isDeleted: true }),
      database.collection(collection.COMMUNITY_STORIES_COLLECTION).countDocuments({ isDeleted: { $ne: true }, expiresAt: { $gt: now } }),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).countDocuments({}),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).countDocuments({ status: { $in: ['pending', 'PENDING', 'open', 'OPEN'] } })
    ]);

    return {
      totalPosts,
      activePosts: Math.max(0, totalPosts - deletedPosts),
      deletedPosts,
      lockedPosts,
      totalComments,
      activeComments: Math.max(0, totalComments - deletedComments),
      deletedComments,
      totalStories,
      activeStories,
      expiredStories: Math.max(0, totalStories - deletedStories - activeStories),
      deletedStories,
      totalReports,
      pendingReports
    };
  } catch (err) {
    logger.error('getCommunityStats error:', err.message);
    return {
      totalPosts: 0,
      activePosts: 0,
      deletedPosts: 0,
      lockedPosts: 0,
      totalComments: 0,
      activeComments: 0,
      deletedComments: 0,
      totalStories: 0,
      activeStories: 0,
      expiredStories: 0,
      deletedStories: 0,
      totalReports: 0,
      pendingReports: 0
    };
  }
};

// ============================================================================
// POSTS MANAGEMENT
// ============================================================================

const getPosts = async (filters = {}) => {
  const database = db.get();
  if (!database) {
    return {
      records: [],
      total: 0,
      page: 1,
      limit: 15,
      totalPages: 1,
      stats: await getCommunityStats(),
      filters
    };
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 15), 100);
  const skip = (page - 1) * limit;

  const query = {};

  // Status Filter
  const status = (filters.status || 'all').toLowerCase();
  if (status === 'active') {
    query.isDeleted = { $ne: true };
  } else if (status === 'deleted') {
    query.isDeleted = true;
  } else if (status === 'locked') {
    query.isLocked = true;
  } else if (status === 'pinned') {
    query.isPinned = true;
  }

  // Audience Filter
  if (filters.audience && filters.audience.toUpperCase() !== 'ALL') {
    query.audience = filters.audience.toUpperCase();
  }

  // Post Type Filter ('original', 'repost', 'quote')
  if (filters.postType && filters.postType.toLowerCase() !== 'all') {
    query.postType = filters.postType.toLowerCase();
  }

  // Content Type Filter ('TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'POLL')
  if (filters.type && filters.type.toUpperCase() !== 'ALL') {
    query.type = filters.type.toUpperCase();
  }

  // Author filter
  if (filters.authorId && typeof filters.authorId === 'string') {
    query.authorId = filters.authorId.trim();
  }

  // Course filter
  if (filters.courseId && typeof filters.courseId === 'string') {
    query.courseId = filters.courseId.trim();
  }

  // Search filter
  const search = (typeof filters.search === 'string' ? filters.search : '').trim();
  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    const authorMatches = await database.collection(collection.STUDENTS_COLLECTION)
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
      .toArray();

    const matchedAuthorIds = authorMatches.map(u => String(u._id));

    const orClauses = [
      { content: sRegex },
      { _id: sRegex },
      { quoteText: sRegex },
      { hashtags: sRegex },
      { tags: sRegex }
    ];

    if (matchedAuthorIds.length) {
      orClauses.push({ authorId: { $in: matchedAuthorIds } });
    }

    query.$or = orClauses;
  }

  // Date range filter
  if (filters.startDate || filters.endDate) {
    const dateFilter = {};
    if (filters.startDate) {
      const s = new Date(filters.startDate);
      if (!isNaN(s.getTime())) dateFilter.$gte = s;
    }
    if (filters.endDate) {
      const e = new Date(filters.endDate);
      if (!isNaN(e.getTime())) {
        e.setHours(23, 59, 59, 999);
        dateFilter.$lte = e;
      }
    }
    if (Object.keys(dateFilter).length > 0) {
      query.createdAt = dateFilter;
    }
  }

  // Sorting (Allowlisted)
  const ALLOWED_POST_SORTS = ['newest', 'oldest', 'likes', 'comments', 'views'];
  const safeSort = ALLOWED_POST_SORTS.includes(filters.sort) ? filters.sort : 'newest';
  let sort = { createdAt: -1 };
  if (safeSort === 'oldest') {
    sort = { createdAt: 1 };
  } else if (safeSort === 'likes') {
    sort = { 'stats.likes': -1, createdAt: -1 };
  } else if (safeSort === 'comments') {
    sort = { 'stats.comments': -1, createdAt: -1 };
  } else if (safeSort === 'views') {
    sort = { 'stats.views': -1, createdAt: -1 };
  }

  try {
    const [total, rawPosts, stats] = await Promise.all([
      database.collection(collection.COMMUNITY_POSTS_COLLECTION).countDocuments(query),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray(),
      getCommunityStats()
    ]);

    const authorIds = rawPosts.map(p => p.authorId).filter(Boolean);
    const postIds = rawPosts.map(p => String(p._id));

    const [userMap, reportMap] = await Promise.all([
      lookupUsersMap(database, authorIds),
      lookupReportCountsMap(database, postIds)
    ]);

    const records = rawPosts.map(p => {
      const pId = String(p._id);
      const author = userMap.get(String(p.authorId)) || {
        _id: String(p.authorId || ''),
        name: 'Community Member',
        username: 'user',
        avatar: null,
        role: 'student',
        isBlocked: false
      };

      const repData = reportMap.get(pId) || { total: 0, pending: 0 };

      // Content preview truncate
      const rawContent = p.content || '';
      const contentSnippet = rawContent.length > 140 ? rawContent.substring(0, 140) + '...' : rawContent;

      const mediaCount = Array.isArray(p.media) ? p.media.length : 0;
      const mediaTypes = Array.isArray(p.media) ? [...new Set(p.media.map(m => m.type || 'image'))] : [];

      return {
        ...p,
        _id: pId,
        author,
        contentSnippet,
        mediaCount,
        mediaTypes,
        hasMedia: mediaCount > 0,
        reportTotal: repData.total,
        reportPending: repData.pending,
        hasReports: repData.total > 0,
        likesCount: p.stats?.likes || 0,
        commentsCount: p.stats?.comments || 0,
        viewsCount: p.stats?.views || 0,
        sharesCount: p.stats?.shares || 0,
        repostsCount: p.stats?.reposts || 0,
        statusLabel: p.isDeleted ? 'DELETED' : (p.isLocked ? 'LOCKED' : 'ACTIVE')
      };
    });

    return {
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      stats,
      filters: {
        ...filters,
        status,
        audience: filters.audience || 'ALL',
        postType: filters.postType || 'ALL',
        type: filters.type || 'ALL',
        search: search || '',
        sort: filters.sort || 'newest'
      }
    };
  } catch (err) {
    logger.error('getPosts error:', err.message);
    return {
      records: [],
      total: 0,
      page: 1,
      limit,
      totalPages: 1,
      stats: await getCommunityStats(),
      filters
    };
  }
};

const getPostById = async (postId) => {
  if (!isValidCommunityId(postId)) return null;

  const database = db.get();
  if (!database) return null;

  try {
    const post = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({
      _id: postId
    });
    if (!post) return null;

    const pId = String(post._id);

    // Lookups in parallel: Author, Reports, Recent Comments, Mod History, Original Post (if repost/quote)
    const [authorMap, reportDocs, recentComments, modLogs, originalPost, courseDoc] = await Promise.all([
      lookupUsersMap(database, [post.authorId]),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .find({ entityId: pId })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
        .find({ postId: pId })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray(),
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION)
        .find({ entityId: pId })
        .sort({ createdAt: -1 })
        .limit(15)
        .toArray(),
      post.originalPostId ? database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: String(post.originalPostId) }) : Promise.resolve(null),
      post.courseId && ObjectId.isValid(post.courseId) ? database.collection(collection.COURSE_COLLECTION).findOne({ _id: new ObjectId(post.courseId) }, { projection: { courseName: 1 } }) : Promise.resolve(null)
    ]);

    // Lookup comment authors
    const commentAuthorIds = recentComments.map(c => c.authorId).filter(Boolean);
    const commentUserMap = await lookupUsersMap(database, commentAuthorIds);

    const enrichedComments = recentComments.map(c => ({
      ...c,
      _id: String(c._id),
      author: commentUserMap.get(String(c.authorId)) || {
        _id: String(c.authorId),
        name: 'Community Member',
        username: 'user'
      }
    }));

    const author = authorMap.get(String(post.authorId)) || {
      _id: String(post.authorId),
      name: 'Community Member',
      username: 'user',
      avatar: null,
      role: 'student',
      isBlocked: false
    };

    return {
      ...post,
      _id: pId,
      author,
      courseTitle: courseDoc ? courseDoc.courseName : null,
      originalPost: originalPost ? {
        ...originalPost,
        _id: String(originalPost._id)
      } : null,
      comments: enrichedComments,
      commentsCount: post.stats?.comments || 0,
      reports: reportDocs.map(r => ({
        ...r,
        _id: String(r._id)
      })),
      reportCount: reportDocs.length,
      moderationLogs: modLogs.map(m => ({
        ...m,
        _id: String(m._id)
      })),
      likesCount: post.stats?.likes || 0,
      lovesCount: post.stats?.loves || 0,
      celebratesCount: post.stats?.celebrates || 0,
      insightfulsCount: post.stats?.insightfuls || 0,
      viewsCount: post.stats?.views || 0,
      sharesCount: post.stats?.shares || 0,
      repostsCount: post.stats?.reposts || 0,
      media: Array.isArray(post.media) ? post.media.map(m => ({
        ...m,
        url: sanitizeUrl(m.url),
        thumbnailUrl: sanitizeUrl(m.thumbnailUrl)
      })) : [],
      hasMedia: Array.isArray(post.media) && post.media.length > 0,
      statusLabel: post.isDeleted ? 'DELETED' : (post.isLocked ? 'LOCKED' : 'ACTIVE')
    };
  } catch (err) {
    logger.error('getPostById error:', err.message);
    return null;
  }
};

const hidePost = async (postId, { reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(postId)) {
    throw new Error('Invalid post ID format.');
  }

  const database = db.get();
  const post = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: postId });
  if (!post) {
    throw new Error('Post not found.');
  }

  if (post.isDeleted) {
    return { success: true, alreadyApplied: true, post };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_POSTS_COLLECTION).updateOne(
    { _id: postId },
    {
      $set: {
        isDeleted: true,
        deletedAt: now,
        updatedAt: now
      }
    }
  );

  const cleanReason = String(reason || 'Violated community guidelines').trim();

  // Audit log
  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_POST_HIDDEN',
    entityType: 'COMMUNITY_POST',
    entityId: postId,
    entityName: `Post by @${post.authorId}`,
    status: 'success',
    message: `Post ${postId} hidden/soft-deleted by admin. Reason: ${cleanReason}`,
    metadata: {
      postId,
      authorId: post.authorId,
      previousState: { isDeleted: false, deletedAt: null },
      newState: { isDeleted: true, deletedAt: now },
      reason: cleanReason
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'hide_post',
    entityId: postId,
    entityType: 'post',
    reason: cleanReason,
    metadata: { isDeleted: true }
  });

  return { success: true, postId, isDeleted: true };
};

const restorePost = async (postId, { reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(postId)) {
    throw new Error('Invalid post ID format.');
  }

  const database = db.get();
  const post = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: postId });
  if (!post) {
    throw new Error('Post not found.');
  }

  if (!post.isDeleted) {
    return { success: true, alreadyApplied: true, post };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_POSTS_COLLECTION).updateOne(
    { _id: postId },
    {
      $set: {
        isDeleted: false,
        deletedAt: null,
        updatedAt: now
      }
    }
  );

  const cleanReason = String(reason || 'Restored by admin').trim();

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_POST_RESTORED',
    entityType: 'COMMUNITY_POST',
    entityId: postId,
    entityName: `Post by @${post.authorId}`,
    status: 'success',
    message: `Post ${postId} restored to active status by admin. Reason: ${cleanReason}`,
    metadata: {
      postId,
      authorId: post.authorId,
      previousState: { isDeleted: true, deletedAt: post.deletedAt },
      newState: { isDeleted: false, deletedAt: null },
      reason: cleanReason
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'restore_post',
    entityId: postId,
    entityType: 'post',
    reason: cleanReason,
    metadata: { isDeleted: false }
  });

  return { success: true, postId, isDeleted: false };
};

const lockPost = async (postId, { isLocked = true, reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(postId)) {
    throw new Error('Invalid post ID format.');
  }

  const database = db.get();
  const post = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: postId });
  if (!post) {
    throw new Error('Post not found.');
  }

  const lockState = Boolean(isLocked);
  if (Boolean(post.isLocked) === lockState) {
    return { success: true, alreadyApplied: true, isLocked: lockState };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_POSTS_COLLECTION).updateOne(
    { _id: postId },
    {
      $set: {
        isLocked: lockState,
        updatedAt: now
      }
    }
  );

  const actionName = lockState ? 'COMMUNITY_POST_LOCKED' : 'COMMUNITY_POST_UNLOCKED';
  const cleanReason = String(reason || (lockState ? 'Comments locked by admin' : 'Comments unlocked by admin')).trim();

  await auditHelper.logAction({
    req,
    actor,
    action: actionName,
    entityType: 'COMMUNITY_POST',
    entityId: postId,
    entityName: `Post by @${post.authorId}`,
    status: 'success',
    message: `Post ${postId} ${lockState ? 'locked' : 'unlocked'} by admin. Reason: ${cleanReason}`,
    metadata: {
      postId,
      authorId: post.authorId,
      previousState: { isLocked: !!post.isLocked },
      newState: { isLocked: lockState },
      reason: cleanReason
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: lockState ? 'lock_post' : 'unlock_post',
    entityId: postId,
    entityType: 'post',
    reason: cleanReason,
    metadata: { isLocked: lockState }
  });

  return { success: true, postId, isLocked: lockState };
};

const pinPost = async (postId, { isPinned = true, reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(postId)) {
    throw new Error('Invalid post ID format.');
  }

  const database = db.get();
  const post = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: postId });
  if (!post) {
    throw new Error('Post not found.');
  }

  const pinState = Boolean(isPinned);
  if (Boolean(post.isPinned) === pinState) {
    return { success: true, alreadyApplied: true, isPinned: pinState };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_POSTS_COLLECTION).updateOne(
    { _id: postId },
    {
      $set: {
        isPinned: pinState,
        updatedAt: now
      }
    }
  );

  const actionName = pinState ? 'COMMUNITY_POST_PINNED' : 'COMMUNITY_POST_UNPINNED';
  const cleanReason = String(reason || (pinState ? 'Pinned to community feed' : 'Unpinned from community feed')).trim();

  await auditHelper.logAction({
    req,
    actor,
    action: actionName,
    entityType: 'COMMUNITY_POST',
    entityId: postId,
    entityName: `Post by @${post.authorId}`,
    status: 'success',
    message: `Post ${postId} ${pinState ? 'pinned' : 'unpinned'} by admin. Reason: ${cleanReason}`,
    metadata: {
      postId,
      authorId: post.authorId,
      previousState: { isPinned: !!post.isPinned },
      newState: { isPinned: pinState },
      reason: cleanReason
    }
  });

  return { success: true, postId, isPinned: pinState };
};

// ============================================================================
// COMMENTS MANAGEMENT
// ============================================================================

const getComments = async (filters = {}) => {
  const database = db.get();
  if (!database) {
    return {
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 1,
      filters
    };
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 20), 100);
  const skip = (page - 1) * limit;

  const query = {};

  // Status Filter
  const status = (filters.status || 'all').toLowerCase();
  if (status === 'active') {
    query.isDeleted = { $ne: true };
  } else if (status === 'deleted') {
    query.isDeleted = true;
  }

  if (filters.postId && typeof filters.postId === 'string') {
    query.postId = filters.postId.trim();
  }

  if (filters.authorId && typeof filters.authorId === 'string') {
    query.authorId = filters.authorId.trim();
  }

  // Search Filter
  const search = (typeof filters.search === 'string' ? filters.search : '').trim();
  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    const authorMatches = await database.collection(collection.STUDENTS_COLLECTION)
      .find({
        $or: [
          { name: sRegex },
          { Name: sRegex },
          { username: sRegex },
          { email: sRegex }
        ]
      }, { projection: { _id: 1 } })
      .limit(50)
      .toArray();

    const matchedAuthorIds = authorMatches.map(u => String(u._id));

    const orClauses = [
      { content: sRegex },
      { _id: sRegex },
      { postId: sRegex }
    ];

    if (matchedAuthorIds.length) {
      orClauses.push({ authorId: { $in: matchedAuthorIds } });
    }

    query.$or = orClauses;
  }

  // Date range filter
  if (filters.startDate || filters.endDate) {
    const dateFilter = {};
    if (filters.startDate) {
      const s = new Date(filters.startDate);
      if (!isNaN(s.getTime())) dateFilter.$gte = s;
    }
    if (filters.endDate) {
      const e = new Date(filters.endDate);
      if (!isNaN(e.getTime())) {
        e.setHours(23, 59, 59, 999);
        dateFilter.$lte = e;
      }
    }
    if (Object.keys(dateFilter).length > 0) {
      query.createdAt = dateFilter;
    }
  }

  // Sorting (Allowlisted)
  const ALLOWED_COMMENT_SORTS = ['newest', 'oldest', 'likes'];
  const safeSort = ALLOWED_COMMENT_SORTS.includes(filters.sort) ? filters.sort : 'newest';
  let sort = { createdAt: -1 };
  if (safeSort === 'oldest') {
    sort = { createdAt: 1 };
  } else if (safeSort === 'likes') {
    sort = { 'stats.likes': -1, createdAt: -1 };
  }

  try {
    const [total, rawComments, stats] = await Promise.all([
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).countDocuments(query),
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
        .find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray(),
      getCommunityStats()
    ]);

    const authorIds = rawComments.map(c => c.authorId).filter(Boolean);
    const postIds = rawComments.map(c => c.postId).filter(Boolean);
    const commentIds = rawComments.map(c => String(c._id));

    const [userMap, postDocs, reportMap] = await Promise.all([
      lookupUsersMap(database, authorIds),
      postIds.length ? database.collection(collection.COMMUNITY_POSTS_COLLECTION)
        .find({ _id: { $in: postIds } }, { projection: { _id: 1, content: 1, authorId: 1, isDeleted: 1 } })
        .toArray() : Promise.resolve([]),
      lookupReportCountsMap(database, commentIds)
    ]);

    const postMap = new Map(postDocs.map(p => [String(p._id), p]));

    const records = rawComments.map(c => {
      const cId = String(c._id);
      const author = userMap.get(String(c.authorId)) || {
        _id: String(c.authorId || ''),
        name: 'Community Member',
        username: 'user',
        avatar: null,
        role: 'student'
      };

      const parentPost = postMap.get(String(c.postId)) || null;
      const repData = reportMap.get(cId) || { total: 0, pending: 0 };

      const contentSnippet = (c.content || '').length > 120 ? (c.content || '').substring(0, 120) + '...' : (c.content || '');
      const parentSnippet = parentPost ? ((parentPost.content || '').length > 70 ? (parentPost.content || '').substring(0, 70) + '...' : parentPost.content) : 'Post unavailable';

      return {
        ...c,
        _id: cId,
        author,
        contentSnippet,
        parentPost,
        parentSnippet,
        isReply: !!c.parentId,
        likesCount: c.stats?.likes || 0,
        repliesCount: c.stats?.replies || 0,
        reportTotal: repData.total,
        reportPending: repData.pending,
        hasReports: repData.total > 0,
        statusLabel: c.isDeleted ? 'DELETED' : 'ACTIVE'
      };
    });

    return {
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      stats,
      filters: {
        ...filters,
        status,
        search: search || '',
        sort: filters.sort || 'newest'
      }
    };
  } catch (err) {
    logger.error('getComments error:', err.message);
    return {
      records: [],
      total: 0,
      page: 1,
      limit,
      totalPages: 1,
      filters
    };
  }
};

const getCommentById = async (commentId) => {
  if (!isValidCommunityId(commentId)) return null;

  const database = db.get();
  if (!database) return null;

  try {
    const comment = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: commentId });
    if (!comment) return null;

    const cId = String(comment._id);

    const [authorMap, parentPost, parentComment, childReplies, reports, modLogs] = await Promise.all([
      lookupUsersMap(database, [comment.authorId]),
      database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: String(comment.postId) }),
      comment.parentId ? database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: String(comment.parentId) }) : Promise.resolve(null),
      database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).find({ parentId: cId }).sort({ createdAt: 1 }).limit(10).toArray(),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).find({ entityId: cId }).sort({ createdAt: -1 }).limit(10).toArray(),
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION).find({ entityId: cId }).sort({ createdAt: -1 }).limit(10).toArray()
    ]);

    // Lookup child reply authors
    const replyAuthorIds = childReplies.map(r => r.authorId).filter(Boolean);
    const replyAuthorMap = await lookupUsersMap(database, replyAuthorIds);

    const enrichedReplies = childReplies.map(r => ({
      ...r,
      _id: String(r._id),
      author: replyAuthorMap.get(String(r.authorId)) || {
        _id: String(r.authorId),
        name: 'Community Member',
        username: 'user'
      }
    }));

    const author = authorMap.get(String(comment.authorId)) || {
      _id: String(comment.authorId),
      name: 'Community Member',
      username: 'user',
      avatar: null,
      role: 'student'
    };

    return {
      ...comment,
      _id: cId,
      author,
      parentPost: parentPost ? {
        ...parentPost,
        _id: String(parentPost._id)
      } : null,
      parentComment: parentComment ? {
        ...parentComment,
        _id: String(parentComment._id)
      } : null,
      replies: enrichedReplies,
      reports: reports.map(r => ({
        ...r,
        _id: String(r._id)
      })),
      reportCount: reports.length,
      moderationLogs: modLogs.map(m => ({
        ...m,
        _id: String(m._id)
      })),
      isReply: !!comment.parentId,
      likesCount: comment.stats?.likes || 0,
      repliesCount: comment.stats?.replies || 0,
      statusLabel: comment.isDeleted ? 'DELETED' : 'ACTIVE'
    };
  } catch (err) {
    logger.error('getCommentById error:', err.message);
    return null;
  }
};

const deleteComment = async (commentId, { reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(commentId)) {
    throw new Error('Invalid comment ID format.');
  }

  const database = db.get();
  const comment = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: commentId });
  if (!comment) {
    throw new Error('Comment not found.');
  }

  if (comment.isDeleted) {
    return { success: true, alreadyApplied: true, comment };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).updateOne(
    { _id: commentId },
    {
      $set: {
        isDeleted: true,
        deletedAt: now,
        updatedAt: now
      }
    }
  );

  const cleanReason = String(reason || 'Violated community guidelines').trim();

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_COMMENT_DELETED',
    entityType: 'COMMUNITY_COMMENT',
    entityId: commentId,
    entityName: `Comment on post #${comment.postId}`,
    status: 'success',
    message: `Comment ${commentId} soft-deleted by admin. Reason: ${cleanReason}`,
    metadata: {
      commentId,
      postId: comment.postId,
      authorId: comment.authorId,
      previousState: { isDeleted: false, deletedAt: null },
      newState: { isDeleted: true, deletedAt: now },
      reason: cleanReason
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'delete_comment',
    entityId: commentId,
    entityType: 'comment',
    reason: cleanReason,
    metadata: { isDeleted: true }
  });

  return { success: true, commentId, isDeleted: true };
};

const restoreComment = async (commentId, { reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(commentId)) {
    throw new Error('Invalid comment ID format.');
  }

  const database = db.get();
  const comment = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: commentId });
  if (!comment) {
    throw new Error('Comment not found.');
  }

  if (!comment.isDeleted) {
    return { success: true, alreadyApplied: true, comment };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).updateOne(
    { _id: commentId },
    {
      $set: {
        isDeleted: false,
        deletedAt: null,
        updatedAt: now
      }
    }
  );

  const cleanReason = String(reason || 'Restored by admin').trim();

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_COMMENT_RESTORED',
    entityType: 'COMMUNITY_COMMENT',
    entityId: commentId,
    entityName: `Comment on post #${comment.postId}`,
    status: 'success',
    message: `Comment ${commentId} restored to active status by admin. Reason: ${cleanReason}`,
    metadata: {
      commentId,
      postId: comment.postId,
      authorId: comment.authorId,
      previousState: { isDeleted: true, deletedAt: comment.deletedAt },
      newState: { isDeleted: false, deletedAt: null },
      reason: cleanReason
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'restore_comment',
    entityId: commentId,
    entityType: 'comment',
    reason: cleanReason,
    metadata: { isDeleted: false }
  });

  return { success: true, commentId, isDeleted: false };
};

// ============================================================================
// STORIES MANAGEMENT
// ============================================================================

const getStories = async (filters = {}) => {
  const database = db.get();
  if (!database) {
    return {
      records: [],
      total: 0,
      page: 1,
      limit: 15,
      totalPages: 1,
      filters
    };
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 15), 100);
  const skip = (page - 1) * limit;

  const now = new Date();
  const query = {};

  const status = (filters.status || 'all').toLowerCase();
  if (status === 'active') {
    query.isDeleted = { $ne: true };
    query.expiresAt = { $gt: now };
  } else if (status === 'expired') {
    query.isDeleted = { $ne: true };
    query.expiresAt = { $lte: now };
  } else if (status === 'deleted') {
    query.isDeleted = true;
  }

  if (filters.type && filters.type.toUpperCase() !== 'ALL') {
    query.type = filters.type.toUpperCase();
  }

  if (filters.courseTag && typeof filters.courseTag === 'string') {
    query.courseTag = filters.courseTag.trim();
  }

  if (filters.authorId && typeof filters.authorId === 'string') {
    query.authorId = filters.authorId.trim();
  }

  const search = (typeof filters.search === 'string' ? filters.search : '').trim();
  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    const authorMatches = await database.collection(collection.STUDENTS_COLLECTION)
      .find({
        $or: [
          { name: sRegex },
          { Name: sRegex },
          { username: sRegex },
          { email: sRegex }
        ]
      }, { projection: { _id: 1 } })
      .limit(50)
      .toArray();

    const matchedAuthorIds = authorMatches.map(u => String(u._id));

    const orClauses = [
      { text: sRegex },
      { _id: sRegex },
      { courseTag: sRegex }
    ];

    if (matchedAuthorIds.length) {
      orClauses.push({ authorId: { $in: matchedAuthorIds } });
    }

    query.$or = orClauses;
  }

  // Date range filter
  if (filters.startDate || filters.endDate) {
    const dateFilter = {};
    if (filters.startDate) {
      const s = new Date(filters.startDate);
      if (!isNaN(s.getTime())) dateFilter.$gte = s;
    }
    if (filters.endDate) {
      const e = new Date(filters.endDate);
      if (!isNaN(e.getTime())) {
        e.setHours(23, 59, 59, 999);
        dateFilter.$lte = e;
      }
    }
    if (Object.keys(dateFilter).length > 0) {
      query.createdAt = dateFilter;
    }
  }

  // Sorting (Allowlisted)
  const ALLOWED_STORY_SORTS = ['newest', 'oldest', 'expiring_soon', 'views'];
  const safeSort = ALLOWED_STORY_SORTS.includes(filters.sort) ? filters.sort : 'newest';
  let sort = { createdAt: -1 };
  if (safeSort === 'expiring_soon') {
    sort = { expiresAt: 1 };
  } else if (safeSort === 'views') {
    sort = { 'stats.views': -1, createdAt: -1 };
  } else if (safeSort === 'oldest') {
    sort = { createdAt: 1 };
  }

  try {
    const [total, rawStories, stats] = await Promise.all([
      database.collection(collection.COMMUNITY_STORIES_COLLECTION).countDocuments(query),
      database.collection(collection.COMMUNITY_STORIES_COLLECTION)
        .find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray(),
      getCommunityStats()
    ]);

    const authorIds = rawStories.map(s => s.authorId).filter(Boolean);
    const storyIds = rawStories.map(s => String(s._id));

    const [userMap, reportMap] = await Promise.all([
      lookupUsersMap(database, authorIds),
      lookupReportCountsMap(database, storyIds)
    ]);

    const records = rawStories.map(s => {
      const sId = String(s._id);
      const author = userMap.get(String(s.authorId)) || {
        _id: String(s.authorId || ''),
        name: 'Community Member',
        username: 'user',
        avatar: null,
        role: 'student'
      };

      const repData = reportMap.get(sId) || { total: 0, pending: 0 };
      const expiresAt = s.expiresAt ? new Date(s.expiresAt) : null;
      const isExpired = expiresAt ? expiresAt <= now : false;

      let lifecycleStatus = 'ACTIVE';
      if (s.isDeleted) {
        lifecycleStatus = 'REMOVED';
      } else if (isExpired) {
        lifecycleStatus = 'EXPIRED';
      }

      return {
        ...s,
        _id: sId,
        author,
        isExpired,
        lifecycleStatus,
        reportTotal: repData.total,
        reportPending: repData.pending,
        hasReports: repData.total > 0,
        viewsCount: s.stats?.views || 0,
        reactionsCount: s.stats?.reactions || 0,
        repliesCount: s.stats?.replies || 0
      };
    });

    return {
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      stats,
      filters: {
        ...filters,
        status,
        type: filters.type || 'ALL',
        search: search || '',
        sort: filters.sort || 'newest'
      }
    };
  } catch (err) {
    logger.error('getStories error:', err.message);
    return {
      records: [],
      total: 0,
      page: 1,
      limit,
      totalPages: 1,
      filters
    };
  }
};

const getStoryById = async (storyId) => {
  if (!isValidCommunityId(storyId)) return null;

  const database = db.get();
  if (!database) return null;

  try {
    const story = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: storyId });
    if (!story) return null;

    const sId = String(story._id);
    const now = new Date();

    const [authorMap, reports, modLogs, mediaList] = await Promise.all([
      lookupUsersMap(database, [story.authorId]),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).find({ entityId: sId }).sort({ createdAt: -1 }).limit(10).toArray(),
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION).find({ entityId: sId }).sort({ createdAt: -1 }).limit(10).toArray(),
      database.collection('community_story_media').find({ storyId: sId }).toArray()
    ]);

    const author = authorMap.get(String(story.authorId)) || {
      _id: String(story.authorId),
      name: 'Community Member',
      username: 'user',
      avatar: null,
      role: 'student'
    };

    const expiresAt = story.expiresAt ? new Date(story.expiresAt) : null;
    const isExpired = expiresAt ? expiresAt <= now : false;

    let lifecycleStatus = 'ACTIVE';
    if (story.isDeleted) {
      lifecycleStatus = 'REMOVED';
    } else if (isExpired) {
      lifecycleStatus = 'EXPIRED';
    }

    return {
      ...story,
      _id: sId,
      author,
      mediaList: mediaList.map(m => ({ ...m, _id: String(m._id), url: sanitizeUrl(m.url) })),
      link: sanitizeUrl(story.link),
      isExpired,
      lifecycleStatus,
      reports: reports.map(r => ({ ...r, _id: String(r._id) })),
      reportCount: reports.length,
      moderationLogs: modLogs.map(m => ({ ...m, _id: String(m._id) })),
      viewsCount: story.stats?.views || 0,
      reactionsCount: story.stats?.reactions || 0,
      repliesCount: story.stats?.replies || 0
    };
  } catch (err) {
    logger.error('getStoryById error:', err.message);
    return null;
  }
};

const removeStory = async (storyId, { reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(storyId)) {
    throw new Error('Invalid story ID format.');
  }

  const database = db.get();
  const story = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: storyId });
  if (!story) {
    throw new Error('Story not found.');
  }

  if (story.isDeleted) {
    return { success: true, alreadyApplied: true, story };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_STORIES_COLLECTION).updateOne(
    { _id: storyId },
    {
      $set: {
        isDeleted: true,
        deletedAt: now,
        updatedAt: now
      }
    }
  );

  const cleanReason = String(reason || 'Violated community guidelines').trim();

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_STORY_REMOVED',
    entityType: 'COMMUNITY_STORY',
    entityId: storyId,
    entityName: `Story by @${story.authorId}`,
    status: 'success',
    message: `Story ${storyId} removed (soft-deleted) by admin. Reason: ${cleanReason}`,
    metadata: {
      storyId,
      authorId: story.authorId,
      previousState: { isDeleted: false, deletedAt: null },
      newState: { isDeleted: true, deletedAt: now },
      reason: cleanReason
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'remove_story',
    entityId: storyId,
    entityType: 'story',
    reason: cleanReason,
    metadata: { isDeleted: true }
  });

  return { success: true, storyId, isDeleted: true };
};

const restoreStory = async (storyId, { reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(storyId)) {
    throw new Error('Invalid story ID format.');
  }

  const database = db.get();
  const story = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: storyId });
  if (!story) {
    throw new Error('Story not found.');
  }

  if (!story.isDeleted) {
    return { success: true, alreadyApplied: true, story };
  }

  const now = new Date();
  await database.collection(collection.COMMUNITY_STORIES_COLLECTION).updateOne(
    { _id: storyId },
    {
      $set: {
        isDeleted: false,
        deletedAt: null,
        updatedAt: now
      }
    }
  );

  const cleanReason = String(reason || 'Restored by admin').trim();

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_STORY_RESTORED',
    entityType: 'COMMUNITY_STORY',
    entityId: storyId,
    entityName: `Story by @${story.authorId}`,
    status: 'success',
    message: `Story ${storyId} restored to active lifecycle by admin. Reason: ${cleanReason}`,
    metadata: {
      storyId,
      authorId: story.authorId,
      previousState: { isDeleted: true, deletedAt: story.deletedAt },
      newState: { isDeleted: false, deletedAt: null },
      reason: cleanReason
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'restore_story',
    entityId: storyId,
    entityType: 'story',
    reason: cleanReason,
    metadata: { isDeleted: false }
  });

  return { success: true, storyId, isDeleted: false };
};

// ============================================================================
// 4. COMMUNITY REPORTS MANAGEMENT
// ============================================================================

const resolveReportedEntity = async (database, entityType, entityId) => {
  if (!entityType || !entityId) return { entity: null, unavailable: true };
  const type = String(entityType).toLowerCase().trim();

  try {
    if (type === 'post') {
      const post = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: entityId });
      if (!post) return { entity: null, entityType: 'post', unavailable: true };
      const authorMap = await lookupUsersMap(database, [post.authorId]);
      return {
        entity: {
          ...post,
          _id: String(post._id),
          author: authorMap.get(String(post.authorId)) || { name: 'Community Member', username: 'user' },
          snippet: post.content ? (post.content.length > 150 ? post.content.substring(0, 150) + '...' : post.content) : 'Media post',
          statusLabel: post.isDeleted ? 'HIDDEN' : (post.isLocked ? 'LOCKED' : 'ACTIVE'),
          url: `/admin/community/posts/${post._id}`
        },
        entityType: 'post',
        unavailable: false
      };
    } else if (type === 'comment') {
      const comment = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: entityId });
      if (!comment) return { entity: null, entityType: 'comment', unavailable: true };
      const authorMap = await lookupUsersMap(database, [comment.authorId]);
      return {
        entity: {
          ...comment,
          _id: String(comment._id),
          author: authorMap.get(String(comment.authorId)) || { name: 'Community Member', username: 'user' },
          snippet: comment.content ? (comment.content.length > 150 ? comment.content.substring(0, 150) + '...' : comment.content) : 'Comment',
          statusLabel: comment.isDeleted ? 'DELETED' : 'ACTIVE',
          url: `/admin/community/comments/${comment._id}`
        },
        entityType: 'comment',
        unavailable: false
      };
    } else if (type === 'story') {
      const story = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: entityId });
      if (!story) return { entity: null, entityType: 'story', unavailable: true };
      const authorMap = await lookupUsersMap(database, [story.authorId]);
      const now = new Date();
      const isExpired = story.expiresAt ? new Date(story.expiresAt) <= now : false;
      let statusLabel = 'ACTIVE';
      if (story.isDeleted) statusLabel = 'REMOVED';
      else if (isExpired) statusLabel = 'EXPIRED';

      return {
        entity: {
          ...story,
          _id: String(story._id),
          author: authorMap.get(String(story.authorId)) || { name: 'Community Member', username: 'user' },
          snippet: story.text || (story.type ? `Story (${story.type})` : 'Story'),
          statusLabel,
          url: `/admin/community/stories/${story._id}`
        },
        entityType: 'story',
        unavailable: false
      };
    } else if (type === 'user') {
      let user = null;
      if (ObjectId.isValid(entityId) && String(new ObjectId(entityId)) === entityId) {
        user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: new ObjectId(entityId) });
      } else {
        user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: entityId });
      }
      if (!user) return { entity: null, entityType: 'user', unavailable: true };
      return {
        entity: {
          _id: String(user._id),
          name: user.Name || user.name || user.username || 'User',
          username: user.username || 'user',
          email: user.Email || user.email || '',
          role: user.primaryRole || user.role || 'student',
          statusLabel: user.account_Status?.isBlocked ? 'BLOCKED' : 'ACTIVE',
          url: `/students`
        },
        entityType: 'user',
        unavailable: false
      };
    } else {
      return { entity: null, entityType: type, unsupported: true, unavailable: true };
    }
  } catch (err) {
    logger.warn('resolveReportedEntity error:', err.message);
    return { entity: null, entityType: type, unavailable: true };
  }
};

const getReports = async (filters = {}) => {
  const database = db.get();
  if (!database) {
    return {
      records: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 1,
      stats: await getCommunityStats(),
      filters
    };
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 20), 100);
  const skip = (page - 1) * limit;

  const query = {};

  // Status Filter
  const status = (filters.status || 'all').toLowerCase();
  if (['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
    query.status = status;
  }

  // Entity Type Filter
  const entityType = (filters.entityType || 'all').toLowerCase();
  if (['post', 'comment', 'story', 'user'].includes(entityType)) {
    query.entityType = entityType;
  }

  // Target Entity ID Filter
  if (filters.targetEntityId && typeof filters.targetEntityId === 'string') {
    query.entityId = filters.targetEntityId.trim();
  }

  // Reporter ID Filter
  if (filters.reporterId && typeof filters.reporterId === 'string') {
    query.reporterId = filters.reporterId.trim();
  }

  // Date range filter
  if (filters.startDate || filters.endDate) {
    const dateFilter = {};
    if (filters.startDate) {
      const s = new Date(filters.startDate);
      if (!isNaN(s.getTime())) dateFilter.$gte = s;
    }
    if (filters.endDate) {
      const e = new Date(filters.endDate);
      if (!isNaN(e.getTime())) {
        e.setHours(23, 59, 59, 999);
        dateFilter.$lte = e;
      }
    }
    if (Object.keys(dateFilter).length > 0) {
      query.createdAt = dateFilter;
    }
  }

  // Reason Filter
  if (filters.reason && filters.reason.toLowerCase() !== 'all') {
    query.reason = filters.reason.trim();
  }

  // Search Filter
  const search = (typeof filters.search === 'string' ? filters.search : '').trim();
  if (search) {
    const sRegex = new RegExp(escapeRegex(search), 'i');
    query.$or = [
      { _id: sRegex },
      { entityId: sRegex },
      { reporterId: sRegex },
      { reason: sRegex },
      { description: sRegex },
      { moderatorNotes: sRegex }
    ];
  }

  // Sorting (Allowlisted)
  const ALLOWED_REPORT_SORTS = ['newest', 'oldest', 'priority'];
  const safeSort = ALLOWED_REPORT_SORTS.includes(filters.sort) ? filters.sort : 'newest';
  let sort = { createdAt: -1 };
  if (safeSort === 'oldest') {
    sort = { createdAt: 1 };
  }

  try {
    const [total, rawReports, stats] = await Promise.all([
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION).countDocuments(query),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray(),
      getCommunityStats()
    ]);

    const reporterIds = rawReports.map(r => r.reporterId).filter(Boolean);
    const entityIds = rawReports.map(r => r.entityId).filter(Boolean);

    const [reporterMap, entityReportCountsMap] = await Promise.all([
      lookupUsersMap(database, reporterIds),
      lookupReportCountsMap(database, entityIds)
    ]);

    // Batch resolve target entities
    const postIds = rawReports.filter(r => (r.entityType || '').toLowerCase() === 'post').map(r => r.entityId);
    const commentIds = rawReports.filter(r => (r.entityType || '').toLowerCase() === 'comment').map(r => r.entityId);
    const storyIds = rawReports.filter(r => (r.entityType || '').toLowerCase() === 'story').map(r => r.entityId);

    const [posts, comments, stories] = await Promise.all([
      postIds.length ? database.collection(collection.COMMUNITY_POSTS_COLLECTION).find({ _id: { $in: postIds } }, { projection: { _id: 1, content: 1, authorId: 1, isDeleted: 1, isLocked: 1 } }).toArray() : Promise.resolve([]),
      commentIds.length ? database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).find({ _id: { $in: commentIds } }, { projection: { _id: 1, content: 1, authorId: 1, isDeleted: 1, postId: 1 } }).toArray() : Promise.resolve([]),
      storyIds.length ? database.collection(collection.COMMUNITY_STORIES_COLLECTION).find({ _id: { $in: storyIds } }, { projection: { _id: 1, text: 1, type: 1, authorId: 1, isDeleted: 1, expiresAt: 1 } }).toArray() : Promise.resolve([])
    ]);

    const postMap = new Map(posts.map(p => [String(p._id), p]));
    const commentMap = new Map(comments.map(c => [String(c._id), c]));
    const storyMap = new Map(stories.map(s => [String(s._id), s]));

    const now = new Date();

    const records = rawReports.map(r => {
      const rId = String(r._id);
      const eId = String(r.entityId);
      const eType = (r.entityType || 'post').toLowerCase();

      const reporter = reporterMap.get(String(r.reporterId)) || {
        _id: String(r.reporterId || ''),
        name: 'Community Member',
        username: 'user'
      };

      const entityReportCounts = entityReportCountsMap.get(eId) || { total: 1, pending: 1 };

      let targetSnippet = 'Reported Content';
      let targetStatus = 'ACTIVE';
      let targetUrl = `/admin/community/reports/${rId}`;
      let isUnavailable = false;

      if (eType === 'post') {
        const post = postMap.get(eId);
        if (post) {
          targetSnippet = post.content ? (post.content.length > 80 ? post.content.substring(0, 80) + '...' : post.content) : 'Post';
          targetStatus = post.isDeleted ? 'HIDDEN' : (post.isLocked ? 'LOCKED' : 'ACTIVE');
          targetUrl = `/admin/community/posts/${eId}`;
        } else {
          isUnavailable = true;
          targetStatus = 'UNAVAILABLE';
        }
      } else if (eType === 'comment') {
        const comment = commentMap.get(eId);
        if (comment) {
          targetSnippet = comment.content ? (comment.content.length > 80 ? comment.content.substring(0, 80) + '...' : comment.content) : 'Comment';
          targetStatus = comment.isDeleted ? 'DELETED' : 'ACTIVE';
          targetUrl = `/admin/community/comments/${eId}`;
        } else {
          isUnavailable = true;
          targetStatus = 'UNAVAILABLE';
        }
      } else if (eType === 'story') {
        const story = storyMap.get(eId);
        if (story) {
          targetSnippet = story.text || (story.type ? `Story (${story.type})` : 'Story');
          const isExpired = story.expiresAt ? new Date(story.expiresAt) <= now : false;
          if (story.isDeleted) targetStatus = 'REMOVED';
          else if (isExpired) targetStatus = 'EXPIRED';
          else targetStatus = 'ACTIVE';
          targetUrl = `/admin/community/stories/${eId}`;
        } else {
          isUnavailable = true;
          targetStatus = 'UNAVAILABLE';
        }
      }

      return {
        ...r,
        _id: rId,
        reporter,
        targetSnippet,
        targetStatus,
        targetUrl,
        isUnavailable,
        entityReportsTotal: entityReportCounts.total,
        statusUpper: String(r.status || 'pending').toUpperCase(),
        isPending: String(r.status || 'pending').toLowerCase() === 'pending',
        isResolved: String(r.status).toLowerCase() === 'resolved',
        isDismissed: String(r.status).toLowerCase() === 'dismissed',
        isReviewed: String(r.status).toLowerCase() === 'reviewed'
      };
    });

    return {
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      stats,
      filters: {
        ...filters,
        status,
        entityType,
        reason: filters.reason || 'ALL',
        search: search || '',
        sort: filters.sort || 'newest'
      }
    };
  } catch (err) {
    logger.error('getReports error:', err.message);
    return {
      records: [],
      total: 0,
      page: 1,
      limit,
      totalPages: 1,
      stats: await getCommunityStats(),
      filters
    };
  }
};

const getReportById = async (reportId) => {
  if (!isValidCommunityId(reportId)) return null;

  const database = db.get();
  if (!database) return null;

  try {
    const report = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: reportId });
    if (!report) return null;

    const rId = String(report._id);
    const eId = String(report.entityId);
    const eType = String(report.entityType || 'post').toLowerCase();

    const [reporterMap, modUserMap, targetResolved, otherReports, modHistory] = await Promise.all([
      lookupUsersMap(database, [report.reporterId]),
      report.moderatorId ? lookupUsersMap(database, [report.moderatorId]) : Promise.resolve(new Map()),
      resolveReportedEntity(database, eType, eId),
      database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
        .find({ entityId: eId, _id: { $ne: rId } })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray(),
      database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION)
        .find({ entityId: eId })
        .sort({ createdAt: -1 })
        .limit(15)
        .toArray()
    ]);

    const reporter = reporterMap.get(String(report.reporterId)) || {
      _id: String(report.reporterId || ''),
      name: 'Community Member',
      username: 'user'
    };

    const moderator = report.moderatorId ? (modUserMap.get(String(report.moderatorId)) || {
      _id: String(report.moderatorId),
      name: report.moderatorName || 'Admin'
    }) : null;

    const reporterTotalReports = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).countDocuments({ reporterId: String(report.reporterId) });

    return {
      ...report,
      _id: rId,
      reporter,
      reporterTotalReports,
      moderator,
      targetEntity: targetResolved.entity,
      targetUnavailable: targetResolved.unavailable,
      targetUnsupported: targetResolved.unsupported,
      otherReports: otherReports.map(or => ({
        ...or,
        _id: String(or._id),
        statusUpper: String(or.status || 'pending').toUpperCase()
      })),
      otherReportsCount: otherReports.length,
      modHistory: modHistory.map(mh => ({
        ...mh,
        _id: String(mh._id)
      })),
      statusUpper: String(report.status || 'pending').toUpperCase(),
      isPending: String(report.status || 'pending').toLowerCase() === 'pending',
      isResolved: String(report.status).toLowerCase() === 'resolved',
      isDismissed: String(report.status).toLowerCase() === 'dismissed',
      isReviewed: String(report.status).toLowerCase() === 'reviewed'
    };
  } catch (err) {
    logger.error('getReportById error:', err.message);
    return null;
  }
};

const dismissReport = async (reportId, { notes = '', reason = '' } = {}, actor, req) => {
  if (!isValidCommunityId(reportId)) {
    throw new Error('Invalid report ID format.');
  }

  const database = db.get();
  const report = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: reportId });
  if (!report) {
    throw new Error('Report not found.');
  }

  if (report.status === 'dismissed') {
    return { success: true, alreadyApplied: true, report };
  }

  const now = new Date();
  const modId = String(actor?._id || actor?.id || 'admin');
  const modName = actor?.Name || actor?.name || actor?.username || 'Admin';
  const cleanNotes = String(notes || reason || 'Dismissed by moderator').trim();

  await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).updateOne(
    { _id: reportId },
    {
      $set: {
        status: 'dismissed',
        moderatorId: modId,
        moderatorName: modName,
        moderatorNotes: cleanNotes,
        resolvedAt: now,
        actionTaken: 'dismissed',
        updatedAt: now
      }
    }
  );

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_REPORT_DISMISSED',
    entityType: 'COMMUNITY_REPORT',
    entityId: reportId,
    entityName: `Report #${reportId.slice(-6)} on ${report.entityType} ${report.entityId}`,
    status: 'success',
    message: `Community report ${reportId} dismissed by admin. Notes: ${cleanNotes}`,
    metadata: {
      reportId,
      entityId: report.entityId,
      entityType: report.entityType,
      previousStatus: report.status,
      newStatus: 'dismissed',
      notes: cleanNotes
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'dismiss_report',
    entityId: report.entityId,
    entityType: report.entityType,
    reason: cleanNotes,
    metadata: { reportId, status: 'dismissed' }
  });

  return { success: true, reportId, status: 'dismissed' };
};

const resolveReport = async (reportId, { notes = '', actionTaken = 'resolved' } = {}, actor, req) => {
  if (!isValidCommunityId(reportId)) {
    throw new Error('Invalid report ID format.');
  }

  const database = db.get();
  const report = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: reportId });
  if (!report) {
    throw new Error('Report not found.');
  }

  if (report.status === 'resolved') {
    return { success: true, alreadyApplied: true, report };
  }

  const now = new Date();
  const modId = String(actor?._id || actor?.id || 'admin');
  const modName = actor?.Name || actor?.name || actor?.username || 'Admin';
  const cleanNotes = String(notes || 'Resolved by moderator').trim();
  const cleanAction = String(actionTaken || 'resolved').trim();

  await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).updateOne(
    { _id: reportId },
    {
      $set: {
        status: 'resolved',
        moderatorId: modId,
        moderatorName: modName,
        moderatorNotes: cleanNotes,
        resolvedAt: now,
        actionTaken: cleanAction,
        updatedAt: now
      }
    }
  );

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_REPORT_RESOLVED',
    entityType: 'COMMUNITY_REPORT',
    entityId: reportId,
    entityName: `Report #${reportId.slice(-6)} on ${report.entityType} ${report.entityId}`,
    status: 'success',
    message: `Community report ${reportId} marked as resolved by admin. Action: ${cleanAction}. Notes: ${cleanNotes}`,
    metadata: {
      reportId,
      entityId: report.entityId,
      entityType: report.entityType,
      previousStatus: report.status,
      newStatus: 'resolved',
      actionTaken: cleanAction,
      notes: cleanNotes
    }
  });

  await logCommunityModeration(database, {
    moderator: actor,
    action: 'resolve_report',
    entityId: report.entityId,
    entityType: report.entityType,
    reason: cleanNotes,
    metadata: { reportId, status: 'resolved', actionTaken: cleanAction }
  });

  return { success: true, reportId, status: 'resolved', actionTaken: cleanAction };
};

const addReportNote = async (reportId, { notes = '' } = {}, actor, req) => {
  if (!isValidCommunityId(reportId)) {
    throw new Error('Invalid report ID format.');
  }

  const database = db.get();
  const report = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: reportId });
  if (!report) {
    throw new Error('Report not found.');
  }

  const cleanNotes = String(notes || '').trim();
  if (!cleanNotes) {
    throw new Error('Note content cannot be empty.');
  }

  const now = new Date();
  const modName = actor?.Name || actor?.name || 'Admin';
  const updatedNote = report.moderatorNotes ? `${report.moderatorNotes}\n[${now.toISOString().slice(0, 10)} ${modName}]: ${cleanNotes}` : `[${now.toISOString().slice(0, 10)} ${modName}]: ${cleanNotes}`;

  await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).updateOne(
    { _id: reportId },
    {
      $set: {
        moderatorNotes: updatedNote,
        updatedAt: now
      }
    }
  );

  await auditHelper.logAction({
    req,
    actor,
    action: 'COMMUNITY_REPORT_NOTE_ADDED',
    entityType: 'COMMUNITY_REPORT',
    entityId: reportId,
    entityName: `Report #${reportId.slice(-6)}`,
    status: 'success',
    message: `Note added to community report ${reportId} by ${modName}`,
    metadata: {
      reportId,
      note: cleanNotes
    }
  });

  return { success: true, reportId, moderatorNotes: updatedNote };
};

// ============================================================================
// BULK MODERATION ACTIONS (REUSING EXISTING SINGLE-ENTITY MUTATION LOGIC)
// ============================================================================

/**
 * Executes a batch moderation action on multiple community entities.
 * Reuses existing single-entity mutation functions, preserves entity-level audit logs,
 * validates batch bounds (1-50 max), and creates an aggregated bulk audit log.
 */
const executeBulkAction = async ({
  entityType,
  action,
  ids = [],
  options = {},
  actor,
  req
}) => {
  if (!Array.isArray(ids)) {
    throw new Error('Invalid IDs payload. Expected an array of IDs.');
  }

  const MAX_BULK_LIMIT = 50;
  if (ids.length === 0) {
    throw new Error('No items selected for bulk action.');
  }
  if (ids.length > MAX_BULK_LIMIT) {
    throw new Error(`Batch limit exceeded. Maximum ${MAX_BULK_LIMIT} items can be processed in a single bulk operation.`);
  }

  const validIds = [];
  const invalidIds = [];
  for (const rawId of ids) {
    const id = String(rawId || '').trim();
    if (isValidCommunityId(id)) {
      validIds.push(id);
    } else {
      invalidIds.push(id);
    }
  }

  const crypto = require('crypto');
  const bulkOperationId = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substr(2, 5));

  const results = {
    bulkOperationId,
    entityType,
    action,
    requested: ids.length,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    details: []
  };

  for (const invId of invalidIds) {
    results.failed++;
    results.details.push({ id: invId, success: false, reason: 'Invalid identifier format' });
  }

  for (const id of validIds) {
    try {
      let res;
      if (entityType === 'post') {
        if (action === 'hide') res = await hidePost(id, options, actor, req);
        else if (action === 'restore') res = await restorePost(id, options, actor, req);
        else if (action === 'lock') res = await lockPost(id, { isLocked: true, ...options }, actor, req);
        else if (action === 'unlock') res = await lockPost(id, { isLocked: false, ...options }, actor, req);
        else if (action === 'pin') res = await pinPost(id, { isPinned: true, ...options }, actor, req);
        else if (action === 'unpin') res = await pinPost(id, { isPinned: false, ...options }, actor, req);
        else throw new Error(`Unsupported action '${action}' for post.`);
      } else if (entityType === 'comment') {
        if (action === 'delete') res = await deleteComment(id, options, actor, req);
        else if (action === 'restore') res = await restoreComment(id, options, actor, req);
        else throw new Error(`Unsupported action '${action}' for comment.`);
      } else if (entityType === 'story') {
        if (action === 'remove') res = await removeStory(id, options, actor, req);
        else if (action === 'restore') res = await restoreStory(id, options, actor, req);
        else throw new Error(`Unsupported action '${action}' for story.`);
      } else if (entityType === 'report') {
        if (action === 'resolve') res = await resolveReport(id, options, actor, req);
        else if (action === 'dismiss') res = await dismissReport(id, options, actor, req);
        else throw new Error(`Unsupported action '${action}' for report.`);
      } else {
        throw new Error(`Unsupported entity type '${entityType}'.`);
      }

      if (res && res.alreadyApplied) {
        results.skipped++;
        results.details.push({ id, success: true, skipped: true, message: 'Item was already in requested state' });
      } else {
        results.succeeded++;
        results.details.push({ id, success: true, skipped: false });
      }
    } catch (itemErr) {
      results.failed++;
      results.details.push({ id, success: false, reason: itemErr.message });
    }
  }

  // Aggregated Bulk Audit Log
  await auditHelper.logAction({
    req,
    actor,
    action: `COMMUNITY_BULK_${entityType.toUpperCase()}_ACTION`,
    entityType: `COMMUNITY_${entityType.toUpperCase()}`,
    entityId: bulkOperationId,
    entityName: `Bulk ${action} on ${entityType}s`,
    status: results.succeeded > 0 ? 'success' : (results.failed > 0 ? 'failure' : 'neutral'),
    message: `Bulk ${action} executed on ${results.requested} ${entityType}s: ${results.succeeded} succeeded, ${results.skipped} skipped, ${results.failed} failed.`,
    metadata: {
      bulkOperationId,
      action,
      entityType,
      requestedCount: results.requested,
      succeededCount: results.succeeded,
      skippedCount: results.skipped,
      failedCount: results.failed,
      reason: options.reason || ''
    }
  });

  return results;
};

// ============================================================================
// GLOBAL COMMUNITY SEARCH
// ============================================================================

/**
 * Searches across Posts, Comments, Stories, Reports, and Users.
 * Employs safe regex escaping, projections, bounded limits, and single-pass user lookups.
 */
const searchCommunity = async (queryText = '', options = {}) => {
  const database = db.get();
  if (!database) {
    return { results: [], total: 0, query: queryText, page: 1, limit: 20, totalPages: 1 };
  }

  const cleanQuery = String(queryText || '').trim().slice(0, 100);
  if (!cleanQuery) {
    return { results: [], total: 0, query: '', page: 1, limit: 20, totalPages: 1 };
  }

  const type = String(options.type || 'all').toLowerCase();
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(Math.max(1, Number(options.limit) || 20), 50);

  const escaped = escapeRegex(cleanQuery);
  const regex = new RegExp(escaped, 'i');

  const searchPosts = async () => {
    return database.collection(collection.COMMUNITY_POSTS_COLLECTION)
      .find({
        $or: [
          { _id: regex },
          { content: regex },
          { title: regex },
          { authorId: regex },
          { tags: regex },
          { hashtags: regex }
        ]
      }, {
        projection: {
          _id: 1,
          authorId: 1,
          title: 1,
          content: 1,
          isDeleted: 1,
          isLocked: 1,
          isPinned: 1,
          createdAt: 1,
          stats: 1
        }
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  };

  const searchComments = async () => {
    return database.collection(collection.COMMUNITY_COMMENTS_COLLECTION)
      .find({
        $or: [
          { _id: regex },
          { content: regex },
          { postId: regex },
          { authorId: regex }
        ]
      }, {
        projection: {
          _id: 1,
          authorId: 1,
          postId: 1,
          content: 1,
          isDeleted: 1,
          createdAt: 1
        }
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  };

  const searchStories = async () => {
    return database.collection(collection.COMMUNITY_STORIES_COLLECTION)
      .find({
        $or: [
          { _id: regex },
          { authorId: regex },
          { text: regex },
          { courseTag: regex }
        ]
      }, {
        projection: {
          _id: 1,
          authorId: 1,
          text: 1,
          mediaUrl: 1,
          expiresAt: 1,
          isDeleted: 1,
          createdAt: 1
        }
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  };

  const searchReports = async () => {
    return database.collection(collection.COMMUNITY_REPORTS_COLLECTION)
      .find({
        $or: [
          { _id: regex },
          { entityId: regex },
          { reporterId: regex },
          { reason: regex },
          { description: regex },
          { status: regex }
        ]
      }, {
        projection: {
          _id: 1,
          entityId: 1,
          entityType: 1,
          reason: 1,
          status: 1,
          reporterId: 1,
          createdAt: 1
        }
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  };

  const searchUsers = async () => {
    return database.collection(collection.STUDENTS_COLLECTION)
      .find({
        $or: [
          { username: regex },
          { Name: regex },
          { name: regex },
          { email: regex },
          { Email: regex }
        ]
      }, {
        projection: {
          _id: 1,
          Name: 1,
          name: 1,
          username: 1,
          email: 1,
          Email: 1,
          avatar: 1,
          role: 1
        }
      })
      .limit(limit)
      .toArray();
  };

  let rawPosts = [], rawComments = [], rawStories = [], rawReports = [], rawUsers = [];

  if (type === 'posts') {
    rawPosts = await searchPosts();
  } else if (type === 'comments') {
    rawComments = await searchComments();
  } else if (type === 'stories') {
    rawStories = await searchStories();
  } else if (type === 'reports') {
    rawReports = await searchReports();
  } else if (type === 'users') {
    rawUsers = await searchUsers();
  } else {
    [rawPosts, rawComments, rawStories, rawReports, rawUsers] = await Promise.all([
      searchPosts(),
      searchComments(),
      searchStories(),
      searchReports(),
      searchUsers()
    ]);
  }

  const authorIds = [
    ...rawPosts.map(p => p.authorId),
    ...rawComments.map(c => c.authorId),
    ...rawStories.map(s => s.authorId),
    ...rawReports.map(r => r.reporterId)
  ].filter(Boolean);

  const usersMap = await lookupUsersMap(database, authorIds);

  const items = [];

  // Format Posts
  for (const p of rawPosts) {
    const author = usersMap.get(String(p.authorId));
    items.push({
      id: String(p._id),
      entityType: 'post',
      typeLabel: 'Post',
      icon: 'fa-solid fa-signs-post',
      iconColor: '#3b82f6',
      badgeClass: p.isDeleted ? 'badge-status-archived' : 'badge-status-active',
      status: p.isDeleted ? 'Deleted' : (p.isLocked ? 'Locked' : 'Active'),
      title: p.title || `Post #${String(p._id).slice(-8)}`,
      snippet: p.content ? (p.content.slice(0, 100) + (p.content.length > 100 ? '...' : '')) : 'No text content',
      authorName: author ? author.name : (p.authorId ? `User (${String(p.authorId).slice(-4)})` : 'Member'),
      authorUsername: author ? author.username : 'user',
      createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
      detailUrl: `/admin/community/posts/${p._id}`
    });
  }

  // Format Comments
  for (const c of rawComments) {
    const author = usersMap.get(String(c.authorId));
    items.push({
      id: String(c._id),
      entityType: 'comment',
      typeLabel: 'Comment',
      icon: 'fa-solid fa-comments',
      iconColor: '#10b981',
      badgeClass: c.isDeleted ? 'badge-status-archived' : 'badge-status-active',
      status: c.isDeleted ? 'Deleted' : 'Active',
      title: `Comment on Post #${String(c.postId || '').slice(-6)}`,
      snippet: c.content ? (c.content.slice(0, 100) + (c.content.length > 100 ? '...' : '')) : 'No text content',
      authorName: author ? author.name : (c.authorId ? `User (${String(c.authorId).slice(-4)})` : 'Member'),
      authorUsername: author ? author.username : 'user',
      createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
      detailUrl: `/admin/community/comments/${c._id}`
    });
  }

  // Format Stories
  for (const s of rawStories) {
    const author = usersMap.get(String(s.authorId));
    const now = new Date();
    const isExpired = s.expiresAt && new Date(s.expiresAt) <= now;
    items.push({
      id: String(s._id),
      entityType: 'story',
      typeLabel: 'Story',
      icon: 'fa-solid fa-circle-play',
      iconColor: '#06b6d4',
      badgeClass: s.isDeleted ? 'badge-status-archived' : (isExpired ? 'badge-status-scheduled' : 'badge-status-active'),
      status: s.isDeleted ? 'Deleted' : (isExpired ? 'Expired' : 'Active'),
      title: `Story #${String(s._id).slice(-8)}`,
      snippet: s.text ? s.text.slice(0, 80) : 'Visual Story Content',
      authorName: author ? author.name : (s.authorId ? `User (${String(s.authorId).slice(-4)})` : 'Member'),
      authorUsername: author ? author.username : 'user',
      createdAt: s.createdAt ? new Date(s.createdAt) : new Date(),
      detailUrl: `/admin/community/stories/${s._id}`
    });
  }

  // Format Reports
  for (const r of rawReports) {
    const reporter = usersMap.get(String(r.reporterId));
    const s = String(r.status || 'pending').toLowerCase();
    let badgeClass = 'badge-status-scheduled';
    if (s === 'resolved') badgeClass = 'badge-status-active';
    else if (s === 'dismissed') badgeClass = 'badge-status-draft';

    items.push({
      id: String(r._id),
      entityType: 'report',
      typeLabel: 'Report',
      icon: 'fa-solid fa-flag',
      iconColor: '#ef4444',
      badgeClass,
      status: s.toUpperCase(),
      title: `Report on ${r.entityType || 'entity'}: ${r.reason || 'Flagged'}`,
      snippet: `Target ID: ${r.entityId || 'N/A'}. Reporter: ${reporter ? reporter.name : (r.reporterId || 'Unknown')}`,
      authorName: reporter ? reporter.name : 'Reporter',
      authorUsername: reporter ? reporter.username : 'user',
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
      detailUrl: `/admin/community/reports/${r._id}`
    });
  }

  // Format Users
  for (const u of rawUsers) {
    items.push({
      id: String(u._id),
      entityType: 'user',
      typeLabel: 'User',
      icon: 'fa-solid fa-user-shield',
      iconColor: '#8b5cf6',
      badgeClass: 'badge-status-active',
      status: u.role || 'Member',
      title: u.Name || u.name || u.username || 'User',
      snippet: `@${u.username || 'user'} • ${u.Email || u.email || ''}`,
      authorName: u.Name || u.name || 'Member',
      authorUsername: u.username || 'user',
      createdAt: new Date(),
      detailUrl: `/admin/community/reports?search=${encodeURIComponent(u.username || u.Name || String(u._id))}`
    });
  }

  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const total = items.length;
  const skip = (page - 1) * limit;
  const paginatedItems = items.slice(skip, skip + limit);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    results: paginatedItems,
    total,
    page,
    limit,
    totalPages,
    query: cleanQuery,
    type
  };
};

module.exports = {
  isValidCommunityId,
  getCommunityStats,
  // Posts
  getPosts,
  getPostById,
  hidePost,
  restorePost,
  lockPost,
  pinPost,
  // Comments
  getComments,
  getCommentById,
  deleteComment,
  restoreComment,
  // Stories
  getStories,
  getStoryById,
  removeStory,
  restoreStory,
  // Reports (Phase 3)
  getReports,
  getReportById,
  dismissReport,
  resolveReport,
  addReportNote,
  // Phase 5 Bulk, Search & Security
  escapeRegex,
  sanitizeUrl,
  executeBulkAction,
  searchCommunity,
  globalCommunitySearch: searchCommunity
};
