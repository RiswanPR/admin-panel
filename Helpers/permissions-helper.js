/**
 * Zeitnah Admin Panel — Permissions & Authorization Helper
 * Implements server-side capability resolution for administrator roles.
 */

const ROLE_CAPABILITIES = {
  superuser: [
    'manage_all',
    'assign_educator',
    'manage_network',
    'manage_account_status',
    'manage_user_sessions',
    'manage_usernames',
    'manage_verification',
    'view_verification_evidence',
    'manage_businesses',
    'review_businesses',
    'approve_businesses',
    'suspend_businesses',
    'restore_businesses',
    'transfer_business_ownership',
    'view_business_members',
    'manage_jobs',
    'moderate_jobs',
    'view_job_reports',
    'view_employer_data',
    'view_matching_data',
    'moderate_content',
    'manage_ai_config',
    'view_ai_metrics',
    'manage_taxonomy',
    'manage_settings',
    'view_audit_logs',
    'view_system_errors',
    'system_reconciliation'
  ],
  admin: [
    'manage_network',
    'manage_account_status',
    'manage_verification',
    'manage_businesses',
    'review_businesses',
    'approve_businesses',
    'suspend_businesses',
    'restore_businesses',
    'view_business_members',
    'manage_jobs',
    'moderate_jobs',
    'view_job_reports',
    'view_employer_data',
    'view_matching_data',
    'moderate_content',
    'manage_ai_config',
    'view_ai_metrics',
    'manage_taxonomy',
    'manage_settings',
    'view_audit_logs',
    'view_system_errors'
  ],
  network_admin: [
    'manage_network',
    'assign_educator',
    'manage_account_status',
    'manage_user_sessions',
    'manage_usernames',
    'manage_verification',
    'manage_taxonomy',
    'view_audit_logs'
  ],
  verification_admin: [
    'manage_verification',
    'view_verification_evidence',
    'manage_network',
    'view_audit_logs'
  ],
  business_admin: [
    'manage_businesses',
    'review_businesses',
    'approve_businesses',
    'suspend_businesses',
    'restore_businesses',
    'view_business_members',
    'view_employer_data',
    'view_audit_logs'
  ],
  jobs_admin: [
    'manage_jobs',
    'moderate_jobs',
    'view_job_reports',
    'view_employer_data',
    'view_matching_data',
    'moderate_content',
    'view_audit_logs'
  ],
  moderation_admin: [
    'moderate_content',
    'moderate_jobs',
    'view_job_reports',
    'view_audit_logs'
  ],
  ai_admin: [
    'manage_ai_config',
    'view_ai_metrics',
    'manage_taxonomy',
    'view_audit_logs'
  ],
  system_admin: [
    'view_system_errors',
    'manage_settings',
    'view_audit_logs',
    'view_ai_metrics'
  ]
};

const hasCapability = (admin, capability) => {
  if (!admin) return false;
  const role = (admin.role || 'admin').toLowerCase();
  
  // Superuser has all permissions
  if (role === 'superuser') return true;

  // Support custom/explicit capabilities attached directly to session admin
  if (Array.isArray(admin.capabilities)) {
    if (admin.capabilities.includes('manage_all') || admin.capabilities.includes(capability)) {
      return true;
    }
  }

  const capabilities = ROLE_CAPABILITIES[role] || [];
  return capabilities.includes(capability) || capabilities.includes('manage_all');
};

const getAdminCapabilities = (admin) => {
  if (!admin) return [];
  const role = (admin.role || 'admin').toLowerCase();
  if (role === 'superuser') {
    return ROLE_CAPABILITIES.superuser;
  }
  return ROLE_CAPABILITIES[role] || [];
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
  getAdminCapabilities,
  requireCapability
};
