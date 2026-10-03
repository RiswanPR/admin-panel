const express = require('express');
const router = express.Router();
const communityHelper = require('../Helpers/community-helper');
const communityAnalyticsHelper = require('../Helpers/community-analytics-helper');
const permissionsHelper = require('../Helpers/permissions-helper');
const { requireCapability } = permissionsHelper;
const logger = require('../Helpers/logger');

// Auth middleware for admin session
const verifyLogin = (req, res, next) => {
  if (req.session?.adminloggedIn) {
    next();
  } else {
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
    }
    res.redirect('/login');
  }
};

// Middleware: inject common locals for navigation and view toggle
router.use((req, res, next) => {
  const admin = req.session?.admin || null;
  res.locals.admins = true;
  res.locals.sessionAdmin = admin;
  res.locals.isSuperuser = admin?.role === 'superuser';
  res.locals.viewMode = req.query?.view === 'table' ? 'table' : 'card';
  res.locals.adminCapabilities = permissionsHelper.getAdminCapabilities(admin);
  res.locals.canManageNetwork = permissionsHelper.hasCapability(admin, 'manage_network');
  res.locals.canModerateContent = permissionsHelper.hasCapability(admin, 'moderate_content');
  res.locals.canViewAuditLogs = permissionsHelper.hasCapability(admin, 'view_audit_logs');
  next();
});

// ID Validation middleware for Community UUIDs
const validateCommunityIdParam = (paramName = 'id') => {
  return (req, res, next) => {
    const id = req.params[paramName];
    if (!communityHelper.isValidCommunityId(id)) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
        return res.status(400).json({ success: false, message: `Invalid identifier format: ${paramName}` });
      }
      return res.status(400).render('error', { message: `Invalid identifier format: ${paramName}` });
    }
    next();
  };
};

// ============================================================================
// ROOT & COMMUNITY OVERVIEW / OPERATIONS DASHBOARD
// ============================================================================

const handleCommunityOverview = async (req, res) => {
  try {
    const overviewData = await communityAnalyticsHelper.getCommunityOverview(req.query);

    // If client requested JSON response
    if (req.xhr || req.query.format === 'json' || req.headers.accept?.indexOf('application/json') > -1) {
      return res.json({ success: true, ...overviewData });
    }

    res.render('admin/community-overview', {
      admin: req.session.admin?.Name || req.session.admin?.name || 'Admin',
      currentPage: 'community-overview',
      data: overviewData,
      dateRange: overviewData.dateRange,
      snapshot: overviewData.snapshot,
      trends: overviewData.trends,
      trendsJson: JSON.stringify(overviewData.trends),
      engagement: overviewData.engagement,
      moderation: overviewData.moderation,
      contentStatus: overviewData.contentStatus,
      recentActivity: overviewData.recentActivity,
      rulesPolicy: overviewData.rulesPolicy,
      validationError: overviewData.error,
      breadcrumbs: [
        { label: 'Admin', url: '/admin' },
        { label: 'Community', url: '/admin/community' },
        { label: 'Operations & Analytics', active: true }
      ]
    });
  } catch (err) {
    logger.error('Error rendering community overview:', err.message);
    if (req.xhr || req.query.format === 'json') {
      return res.status(500).json({ success: false, message: 'Failed to load community analytics' });
    }
    res.status(500).render('error', { message: 'Failed to load community operations dashboard' });
  }
};

router.get('/', verifyLogin, requireCapability('moderate_content'), handleCommunityOverview);
router.get('/overview', verifyLogin, requireCapability('moderate_content'), handleCommunityOverview);

// ============================================================================
// 1. COMMUNITY POSTS
// ============================================================================

// GET /admin/community/posts — List & Filter Posts
router.get('/posts', verifyLogin, async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      status: req.query.status || 'all',
      audience: req.query.audience || 'ALL',
      postType: req.query.postType || 'ALL',
      type: req.query.type || 'ALL',
      authorId: req.query.authorId || '',
      courseId: req.query.courseId || '',
      sort: req.query.sort || 'newest',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      hasReports: req.query.hasReports || '',
      page: req.query.page || 1,
      limit: req.query.limit || 15
    };

    const hasActiveFilters = Boolean(
      (filters.search && filters.search.trim()) ||
      (filters.status && filters.status !== 'all') ||
      (filters.audience && filters.audience !== 'ALL') ||
      (filters.postType && filters.postType !== 'ALL') ||
      (filters.type && filters.type !== 'ALL') ||
      (filters.authorId && filters.authorId.trim()) ||
      (filters.courseId && filters.courseId.trim()) ||
      (filters.startDate && filters.startDate.trim()) ||
      (filters.endDate && filters.endDate.trim()) ||
      (filters.hasReports && filters.hasReports.trim())
    );

    const result = await communityHelper.getPosts(filters);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, ...result });
    }

    res.render('admin/community-posts', {
      currentPage: 'community-posts',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Posts' }
      ],
      records: result.records,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      stats: result.stats,
      filters: result.filters,
      hasActiveFilters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Error fetching community posts:', err.message);
    res.status(500).render('error', { message: 'Failed to load community posts.' });
  }
});

// POST /admin/community/posts/bulk — Bulk Post Administration
router.post('/posts/bulk', verifyLogin, requireCapability('moderate_content'), async (req, res) => {
  try {
    const { action, ids, reason } = req.body;
    const result = await communityHelper.executeBulkAction({
      entityType: 'post',
      action,
      ids,
      options: { reason },
      actor: req.session.admin,
      req
    });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Bulk post action error:', err.message);
    const status = err.message.includes('limit') || err.message.includes('selected') || err.message.includes('Unsupported') || err.message.includes('array') ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// GET /admin/community/posts/:id — Post Dossier & Detail
router.get('/posts/:id', verifyLogin, validateCommunityIdParam('id'), async (req, res) => {
  try {
    const post = await communityHelper.getPostById(req.params.id);
    if (!post) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(404).json({ success: false, message: 'Community post not found.' });
      }
      return res.status(404).render('error', { message: 'Community post not found.' });
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, post });
    }

    res.render('admin/community-post-detail', {
      currentPage: 'community-posts',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Posts', url: '/admin/community/posts' },
        { label: `Post #${post._id.slice(-6)}` }
      ],
      post
    });
  } catch (err) {
    logger.error('Error loading post detail:', err.message);
    res.status(500).render('error', { message: 'Failed to load post detail.' });
  }
});

// POST /admin/community/posts/:id/hide — Soft Delete
router.post('/posts/:id/hide', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const reason = (req.body.reason || 'Violated community guidelines').trim();
    const result = await communityHelper.hidePost(req.params.id, { reason }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Post was already hidden.' : 'Post hidden successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error hiding post:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/posts/:id/restore — Restore
router.post('/posts/:id/restore', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const reason = (req.body.reason || 'Restored by admin').trim();
    const result = await communityHelper.restorePost(req.params.id, { reason }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Post was already active.' : 'Post restored successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error restoring post:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/posts/:id/lock — Lock / Unlock Comments
router.post('/posts/:id/lock', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const isLocked = req.body.isLocked !== undefined ? String(req.body.isLocked) === 'true' : true;
    const reason = (req.body.reason || (isLocked ? 'Comments locked by moderator' : 'Comments unlocked by moderator')).trim();
    const result = await communityHelper.lockPost(req.params.id, { isLocked, reason }, req.session.admin, req);
    res.json({
      success: true,
      message: `Comments ${result.isLocked ? 'locked' : 'unlocked'} successfully.`,
      ...result
    });
  } catch (err) {
    logger.error('Error updating post lock status:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/posts/:id/pin — Pin / Unpin
router.post('/posts/:id/pin', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const isPinned = req.body.isPinned !== undefined ? String(req.body.isPinned) === 'true' : true;
    const reason = (req.body.reason || (isPinned ? 'Pinned by moderator' : 'Unpinned by moderator')).trim();
    const result = await communityHelper.pinPost(req.params.id, { isPinned, reason }, req.session.admin, req);
    res.json({
      success: true,
      message: `Post ${result.isPinned ? 'pinned' : 'unpinned'} successfully.`,
      ...result
    });
  } catch (err) {
    logger.error('Error pinning post:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 2. COMMUNITY COMMENTS
// ============================================================================

// GET /admin/community/comments — List Comments
router.get('/comments', verifyLogin, async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      status: req.query.status || 'all',
      postId: req.query.postId || '',
      authorId: req.query.authorId || '',
      sort: req.query.sort || 'newest',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      page: req.query.page || 1,
      limit: req.query.limit || 20
    };

    const hasActiveFilters = Boolean(
      (filters.search && filters.search.trim()) ||
      (filters.status && filters.status !== 'all') ||
      (filters.postId && filters.postId.trim()) ||
      (filters.authorId && filters.authorId.trim()) ||
      (filters.startDate && filters.startDate.trim()) ||
      (filters.endDate && filters.endDate.trim())
    );

    const result = await communityHelper.getComments(filters);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, ...result });
    }

    res.render('admin/community-comments', {
      currentPage: 'community-comments',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Comments' }
      ],
      records: result.records,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      stats: result.stats,
      filters: result.filters,
      hasActiveFilters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Error fetching comments:', err.message);
    res.status(500).render('error', { message: 'Failed to load comments.' });
  }
});

// POST /admin/community/comments/bulk — Bulk Comment Administration
router.post('/comments/bulk', verifyLogin, requireCapability('moderate_content'), async (req, res) => {
  try {
    const { action, ids, reason } = req.body;
    const result = await communityHelper.executeBulkAction({
      entityType: 'comment',
      action,
      ids,
      options: { reason },
      actor: req.session.admin,
      req
    });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Bulk comment action error:', err.message);
    const status = err.message.includes('limit') || err.message.includes('selected') || err.message.includes('Unsupported') || err.message.includes('array') ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// GET /admin/community/comments/:id — Comment Detail & Context
router.get('/comments/:id', verifyLogin, validateCommunityIdParam('id'), async (req, res) => {
  try {
    const comment = await communityHelper.getCommentById(req.params.id);
    if (!comment) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(404).json({ success: false, message: 'Comment not found.' });
      }
      return res.status(404).render('error', { message: 'Comment not found.' });
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, comment });
    }

    res.render('admin/community-comment-detail', {
      currentPage: 'community-comments',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Comments', url: '/admin/community/comments' },
        { label: `Comment #${comment._id.slice(-6)}` }
      ],
      comment
    });
  } catch (err) {
    logger.error('Error loading comment detail:', err.message);
    res.status(500).render('error', { message: 'Failed to load comment detail.' });
  }
});

// POST /admin/community/comments/:id/delete — Soft Delete
router.post('/comments/:id/delete', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const reason = (req.body.reason || 'Violated community guidelines').trim();
    const result = await communityHelper.deleteComment(req.params.id, { reason }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Comment was already deleted.' : 'Comment deleted successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error deleting comment:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/comments/:id/restore — Restore Comment
router.post('/comments/:id/restore', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const reason = (req.body.reason || 'Restored by admin').trim();
    const result = await communityHelper.restoreComment(req.params.id, { reason }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Comment was already active.' : 'Comment restored successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error restoring comment:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 3. COMMUNITY STORIES
// ============================================================================

// GET /admin/community/stories — List Stories
router.get('/stories', verifyLogin, async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      status: req.query.status || 'all',
      type: req.query.type || 'ALL',
      authorId: req.query.authorId || '',
      courseTag: req.query.courseTag || '',
      sort: req.query.sort || 'newest',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      page: req.query.page || 1,
      limit: req.query.limit || 15
    };

    const hasActiveFilters = Boolean(
      (filters.search && filters.search.trim()) ||
      (filters.status && filters.status !== 'all') ||
      (filters.type && filters.type !== 'ALL') ||
      (filters.authorId && filters.authorId.trim()) ||
      (filters.courseTag && filters.courseTag.trim()) ||
      (filters.startDate && filters.startDate.trim()) ||
      (filters.endDate && filters.endDate.trim())
    );

    const result = await communityHelper.getStories(filters);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, ...result });
    }

    res.render('admin/community-stories', {
      currentPage: 'community-stories',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Stories' }
      ],
      records: result.records,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      stats: result.stats,
      filters: result.filters,
      hasActiveFilters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Error fetching stories:', err.message);
    res.status(500).render('error', { message: 'Failed to load stories.' });
  }
});

// POST /admin/community/stories/bulk — Bulk Story Administration
router.post('/stories/bulk', verifyLogin, requireCapability('moderate_content'), async (req, res) => {
  try {
    const { action, ids, reason } = req.body;
    const result = await communityHelper.executeBulkAction({
      entityType: 'story',
      action,
      ids,
      options: { reason },
      actor: req.session.admin,
      req
    });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Bulk story action error:', err.message);
    const status = err.message.includes('limit') || err.message.includes('selected') || err.message.includes('Unsupported') || err.message.includes('array') ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// GET /admin/community/stories/:id — Story Detail
router.get('/stories/:id', verifyLogin, validateCommunityIdParam('id'), async (req, res) => {
  try {
    const story = await communityHelper.getStoryById(req.params.id);
    if (!story) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(404).json({ success: false, message: 'Story not found.' });
      }
      return res.status(404).render('error', { message: 'Story not found.' });
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, story });
    }

    res.render('admin/community-story-detail', {
      currentPage: 'community-stories',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Stories', url: '/admin/community/stories' },
        { label: `Story #${story._id.slice(-6)}` }
      ],
      story
    });
  } catch (err) {
    logger.error('Error loading story detail:', err.message);
    res.status(500).render('error', { message: 'Failed to load story detail.' });
  }
});

// POST /admin/community/stories/:id/remove — Soft Delete Story
router.post('/stories/:id/remove', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const reason = (req.body.reason || 'Violated community guidelines').trim();
    const result = await communityHelper.removeStory(req.params.id, { reason }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Story was already removed.' : 'Story removed successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error removing story:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/stories/:id/restore — Restore Story
router.post('/stories/:id/restore', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const reason = (req.body.reason || 'Restored by admin').trim();
    const result = await communityHelper.restoreStory(req.params.id, { reason }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Story was already active.' : 'Story restored successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error restoring story:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 4. COMMUNITY REPORTS
// ============================================================================

// GET /admin/community/reports — List & Filter Reports
router.get('/reports', verifyLogin, async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      status: req.query.status || 'all',
      entityType: req.query.entityType || 'all',
      reason: req.query.reason || 'ALL',
      sort: req.query.sort || 'newest',
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      page: req.query.page || 1,
      limit: req.query.limit || 20
    };

    const hasActiveFilters = Boolean(
      (filters.search && filters.search.trim()) ||
      (filters.status && filters.status !== 'all') ||
      (filters.entityType && filters.entityType !== 'all') ||
      (filters.reason && filters.reason !== 'ALL') ||
      (filters.startDate && filters.startDate.trim()) ||
      (filters.endDate && filters.endDate.trim())
    );

    const result = await communityHelper.getReports(filters);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, ...result });
    }

    res.render('admin/community-reports', {
      currentPage: 'community-reports',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Reports' }
      ],
      records: result.records,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      stats: result.stats,
      filters: result.filters,
      hasActiveFilters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Error fetching community reports:', err.message);
    res.status(500).render('error', { message: 'Failed to load community reports.' });
  }
});

// GET /admin/community/reports/:id — Report Dossier & Detail
router.get('/reports/:id', verifyLogin, validateCommunityIdParam('id'), async (req, res) => {
  try {
    const report = await communityHelper.getReportById(req.params.id);
    if (!report) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(404).json({ success: false, message: 'Community report not found.' });
      }
      return res.status(404).render('error', { message: 'Community report not found.' });
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, report });
    }

    res.render('admin/community-report-detail', {
      currentPage: 'community-reports',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community/posts' },
        { label: 'Reports', url: '/admin/community/reports' },
        { label: `Report #${report._id.slice(-6)}` }
      ],
      report
    });
  } catch (err) {
    logger.error('Error loading report detail:', err.message);
    res.status(500).render('error', { message: 'Failed to load report detail.' });
  }
});

// POST /admin/community/reports/:id/dismiss — Dismiss Report
router.post('/reports/:id/dismiss', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const notes = (req.body.notes || req.body.reason || 'Dismissed by moderator').trim();
    const result = await communityHelper.dismissReport(req.params.id, { notes }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Report was already dismissed.' : 'Report dismissed successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error dismissing report:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/reports/:id/resolve — Mark Report Resolved
router.post('/reports/:id/resolve', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const notes = (req.body.notes || req.body.reason || 'Resolved by moderator').trim();
    const actionTaken = (req.body.actionTaken || 'resolved').trim();
    const result = await communityHelper.resolveReport(req.params.id, { notes, actionTaken }, req.session.admin, req);
    res.json({
      success: true,
      message: result.alreadyApplied ? 'Report was already resolved.' : 'Report resolved successfully.',
      ...result
    });
  } catch (err) {
    logger.error('Error resolving report:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/reports/:id/note — Add Moderator Note
router.post('/reports/:id/note', verifyLogin, requireCapability('moderate_content'), validateCommunityIdParam('id'), async (req, res) => {
  try {
    const notes = (req.body.notes || req.body.note || '').trim();
    const result = await communityHelper.addReportNote(req.params.id, { notes }, req.session.admin, req);
    res.json({
      success: true,
      message: 'Moderator note recorded.',
      ...result
    });
  } catch (err) {
    logger.error('Error adding note to report:', err.message);
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, message: err.message });
  }
});

// POST /admin/community/reports/bulk — Bulk Report Administration
router.post('/reports/bulk', verifyLogin, requireCapability('moderate_content'), async (req, res) => {
  try {
    const { action, ids, notes, actionTaken } = req.body;
    const result = await communityHelper.executeBulkAction({
      entityType: 'report',
      action,
      ids,
      options: { notes, actionTaken },
      actor: req.session.admin,
      req
    });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Bulk report action error:', err.message);
    const status = err.message.includes('limit') || err.message.includes('selected') || err.message.includes('Unsupported') || err.message.includes('array') ? 400 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// ============================================================================
// 5. GLOBAL COMMUNITY SEARCH
// ============================================================================

// GET /admin/community/search — Search View & JSON API
router.get('/search', verifyLogin, async (req, res) => {
  try {
    const queryText = (req.query.q || req.query.search || '').trim();
    const type = (req.query.type || 'all').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 50);

    const searchResult = await communityHelper.searchCommunity(queryText, { type, page, limit });

    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.query.format === 'json') {
      return res.json({ success: true, ...searchResult });
    }

    res.render('admin/community-search', {
      currentPage: 'community-search',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Community', url: '/admin/community' },
        { label: 'Global Search' }
      ],
      ...searchResult,
      filters: { q: queryText, type },
      hasQuery: Boolean(queryText)
    });
  } catch (err) {
    logger.error('Community Search Error:', err.message);
    if (req.xhr || req.query.format === 'json') {
      return res.status(500).json({ success: false, message: 'Search operation failed' });
    }
    res.status(500).render('error', { message: 'Community search failed' });
  }
});

router.get('/api/search', verifyLogin, async (req, res) => {
  try {
    const queryText = (req.query.q || req.query.search || '').trim();
    const type = (req.query.type || 'all').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 50);

    const result = await communityHelper.searchCommunity(queryText, { type, page, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, results: [] });
  }
});

module.exports = router;
