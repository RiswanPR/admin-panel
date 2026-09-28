/**
 * Zeitnah Admin Panel — Handlebars Live Template Stress & Edge-Case Validator
 * Validates rendering of all primary governance and administrative templates
 * under normal, empty, missing, null, and boundary conditions.
 */

const path = require('path');
const exphbs = require('express-handlebars');
const assert = require('assert');

// Instantiate express-handlebars engine exactly matching app.js
const hbs = exphbs.create({
  extname: 'hbs',
  defaultLayout: 'layout',
  layoutsDir: path.join(__dirname, '../views/Layout'),
  partialsDir: path.join(__dirname, '../views/partials'),
  helpers: {
    eq: (a, b) => String(a) === String(b),
    gt: (a, b) => a > b,
    lt: (a, b) => a < b,
    ifEquals: function (a, b, options) {
      return String(a) === String(b) ? options.fn(this) : options.inverse(this);
    },
    inc: (val) => Number(val || 0) + 1,
    add: (a, b) => Number(a || 0) + Number(b || 0),
    dec: (val) => Math.max(1, Number(val || 1) - 1),
    ifGt: function (a, b, options) {
      return Number(a) > Number(b) ? options.fn(this) : options.inverse(this);
    },
    ifLt: function (a, b, options) {
      return Number(a) < Number(b) ? options.fn(this) : options.inverse(this);
    },
    resolveImage: (imagePath, folderName) => imagePath || '/img/placeholders/profile.svg',
    selected: (a, b) => String(a) === String(b) ? 'selected' : '',
    formatDate: (d) => d ? new Date(d).toISOString().split('T')[0] : '',
    formatDateTime: (d) => d ? new Date(d).toLocaleString() : '',
    includes: (arr, item) => Array.isArray(arr) ? arr.map(String).includes(String(item)) : false,
    json: (ctx) => JSON.stringify(ctx || {}),
    truncate: (str, len) => (str && str.length > (len || 100)) ? str.substring(0, len || 100) + '...' : (str || ''),
    badgeClass: (t, v) => 'badge-status-active',
    upper: (s) => String(s || '').toUpperCase(),
    lower: (s) => String(s || '').toLowerCase(),
    or: (...args) => args.slice(0, -1).some(Boolean),
    hasAdminCapability: function (cap, options) {
      return options && options.fn ? options.fn(this) : true;
    },
    ternary: (cond, a, b) => cond ? a : b,
    statusBadgeClass: () => 'badge-status-active'
  }
});

const templatesToStress = [
  'views/admin/home.hbs',
  'views/admin/verification.hbs',
  'views/admin/error-reports.hbs',
  'views/admin/moderation.hbs',
  'views/admin/audit-logs.hbs',
  'views/admin/businesses.hbs',
  'views/admin/jobs.hbs',
  'views/admin/network-users.hbs',
  'views/admin/network-user.hbs',
  'views/admin/network-taxonomy.hbs',
  'views/admin/ai-matching.hbs',
  'views/admin/ai-job-matches.hbs',
  'views/admin/ai-talent-recommendations.hbs',
  'views/admin/ai-config.hbs',
  'views/admin/career-roles.hbs',
  'views/admin/career-skills.hbs',
  'views/admin/career-pathways.hbs',
  'views/admin/analytics.hbs',
  'views/admin/settings.hbs'
];

const runTemplateStressSuite = async () => {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: HANDLEBARS TEMPLATE STRESS TEST         ');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  for (const tPath of templatesToStress) {
    const fullPath = path.join(__dirname, '..', tPath);

    // Scenario 1: Normal Standard Payload
    total++;
    try {
      const rendered = await hbs.renderView(fullPath, {
        layout: false,
        admins: true,
        sessionAdmin: { Name: 'QA Admin', Email: 'qa@zeitnah.com', role: 'superuser' },
        isSuperuser: true,
        viewMode: 'card',
        records: [
          { _id: '640102030405060708090a0b', targetName: 'John Doe', name: 'Acme Corp', title: 'Senior Engineer', category: 'IDENTITY', status: 'PENDING', statusNormalized: 'PENDING' }
        ],
        stats: { total: 1, pending: 1, verified: 0, active: 1, open: 1, resolved: 0, application: 0, unresolved: 0 },
        total: 1,
        page: 1,
        totalPages: 1,
        filters: { search: 'test', status: 'all', category: 'all' },
        dashboard: {
          totalStudents: 10,
          activeStudents: 8,
          activePercentage: 80,
          totalCourses: 5,
          totalChapters: 20,
          totalRevenue: 50000,
          systemHealth: { database: 'ONLINE', sessionStore: 'READY', errorRate: 'NORMAL', uptimeFormatted: '12h' },
          alerts: [],
          recentActivity: []
        }
      });
      assert.ok(rendered.length > 50, 'Render produced content');
      passed++;
      console.log(`  ✔ PASS [Standard]: ${tPath}`);
    } catch (e) {
      console.error(`  ✖ FAIL [Standard]: ${tPath} -> ${e.message}`);
    }

    // Scenario 2: Empty Data (records: [], stats: {}, null fields)
    total++;
    try {
      const renderedEmpty = await hbs.renderView(fullPath, {
        layout: false,
        admins: true,
        sessionAdmin: null,
        isSuperuser: false,
        viewMode: 'card',
        records: [],
        stats: {},
        total: 0,
        page: 1,
        totalPages: 0,
        filters: {},
        dashboard: {
          totalStudents: 0,
          activeStudents: 0,
          activePercentage: 0,
          totalCourses: 0,
          totalChapters: 0,
          totalRevenue: 0,
          systemHealth: null,
          alerts: [],
          recentActivity: []
        }
      });
      assert.ok(renderedEmpty.length > 20, 'Render produced content on empty state');
      passed++;
      console.log(`  ✔ PASS [Empty State]: ${tPath}`);
    } catch (e) {
      console.error(`  ✖ FAIL [Empty State]: ${tPath} -> ${e.message}`);
    }

    // Scenario 3: Boundary / Long Text Payload (Stress test)
    total++;
    try {
      const longText = 'A'.repeat(4000);
      const renderedStress = await hbs.renderView(fullPath, {
        layout: false,
        admins: true,
        sessionAdmin: { Name: longText.slice(0, 50), Email: 'long@example.com', role: 'admin' },
        isSuperuser: false,
        viewMode: 'table', // test table view rendering as well!
        records: [
          { _id: '640102030405060708090a0b', targetName: longText.slice(0, 100), message: longText, notes: longText, status: 'VERIFIED', statusNormalized: 'APPROVED' }
        ],
        stats: { total: 99999 },
        total: 99999,
        page: 50,
        totalPages: 100,
        filters: { search: longText.slice(0, 50) },
        dashboard: {
          totalStudents: 99999,
          systemHealth: { database: 'ONLINE', sessionStore: 'READY', errorRate: 'NORMAL' },
          alerts: [],
          recentActivity: []
        }
      });
      assert.ok(renderedStress.length > 50, 'Render produced content under stress');
      passed++;
      console.log(`  ✔ PASS [Boundary/Table View]: ${tPath}`);
    } catch (e) {
      console.error(`  ✖ FAIL [Boundary/Table View]: ${tPath} -> ${e.message}`);
    }
  }

  console.log('\n================================================================');
  console.log(`TEMPLATE STRESS SUMMARY: ${passed}/${total} passed (${total} tests)`);
  console.log('================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
};

runTemplateStressSuite().catch(err => {
  console.error('Fatal Template Stress Error:', err);
  process.exit(1);
});
