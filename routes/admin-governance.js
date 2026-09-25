const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const logger = require('../Helpers/logger');
const governanceHelper = require('../Helpers/governance-helper');
const aiAdminHelper = require('../Helpers/ai-admin-helper');
const careerAdminHelper = require('../Helpers/career-admin-helper');
const moderationHelper = require('../Helpers/moderation-helper');
const analyticsHelper = require('../Helpers/analytics-helper');
const networkHelper = require('../Helpers/network-helper');
const permissionsHelper = require('../Helpers/permissions-helper');
const { requireCapability } = permissionsHelper;

// Auth middleware
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

const validateObjectIds = (paramNames) => {
  return (req, res, next) => {
    for (const name of paramNames) {
      const value = req.params[name] || req.body[name] || req.query[name];
      if (value && !ObjectId.isValid(value)) {
        if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
          return res.status(400).json({ success: false, message: `Invalid identifier: ${name}` });
        }
        return res.status(400).render('error', { message: `Invalid identifier: ${name}` });
      }
    }
    next();
  };
};

// Inject locals for admin navigation & view state
router.use((req, res, next) => {
  res.locals.admins = true;
  res.locals.sessionAdmin = req.session?.admin || null;
  res.locals.isSuperuser = req.session?.admin?.role === 'superuser';
  res.locals.viewMode = req.query?.view === 'table' ? 'table' : 'card';
  next();
});

// ─────────────────────────────────────────────────────────
// PHASE 1: NETWORK & PROFILE ADMINISTRATION
// ─────────────────────────────────────────────────────────

// User Directory
const handleUserDirectory = async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      role: req.query.role || 'all',
      discipline: req.query.discipline || 'all',
      sector: req.query.sector || 'all',
      status: req.query.status || 'all',
      verified: req.query.verified || 'all',
      page: req.query.page || 1,
      limit: req.query.limit || 20
    };

    const [stats, result] = await Promise.all([
      networkHelper.getNetworkStats(),
      networkHelper.getNetworkUsers(filters)
    ]);

    res.render('admin/network-users', {
      currentPage: 'network-users',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Network', url: '/admin/network' }, { label: 'Users' }],
      stats,
      records: result.records,
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
      filters,
      disciplines: careerAdminHelper.INFRASTRUCTURE_DISCIPLINES,
      sectors: careerAdminHelper.INFRASTRUCTURE_SECTORS,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('User Directory Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load user directory.' });
  }
};

router.get('/network', verifyLogin, handleUserDirectory);
router.get('/network/users', verifyLogin, handleUserDirectory);

// Profile Inspection
router.get('/network/users/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const details = await networkHelper.getNetworkUserDetails(req.params.id, req.query.role || '');
    if (!details) {
      return res.status(404).render('error', { message: 'User not found.' });
    }

    res.render('admin/network-user', {
      currentPage: 'network-users',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Network', url: '/admin/network' },
        { label: details.user?.Name || details.user?.name || 'User Profile' }
      ],
      ...details
    });
  } catch (err) {
    logger.error('User Inspection Error:', err.message);
    res.redirect('/admin/network/users');
  }
});

// Profile Role Management (Special Educator Protection)
router.post('/network/users/:id/role', verifyLogin, requireCapability('assign_educator'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { role } = req.body;
    if (!role) {
      return res.status(400).json({ success: false, message: 'Role parameter is required.' });
    }

    const result = await governanceHelper.assignUserRole(
      req.params.id,
      role,
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: `Role successfully updated to ${result.newRole}`, ...result });
    }

    res.redirect(`/admin/network/users/${req.params.id}`);
  } catch (err) {
    logger.error('Role Update Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Profile Verification
router.post('/network/users/:id/verification', verifyLogin, requireCapability('manage_network'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { status, notes } = req.body;
    const result = await governanceHelper.updateUserVerification(
      req.params.id,
      { status, notes },
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: `Verification status updated to ${result.verificationStatus}` });
    }

    res.redirect(`/admin/network/users/${req.params.id}`);
  } catch (err) {
    logger.error('Verification Update Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Infrastructure Taxonomy Administration
router.get('/network/taxonomy', verifyLogin, async (req, res) => {
  try {
    const skills = await careerAdminHelper.getSkillGraph();
    const roles = careerAdminHelper.getRoles();

    res.render('admin/network-taxonomy', {
      currentPage: 'network-taxonomy',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Network', url: '/admin/network' }, { label: 'Taxonomy' }],
      disciplines: careerAdminHelper.INFRASTRUCTURE_DISCIPLINES,
      sectors: careerAdminHelper.INFRASTRUCTURE_SECTORS,
      roles,
      skills,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Taxonomy View Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load taxonomy.' });
  }
});

// ─────────────────────────────────────────────────────────
// PHASE 2: BUSINESS & JOB GOVERNANCE
// ─────────────────────────────────────────────────────────

// Business Review Center
router.get('/businesses', verifyLogin, async (req, res) => {
  try {
    const filters = {
      tab: req.query.tab || 'all',
      search: req.query.search || '',
      industry: req.query.industry || 'all',
      page: req.query.page || 1,
      limit: req.query.limit || 15
    };

    const data = await governanceHelper.getBusinesses(filters);

    res.render('admin/businesses', {
      currentPage: 'businesses',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Businesses' }],
      ...data,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Businesses List Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load businesses.' });
  }
});

// Business Review Detail
router.get('/businesses/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const details = await governanceHelper.getBusinessById(req.params.id);
    if (!details) {
      return res.status(404).render('error', { message: 'Business not found.' });
    }

    res.render('admin/business-detail', {
      currentPage: 'businesses',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Businesses', url: '/admin/businesses' },
        { label: details.business.name }
      ],
      ...details
    });
  } catch (err) {
    logger.error('Business Detail Error:', err.message);
    res.redirect('/admin/businesses');
  }
});

// Approve Business
router.post('/businesses/:id/approve', verifyLogin, requireCapability('approve_businesses'), validateObjectIds(['id']), async (req, res) => {
  try {
    await governanceHelper.approveBusiness(req.params.id, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Business approved successfully.' });
    }
    res.redirect(`/admin/businesses/${req.params.id}`);
  } catch (err) {
    logger.error('Approve Business Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Reject Business
router.post('/businesses/:id/reject', verifyLogin, requireCapability('review_businesses'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    await governanceHelper.rejectBusiness(req.params.id, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Business rejected.' });
    }
    res.redirect(`/admin/businesses/${req.params.id}`);
  } catch (err) {
    logger.error('Reject Business Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Suspend Business
router.post('/businesses/:id/suspend', verifyLogin, requireCapability('suspend_businesses'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    await governanceHelper.suspendBusiness(req.params.id, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Business suspended.' });
    }
    res.redirect(`/admin/businesses/${req.params.id}`);
  } catch (err) {
    logger.error('Suspend Business Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Job Governance Center
router.get('/jobs', verifyLogin, async (req, res) => {
  try {
    const filters = {
      tab: req.query.tab || 'all',
      search: req.query.search || '',
      discipline: req.query.discipline || 'all',
      sector: req.query.sector || 'all',
      page: req.query.page || 1,
      limit: req.query.limit || 15
    };

    const data = await governanceHelper.getJobs(filters);

    res.render('admin/jobs', {
      currentPage: 'jobs',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Jobs' }],
      ...data,
      filters,
      disciplines: careerAdminHelper.INFRASTRUCTURE_DISCIPLINES,
      sectors: careerAdminHelper.INFRASTRUCTURE_SECTORS,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Jobs List Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load jobs.' });
  }
});

// Job Inspection
router.get('/jobs/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const details = await governanceHelper.getJobById(req.params.id);
    if (!details) {
      return res.status(404).render('error', { message: 'Job not found.' });
    }

    res.render('admin/job-detail', {
      currentPage: 'jobs',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Jobs', url: '/admin/jobs' },
        { label: details.job.title }
      ],
      ...details
    });
  } catch (err) {
    logger.error('Job Detail Error:', err.message);
    res.redirect('/admin/jobs');
  }
});

// Job Actions: Unpublish, Close, Restore, Flag
router.post('/jobs/:id/unpublish', verifyLogin, requireCapability('manage_jobs'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    await governanceHelper.unpublishJob(req.params.id, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Job unpublished.' });
    }
    res.redirect(`/admin/jobs/${req.params.id}`);
  } catch (err) {
    logger.error('Unpublish Job Error:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/jobs/:id/close', verifyLogin, requireCapability('manage_jobs'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    await governanceHelper.closeJob(req.params.id, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Job closed.' });
    }
    res.redirect(`/admin/jobs/${req.params.id}`);
  } catch (err) {
    logger.error('Close Job Error:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/jobs/:id/restore', verifyLogin, requireCapability('manage_jobs'), validateObjectIds(['id']), async (req, res) => {
  try {
    await governanceHelper.restoreJob(req.params.id, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Job restored to active publication.' });
    }
    res.redirect(`/admin/jobs/${req.params.id}`);
  } catch (err) {
    logger.error('Restore Job Error:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/jobs/:id/flag', verifyLogin, requireCapability('moderate_content'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    await governanceHelper.flagJob(req.params.id, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Job flagged for administrative review.' });
    }
    res.redirect(`/admin/jobs/${req.params.id}`);
  } catch (err) {
    logger.error('Flag Job Error:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// PHASE 3: AI MATCHING ADMINISTRATION
// ─────────────────────────────────────────────────────────

// AI Matching Dashboard
router.get('/ai', verifyLogin, async (req, res) => {
  res.redirect('/admin/ai/matching');
});

router.get('/ai/matching', verifyLogin, async (req, res) => {
  try {
    const [metrics, modelVersions, failureStats, config] = await Promise.all([
      aiAdminHelper.getAIMatchingMetrics(),
      aiAdminHelper.getAIModelVersions(),
      aiAdminHelper.getAIFailureMonitoring(),
      aiAdminHelper.getMatchingConfig()
    ]);

    res.render('admin/ai-matching', {
      currentPage: 'ai-matching',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'AI Matching' }],
      metrics,
      modelVersions,
      failureStats,
      config
    });
  } catch (err) {
    logger.error('AI Matching Dashboard Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load AI matching dashboard.' });
  }
});

// Job -> Talent Monitoring
router.get('/ai/job-matches', verifyLogin, async (req, res) => {
  try {
    const jobId = req.query.jobId || '';
    const filters = {
      category: req.query.category || 'all',
      page: req.query.page || 1,
      limit: req.query.limit || 20
    };

    const [matchesData, jobsList] = await Promise.all([
      aiAdminHelper.getJobTalentMatches(jobId, filters),
      db.get().collection(collection.OPPORTUNITIES_COLLECTION)
        .find({ status: { $in: ['PUBLISHED', 'published'] } }, { projection: { _id: 1, title: 1 } })
        .limit(50)
        .toArray()
    ]);

    res.render('admin/ai-job-matches', {
      currentPage: 'ai-job-matches',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'AI Matching', url: '/admin/ai/matching' }, { label: 'Job → Talent Monitoring' }],
      jobId,
      jobsList,
      ...matchesData,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Job Talent Matches Error:', err.message);
    res.redirect('/admin/ai/matching');
  }
});

// Talent -> Job Monitoring
router.get('/ai/talent-recommendations', verifyLogin, async (req, res) => {
  try {
    const userId = req.query.userId || '';
    const filters = {
      page: req.query.page || 1,
      limit: req.query.limit || 20
    };

    const recsData = await aiAdminHelper.getTalentJobRecommendations(userId, filters);

    res.render('admin/ai-talent-recommendations', {
      currentPage: 'ai-talent-recommendations',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'AI Matching', url: '/admin/ai/matching' }, { label: 'Talent → Job Recommendations' }],
      userId,
      ...recsData,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Talent Recommendations Error:', err.message);
    res.redirect('/admin/ai/matching');
  }
});

// Matching Configuration
router.get('/ai/config', verifyLogin, async (req, res) => {
  try {
    const config = await aiAdminHelper.getMatchingConfig();
    const modelVersions = aiAdminHelper.getAIModelVersions();

    res.render('admin/ai-config', {
      currentPage: 'ai-config',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'AI Matching', url: '/admin/ai/matching' }, { label: 'Configuration' }],
      config,
      modelVersions
    });
  } catch (err) {
    logger.error('Matching Config Error:', err.message);
    res.redirect('/admin/ai/matching');
  }
});

router.post('/ai/config', verifyLogin, requireCapability('manage_ai_config'), async (req, res) => {
  try {
    const result = await aiAdminHelper.updateMatchingConfig(req.body, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: `Configuration updated to ${result.version}`, ...result });
    }

    res.redirect('/admin/ai/config');
  } catch (err) {
    logger.error('Update Matching Config Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// PHASE 4: CAREER INTELLIGENCE ADMINISTRATION
// ─────────────────────────────────────────────────────────

router.get('/career-intelligence', verifyLogin, (req, res) => {
  res.redirect('/admin/career-intelligence/roles');
});

// Role Taxonomy
router.get('/career-intelligence/roles', verifyLogin, async (req, res) => {
  try {
    const filters = {
      discipline: req.query.discipline || 'all',
      tier: req.query.tier || 'all',
      search: req.query.search || ''
    };

    const roles = careerAdminHelper.getRoles(filters);

    res.render('admin/career-roles', {
      currentPage: 'career-roles',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Career Intelligence' }, { label: 'Role Taxonomy' }],
      roles,
      disciplines: careerAdminHelper.INFRASTRUCTURE_DISCIPLINES,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Career Roles Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load career roles.' });
  }
});

// Skill Graph & Aliases
router.get('/career-intelligence/skills', verifyLogin, async (req, res) => {
  try {
    const filters = {
      category: req.query.category || 'all',
      search: req.query.search || ''
    };

    const skills = await careerAdminHelper.getSkillGraph(filters);

    res.render('admin/career-skills', {
      currentPage: 'career-skills',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Career Intelligence' }, { label: 'Skill Graph' }],
      skills,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Career Skills Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load skill graph.' });
  }
});

// Update Canonical Skill Alias
router.post('/career-intelligence/skills/alias', verifyLogin, requireCapability('manage_taxonomy'), async (req, res) => {
  try {
    const { skillName, aliases } = req.body;
    if (!skillName) throw new Error('Skill name is required.');

    const result = await careerAdminHelper.updateSkillAlias(skillName, aliases, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Skill aliases updated.', ...result });
    }
    res.redirect('/admin/career-intelligence/skills');
  } catch (err) {
    logger.error('Skill Alias Update Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Career Pathways
router.get('/career-intelligence/pathways', verifyLogin, async (req, res) => {
  try {
    const pathways = careerAdminHelper.getCareerPathways();

    res.render('admin/career-pathways', {
      currentPage: 'career-pathways',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Career Intelligence' }, { label: 'Pathways' }],
      pathways,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Career Pathways Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load pathways.' });
  }
});

// Market Intelligence
router.get('/career-intelligence/market', verifyLogin, async (req, res) => {
  try {
    const market = await careerAdminHelper.getMarketIntelligence();

    res.render('admin/career-market', {
      currentPage: 'career-market',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Career Intelligence' }, { label: 'Market Data' }],
      market,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Market Intelligence Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load market data.' });
  }
});

// Career Assistant Monitoring
router.get('/career-intelligence/assistant', verifyLogin, async (req, res) => {
  try {
    const telemetry = careerAdminHelper.getCareerAssistantTelemetry();

    res.render('admin/career-assistant', {
      currentPage: 'career-assistant',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Career Intelligence' }, { label: 'Assistant Telemetry' }],
      telemetry
    });
  } catch (err) {
    logger.error('Career Assistant Telemetry Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load assistant telemetry.' });
  }
});

// ─────────────────────────────────────────────────────────
// PHASE 5: MODERATION & ANALYTICS
// ─────────────────────────────────────────────────────────

// Moderation Center
router.get('/moderation', verifyLogin, async (req, res) => {
  try {
    const filters = {
      tab: req.query.tab || 'open',
      targetType: req.query.targetType || 'all',
      search: req.query.search || '',
      page: req.query.page || 1,
      limit: req.query.limit || 15
    };

    const data = await moderationHelper.getReports(filters);

    res.render('admin/moderation', {
      currentPage: 'moderation',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Moderation Center' }],
      ...data,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Moderation Center Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load moderation center.' });
  }
});

router.post('/moderation/reports/:id/resolve', verifyLogin, requireCapability('moderate_content'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { status, moderatorNotes, actionTaken } = req.body;
    await moderationHelper.updateReportStatus(
      req.params.id,
      { status, moderatorNotes, actionTaken },
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: `Report marked as ${status}.` });
    }
    res.redirect('/admin/moderation');
  } catch (err) {
    logger.error('Resolve Report Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Unified Analytics Dashboard
router.get('/analytics', verifyLogin, async (req, res) => {
  try {
    const analytics = await analyticsHelper.getUnifiedAnalytics();

    res.render('admin/analytics', {
      currentPage: 'analytics',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Platform Analytics' }],
      analytics,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Analytics Dashboard Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load platform analytics.' });
  }
});

module.exports = router;
