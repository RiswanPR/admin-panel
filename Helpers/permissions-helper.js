/**
 * Zeitnah Admin Panel — Permissions & Authorization Helper
 * Implements server-side capability resolution for administrator roles.
 */

const ROLE_CAPABILITIES = {
  superuser: [
    'manage_all',
    'assign_educator',
    'manage_network',
    'review_businesses',
    'approve_businesses',
    'suspend_businesses',
    'manage_jobs',
    'moderate_content',
    'manage_ai_config',
    'view_ai_metrics',
    'manage_taxonomy',
    'view_audit_logs',
    'system_reconciliation'
  ],
  admin: [
    'assign_educator',
    'manage_network',
    'review_businesses',
    'approve_businesses',
    'suspend_businesses',
    'manage_jobs',
    'moderate_content',
    'manage_ai_config',
    'view_ai_metrics',
    'manage_taxonomy',
    'view_audit_logs'
  ],
  network_admin: [
    'manage_network',
    'assign_educator',
    'manage_taxonomy',
    'view_audit_logs'
  ],
  business_admin: [
    'review_businesses',
    'approve_businesses',
    'suspend_businesses',
    'view_audit_logs'
  ],
  jobs_admin: [
    'manage_jobs',
    'moderate_content',
    'view_audit_logs'
  ],
  moderation_admin: [
    'moderate_content',
    'view_audit_logs'
  ],
  ai_admin: [
    'manage_ai_config',
    'view_ai_metrics',
    'manage_taxonomy',
    'view_audit_logs'
  ]
};

const hasCapability = (admin, capability) => {
  if (!admin) return false;
  const role = (admin.role || 'admin').toLowerCase();
  
  // Superuser has all permissions
  if (role === 'superuser') return true;

  const capabilities = ROLE_CAPABILITIES[role] || [];
  return capabilities.includes(capability) || capabilities.includes('manage_all');
};

const requireCapability = (capability) => {
  return (req, res, next) => {
    const admin = req.session?.admin;
    if (!admin) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
      }
      return res.redirect('/login');
    }

    if (!hasCapability(admin, capability)) {
      if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
        return res.status(403).json({ success: false, message: 'Permission denied: Insufficient privileges.' });
      }
      return res.status(403).render('error', { 
        message: `Access Denied: You do not have permission to perform this action (${capability}).` 
      });
    }

    next();
  };
};

module.exports = {
  ROLE_CAPABILITIES,
  hasCapability,
  requireCapability
};
