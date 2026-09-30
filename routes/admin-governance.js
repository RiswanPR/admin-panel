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
const db = require('../config/connection');
const collection = require('../config/collections');
const auditHelper = require('../Helpers/audit-helper');
const verificationHelper = require('../Helpers/verification-helper');
const errorHelper = require('../Helpers/error-helper');

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
  const admin = req.session?.admin || null;
  res.locals.admins = true;
  res.locals.sessionAdmin = admin;
  res.locals.isSuperuser = admin?.role === 'superuser';
  res.locals.viewMode = req.query?.view === 'table' ? 'table' : 'card';
  res.locals.adminCapabilities = permissionsHelper.getAdminCapabilities(admin);
  res.locals.canManageNetwork = permissionsHelper.hasCapability(admin, 'manage_network');
  res.locals.canAssignEducator = permissionsHelper.hasCapability(admin, 'assign_educator');
  res.locals.canManageAccountStatus = permissionsHelper.hasCapability(admin, 'manage_account_status');
  res.locals.canManageSessions = permissionsHelper.hasCapability(admin, 'manage_user_sessions');
  res.locals.canManageUsernames = permissionsHelper.hasCapability(admin, 'manage_usernames');
  res.locals.canManageVerification = permissionsHelper.hasCapability(admin, 'manage_verification');
  res.locals.canViewVerificationEvidence = permissionsHelper.hasCapability(admin, 'view_verification_evidence');
  res.locals.canReviewBusinesses = permissionsHelper.hasCapability(admin, 'review_businesses');
  res.locals.canManageJobs = permissionsHelper.hasCapability(admin, 'manage_jobs');
  res.locals.canModerateContent = permissionsHelper.hasCapability(admin, 'moderate_content');
  res.locals.canManageAI = permissionsHelper.hasCapability(admin, 'manage_ai_config');
  res.locals.canManageTaxonomy = permissionsHelper.hasCapability(admin, 'manage_taxonomy');
  res.locals.canViewAuditLogs = permissionsHelper.hasCapability(admin, 'view_audit_logs');
  res.locals.canViewErrors = permissionsHelper.hasCapability(admin, 'view_system_errors');
  res.locals.canManageSettings = permissionsHelper.hasCapability(admin, 'manage_settings');
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
      usernameState: req.query.usernameState || 'all',
      page: req.query.page || 1,
      limit: req.query.limit || 20
    };

    const hasActiveFilters = Boolean(
      (filters.search && filters.search.trim()) ||
      (filters.role && filters.role !== 'all') ||
      (filters.discipline && filters.discipline !== 'all') ||
      (filters.sector && filters.sector !== 'all') ||
      (filters.status && filters.status !== 'all') ||
      (filters.verified && filters.verified !== 'all') ||
      (filters.usernameState && filters.usernameState !== 'all')
    );

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
      hasActiveFilters,
      disciplines: careerAdminHelper.INFRASTRUCTURE_DISCIPLINES,
      sectors: careerAdminHelper.INFRASTRUCTURE_SECTORS,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('User Directory Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load user directory.' });
  }
};

// Network Users Directory is canonically mounted at /admin/network/users
router.get('/network/users', verifyLogin, handleUserDirectory);

// If /admin/network is requested, redirect to /admin/network/users.
// If root /network is requested, pass through to usersRouter profiles directory without shadowing.
router.get('/network', verifyLogin, (req, res, next) => {
  if (req.baseUrl === '/admin') {
    return res.redirect('/admin/network/users');
  }
  next();
});

// Enterprise User Governance Dossier
router.get('/network/users/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const dossier = await governanceHelper.getUserGovernanceDossier(req.params.id, req.session.admin, req);
    if (!dossier) {
      return res.status(404).render('error', { message: 'User not found.' });
    }

    res.render('admin/network-user', {
      currentPage: 'network-users',
      breadcrumb: [
        { label: 'Dashboard', url: '/' },
        { label: 'Network', url: '/admin/network/users' },
        { label: dossier.displayName || 'User Dossier' }
      ],
      ...dossier
    });
  } catch (err) {
    logger.error('User Inspection Error:', err.message);
    res.redirect('/admin/network/users');
  }
});

// Profile Role Management (Special Educator Protection & Capability Enforcement)
router.post('/network/users/:id/role', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const { role, reason } = req.body;
    if (!role) {
      return res.status(400).json({ success: false, message: 'Role parameter is required.' });
    }

    const admin = req.session.admin;
    const normalizedRole = String(role).toUpperCase();

    // Educator role assignment is strictly guarded
    if (normalizedRole === 'EDUCATOR') {
      if (!permissionsHelper.hasCapability(admin, 'assign_educator')) {
        if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
          return res.status(403).json({ success: false, message: 'Permission denied: assign_educator capability is required to assign the Educator role.' });
        }
        return res.status(403).render('error', { message: 'Access Denied: assign_educator capability required.' });
      }
    } else {
      // General role governance requires manage_network capability
      if (!permissionsHelper.hasCapability(admin, 'manage_network')) {
        if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
          return res.status(403).json({ success: false, message: 'Permission denied: Insufficient privileges.' });
        }
        return res.status(403).render('error', { message: 'Access Denied: manage_network capability required.' });
      }
    }

    const result = await governanceHelper.assignUserRole(
      req.params.id,
      role,
      req.session.admin,
      req,
      reason
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: `Role successfully updated to ${result.newRole}`, ...result });
    }

    res.redirect(`/admin/network/users/${req.params.id}`);
  } catch (err) {
    logger.error('Role Update Error:', err.message);
    const status = err.message && err.message.includes('Permission denied') ? 403 : 400;
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(status).json({ success: false, message: err.message });
    }
    res.status(status).render('error', { message: err.message });
  }
});

// Account Status: Suspend User
router.post('/network/users/:id/suspend', verifyLogin, requireCapability('manage_account_status'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason, restrictions } = req.body;
    const result = await governanceHelper.suspendUser(
      req.params.id,
      { reason, restrictions },
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json(result);
    }
    res.redirect(`/admin/network/users/${req.params.id}`);
  } catch (err) {
    logger.error('User Suspension Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Account Status: Restore User
router.post('/network/users/:id/restore', verifyLogin, requireCapability('manage_account_status'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await governanceHelper.restoreUser(
      req.params.id,
      { reason },
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json(result);
    }
    res.redirect(`/admin/network/users/${req.params.id}`);
  } catch (err) {
    logger.error('User Restoration Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Account Status: Restrict User
router.post('/network/users/:id/restrict', verifyLogin, requireCapability('manage_account_status'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { restrictions, reason } = req.body;
    const result = await governanceHelper.restrictUser(
      req.params.id,
      { restrictions, reason },
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json(result);
    }
    res.redirect(`/admin/network/users/${req.params.id}`);
  } catch (err) {
    logger.error('User Restriction Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Identity Governance: Administrative Username Change
router.post('/network/users/:id/username', verifyLogin, requireCapability('manage_usernames'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { newUsername, username, reason } = req.body;
    const targetUsername = newUsername || username;
    const result = await governanceHelper.changeUserUsername(
      req.params.id,
      { newUsername: targetUsername, reason },
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json(result);
    }
    res.redirect(`/admin/network/users/${req.params.id}`);
  } catch (err) {
    logger.error('Username Update Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Session Governance: List Active Sessions
router.get('/network/users/:id/sessions', verifyLogin, requireCapability('manage_user_sessions'), validateObjectIds(['id']), async (req, res) => {
  try {
    const sessions = await governanceHelper.getUserSessions(req.params.id, req.session.admin, req);
    res.json({ success: true, sessions });
  } catch (err) {
    logger.error('Get Sessions Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Session Governance: Revoke Single Session
router.post('/network/users/:id/sessions/:sid/revoke', verifyLogin, requireCapability('manage_user_sessions'), validateObjectIds(['id']), async (req, res) => {
  try {
    const result = await governanceHelper.revokeUserSession(
      req.params.id,
      req.params.sid,
      req.session.admin,
      req
    );
    res.json(result);
  } catch (err) {
    logger.error('Revoke Session Error:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

// Session Governance: Revoke All Sessions
router.post('/network/users/:id/sessions/revoke-all', verifyLogin, requireCapability('manage_user_sessions'), validateObjectIds(['id']), async (req, res) => {
  try {
    const result = await governanceHelper.revokeAllUserSessions(
      req.params.id,
      req.session.admin,
      req
    );
    res.json(result);
  } catch (err) {
    logger.error('Revoke All Sessions Error:', err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

// User Audit History
router.get('/network/users/:id/audit', verifyLogin, requireCapability('view_audit_logs'), validateObjectIds(['id']), async (req, res) => {
  try {
    const database = db.get();
    const idStr = String(req.params.id);
    const auditLogs = await database.collection(collection.AUDIT_LOG_COLLECTION).find({
      $or: [
        { entityId: idStr },
        { 'metadata.targetUserId': idStr }
      ]
    }).sort({ timestamp: -1 }).limit(50).toArray();

    res.json({ success: true, auditLogs });
  } catch (err) {
    logger.error('User Audit History Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
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
      sector: req.query.sector || 'all',
      verification: req.query.verification || 'all',
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
    const details = await governanceHelper.getBusinessById(req.params.id, req.session.admin);
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

// Restore Business
router.post('/businesses/:id/restore', verifyLogin, requireCapability('restore_businesses'), validateObjectIds(['id']), async (req, res) => {
  try {
    await governanceHelper.restoreBusiness(req.params.id, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Business restored successfully.' });
    }
    res.redirect(`/admin/businesses/${req.params.id}`);
  } catch (err) {
    logger.error('Restore Business Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Transfer Business Ownership
router.post('/businesses/:id/transfer-ownership', verifyLogin, requireCapability('transfer_business_ownership'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { newOwnerId, reason } = req.body;
    await governanceHelper.transferBusinessOwnership(req.params.id, newOwnerId, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Business ownership transferred successfully.' });
    }
    res.redirect(`/admin/businesses/${req.params.id}`);
  } catch (err) {
    logger.error('Transfer Ownership Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Update Member Role
router.post('/businesses/:id/members/:memberId/role', verifyLogin, requireCapability('manage_businesses'), validateObjectIds(['id', 'memberId']), async (req, res) => {
  try {
    const { role, reason } = req.body;
    await governanceHelper.updateBusinessMemberRole(req.params.id, req.params.memberId, role, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Member role updated successfully.' });
    }
    res.redirect(`/admin/businesses/${req.params.id}`);
  } catch (err) {
    logger.error('Update Member Role Error:', err.message);
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
      businessId: req.query.businessId || '',
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

// Approve Job (Publication Governance)
router.post('/jobs/:id/approve', verifyLogin, requireCapability('manage_jobs'), validateObjectIds(['id']), async (req, res) => {
  try {
    await governanceHelper.approveJob(req.params.id, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Job approved and published.' });
    }
    res.redirect(`/admin/jobs/${req.params.id}`);
  } catch (err) {
    logger.error('Approve Job Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Reject Job
router.post('/jobs/:id/reject', verifyLogin, requireCapability('manage_jobs'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    await governanceHelper.rejectJob(req.params.id, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Job rejected.' });
    }
    res.redirect(`/admin/jobs/${req.params.id}`);
  } catch (err) {
    logger.error('Reject Job Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// Suspend Job
router.post('/jobs/:id/suspend', verifyLogin, requireCapability('manage_jobs'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { reason } = req.body;
    await governanceHelper.suspendJob(req.params.id, reason, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Job suspended for policy compliance.' });
    }
    res.redirect(`/admin/jobs/${req.params.id}`);
  } catch (err) {
    logger.error('Suspend Job Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
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
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
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
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
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
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
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
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
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

// ─────────────────────────────────────────────────────────
// PHASE 6: VERIFICATION GOVERNANCE
// ─────────────────────────────────────────────────────────

// Verification Review Center
router.get('/verification', verifyLogin, async (req, res) => {
  try {
    const filters = {
      category: req.query.category || 'all',
      status: req.query.status || 'all',
      search: req.query.search || '',
      page: req.query.page || 1,
      limit: req.query.limit || 15
    };

    const data = await verificationHelper.getVerificationRequests(filters, req.session.admin);

    res.render('admin/verification', {
      currentPage: 'verification',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Verification Governance' }],
      ...data,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Verification Queue Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load verification review center.' });
  }
});

// Verification Detail (Evidence Protected)
router.get('/verification/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const details = await verificationHelper.getVerificationById(req.params.id, req.session.admin);
    if (!details) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(404).json({ success: false, message: 'Verification request not found.' });
      }
      return res.status(404).render('error', { message: 'Verification request not found.' });
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, details });
    }

    res.render('admin/verification-detail', {
      currentPage: 'verification',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Verification', url: '/admin/verification' }, { label: details.targetName }],
      details,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Verification Detail Error:', err.message);
    res.redirect('/admin/verification');
  }
});

// Verification Review Action (Approve / Reject / Expire)
router.post('/verification/:id/review', verifyLogin, requireCapability('manage_verification'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { status, notes, rejectionReason } = req.body;
    const result = await verificationHelper.reviewVerification(
      req.params.id,
      { status, notes, rejectionReason },
      req.session.admin,
      req
    );

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: `Verification status updated to ${result.status}.`, ...result });
    }
    res.redirect('/admin/verification');
  } catch (err) {
    logger.error('Verification Review Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// PHASE 7: AUDIT LOGS GOVERNANCE
// ─────────────────────────────────────────────────────────

const handleAuditLogs = async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      action: req.query.action || '',
      entityType: req.query.entityType || '',
      status: req.query.status || '',
      page: req.query.page || 1,
      limit: req.query.limit || 50
    };

    const logs = await auditHelper.getLogs(filters);

    res.render('admin/audit-logs', {
      currentPage: 'audit-logs',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Governance' }, { label: 'Audit Logs' }],
      logs,
      total: logs.total,
      page: logs.page,
      limit: logs.limit,
      totalPages: logs.totalPages,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Audit Logs Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load audit logs.' });
  }
};

router.get('/audit-logs', verifyLogin, requireCapability('view_audit_logs'), handleAuditLogs);

router.post('/audit-logs/clear', verifyLogin, requireCapability('manage_all'), async (req, res) => {
  try {
    await auditHelper.clearLogs();
    await auditHelper.logAction({
      req,
      action: 'AUDIT_LOGS_CLEARED',
      entityType: 'SYSTEM',
      status: 'success',
      message: 'All audit log records cleared by superuser'
    });

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: 'Audit logs cleared successfully.' });
    }
    res.redirect('/admin/audit-logs');
  } catch (err) {
    logger.error('Clear Audit Logs Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// PHASE 8: ERROR REPORTING & SYSTEM HEALTH
// ─────────────────────────────────────────────────────────

router.get('/error-reports', verifyLogin, requireCapability('view_system_errors'), async (req, res) => {
  try {
    const filters = {
      category: req.query.category || 'all',
      status: req.query.status || 'all',
      search: req.query.search || '',
      page: req.query.page || 1,
      limit: req.query.limit || 20
    };

    const data = await errorHelper.getErrorReports(filters);

    res.render('admin/error-reports', {
      currentPage: 'error-reports',
      breadcrumb: [{ label: 'Dashboard', url: '/' }, { label: 'Governance' }, { label: 'System Error Reports' }],
      ...data,
      filters,
      viewMode: req.query.view === 'table' ? 'table' : 'card'
    });
  } catch (err) {
    logger.error('Error Reports View Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load error reports.' });
  }
});

router.post('/error-reports/:id/status', verifyLogin, requireCapability('view_system_errors'), validateObjectIds(['id']), async (req, res) => {
  try {
    const { status } = req.body;
    await errorHelper.updateErrorStatus(req.params.id, status, req.session.admin, req);

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: `Error report marked as ${status}.` });
    }
    res.redirect('/admin/error-reports');
  } catch (err) {
    logger.error('Update Error Status Error:', err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(400).render('error', { message: err.message });
  }
});

module.exports = router;
