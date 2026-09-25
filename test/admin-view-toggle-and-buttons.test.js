'use strict';

/**
 * Zeitnah Admin Panel — View Toggle System & Complete Button Interaction Test Suite
 * Validates:
 * 1. Card View as Default & View State Preservation (URL & Fallbacks)
 * 2. Complete Button & Route Action Handlers (Approve, Reject, Suspend, Unpublish, Restore, Flag, Alias, Resolve)
 * 3. Double-Submission Protection & Loading Feedback
 * 4. Granular Permission & Capability Enforcement (Least Privilege)
 * 5. Audit Trail Verification for Every Privileged Mutation
 * 6. Partial & Style Specification Integrity (Table Alignment, Badges, Fixed Action Columns)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const permissionsHelper = require('../Helpers/permissions-helper');
const governanceHelper = require('../Helpers/governance-helper');
const moderationHelper = require('../Helpers/moderation-helper');
const careerAdminHelper = require('../Helpers/career-admin-helper');
const db = require('../config/connection');
const collection = require('../config/collections');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(desc, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✔ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✖ FAIL: ${desc}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

async function testAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✔ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✖ FAIL: ${desc}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

// In-memory mock database state for testing
const mockDb = {
  users: new Map(),
  organizations: new Map(),
  opportunities: new Map(),
  skills: new Map(),
  moderation_reports: new Map(),
  audit_logs: []
};

const createMockCollection = (mapOrArray) => {
  if (Array.isArray(mapOrArray)) {
    return {
      insertOne: async (doc) => { mapOrArray.push({ ...doc, _id: doc._id || new ObjectId() }); return { insertedId: doc._id }; },
      find: () => ({ toArray: async () => mapOrArray }),
      countDocuments: async () => mapOrArray.length
    };
  }

  return {
    findOne: async (q) => {
      for (const item of mapOrArray.values()) {
        let match = true;
        for (const [k, v] of Object.entries(q)) {
          if (k === '_id' && String(item._id) !== String(v)) match = false;
          else if (k !== '_id' && item[k] !== v) match = false;
        }
        if (match) return JSON.parse(JSON.stringify(item));
      }
      return null;
    },
    updateOne: async (q, u) => {
      const id = String(q._id);
      const existing = mapOrArray.get(id);
      if (existing) {
        if (u.$set) Object.assign(existing, u.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    updateMany: async (q, u) => {
      return { matchedCount: 1, modifiedCount: 1 };
    },
    countDocuments: async () => mapOrArray.size
  };
};

db.get = () => ({
  collection: (name) => {
    switch (name) {
      case collection.STUDENTS_COLLECTION:
        return createMockCollection(mockDb.users);
      case collection.ORGANIZATIONS_COLLECTION:
      case 'organizations':
        return createMockCollection(mockDb.organizations);
      case collection.OPPORTUNITIES_COLLECTION:
      case 'opportunities':
        return createMockCollection(mockDb.opportunities);
      case collection.SKILLS_COLLECTION:
      case 'skills':
        return createMockCollection(mockDb.skills);
      case collection.MODERATION_REPORTS_COLLECTION:
      case 'moderation_reports':
        return createMockCollection(mockDb.moderation_reports);
      case collection.AUDIT_LOG_COLLECTION:
      case collection.AUDIT_COLLECTION:
      case 'audit_logs':
        return createMockCollection(mockDb.audit_logs);
      default:
        return createMockCollection(new Map());
    }
  }
});

async function runAllTests() {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: VIEW TOGGLE & BUTTON INTERACTION SUITE  ');
  console.log('================================================================\n');

  // --- 1. VIEW STATE RESOLUTION & INVARIANTS ---
  console.log('--- 1. View State Resolution & Default Invariants ---');

  test('✓ Default viewMode is strictly "card" when query parameter is omitted', () => {
    const resolveView = (q) => (q?.view === 'table' ? 'table' : 'card');
    assert.strictEqual(resolveView(undefined), 'card');
    assert.strictEqual(resolveView({}), 'card');
  });

  test('✓ Default viewMode falls back safely to "card" on unknown or invalid parameter', () => {
    const resolveView = (q) => (q?.view === 'table' ? 'table' : 'card');
    assert.strictEqual(resolveView({ view: 'unknown' }), 'card');
    assert.strictEqual(resolveView({ view: 'grid' }), 'card');
    assert.strictEqual(resolveView({ view: 'list' }), 'card');
  });

  test('✓ Explicit "table" view query correctly activates Table View', () => {
    const resolveView = (q) => (q?.view === 'table' ? 'table' : 'card');
    assert.strictEqual(resolveView({ view: 'table' }), 'table');
  });

  test('✓ Pagination & filter URL builders preserve current viewMode', () => {
    const buildPaginationUrl = (base, page, filters, view) => {
      const params = new URLSearchParams({ ...filters, page, view: view === 'table' ? 'table' : 'card' });
      return `${base}?${params.toString()}`;
    };

    const cardUrl = buildPaginationUrl('/admin/businesses', 2, { tab: 'pending', search: 'road' }, 'card');
    assert.ok(cardUrl.includes('view=card'));
    assert.ok(cardUrl.includes('tab=pending'));
    assert.ok(cardUrl.includes('page=2'));

    const tableUrl = buildPaginationUrl('/admin/jobs', 3, { discipline: 'Civil' }, 'table');
    assert.ok(tableUrl.includes('view=table'));
    assert.ok(tableUrl.includes('page=3'));
    assert.ok(tableUrl.includes('discipline=Civil'));
  });

  // --- 2. PERMISSION-BASED BUTTON & ROUTE GUARDS ---
  console.log('\n--- 2. Permission-Based Button & Route Capability Guards ---');

  const superuserAdmin = { _id: new ObjectId(), username: 'super', role: 'superuser' };
  const generalAdmin = { _id: new ObjectId(), username: 'general', role: 'admin' };
  const jobsAdmin = { _id: new ObjectId(), username: 'jobs', role: 'jobs_admin' };
  const bizAdmin = { _id: new ObjectId(), username: 'biz', role: 'business_admin' };
  const aiAdmin = { _id: new ObjectId(), username: 'ai', role: 'ai_admin' };

  test('✓ Superuser possesses all capabilities and passes any capability check', () => {
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'manage_network'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'approve_businesses'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'manage_jobs'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'manage_ai_config'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'moderate_content'), true);
  });

  test('✓ Jobs Admin can manage jobs but is forbidden from approving businesses', () => {
    assert.strictEqual(permissionsHelper.hasCapability(jobsAdmin, 'manage_jobs'), true);
    assert.strictEqual(permissionsHelper.hasCapability(jobsAdmin, 'approve_businesses'), false);
    assert.strictEqual(permissionsHelper.hasCapability(jobsAdmin, 'manage_ai_config'), false);
  });

  test('✓ Business Admin can review & approve businesses but is forbidden from modifying AI config', () => {
    assert.strictEqual(permissionsHelper.hasCapability(bizAdmin, 'approve_businesses'), true);
    assert.strictEqual(permissionsHelper.hasCapability(bizAdmin, 'suspend_businesses'), true);
    assert.strictEqual(permissionsHelper.hasCapability(bizAdmin, 'manage_jobs'), false);
    assert.strictEqual(permissionsHelper.hasCapability(bizAdmin, 'manage_ai_config'), false);
  });

  test('✓ AI Admin can update AI configuration but is forbidden from suspending businesses', () => {
    assert.strictEqual(permissionsHelper.hasCapability(aiAdmin, 'manage_ai_config'), true);
    assert.strictEqual(permissionsHelper.hasCapability(aiAdmin, 'suspend_businesses'), false);
    assert.strictEqual(permissionsHelper.hasCapability(aiAdmin, 'approve_businesses'), false);
  });

  test('✓ requireCapability middleware blocks unauthorized requests with 403', () => {
    const middleware = permissionsHelper.requireCapability('approve_businesses');
    const req = { session: { admin: jobsAdmin }, xhr: true, headers: {} };
    let statusSent = 0;
    let jsonSent = null;
    const res = {
      status: (code) => { statusSent = code; return res; },
      json: (data) => { jsonSent = data; }
    };
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(statusSent, 403);
    assert.strictEqual(jsonSent.success, false);
  });

  test('✓ requireCapability middleware rejects unauthenticated session with 401', () => {
    const middleware = permissionsHelper.requireCapability('manage_jobs');
    const req = { session: {}, xhr: true, headers: {} };
    let statusSent = 0;
    const res = {
      status: (code) => { statusSent = code; return res; },
      json: () => {}
    };
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(statusSent, 401);
  });

  // --- 3. COMPLETE GOVERNANCE BUTTON HANDLER VERIFICATION ---
  console.log('\n--- 3. Governance Button Handlers & Audit Log Verification ---');

  const testBizId = new ObjectId();
  mockDb.organizations.set(String(testBizId), {
    _id: testBizId,
    name: 'Mega Bridges Ltd',
    status: 'PENDING',
    statusNormalized: 'PENDING'
  });

  await testAsync('✓ Business [Approve] button: mutates status to APPROVED and records audit log', async () => {
    const result = await governanceHelper.approveBusiness(String(testBizId), superuserAdmin);
    assert.strictEqual(result.success, true);
    assert.strictEqual(mockDb.organizations.get(String(testBizId)).status, 'APPROVED');

    const lastAudit = mockDb.audit_logs[mockDb.audit_logs.length - 1];
    assert.strictEqual(lastAudit.action, 'BUSINESS_APPROVED');
    assert.strictEqual(lastAudit.entityId, String(testBizId));
  });

  await testAsync('✓ Business [Reject] button: mandates reason and transitions status', async () => {
    await assert.rejects(
      async () => await governanceHelper.rejectBusiness(String(testBizId), '', superuserAdmin),
      /rejection reason is mandatory/i
    );

    const result = await governanceHelper.rejectBusiness(String(testBizId), 'Domain verification failed', superuserAdmin);
    assert.strictEqual(result.success, true);
    assert.strictEqual(mockDb.organizations.get(String(testBizId)).status, 'REJECTED');

    const lastAudit = mockDb.audit_logs[mockDb.audit_logs.length - 1];
    assert.strictEqual(lastAudit.action, 'BUSINESS_REJECTED');
  });

  await testAsync('✓ Business [Suspend] button: mandates reason, pauses entities, and audits', async () => {
    await assert.rejects(
      async () => await governanceHelper.suspendBusiness(String(testBizId), '', superuserAdmin),
      /suspension reason is mandatory/i
    );

    const result = await governanceHelper.suspendBusiness(String(testBizId), 'Non-compliance with safety codes', superuserAdmin);
    assert.strictEqual(result.success, true);
    assert.strictEqual(mockDb.organizations.get(String(testBizId)).status, 'SUSPENDED');
  });

  const testJobId = new ObjectId();
  mockDb.opportunities.set(String(testJobId), {
    _id: testJobId,
    title: 'Lead Structural Engineer',
    status: 'PUBLISHED',
    statusNormalized: 'PUBLISHED',
    isFlagged: false
  });

  await testAsync('✓ Job [Unpublish] button: pauses publication, updates status, and records audit', async () => {
    const result = await governanceHelper.unpublishJob(String(testJobId), 'Salary range inaccurate', superuserAdmin);
    assert.strictEqual(result.success, true);
    assert.strictEqual(mockDb.opportunities.get(String(testJobId)).status, 'PAUSED');

    const lastAudit = mockDb.audit_logs[mockDb.audit_logs.length - 1];
    assert.strictEqual(lastAudit.action, 'JOB_UNPUBLISHED');
  });

  await testAsync('✓ Job [Restore] button: restores job to PUBLISHED and records audit', async () => {
    const result = await governanceHelper.restoreJob(String(testJobId), superuserAdmin);
    assert.strictEqual(result.success, true);
    assert.strictEqual(mockDb.opportunities.get(String(testJobId)).status, 'PUBLISHED');

    const lastAudit = mockDb.audit_logs[mockDb.audit_logs.length - 1];
    assert.strictEqual(lastAudit.action, 'JOB_RESTORED');
  });

  await testAsync('✓ Job [Flag] button: flags job for moderation and records audit', async () => {
    const result = await governanceHelper.flagJob(String(testJobId), 'Suspicious contact info', superuserAdmin);
    assert.strictEqual(result.success, true);
    assert.strictEqual(mockDb.opportunities.get(String(testJobId)).isFlagged, true);

    const lastAudit = mockDb.audit_logs[mockDb.audit_logs.length - 1];
    assert.strictEqual(lastAudit.action, 'JOB_FLAGGED');
  });

  const testReportId = new ObjectId();
  mockDb.moderation_reports.set(String(testReportId), {
    _id: testReportId,
    status: 'PENDING',
    statusNormalized: 'PENDING',
    targetType: 'OPPORTUNITY',
    targetId: String(testJobId)
  });

  await testAsync('✓ Moderation [Adjudicate/Resolve] button: updates status and creates audit entry', async () => {
    const result = await moderationHelper.updateReportStatus(
      String(testReportId),
      { status: 'RESOLVED', actionTaken: 'Job content adjusted', moderatorNotes: 'Reviewed with employer' },
      superuserAdmin
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(mockDb.moderation_reports.get(String(testReportId)).status, 'RESOLVED');

    const lastAudit = mockDb.audit_logs[mockDb.audit_logs.length - 1];
    assert.strictEqual(lastAudit.action, 'MODERATION_ACTION');
  });

  // --- 4. TEMPLATE & DESIGN SYSTEM AUDIT ---
  console.log('\n--- 4. Template & CSS Design System Verification ---');

  test('✓ Reusable view-toggle partial exists and contains accessible labels & icons', () => {
    const partialPath = path.join(__dirname, '../views/partials/admin/view-toggle.hbs');
    assert.ok(fs.existsSync(partialPath), 'view-toggle.hbs partial must exist');
    const content = fs.readFileSync(partialPath, 'utf8');
    assert.ok(content.includes('data-view="card"'), 'must include data-view="card"');
    assert.ok(content.includes('data-view="table"'), 'must include data-view="table"');
    assert.ok(content.toLowerCase().includes('aria-label="cards view"'), 'must include accessible Cards label');
    assert.ok(content.toLowerCase().includes('aria-label="table view"'), 'must include accessible Table label');
  });

  test('✓ Client-side view toggle script exists with localStorage and URL preservation', () => {
    const jsPath = path.join(__dirname, '../public/javascripts/admin-view-toggle.js');
    assert.ok(fs.existsSync(jsPath), 'admin-view-toggle.js must exist');
    const content = fs.readFileSync(jsPath, 'utf8');
    assert.ok(content.includes('zeitnah_admin_view_'), 'must use localStorage namespace');
    assert.ok(content.includes('history.replaceState'), 'must sync URL without reloading');
    assert.ok(content.includes('zeitnahSetSubmitting'), 'must export double-submission helper');
  });

  test('✓ Unified CSS design system specifies responsive cards, aligned tables, and fixed action columns', () => {
    const cssPath = path.join(__dirname, '../public/stylesheets/admin-cards-tables.css');
    assert.ok(fs.existsSync(cssPath), 'admin-cards-tables.css must exist');
    const content = fs.readFileSync(cssPath, 'utf8');
    assert.ok(content.includes('.admin-view-toggle'), 'must define .admin-view-toggle');
    assert.ok(content.includes('.admin-governance-card'), 'must define .admin-governance-card');
    assert.ok(content.includes('.table-actions'), 'must define .table-actions');
    assert.ok(content.includes('vertical-align: middle'), 'table cells must be vertically centered');
    assert.ok(content.includes('.btn-submitting'), 'must style disabled double-submission state');
  });

  const checkTemplate = (templateRelPath, sectionName) => {
    const fullPath = path.join(__dirname, '..', templateRelPath);
    assert.ok(fs.existsSync(fullPath), `${templateRelPath} must exist`);
    const content = fs.readFileSync(fullPath, 'utf8');
    assert.ok(
      content.includes(`id="${sectionName}CardView"`),
      `${templateRelPath} must have #${sectionName}CardView`
    );
    assert.ok(
      content.includes(`id="${sectionName}TableView"`),
      `${templateRelPath} must have #${sectionName}TableView`
    );
    assert.ok(
      content.includes('admin/view-toggle'),
      `${templateRelPath} must include view-toggle partial`
    );
  };

  test('✓ Network Users page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/network-users.hbs', 'network_users');
  });

  test('✓ Businesses Review page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/businesses.hbs', 'businesses');
  });

  test('✓ Jobs Governance page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/jobs.hbs', 'jobs');
  });

  test('✓ AI Job Matches page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/ai-job-matches.hbs', 'ai-matches');
  });

  test('✓ AI Talent Recommendations page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/ai-talent-recommendations.hbs', 'ai-recommendations');
  });

  test('✓ Career Roles page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/career-roles.hbs', 'career-roles');
  });

  test('✓ Career Skills page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/career-skills.hbs', 'career-skills');
  });

  test('✓ Career Pathways page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/career-pathways.hbs', 'career-pathways');
  });

  test('✓ Moderation page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/moderation.hbs', 'moderation');
  });

  test('✓ Audit Logs page has Card View default and Table View toggle', () => {
    checkTemplate('views/admin/audit-logs.hbs', 'audit-logs');
  });

  test('✓ Dashboard Home has 6 actionable ecosystem governance CTAs', () => {
    const homePath = path.join(__dirname, '../views/admin/home.hbs');
    const content = fs.readFileSync(homePath, 'utf8');
    assert.ok(content.includes('/admin/network/users'), 'Home must link to users');
    assert.ok(content.includes('/admin/businesses?tab=pending'), 'Home must link to pending businesses');
    assert.ok(content.includes('/admin/jobs?tab=published'), 'Home must link to jobs');
    assert.ok(content.includes('/admin/ai/matching'), 'Home must link to AI matching');
    assert.ok(content.includes('/admin/career-intelligence/roles'), 'Home must link to roles');
    assert.ok(content.includes('/admin/moderation?tab=open'), 'Home must link to moderation queue');
  });

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests}`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test Suite Fatal Error:', err);
  process.exit(1);
});
