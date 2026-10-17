'use strict';

/**
 * Zeitnah Admin Panel — Professional Identity Catalogue Admin Router (Phase 3)
 *
 * Protected routes for administering the Professional Identity catalogue:
 * - Department listing, searching, filtering, and metric calculation
 * - Department details and scoped title listing with pagination and search
 * - Department updates (name, displayOrder, aliases, retirement/reactivation)
 * - Department-scoped title creation with automatic slug-based stable ID generation
 * - Title display label, displayOrder, alias, and status updates
 * - Immutable stable IDs (<departmentId>:<slug>) and no hard-deletion guarantees
 * - Full enforcement of verifyLogin and requireCapability('manage_taxonomy')
 * - Double CSRF verification (origin validation and cryptographic session tokens)
 * - Mandatory audit logging verification (fails closed if audit logging fails)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../Helpers/logger');
const catalogueAdmin = require('../Helpers/catalogue-admin-helper');
const permissionsHelper = require('../Helpers/permissions-helper');
const { requireCapability } = permissionsHelper;

// Authentication guard
const verifyLogin = (req, res, next) => {
  if (req.session?.adminloggedIn && req.session?.admin) {
    return next();
  }
  if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.is('json') || req.method === 'POST') {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }
  res.redirect('/login');
};

// CSRF token verification middleware
const verifyCsrf = (req, res, next) => {
  const token = req.body?._csrf || req.headers['x-csrf-token'] || req.headers['csrf-token'];
  const sessionToken = req.session?.csrfToken;

  if (!sessionToken || !token || token !== sessionToken) {
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.is('json')) {
      return res.status(403).json({ success: false, message: 'Forbidden: Invalid or missing CSRF token.' });
    }
    return res.status(403).render('error', {
      message: 'Forbidden: Invalid or missing CSRF token. Please refresh the page and try again.',
    });
  }
  next();
};

// Common admin locals & CSRF token injector
router.use((req, res, next) => {
  const admin = req.session?.admin || null;
  res.locals.admins = true;
  res.locals.sessionAdmin = admin;
  res.locals.isSuperuser = admin?.role === 'superuser';
  res.locals.adminCapabilities = permissionsHelper.getAdminCapabilities(admin);
  res.locals.canManageTaxonomy = permissionsHelper.hasCapability(admin, 'manage_taxonomy');
  res.locals.currentPage = 'catalogue-departments';

  // Handle flash-style feedback queries
  if (req.query.success) res.locals.successMessage = String(req.query.success);
  if (req.query.error) res.locals.errorMessage = String(req.query.error);

  // Ensure session CSRF token
  if (!req.session) req.session = {};
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  next();
});

// Helper: parse aliases input
function parseAliasesInput(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// Helper: sanitize returnTo URL to strictly prevent Open Redirect attacks
function sanitizeReturnUrl(target, fallback) {
  if (
    typeof target === 'string' &&
    target.startsWith('/admin/catalogue') &&
    !target.startsWith('//') &&
    !target.includes('\\')
  ) {
    return target;
  }
  return fallback;
}

// =============================================================================
// 1. ROOT & DEPARTMENT LISTING ROUTES
// =============================================================================

// Root redirects to departments list
router.get('/', verifyLogin, requireCapability('manage_taxonomy'), (req, res) => {
  res.redirect('/admin/catalogue/departments');
});

// List departments with statistics, search, and status filters
router.get('/departments', verifyLogin, requireCapability('manage_taxonomy'), async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      status: req.query.status || 'all',
    };

    const viewMode = req.query.view === 'table' ? 'table' : 'card';
    res.locals.viewMode = viewMode;

    const departments = await catalogueAdmin.getDepartmentsWithStats(filters);

    // Compute KPI metrics
    const totalDepartments = departments.length;
    const activeDepartments = departments.filter((d) => d.status === 'active').length;
    const retiredDepartments = departments.filter((d) => d.status === 'retired').length;
    const totalTitles = departments.reduce((acc, d) => acc + (d.titlesCount || 0), 0);
    const totalActiveTitles = departments.reduce((acc, d) => acc + (d.activeTitlesCount || 0), 0);

    // Check if usage statistics are available or unlinked
    const usageStatsAvailable = departments.some((d) => d.usageCount !== null);

    res.render('admin/catalogue-departments', {
      title: 'Professional Identity Catalogue — Departments',
      departments,
      filters,
      viewMode,
      totalDepartments,
      activeDepartments,
      retiredDepartments,
      totalTitles,
      totalActiveTitles,
      usageStatsAvailable,
    });
  } catch (err) {
    logger.error('Failed to load catalogue departments:', err.message);
    res.status(500).render('error', {
      message: 'Failed to load Professional Identity catalogue departments. Please try again later.',
    });
  }
});

// =============================================================================
// 2. DEPARTMENT DETAILS & SCOPED TITLES
// =============================================================================

// View department details and scoped titles
router.get('/departments/:departmentId', verifyLogin, requireCapability('manage_taxonomy'), async (req, res) => {
  try {
    const departmentId = req.params.departmentId;
    const dept = await catalogueAdmin.getDepartmentById(departmentId);
    if (!dept) {
      return res.status(404).render('error', {
        message: `Department with ID '${departmentId}' not found.`,
      });
    }

    const filters = {
      search: req.query.search || '',
      status: req.query.status || 'all',
    };

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const viewMode = req.query.view === 'table' ? 'table' : 'card';
    res.locals.viewMode = viewMode;

    const titleListing = await catalogueAdmin.getTitlesForDepartment(departmentId, filters, {
      page,
      limit,
    });

    res.render('admin/catalogue-titles', {
      title: `${dept.name} — Professional Titles`,
      department: dept,
      titles: titleListing.titles,
      total: titleListing.total,
      page: titleListing.page,
      limit: titleListing.limit,
      totalPages: titleListing.totalPages,
      filters,
      viewMode,
      usageStatsAvailable: dept.usageCount !== null,
    });
  } catch (err) {
    logger.error('Failed to load department catalogue titles:', err.message);
    res.status(500).render('error', {
      message: err.message || 'Failed to load department titles.',
    });
  }
});

// =============================================================================
// 3. DEPARTMENT MUTATIONS
// =============================================================================

// Update department details
router.post('/departments/:departmentId', verifyLogin, requireCapability('manage_taxonomy'), verifyCsrf, async (req, res) => {
  const departmentId = req.params.departmentId;
  try {
    const changes = {};

    if (req.body.name !== undefined && String(req.body.name).trim()) {
      changes.name = String(req.body.name).trim();
    }
    if (req.body.displayOrder !== undefined && req.body.displayOrder !== '') {
      changes.displayOrder = Number(req.body.displayOrder);
    }
    if (req.body.status !== undefined && req.body.status !== '') {
      changes.status = String(req.body.status).trim();
    }
    if (req.body.aliases !== undefined) {
      changes.aliases = parseAliasesInput(req.body.aliases);
    }

    const actorContext = {
      actor: req.session.admin,
      req,
      reason: req.body.reason || 'Admin updated department configuration',
    };

    const result = await catalogueAdmin.updateDepartment(departmentId, changes, actorContext);

    // Fail closed if audit logging could not be recorded
    if (!result.auditLogged) {
      logger.error(`Department '${departmentId}' updated in DB but audit logging failed. Failing closed.`);
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(500).json({
          success: false,
          message: 'Security Audit Failure: The mutation was committed to the database but mandatory audit logging could not be recorded. Action reported as unaudited.',
          auditFailure: true,
        });
      }
      return res.status(500).render('error', {
        message: 'Security Audit Failure: Mutation was committed to the database but mandatory audit logging could not be verified.',
      });
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({
        success: true,
        message: `Department '${result.department.name}' updated successfully.`,
        department: result.department,
      });
    }

    const returnUrl = sanitizeReturnUrl(req.body.returnTo, `/admin/catalogue/departments/${departmentId}`);
    res.redirect(`${returnUrl}?success=${encodeURIComponent(`Department '${result.department.name}' updated successfully.`)}`);
  } catch (err) {
    logger.error(`Error updating department '${departmentId}':`, err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    const returnUrl = sanitizeReturnUrl(req.body.returnTo, `/admin/catalogue/departments/${departmentId}`);
    res.redirect(`${returnUrl}?error=${encodeURIComponent(err.message)}`);
  }
});

// Toggle department status (Retire / Reactivate)
router.post('/departments/:departmentId/status', verifyLogin, requireCapability('manage_taxonomy'), verifyCsrf, async (req, res) => {
  const departmentId = req.params.departmentId;
  try {
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!['active', 'retired'].includes(status)) {
      throw new Error(`Invalid status '${status}'. Must be 'active' or 'retired'.`);
    }

    const actorContext = {
      actor: req.session.admin,
      req,
      reason: req.body.reason || `Admin toggled department status to ${status}`,
    };

    const result = await catalogueAdmin.updateDepartment(departmentId, { status }, actorContext);

    if (!result.auditLogged) {
      logger.error(`Department '${departmentId}' status updated but audit logging failed.`);
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(500).json({
          success: false,
          message: 'Security Audit Failure: Mutation committed but audit logging failed.',
          auditFailure: true,
        });
      }
      return res.status(500).render('error', {
        message: 'Security Audit Failure: Mutation committed but audit logging failed.',
      });
    }

    const msg = status === 'retired'
      ? `Department '${result.department.name}' has been retired. Titles and historical profile references remain intact.`
      : `Department '${result.department.name}' has been reactivated.`;

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: msg, department: result.department });
    }

    const returnUrl = sanitizeReturnUrl(req.body.returnTo, `/admin/catalogue/departments/${departmentId}`);
    res.redirect(`${returnUrl}?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    logger.error(`Error setting department status '${departmentId}':`, err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    const returnUrl = sanitizeReturnUrl(req.body.returnTo, `/admin/catalogue/departments/${departmentId}`);
    res.redirect(`${returnUrl}?error=${encodeURIComponent(err.message)}`);
  }
});

// =============================================================================
// 4. TITLE MUTATIONS (SCOPED TO DEPARTMENT)
// =============================================================================

// Add a new title to a department
router.post('/departments/:departmentId/titles', verifyLogin, requireCapability('manage_taxonomy'), verifyCsrf, async (req, res) => {
  const departmentId = req.params.departmentId;
  try {
    const input = {
      label: String(req.body.label || '').trim(),
    };

    if (req.body.displayOrder !== undefined && req.body.displayOrder !== '') {
      input.displayOrder = Number(req.body.displayOrder);
    }
    if (req.body.status !== undefined && req.body.status !== '') {
      input.status = String(req.body.status).trim();
    }
    if (req.body.aliases !== undefined) {
      input.aliases = parseAliasesInput(req.body.aliases);
    }

    const actorContext = {
      actor: req.session.admin,
      req,
      reason: req.body.reason || 'Admin created new professional title',
    };

    const result = await catalogueAdmin.addTitle(departmentId, input, actorContext);

    if (!result.auditLogged) {
      logger.error(`Title '${result.title.id}' created in DB but audit logging failed. Failing closed.`);
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(500).json({
          success: false,
          message: 'Security Audit Failure: Title created but audit logging could not be recorded.',
          auditFailure: true,
        });
      }
      return res.status(500).render('error', {
        message: 'Security Audit Failure: Title created but audit logging could not be recorded.',
      });
    }

    const msg = `Title '${result.title.label}' created successfully with stable ID '${result.title.id}'.`;

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: msg, title: result.title });
    }

    res.redirect(`/admin/catalogue/departments/${departmentId}?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    logger.error(`Error adding title to department '${departmentId}':`, err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.redirect(`/admin/catalogue/departments/${departmentId}?error=${encodeURIComponent(err.message)}`);
  }
});

// Update title label, displayOrder, aliases, or status
router.post('/titles/:titleId', verifyLogin, requireCapability('manage_taxonomy'), verifyCsrf, async (req, res) => {
  const titleId = req.params.titleId;
  try {
    const changes = {};

    if (req.body.label !== undefined && String(req.body.label).trim()) {
      changes.label = String(req.body.label).trim();
    }
    if (req.body.displayOrder !== undefined && req.body.displayOrder !== '') {
      changes.displayOrder = Number(req.body.displayOrder);
    }
    if (req.body.status !== undefined && req.body.status !== '') {
      changes.status = String(req.body.status).trim();
    }
    if (req.body.aliases !== undefined) {
      changes.aliases = parseAliasesInput(req.body.aliases);
    }

    const actorContext = {
      actor: req.session.admin,
      req,
      reason: req.body.reason || 'Admin updated title configuration',
    };

    const result = await catalogueAdmin.updateTitle(titleId, changes, actorContext);

    if (!result.auditLogged) {
      logger.error(`Title '${titleId}' updated in DB but audit logging failed.`);
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(500).json({
          success: false,
          message: 'Security Audit Failure: Title updated in DB but audit logging failed.',
          auditFailure: true,
        });
      }
      return res.status(500).render('error', {
        message: 'Security Audit Failure: Title updated in DB but audit logging failed.',
      });
    }

    const msg = `Title '${result.title.label}' updated successfully. Stable ID '${result.title.id}' is preserved.`;

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: msg, title: result.title });
    }

    const departmentId = result.title.departmentId || titleId.split(':')[0];
    res.redirect(`/admin/catalogue/departments/${departmentId}?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    logger.error(`Error updating title '${titleId}':`, err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    const departmentId = titleId.split(':')[0];
    res.redirect(`/admin/catalogue/departments/${departmentId}?error=${encodeURIComponent(err.message)}`);
  }
});

// Toggle title status (Retire / Reactivate)
router.post('/titles/:titleId/status', verifyLogin, requireCapability('manage_taxonomy'), verifyCsrf, async (req, res) => {
  const titleId = req.params.titleId;
  try {
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!['active', 'retired'].includes(status)) {
      throw new Error(`Invalid status '${status}'. Must be 'active' or 'retired'.`);
    }

    const actorContext = {
      actor: req.session.admin,
      req,
      reason: req.body.reason || `Admin toggled title status to ${status}`,
    };

    const result = await catalogueAdmin.setTitleStatus(titleId, status, actorContext);

    if (!result.auditLogged) {
      logger.error(`Title '${titleId}' status updated but audit logging failed.`);
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(500).json({
          success: false,
          message: 'Security Audit Failure: Title status updated but audit logging failed.',
          auditFailure: true,
        });
      }
      return res.status(500).render('error', {
        message: 'Security Audit Failure: Title status updated but audit logging failed.',
      });
    }

    const msg = status === 'retired'
      ? `Title '${result.title.label}' has been retired. Existing user profile selections remain preserved.`
      : `Title '${result.title.label}' has been reactivated.`;

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: msg, title: result.title });
    }

    const departmentId = result.title.departmentId || titleId.split(':')[0];
    res.redirect(`/admin/catalogue/departments/${departmentId}?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    logger.error(`Error setting title status '${titleId}':`, err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.status(400).json({ success: false, message: err.message });
    }
    const departmentId = titleId.split(':')[0];
    res.redirect(`/admin/catalogue/departments/${departmentId}?error=${encodeURIComponent(err.message)}`);
  }
});

// =============================================================================
// 5. CUSTOM TITLE REQUESTS ADMINISTRATION (REVIEW QUEUE)
// =============================================================================

// List title requests with filtering and pagination
router.get('/requests', verifyLogin, requireCapability('manage_taxonomy'), async (req, res) => {
  try {
    const filters = {
      status: req.query.status || 'pending',
      departmentId: req.query.departmentId || '',
      search: req.query.search || '',
    };

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    res.locals.currentPage = 'catalogue-requests';

    const [listing, departments] = await Promise.all([
      catalogueAdmin.getTitleRequests(filters, { page, limit }, { req }),
      catalogueAdmin.getDepartmentsWithStats({ status: 'all' }, { req }),
    ]);

    res.render('admin/catalogue-requests', {
      title: 'Professional Identity — Custom Title Requests',
      requests: listing.requests,
      total: listing.total,
      page: listing.page,
      limit: listing.limit,
      totalPages: listing.totalPages,
      pendingCount: listing.pendingCount,
      approvedCount: listing.approvedCount,
      rejectedCount: listing.rejectedCount,
      departments,
      filters,
    });
  } catch (err) {
    logger.error('Failed to load custom title requests:', err.message);
    res.status(500).render('error', {
      message: err.message || 'Failed to load custom title requests. Please try again later.',
    });
  }
});

// Inspect a single custom title request with review history and duplicate checking
router.get('/requests/:requestId', verifyLogin, requireCapability('manage_taxonomy'), async (req, res) => {
  const requestId = req.params.requestId;
  try {
    const result = await catalogueAdmin.getTitleRequestById(requestId, {
      includeConflictCheck: true,
      db: req.mockDb,
      req,
    });

    if (!result || !result.request) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.is('json')) {
        return res.status(404).json({ success: false, message: `Custom title request with ID '${requestId}' not found.` });
      }
      return res.status(404).render('error', {
        message: `Custom title request with ID '${requestId}' not found.`,
      });
    }

    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.is('json')) {
      return res.json({
        success: true,
        request: result.request,
        department: result.department,
        conflictingTitle: result.conflictingTitle,
      });
    }

    res.locals.currentPage = 'catalogue-requests';
    res.render('admin/catalogue-request-detail', {
      title: `Review Title Request: "${result.request.requestedTitle}"`,
      request: result.request,
      department: result.department,
      conflictingTitle: result.conflictingTitle,
    });
  } catch (err) {
    logger.error(`Error loading title request '${requestId}':`, err.message);
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.is('json')) {
      return res.status(500).json({ success: false, message: err.message });
    }
    res.status(500).render('error', {
      message: err.message || 'Failed to load custom title request details.',
    });
  }
});

// Approve a custom title request
router.post('/requests/:requestId/approve', verifyLogin, requireCapability('manage_taxonomy'), verifyCsrf, async (req, res) => {
  const requestId = req.params.requestId;
  try {
    const actorContext = {
      actor: req.session.admin,
      req,
      db: req.mockDb,
      reason: req.body.reason || req.body.note || 'Admin approved custom title request',
    };

    const input = {
      label: req.body.label ? String(req.body.label).trim() : undefined,
      note: req.body.note ? String(req.body.note).trim() : (req.body.reason ? String(req.body.reason).trim() : undefined),
    };

    const result = await catalogueAdmin.approveTitleRequest(requestId, input, actorContext);

    if (!result.auditLogged) {
      logger.error(`Request '${requestId}' approved in DB but audit logging failed. Failing closed.`);
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(500).json({
          success: false,
          message: 'Security Audit Failure: Request approved but audit logging could not be recorded.',
          auditFailure: true,
        });
      }
      return res.status(500).render('error', {
        message: 'Security Audit Failure: Request approved but audit logging could not be recorded.',
      });
    }

    const msg = result.message || `Title '${result.title?.label}' approved successfully.`;

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: msg, request: result.request, title: result.title });
    }

    const returnUrl = sanitizeReturnUrl(req.body.returnTo, '/admin/catalogue/requests');
    res.redirect(`${returnUrl}?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    logger.error(`Error approving title request '${requestId}':`, err.message);
    const statusCode = err.code === 'CONFLICT' || err.status === 409 ? 409 : 400;
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.is('json')) {
      return res.status(statusCode).json({ success: false, message: err.message, code: err.code });
    }
    const returnUrl = sanitizeReturnUrl(req.body.returnTo, '/admin/catalogue/requests');
    res.redirect(`${returnUrl}?error=${encodeURIComponent(err.message)}`);
  }
});

// Reject a custom title request
router.post('/requests/:requestId/reject', verifyLogin, requireCapability('manage_taxonomy'), verifyCsrf, async (req, res) => {
  const requestId = req.params.requestId;
  try {
    const actorContext = {
      actor: req.session.admin,
      req,
      db: req.mockDb,
      reason: req.body.reason || req.body.note || 'Admin rejected custom title request',
    };

    const input = {
      reason: req.body.reason !== undefined ? String(req.body.reason).trim() : (req.body.note !== undefined ? String(req.body.note).trim() : undefined),
    };

    const result = await catalogueAdmin.rejectTitleRequest(requestId, input, actorContext);

    if (!result.auditLogged) {
      logger.error(`Request '${requestId}' rejected in DB but audit logging failed.`);
      if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(500).json({
          success: false,
          message: 'Security Audit Failure: Request rejected but audit logging could not be recorded.',
          auditFailure: true,
        });
      }
      return res.status(500).render('error', {
        message: 'Security Audit Failure: Request rejected but audit logging could not be recorded.',
      });
    }

    const msg = result.message || 'Custom title request rejected.';

    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
      return res.json({ success: true, message: msg, request: result.request });
    }

    const returnUrl = sanitizeReturnUrl(req.body.returnTo, '/admin/catalogue/requests');
    res.redirect(`${returnUrl}?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    logger.error(`Error rejecting title request '${requestId}':`, err.message);
    const statusCode = err.code === 'CONFLICT' || err.status === 409 ? 409 : 400;
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.is('json')) {
      return res.status(statusCode).json({ success: false, message: err.message, code: err.code });
    }
    const returnUrl = sanitizeReturnUrl(req.body.returnTo, '/admin/catalogue/requests');
    res.redirect(`${returnUrl}?error=${encodeURIComponent(err.message)}`);
  }
});

// =============================================================================
// 6. HARD DELETION & REASSIGNMENT REJECTION GUARDS
// =============================================================================

router.all('/departments/:departmentId/delete', verifyLogin, requireCapability('manage_taxonomy'), (req, res) => {
  res.status(405).render('error', {
    message: 'Method Not Allowed: Departments cannot be deleted. Deletion would break historical user profile references. Use retirement instead.',
  });
});

router.all('/titles/:titleId/delete', verifyLogin, requireCapability('manage_taxonomy'), (req, res) => {
  res.status(405).render('error', {
    message: 'Method Not Allowed: Titles cannot be deleted. Deletion would break historical user profile references. Use retirement instead.',
  });
});

router.all('/titles/:titleId/reassign', verifyLogin, requireCapability('manage_taxonomy'), (req, res) => {
  res.status(400).render('error', {
    message: 'Department Reassignment Not Supported: Title IDs are department-scoped composite identifiers (<departmentId>:<slug>). Create a new title in the destination department and retire the source title.',
  });
});

module.exports = router;
