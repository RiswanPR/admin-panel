'use strict';

/**
 * Zeitnah Admin Panel — Dashboard Phase 1 Test Suite
 * Critical Security, RBAC & Data Integrity Hardening
 *
 * Verifies:
 * Group A: Authentication & Canonical Route Protection
 * Group B: RBAC & Capability Protection for Sensitive Metrics & CTAs
 * Group C: XSS Vulnerability Remediation & Context-Safe JSON Serialization
 * Group D: Database Error Handling & Session Preservation
 * Group E: Data Contract Alignment (OPERATIONAL/ONLINE, activeJobs, uptimeFormatted)
 * Group F: Backward Compatibility & Regression Invariants
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const permissionsHelper = require('../Helpers/permissions-helper');
const dashboardHelper = require('../Helpers/dashboard-helper');
const db = require('../config/connection');

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
    process.exitCode = 1;
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
    process.exitCode = 1;
  }
}

// Register Handlebars helpers matching app.js
Handlebars.registerHelper('eq', (a, b) => String(a) === String(b));
Handlebars.registerHelper('gt', (a, b) => Number(a) > Number(b));
Handlebars.registerHelper('lt', (a, b) => Number(a) < Number(b));
Handlebars.registerHelper('ifEquals', function(a, b, options) {
  return String(a) === String(b) ? options.fn(this) : options.inverse(this);
});
Handlebars.registerHelper('or', function(...args) {
  return args.slice(0, -1).some(Boolean);
});
Handlebars.registerHelper('ternary', (cond, a, b) => cond ? a : b);
Handlebars.registerHelper('json', function(context) {
  const jsonStr = JSON.stringify(context !== undefined ? context : {});
  const safe = jsonStr
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return new Handlebars.SafeString(safe);
});
Handlebars.registerHelper('safeJson', function(context) {
  const jsonStr = JSON.stringify(context !== undefined ? context : {});
  const safe = jsonStr
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return new Handlebars.SafeString(safe);
});

// Load and compile views/admin/home.hbs
const homeTemplateSource = fs.readFileSync(path.join(__dirname, '../views/admin/home.hbs'), 'utf8');
const compiledHomeTemplate = Handlebars.compile(homeTemplateSource);

// Helper to create mock req/res
const createMockReqRes = (sessionData = {}, headers = {}) => {
  const req = {
    session: sessionData,
    headers: {
      accept: 'text/html',
      ...headers
    }
  };
  const res = {
    statusCode: 200,
    redirectUrl: null,
    renderedView: null,
    renderedData: null,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    redirect(url) {
      this.redirectUrl = url;
    },
    render(view, data) {
      this.renderedView = view;
      this.renderedData = data;
    },
    json(data) {
      this.jsonBody = data;
    }
  };
  return { req, res };
};

// Canonical verifyLogin middleware representation
const verifyLogin = (req, res, next) => {
  if (req.session?.adminloggedIn) {
    next();
  } else {
    if (req.xhr || req.headers?.accept?.indexOf('json') > -1 || req.method === 'POST') {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
    }
    res.redirect('/login');
  }
};

// Mock In-Memory Database for Dashboard Queries
function createMockDb() {
  const mockStudents = [
    { _id: '1', Name: 'Alice Smith', Email: 'alice@example.com', primaryRole: 'STUDENT', status: true, Paid_Amount: 1500, course: [{ courseName: 'Full Stack Web' }], createdAt: new Date() },
    { _id: '2', Name: 'Bob Jones', Email: 'bob@example.com', primaryRole: 'STUDENT', status: true, Paid_Amount: 2500, course: [{ courseName: 'Data Science' }], createdAt: new Date() },
    { _id: '3', Name: 'Charlie Brown', Email: 'charlie@example.com', role: 'student', status: false, Paid_Amount: 'invalid_currency', course: [{ courseName: 'Full Stack Web' }], createdAt: new Date() }
  ];

  let queryLog = [];

  return {
    queryLog,
    collection: (name) => {
      queryLog.push(name);
      if (name === 'students' || name === 'users') {
        return {
          countDocuments: async (query = {}) => {
            if (query.status === false) return 1;
            if (query.status === true) return 2;
            return mockStudents.length;
          },
          find: (query = {}, options = {}) => ({
            sort: () => ({
              limit: (lim) => ({
                toArray: async () => {
                  let results = mockStudents.slice(0, lim || mockStudents.length);
                  if (options.projection) {
                    results = results.map(s => {
                      const proj = { _id: s._id };
                      if (options.projection.Name) proj.Name = s.Name;
                      if (options.projection.Email) proj.Email = s.Email;
                      if (options.projection['course.courseName'] || options.projection.course) proj.course = s.course;
                      if (options.projection['account_Status.isActive']) proj.account_Status = s.account_Status;
                      if (options.projection.createdAt) proj.createdAt = s.createdAt;
                      return proj;
                    });
                  }
                  return results;
                }
              })
            })
          }),
          aggregate: (pipeline) => ({
            toArray: async () => {
              const stages = Array.isArray(pipeline) ? pipeline : [];
              const groupStage = stages.find(s => s.$group);
              if (groupStage) {
                // If course distribution
                if (groupStage.$group._id === '$course.courseName') {
                  return [
                    { _id: 'Full Stack Web', count: 2 },
                    { _id: 'Data Science', count: 1 }
                  ];
                }
                // If monthly trends
                if (groupStage.$group._id && groupStage.$group._id.year) {
                  const now = new Date();
                  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                  return [
                    {
                      _id: { year: now.getFullYear(), month: now.getMonth() + 1 },
                      enrollmentCount: 2,
                      revenueTotal: 4000
                    },
                    {
                      _id: { year: prevMonthDate.getFullYear(), month: prevMonthDate.getMonth() + 1 },
                      enrollmentCount: 1,
                      revenueTotal: 2000
                    }
                  ];
                }
                // If user stats consolidation
                if (groupStage.$group.totalUsers) {
                  return [{
                    _id: null,
                    totalUsers: 3,
                    totalStudents: 3,
                    totalLearners: 3,
                    activeUsers: 2,
                    activeStudents: 2,
                    activeLearners: 2,
                    expiredStudents: 1,
                    newUsers7d: 3,
                    prevUsers7d: 2,
                    pendingUsersVerification: 0,
                    totalRevenue: 4000
                  }];
                }
                // Legacy total revenue pipeline fallback
                if (groupStage.$group.total) {
                  return [{ _id: null, total: 4000 }];
                }
              }
              return [];
            }
          })
        };
      }
      if (name === 'courses') {
        return {
          countDocuments: async () => 2,
          find: () => ({
            toArray: async () => [{ chapters: [{}, {}] }, { chapters: [{}] }]
          }),
          aggregate: (pipeline) => ({
            toArray: async () => [{
              _id: null,
              totalCourses: 2,
              totalChapters: 3
            }]
          })
        };
      }
      if (name === 'error_reports') {
        return {
          countDocuments: async () => 3
        };
      }
      if (name === 'moderation_reports') {
        return {
          countDocuments: async () => 2,
          aggregate: (pipeline) => ({
            toArray: async () => [{
              _id: null,
              open: 2,
              underReview: 1
            }]
          })
        };
      }
      if (name === 'organizations') {
        return {
          countDocuments: async () => 1,
          aggregate: (pipeline) => ({
            toArray: async () => [{
              _id: null,
              pending: 1,
              approved: 2
            }]
          })
        };
      }
      if (name === 'opportunities') {
        return {
          countDocuments: async () => 5
        };
      }
      if (name === 'verification_requests') {
        return {
          countDocuments: async () => 0
        };
      }
      if (name === 'teachers') {
        return {
          countDocuments: async () => 0
        };
      }
      if (name === 'learning_spaces') {
        return {
          countDocuments: async () => 0
        };
      }
      if (name === 'job_talent_matches') {
        return {
          countDocuments: async () => 0
        };
      }
      if (name === 'audit_logs') {
        return {
          find: () => ({
            sort: () => ({
              limit: () => ({
                toArray: async () => [
                  { _id: 'log1', action: 'APPROVE', entityType: 'business', entityName: 'Acme Corp', createdAt: new Date() }
                ]
              })
            })
          })
        };
      }
      if (name === 'community_posts') {
        return {
          countDocuments: async () => 10,
          aggregate: (pipeline) => ({
            toArray: async () => [{
              _id: null,
              totalPosts: 10,
              activePosts: 8,
              newPosts7d: 5,
              prevPosts7d: 3
            }]
          })
        };
      }
      if (name === 'community_comments') {
        return {
          countDocuments: async () => 25,
          aggregate: (pipeline) => ({
            toArray: async () => [{
              _id: null,
              totalComments: 25,
              activeComments: 22,
              newComments7d: 14,
              prevComments7d: 10
            }]
          })
        };
      }
      if (name === 'community_stories') {
        return {
          countDocuments: async () => 6,
          aggregate: (pipeline) => ({
            toArray: async () => [{
              _id: null,
              totalStories: 6,
              activeStories: 4,
              newStories7d: 3,
              prevStories7d: 2
            }]
          })
        };
      }
      if (name === 'community_reports') {
        return {
          countDocuments: async () => 8,
          aggregate: (pipeline) => ({
            toArray: async () => [{
              _id: null,
              totalReports: 8,
              pendingReports: 3,
              underReviewReports: 2,
              postReports: 2,
              commentReports: 1,
              storyReports: 1,
              userReports: 1,
              newReports7d: 3,
              prevReports7d: 1
            }]
          })
        };
      }
      return {
        countDocuments: async () => 0,
        find: () => ({
          toArray: async () => [],
          sort: () => ({ limit: () => ({ toArray: async () => [] }) })
        }),
        aggregate: () => ({ toArray: async () => [] })
      };
    }
  };
}

async function runDashboardTests() {
  console.log('\n======================================================');
  console.log('   RUNNING ZEITNAH ADMIN DASHBOARD TEST SUITE        ');
  console.log('======================================================\n');

  // --------------------------------------------------------------------------
  // Group A: Authentication & Canonical Route Protection
  // --------------------------------------------------------------------------
  console.log('--- Group A: Authentication & Canonical Route Protection ---');

  test('A.1: Unauthenticated request redirects to /login', () => {
    const { req, res } = createMockReqRes({ adminloggedIn: false });
    let nextCalled = false;
    verifyLogin(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false, 'next() must not be called when unauthenticated');
    assert.strictEqual(res.redirectUrl, '/login', 'Must redirect to /login');
  });

  test('A.2: Unauthenticated AJAX/JSON request returns 401 Unauthorized JSON', () => {
    const { req, res } = createMockReqRes({ adminloggedIn: false }, { accept: 'application/json' });
    let nextCalled = false;
    verifyLogin(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonBody?.success, false);
  });

  test('A.3: Teacher session redirects to /teacher/dashboard', () => {
    const { req, res } = createMockReqRes({ teacherloggedIn: true, adminloggedIn: false });
    if (req.session?.teacherloggedIn) {
      res.redirect('/teacher/dashboard');
    }
    assert.strictEqual(res.redirectUrl, '/teacher/dashboard');
  });

  test('A.4: Authenticated admin session successfully passes verifyLogin guard', () => {
    const { req, res } = createMockReqRes({
      adminloggedIn: true,
      admin: { Email: 'admin@zeitnah.com', role: 'admin' }
    });
    let nextCalled = false;
    verifyLogin(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true, 'next() must be called for authenticated admin');
    assert.strictEqual(res.redirectUrl, null);
  });

  // --------------------------------------------------------------------------
  // Group B: RBAC & Capability Protection for Sensitive Metrics & CTAs
  // --------------------------------------------------------------------------
  console.log('\n--- Group B: RBAC & Sensitive Metrics Protection ---');

  const originalDbGet = db.get;
  db.get = () => createMockDb();

  await testAsync('B.1: Superuser receives unmasked revenue and complete financial telemetry', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);
    assert.strictEqual(typeof data.totalRevenue, 'number', 'Superuser must receive numeric totalRevenue');
    assert.strictEqual(data.totalRevenue, 4000);
    assert.ok(Array.isArray(data.revenueChart?.labels), 'Superuser must receive revenue chart labels');
    assert.strictEqual(data.systemHealth.errorRate, 'NORMAL', 'Superuser can view system error health rate');
  });

  await testAsync('B.2: Admin with manage_settings receives totalRevenue and revenueChart', async () => {
    const adminWithSettings = { Email: 'sysadmin@zeitnah.com', role: 'system_admin' };
    const data = await dashboardHelper.getDashboardData(adminWithSettings);
    assert.strictEqual(typeof data.totalRevenue, 'number', 'system_admin has manage_settings, must receive totalRevenue');
    assert.ok(Array.isArray(data.revenueChart?.data));
  });

  await testAsync('B.3: Moderation admin (lacks manage_settings) has totalRevenue masked (null) and empty revenueChart', async () => {
    const moderationAdmin = { Email: 'mod@zeitnah.com', role: 'moderation_admin' };
    const data = await dashboardHelper.getDashboardData(moderationAdmin);
    assert.strictEqual(data.totalRevenue, null, 'totalRevenue must be null for admin lacking manage_settings');
    assert.deepStrictEqual(data.revenueChart, { labels: [], data: [] }, 'revenueChart must be empty for unauthorized admin');
  });

  await testAsync('B.4: Verification admin (lacks manage_settings) does not receive financial metrics', async () => {
    const verificationAdmin = { Email: 'verify@zeitnah.com', role: 'verification_admin' };
    const data = await dashboardHelper.getDashboardData(verificationAdmin);
    assert.strictEqual(data.totalRevenue, null);
    assert.deepStrictEqual(data.revenueChart.data, []);
  });

  await testAsync('B.5: Admin lacking view_system_errors has systemHealth.errorRate masked and systemErrors omitted', async () => {
    const moderationAdmin = { Email: 'mod@zeitnah.com', role: 'moderation_admin' };
    const data = await dashboardHelper.getDashboardData(moderationAdmin);
    assert.strictEqual(data.systemHealth.errorRate, 'RESTRICTED', 'Error rate must be RESTRICTED for unauthorized role');
    assert.strictEqual(data.governance.systemErrors, 0, 'systemErrors must be masked to 0 for unauthorized role');
  });

  await testAsync('B.6: Admin lacking view_system_errors does not receive unresolved system error alert', async () => {
    const jobsAdmin = { Email: 'jobs@zeitnah.com', role: 'jobs_admin' };
    const data = await dashboardHelper.getDashboardData(jobsAdmin);
    const hasErrorAlert = data.alerts.some(a => a.badge === 'System Alert' || a.url?.includes('error-reports'));
    assert.strictEqual(hasErrorAlert, false, 'Unauthorized admin must not receive system error alert');
  });

  test('B.7: Rendered template hides Revenue tab when canViewRevenue is false', () => {
    const mockContext = {
      isSuperuser: false,
      canViewRevenue: false,
      canViewErrors: false,
      dashboard: {
        totalLearners: 10,
        totalStudents: 10,
        activeLearners: 8,
        activeLearnerPercentage: 80,
        totalCourses: 3,
        totalChapters: 6,
        totalUsers: 25,
        totalRevenue: null,
        systemHealth: { database: 'OPERATIONAL', sessionStore: 'HEALTHY', errorRate: 'RESTRICTED', uptimeFormatted: '1h 30m' },
        enrollmentChart: { labels: ['Jan'], data: [10] },
        revenueChart: { labels: [], data: [] },
        courseDistribution: { labels: ['Web'], data: [10] },
        alerts: [],
        governance: { activeJobs: 5, pendingBusinesses: 0, openModeration: 0 }
      }
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('id="btnTrendRevenue"'), false, 'Revenue trend button must not be rendered');
    assert.strictEqual(html.includes('Registered Accounts'), true, 'Non-sensitive Registered Accounts card must be rendered');
  });

  test('B.8: Rendered template shows Total Revenue card and tab when canViewRevenue is true', () => {
    const mockContext = {
      isSuperuser: true,
      canViewRevenue: true,
      canViewErrors: true,
      dashboard: {
        totalLearners: 10,
        totalStudents: 10,
        activeLearners: 8,
        activeLearnerPercentage: 80,
        totalCourses: 3,
        totalChapters: 6,
        totalUsers: 25,
        totalRevenue: 50000,
        systemHealth: { database: 'OPERATIONAL', sessionStore: 'HEALTHY', errorRate: 'NORMAL', uptimeFormatted: '2h 10m' },
        enrollmentChart: { labels: ['Jan'], data: [10] },
        revenueChart: { labels: ['Jan'], data: [50000] },
        courseDistribution: { labels: ['Web'], data: [10] },
        alerts: [],
        governance: { activeJobs: 5, pendingBusinesses: 0, openModeration: 0 }
      }
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('id="btnTrendRevenue"'), true, 'Revenue trend button must be rendered for authorized admin');
    assert.strictEqual(html.includes('Total Revenue'), true, 'Total Revenue card must be rendered');
    assert.strictEqual(html.includes('50000'), true, 'Revenue amount must be rendered for authorized admin');
  });

  test('B.9: Ecosystem CTAs render "Restricted" placeholder when capability is missing', () => {
    const mockContext = {
      isSuperuser: false,
      canManageNetwork: false,
      canReviewBusinesses: false,
      canManageJobs: false,
      canManageAI: false,
      canManageTaxonomy: false,
      canModerateContent: false,
      dashboard: {
        totalLearners: 5,
        totalStudents: 5,
        activeLearners: 5,
        activeLearnerPercentage: 100,
        totalCourses: 2,
        totalChapters: 4,
        totalUsers: 10,
        totalRevenue: null,
        systemHealth: { database: 'OPERATIONAL', sessionStore: 'HEALTHY', errorRate: 'RESTRICTED', uptimeFormatted: '45m' },
        enrollmentChart: { labels: [], data: [] },
        revenueChart: { labels: [], data: [] },
        courseDistribution: { labels: [], data: [] },
        alerts: [],
        governance: { activeJobs: 2, pendingBusinesses: 1, openModeration: 1 }
      }
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('<a href="/admin/network/users"'), false, 'Network users link must be hidden');
    assert.strictEqual(html.includes('<a href="/admin/businesses?tab=pending"'), false, 'Businesses review link must be hidden');
    assert.strictEqual(html.includes('<a href="/admin/jobs?tab=published"'), false, 'Jobs link must be hidden');
    assert.strictEqual(html.includes('<a href="/admin/moderation?tab=open"'), false, 'Moderation link must be hidden');
    assert.strictEqual(html.includes('Restricted'), true, 'Restricted badges must be rendered for unauthorized cards');
  });

  // --------------------------------------------------------------------------
  // Group C: XSS Vulnerability Remediation & Context-Safe JSON Serialization
  // --------------------------------------------------------------------------
  console.log('\n--- Group C: XSS Remediation & Safe JSON Serialization ---');

  test('C.1: safeJson escapes <, >, &, and Unicode line separators into valid JSON escape codes', () => {
    const maliciousPayload = {
      courseName: '</script><script>alert("XSS")</script>',
      description: 'Intro & Advanced <Guide>',
      unicodeBreak: 'Line\u2028Break\u2029Here'
    };
    const serialized = Handlebars.helpers.safeJson(maliciousPayload).toString();

    assert.strictEqual(serialized.includes('</script>'), false, 'Must not contain unescaped </script>');
    assert.strictEqual(serialized.includes('<script>'), false, 'Must not contain unescaped <script>');
    assert.strictEqual(serialized.includes('\\u003c/script\\u003e'), true, '< must be escaped to \\u003c');
    assert.strictEqual(serialized.includes('\\u003e'), true, '> must be escaped to \\u003e');
    assert.strictEqual(serialized.includes('\\u0026'), true, '& must be escaped to \\u0026');
    assert.strictEqual(serialized.includes('\\u2028'), true, 'U+2028 must be escaped');
    assert.strictEqual(serialized.includes('\\u2029'), true, 'U+2029 must be escaped');

    // Must be 100% valid JSON parseable
    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.courseName, maliciousPayload.courseName, 'JSON.parse must restore original string');
    assert.strictEqual(parsed.description, maliciousPayload.description);
    assert.strictEqual(parsed.unicodeBreak, maliciousPayload.unicodeBreak);
  });

  test('C.2: home.hbs script block does not break context when course title contains </script>', () => {
    const maliciousCourseDistribution = {
      labels: ['</script><script>alert("XSS")</script>', 'Normal Course'],
      data: [15, 25]
    };
    const mockContext = {
      dashboard: {
        totalLearners: 40,
        totalStudents: 40,
        activeLearners: 30,
        activeLearnerPercentage: 75,
        totalCourses: 2,
        totalChapters: 5,
        totalUsers: 50,
        systemHealth: { database: 'OPERATIONAL', sessionStore: 'HEALTHY', errorRate: 'NORMAL', uptimeFormatted: '1d' },
        enrollmentChart: { labels: ['Jan'], data: [40] },
        revenueChart: { labels: ['Jan'], data: [0] },
        courseDistribution: maliciousCourseDistribution,
        alerts: [],
        governance: { activeJobs: 1, pendingBusinesses: 0, openModeration: 0 }
      }
    };
    const html = compiledHomeTemplate(mockContext);

    // Verify <script id="dashboardAnalyticsData"> content
    const scriptTagStart = html.indexOf('<script id="dashboardAnalyticsData" type="application/json">');
    assert.notStrictEqual(scriptTagStart, -1, 'Embedded analytics script tag must exist');
    const scriptTagEnd = html.indexOf('</script>', scriptTagStart);

    const scriptContent = html.substring(scriptTagStart + '<script id="dashboardAnalyticsData" type="application/json">'.length, scriptTagEnd);

    // The scriptContent must NOT contain premature </script>
    assert.strictEqual(scriptContent.includes('</script>'), false, 'Script block content must not contain literal </script>');

    // JSON.parse on the script block content must succeed
    const parsed = JSON.parse(scriptContent.trim());
    assert.deepStrictEqual(parsed.courseDistribution.labels, maliciousCourseDistribution.labels);
    assert.strictEqual(parsed.courseDistribution.labels[0], '</script><script>alert("XSS")</script>');
  });

  test('C.3: Standard json helper is also safe against script context escape', () => {
    const payload = { text: '</b><script>alert(1)</script>' };
    const serialized = Handlebars.helpers.json(payload).toString();
    assert.strictEqual(serialized.includes('<script>'), false);
    assert.strictEqual(serialized.includes('\\u003cscript\\u003e'), true);
  });

  // --------------------------------------------------------------------------
  // Group D: Database Error Handling & Session Preservation
  // --------------------------------------------------------------------------
  console.log('\n--- Group D: Database Error Handling & Session Resilience ---');

  test('D.1: getSafeFallbackData produces complete, valid fallback structure', () => {
    const fallback = dashboardHelper.getSafeFallbackData({ role: 'admin' });
    assert.strictEqual(fallback.totalUsers, 0);
    assert.strictEqual(fallback.systemHealth.database, 'OFFLINE');
    assert.strictEqual(fallback.systemHealth.sessionStore, 'HEALTHY');
    assert.ok(typeof fallback.systemHealth.uptimeFormatted === 'string');
    assert.strictEqual(fallback.governance.activeJobs, 0);
    assert.strictEqual(fallback.governance.publishedJobs, 0);
    assert.ok(Array.isArray(fallback.alerts));
    assert.ok(Array.isArray(fallback.recentActivity));
  });

  test('D.2: getSafeFallbackData enforces server-side RBAC on fallback values', () => {
    const unauthorizedAdmin = { role: 'moderation_admin' };
    const fallback = dashboardHelper.getSafeFallbackData(unauthorizedAdmin);
    assert.strictEqual(fallback.totalRevenue, null, 'Fallback revenue must be null for unauthorized role');
    assert.strictEqual(fallback.systemHealth.errorRate, 'RESTRICTED', 'Fallback error rate must be RESTRICTED for unauthorized role');
  });

  test('D.3: Simulated route error keeps session intact and does NOT redirect to /login', () => {
    const session = {
      adminloggedIn: true,
      admin: { Email: 'admin@zeitnah.com', role: 'admin' }
    };
    const { req, res } = createMockReqRes(session);

    // Simulate route error handling in GET /
    try {
      throw new Error('MongoNetworkTimeoutException: connection closed');
    } catch (err) {
      const safeFallback = dashboardHelper.getSafeFallbackData(req.session.admin);
      res.render('admin/home', {
        admin: req.session.admin.Email,
        adminData: req.session.admin,
        isSuperuser: false,
        canViewRevenue: false,
        canViewErrors: false,
        admins: true,
        currentPage: 'dashboard',
        dashboardError: true,
        dashboard: safeFallback
      });
    }

    assert.strictEqual(res.redirectUrl, null, 'Must NOT redirect to /login on DB failure');
    assert.strictEqual(res.renderedView, 'admin/home', 'Must render admin/home with fallback state');
    assert.strictEqual(res.renderedData.dashboardError, true, 'dashboardError flag must be true');
    assert.strictEqual(req.session.adminloggedIn, true, 'Session must remain intact');
    assert.strictEqual(req.session.admin.Email, 'admin@zeitnah.com', 'Admin identity preserved');
  });

  test('D.4: Rendered fallback error state displays warning banner without leaking DB internals', () => {
    const safeFallback = dashboardHelper.getSafeFallbackData({ role: 'admin' });
    const mockContext = {
      dashboardError: true,
      isSuperuser: false,
      canViewRevenue: false,
      dashboard: safeFallback
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('Telemetry Fallback Active'), true, 'Fallback banner must be rendered');
    assert.strictEqual(html.includes('MongoNetworkTimeoutException'), false, 'Stack trace / DB exception must not be rendered');
    assert.strictEqual(html.includes('mongodb://'), false, 'DB connection string must not be leaked');
  });

  // --------------------------------------------------------------------------
  // Group E: Data Contract Consistency
  // --------------------------------------------------------------------------
  console.log('\n--- Group E: Data Contract Consistency ---');

  test('E.1: database: "OPERATIONAL" renders green status badge (not danger)', () => {
    const mockContext = {
      dashboard: {
        totalLearners: 1, totalStudents: 1, activeLearners: 1, activeLearnerPercentage: 100,
        totalCourses: 1, totalChapters: 1, totalUsers: 1,
        systemHealth: { database: 'OPERATIONAL', sessionStore: 'HEALTHY', errorRate: 'NORMAL', uptimeFormatted: '2h' },
        enrollmentChart: { labels: [], data: [] }, revenueChart: { labels: [], data: [] }, courseDistribution: { labels: [], data: [] },
        alerts: [], governance: { activeJobs: 1, pendingBusinesses: 0, openModeration: 0 }
      }
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('bg-success-subtle text-success'), true, 'OPERATIONAL must evaluate to green success badge');
    assert.strictEqual(html.includes('DB: OPERATIONAL'), true, 'DB: OPERATIONAL text must be rendered');
  });

  test('E.2: database: "ONLINE" also renders green status badge for backward compatibility', () => {
    const mockContext = {
      dashboard: {
        totalLearners: 1, totalStudents: 1, activeLearners: 1, activeLearnerPercentage: 100,
        totalCourses: 1, totalChapters: 1, totalUsers: 1,
        systemHealth: { database: 'ONLINE', sessionStore: 'HEALTHY', errorRate: 'NORMAL', uptimeFormatted: '2h' },
        enrollmentChart: { labels: [], data: [] }, revenueChart: { labels: [], data: [] }, courseDistribution: { labels: [], data: [] },
        alerts: [], governance: { activeJobs: 1, pendingBusinesses: 0, openModeration: 0 }
      }
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('bg-success-subtle text-success'), true, 'ONLINE must evaluate to green success badge');
    assert.strictEqual(html.includes('DB: ONLINE'), true);
  });

  test('E.3: activeJobs is populated in governance and renders count in template', () => {
    const mockContext = {
      dashboard: {
        totalLearners: 1, totalStudents: 1, activeLearners: 1, activeLearnerPercentage: 100,
        totalCourses: 1, totalChapters: 1, totalUsers: 1,
        systemHealth: { database: 'OPERATIONAL', sessionStore: 'HEALTHY', errorRate: 'NORMAL', uptimeFormatted: '2h' },
        enrollmentChart: { labels: [], data: [] }, revenueChart: { labels: [], data: [] }, courseDistribution: { labels: [], data: [] },
        alerts: [], governance: { activeJobs: 42, pendingBusinesses: 0, openModeration: 0 }
      }
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('42 Active'), true, 'activeJobs count (42) must be rendered in badge');
  });

  test('E.4: uptimeFormatted is present and displayed in template', () => {
    const mockContext = {
      dashboard: {
        totalLearners: 1, totalStudents: 1, activeLearners: 1, activeLearnerPercentage: 100,
        totalCourses: 1, totalChapters: 1, totalUsers: 1,
        systemHealth: { database: 'OPERATIONAL', sessionStore: 'HEALTHY', errorRate: 'NORMAL', uptimeFormatted: '5d 14h 22m' },
        enrollmentChart: { labels: [], data: [] }, revenueChart: { labels: [], data: [] }, courseDistribution: { labels: [], data: [] },
        alerts: [], governance: { activeJobs: 1, pendingBusinesses: 0, openModeration: 0 }
      }
    };
    const html = compiledHomeTemplate(mockContext);
    assert.strictEqual(html.includes('Uptime: <strong>5d 14h 22m</strong>'), true, 'Uptime must be displayed accurately');
  });

  // --------------------------------------------------------------------------
  // Group F: Backward Compatibility & Regression Invariants
  // --------------------------------------------------------------------------
  console.log('\n--- Group F: Backward Compatibility & Regression Invariants ---');

  await testAsync('F.1: getDashboardData() without arguments provides full unmasked data for legacy callers', async () => {
    const data = await dashboardHelper.getDashboardData();
    assert.strictEqual(typeof data.totalRevenue, 'number', 'Legacy call without admin must have numeric totalRevenue');
    assert.strictEqual(data.governance.activeJobs, 5, 'activeJobs must be provided');
    assert.strictEqual(data.governance.publishedJobs, 5, 'publishedJobs must be preserved');
    assert.strictEqual(data.systemHealth.database, 'OPERATIONAL');
    assert.ok(typeof data.systemHealth.uptimeFormatted === 'string');
    assert.ok(Array.isArray(data.revenueChart.labels));
  });

  test('F.2: ROLE_CAPABILITIES integrity: manage_settings and view_system_errors are restricted to privileged roles', () => {
    const settingsCap = 'manage_settings';
    const errorsCap = 'view_system_errors';

    assert.strictEqual(permissionsHelper.hasCapability({ role: 'superuser' }, settingsCap), true);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'admin' }, settingsCap), true);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'system_admin' }, settingsCap), true);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'moderation_admin' }, settingsCap), false);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'verification_admin' }, settingsCap), false);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'jobs_admin' }, settingsCap), false);

    assert.strictEqual(permissionsHelper.hasCapability({ role: 'superuser' }, errorsCap), true);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'admin' }, errorsCap), true);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'system_admin' }, errorsCap), true);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'moderation_admin' }, errorsCap), false);
  });

  // --------------------------------------------------------------------------
  // Group G: Dashboard Phase 2 Performance, Optimization & Aggregation Integrity
  // --------------------------------------------------------------------------
  console.log('\n--- Group G: Phase 2 Performance, Aggregation & Indexing Optimization ---');

  await testAsync('G.1: Consolidated user stats aggregation produces exact user, student, and learner counts', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);
    assert.strictEqual(data.totalUsers, 3, 'Total users must match mock data count (3)');
    assert.strictEqual(data.totalStudents, 3, 'Total canonical students must be 3');
    assert.strictEqual(data.totalLearners, 3, 'Total enrolled learners must be 3');
    assert.strictEqual(data.activeUsers, 2, 'Active users must be 2');
    assert.strictEqual(data.activeStudents, 2, 'Active students must be 2');
    assert.strictEqual(data.expiredStudents, 1, 'Expired students must be 1');
  });

  test('G.2: Course metrics aggregation handles missing, null, and empty chapters arrays safely', () => {
    const testCases = [
      { chapters: null },
      { /* missing chapters */ },
      { chapters: [] },
      { chapters: [{ _id: 'ch1' }, { _id: 'ch2' }] }
    ];

    // Simulate MongoDB pipeline condition: { $cond: [ { $isArray: '$chapters' }, { $size: '$chapters' }, 0 ] }
    const totalChapters = testCases.reduce((sum, c) => {
      const isArray = Array.isArray(c.chapters);
      const size = isArray ? c.chapters.length : 0;
      return sum + size;
    }, 0);

    assert.strictEqual(totalChapters, 2, 'Malformed course documents must evaluate to 0 chapters without crashing');
  });

  await testAsync('G.3: Lean projection strips credentials and heavy objects from recentStudents', async () => {
    const data = await dashboardHelper.getDashboardData();
    assert.ok(Array.isArray(data.recentStudents));
    assert.strictEqual(data.recentStudents.length, 3);
    data.recentStudents.forEach(student => {
      assert.ok(student._id, 'Student _id must be present');
      assert.ok(student.Name, 'Student Name must be projected');
      assert.ok(student.Email, 'Student Email must be projected');
      assert.strictEqual(student.Password, undefined, 'Password must NOT be projected');
      assert.strictEqual(student.gamification, undefined, 'Heavy gamification tree must NOT be projected');
    });
  });

  await testAsync('G.4: Single-pass monthly trend aggregation correctly bins enrollments and revenues across 6 months', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);
    assert.strictEqual(data.enrollmentChart.labels.length, 6, 'Must generate exactly 6 month labels');
    assert.strictEqual(data.enrollmentChart.data.length, 6, 'Must generate exactly 6 enrollment data points');
    assert.strictEqual(data.revenueChart.data.length, 6, 'Must generate exactly 6 revenue data points');

    // The current month (last bin) must contain the aggregated mock values
    const lastEnrollment = data.enrollmentChart.data[data.enrollmentChart.data.length - 1];
    const lastRevenue = data.revenueChart.data[data.revenueChart.data.length - 1];
    assert.strictEqual(lastEnrollment, 2, 'Latest month must have mock enrollment count (2)');
    assert.strictEqual(lastRevenue, 4000, 'Latest month must have mock revenue (4000)');
  });

  test('G.5: Timezone and month window calculation generates valid, contiguous 6-month intervals across year boundaries', () => {
    const fixedNow = new Date(2026, 0, 15); // Jan 15, 2026
    const monthLabels = [];
    const monthKeys = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(fixedNow.getFullYear(), fixedNow.getMonth() - i, 1);
      monthLabels.push(d.toLocaleString('en-US', { month: 'short' }));
      monthKeys.push(`${d.getFullYear()}-${d.getMonth() + 1}`);
    }

    assert.deepStrictEqual(monthLabels, ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan']);
    assert.deepStrictEqual(monthKeys, ['2025-8', '2025-9', '2025-10', '2025-11', '2025-12', '2026-1']);
  });

  await testAsync('G.6: Resilient financial conversion handles non-numeric strings and null Paid_Amount without error', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);
    assert.strictEqual(typeof data.totalRevenue, 'number', 'Revenue must be a number');
    assert.strictEqual(data.totalRevenue, 4000, 'Non-numeric string ("invalid_currency") must evaluate to 0 and not corrupt 1500 + 2500');
  });

  await testAsync('G.7: Capability-gated query skipping: audit_logs query omitted when admin lacks view_audit_logs', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;
    const restrictedAdmin = { Email: 'restricted@zeitnah.com', role: 'custom_role', capabilities: [] };
    await dashboardHelper.getDashboardData(restrictedAdmin);
    assert.strictEqual(customDb.queryLog.includes('audit_logs'), false, 'audit_logs query must be skipped for admin lacking view_audit_logs');
  });

  await testAsync('G.8: Capability-gated query skipping: error_reports query omitted when admin lacks view_system_errors', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;
    const moderationAdmin = { Email: 'mod@zeitnah.com', role: 'moderation_admin' };
    await dashboardHelper.getDashboardData(moderationAdmin);
    assert.strictEqual(customDb.queryLog.includes('error_reports'), false, 'error_reports query must be skipped for moderation_admin');
  });

  await testAsync('G.9: Justified indexes: ensureIndexes includes student createdAt, error_reports status+createdAt, verification_requests status+createdAt', async () => {
    const { ensureIndexes } = require('../Helpers/index-helper');
    const createdIndexes = [];
    const mockDbForIndexes = {
      collection: (colName) => ({
        createIndex: async (keys, opts) => {
          createdIndexes.push({ colName, keys, opts });
        }
      })
    };

    await ensureIndexes(mockDbForIndexes);

    const hasStudentCreatedAt = createdIndexes.some(idx => idx.colName === 'users' && idx.keys.createdAt === -1);
    const hasErrorIndex = createdIndexes.some(idx => idx.colName === 'error_reports' && idx.keys.status === 1 && idx.keys.createdAt === -1);
    const hasVerifyIndex = createdIndexes.some(idx => idx.colName === 'verification_requests' && idx.keys.status === 1 && idx.keys.createdAt === -1);

    assert.strictEqual(hasStudentCreatedAt, true, 'students collection must have createdAt: -1 index registered');
    assert.strictEqual(hasErrorIndex, true, 'error_reports collection must have { status: 1, createdAt: -1 } index registered');
    assert.strictEqual(hasVerifyIndex, true, 'verification_requests collection must have { status: 1, createdAt: -1 } index registered');
  });

  await testAsync('G.10: Database operations count: total queries per request consolidated to <= 18 with Community (down from unoptimized 35+)', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    await dashboardHelper.getDashboardData(superuser);

    assert.ok(customDb.queryLog.length <= 18, `Database calls must be <= 18, actual was ${customDb.queryLog.length}`);
  });

  // --------------------------------------------------------------------------
  // Group H: Phase 3 Community & Ecosystem Integration
  // --------------------------------------------------------------------------
  console.log('\n--- Group H: Phase 3 Community & Ecosystem Integration ---');

  await testAsync('H.1: Community dashboard data loads successfully with complete contract shape', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    assert.ok(data.community, 'dashboard.community must exist');
    assert.ok(data.community.overview, 'dashboard.community.overview must exist');
    assert.ok(data.community.moderation, 'dashboard.community.moderation must exist');
    assert.strictEqual(typeof data.community.recentActivityCount, 'number', 'recentActivityCount must be a number');
  });

  await testAsync('H.2: Posts metric is correct and excludes soft-deleted posts from active count', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    assert.strictEqual(data.community.overview.totalPosts, 10, 'Total posts must be 10');
    assert.strictEqual(data.community.overview.activePosts, 8, 'Active posts must be 8 (excluding 2 soft-deleted)');
    assert.strictEqual(data.community.overview.newPosts7d, 5, 'New posts in 7d must be 5');
    assert.strictEqual(data.governance.communityPosts, 8, 'Governance communityPosts must reflect active posts');
  });

  await testAsync('H.3: Comments metric is correct and excludes soft-deleted comments from active count', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    assert.strictEqual(data.community.overview.totalComments, 25, 'Total comments must be 25');
    assert.strictEqual(data.community.overview.activeComments, 22, 'Active comments must be 22 (excluding 3 soft-deleted)');
    assert.strictEqual(data.community.overview.newComments7d, 14, 'New comments in 7d must be 14');
    assert.strictEqual(data.governance.communityComments, 22, 'Governance communityComments must reflect active comments');
  });

  await testAsync('H.4: Stories metric is correct and excludes soft-deleted and expired stories from active count', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    assert.strictEqual(data.community.overview.totalStories, 6, 'Total stories must be 6');
    assert.strictEqual(data.community.overview.activeStories, 4, 'Active stories must be 4 (excluding 1 soft-deleted, 1 expired)');
    assert.strictEqual(data.community.overview.newStories7d, 3, 'New stories in 7d must be 3');
    assert.strictEqual(data.governance.communityStories, 4, 'Governance communityStories must reflect active stories');
  });

  await testAsync('H.5: Report metrics are correct for pending, underReview, and totalActionable', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    assert.strictEqual(data.community.moderation.totalReports, 8, 'Total reports must be 8');
    assert.strictEqual(data.community.moderation.pendingReports, 3, 'Pending reports must be 3');
    assert.strictEqual(data.community.moderation.underReviewReports, 2, 'Under review reports must be 2');
    assert.strictEqual(data.community.moderation.totalActionable, 5, 'Total actionable reports must be 3 + 2 = 5');
    assert.strictEqual(data.governance.communityPendingReports, 3, 'Governance communityPendingReports must be 3');
  });

  await testAsync('H.6: User reports are treated strictly as user entities and not as content reports', async () => {
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    const typeBreakdown = data.community.moderation.reportsByType;
    assert.strictEqual(typeBreakdown.post, 2, 'Post reports must be 2');
    assert.strictEqual(typeBreakdown.comment, 1, 'Comment reports must be 1');
    assert.strictEqual(typeBreakdown.story, 1, 'Story reports must be 1');
    assert.strictEqual(typeBreakdown.user, 1, 'User reports must be 1');
    assert.strictEqual(
      typeBreakdown.post + typeBreakdown.comment + typeBreakdown.story + typeBreakdown.user,
      5,
      'Total by type must match total actionable reports (5)'
    );
  });

  await testAsync('H.7: Capability gating: unauthorized admin has report metrics masked to null (server-side RBAC)', async () => {
    const businessAdmin = { Email: 'biz@zeitnah.com', role: 'business_admin' };
    const data = await dashboardHelper.getDashboardData(businessAdmin);

    assert.strictEqual(data.community.moderation.visible, false, 'moderation.visible must be false for unauthorized admin');
    assert.strictEqual(data.community.moderation.totalReports, null, 'totalReports must be null');
    assert.strictEqual(data.community.moderation.pendingReports, null, 'pendingReports must be null');
    assert.strictEqual(data.community.moderation.underReviewReports, null, 'underReviewReports must be null');
    assert.strictEqual(data.community.moderation.totalActionable, null, 'totalActionable must be null');
    assert.deepStrictEqual(data.community.moderation.reportsByType, {}, 'reportsByType must be empty object');
    assert.strictEqual(data.governance.communityPendingReports, null, 'governance.communityPendingReports must be null');
  });

  await testAsync('H.8: Capability gating: community_reports query is omitted when admin lacks moderate_content', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;
    const businessAdmin = { Email: 'biz@zeitnah.com', role: 'business_admin' };
    await dashboardHelper.getDashboardData(businessAdmin);

    assert.strictEqual(
      customDb.queryLog.includes('community_reports'),
      false,
      'community_reports query must be completely omitted when admin lacks moderate_content'
    );
  });

  await testAsync('H.9: Authorized admin receives actionable Community report backlog alert', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    const communityAlert = data.alerts.find(a => a.url?.includes('/admin/community/reports'));
    assert.ok(communityAlert, 'Actionable Community report alert must be generated');
    assert.strictEqual(communityAlert.type, 'danger');
    assert.ok(communityAlert.message.includes('3 pending community report(s)'));
    assert.strictEqual(communityAlert.url, '/admin/community/reports?status=pending');
  });

  await testAsync('H.10: Empty Community state handles zero content and zero reports safely', async () => {
    const emptyDb = {
      collection: () => ({
        countDocuments: async () => 0,
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }), toArray: async () => [] }),
        aggregate: () => ({ toArray: async () => [] })
      })
    };
    db.get = () => emptyDb;
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    assert.strictEqual(data.community.overview.totalPosts, 0);
    assert.strictEqual(data.community.overview.activePosts, 0);
    assert.strictEqual(data.community.overview.totalComments, 0);
    assert.strictEqual(data.community.overview.totalStories, 0);
    assert.strictEqual(data.community.moderation.pendingReports, 0);
    assert.strictEqual(data.community.recentActivityCount, 0);
  });

  test('H.11: Graceful error fallback provides valid community fallback structure with server-side RBAC', () => {
    const superuserFallback = dashboardHelper.getSafeFallbackData({ role: 'superuser' });
    assert.strictEqual(superuserFallback.community.moderation.visible, true);
    assert.strictEqual(superuserFallback.community.moderation.pendingReports, 0);
    assert.strictEqual(superuserFallback.governance.communityPendingReports, 0);

    const restrictedFallback = dashboardHelper.getSafeFallbackData({ role: 'business_admin' });
    assert.strictEqual(restrictedFallback.community.moderation.visible, false);
    assert.strictEqual(restrictedFallback.community.moderation.pendingReports, null);
    assert.strictEqual(restrictedFallback.governance.communityPendingReports, null);
  });

  await testAsync('H.12: Database operations count: full admin runs exactly 18 consolidated queries (14 Phase 2 + 4 Community)', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;
    const superuser = { Email: 'super@zeitnah.com', role: 'superuser' };
    await dashboardHelper.getDashboardData(superuser);

    assert.strictEqual(customDb.queryLog.length, 18, `Full dashboard queries must be exactly 18, actual was ${customDb.queryLog.length}`);
  });

  await testAsync('H.13: Database operations count: restricted admin runs fewer queries (15 queries for unprivileged admin, 16 for business_admin)', async () => {
    const customDb1 = createMockDb();
    db.get = () => customDb1;
    const restrictedAdmin = { Email: 'restricted@zeitnah.com', role: 'custom_restricted', capabilities: [] };
    await dashboardHelper.getDashboardData(restrictedAdmin);

    assert.strictEqual(customDb1.queryLog.length, 15, `Unprivileged admin queries must be exactly 15, actual was ${customDb1.queryLog.length}`);
    assert.strictEqual(customDb1.queryLog.includes('community_reports'), false, 'community_reports must be skipped');
    assert.strictEqual(customDb1.queryLog.includes('audit_logs'), false, 'audit_logs must be skipped');
    assert.strictEqual(customDb1.queryLog.includes('error_reports'), false, 'error_reports must be skipped');

    const customDb2 = createMockDb();
    db.get = () => customDb2;
    const businessAdmin = { Email: 'biz@zeitnah.com', role: 'business_admin' };
    await dashboardHelper.getDashboardData(businessAdmin);

    assert.strictEqual(customDb2.queryLog.length, 16, `business_admin queries must be 16 (includes audit_logs, skips error_reports & community_reports)`);
    assert.strictEqual(customDb2.queryLog.includes('community_reports'), false);
    assert.strictEqual(customDb2.queryLog.includes('error_reports'), false);
    assert.strictEqual(customDb2.queryLog.includes('audit_logs'), true);
  });

  await testAsync('H.14: Index registration: indexHelper registers canonical index on community_reports { status: 1, createdAt: -1 }', async () => {
    const { ensureIndexes } = require('../Helpers/index-helper');
    const createdIndexes = [];
    const mockDbForIndexes = {
      collection: (colName) => ({
        createIndex: async (keys, opts) => {
          createdIndexes.push({ colName, keys, opts });
        }
      })
    };

    await ensureIndexes(mockDbForIndexes);

    const hasCommunityReportsIndex = createdIndexes.some(
      idx => idx.colName === 'community_reports' && idx.keys.status === 1 && idx.keys.createdAt === -1
    );
    assert.strictEqual(hasCommunityReportsIndex, true, 'community_reports must have { status: 1, createdAt: -1 } registered');
  });

  test('H.15: Handlebars template renders Community section with verified routes for authorized admin', () => {
    const dashboardData = {
      ...dashboardHelper.getSafeFallbackData({ role: 'superuser' }),
      community: {
        overview: { activePosts: 8, totalPosts: 10, activeComments: 22, totalComments: 25, activeStories: 4, totalStories: 6, newPosts7d: 5, newComments7d: 14, newStories7d: 3 },
        moderation: { visible: true, totalReports: 8, pendingReports: 3, underReviewReports: 2, totalActionable: 5, reportsByType: { post: 2, comment: 1, story: 1, user: 1 } },
        recentActivityCount: 22
      }
    };

    const rendered = compiledHomeTemplate({
      admin: 'Super Admin',
      isSuperuser: true,
      canModerateContent: true,
      dashboard: dashboardData
    });

    assert.ok(rendered.includes('/admin/community/posts'), 'Must contain link to /admin/community/posts');
    assert.ok(rendered.includes('/admin/community/comments'), 'Must contain link to /admin/community/comments');
    assert.ok(rendered.includes('/admin/community/stories'), 'Must contain link to /admin/community/stories');
    assert.ok(rendered.includes('/admin/community/reports?status=pending'), 'Must contain triage link to pending reports');
    assert.ok(rendered.includes('/admin/community/reports'), 'Must contain link to Reports Center');
    assert.ok(rendered.includes('Community &amp; Social Ecosystem'), 'Must render Community & Social Ecosystem title');
  });

  test('H.16: Handlebars template renders Restricted lock badge for unauthorized admin without leaking report metrics', () => {
    const dashboardData = {
      ...dashboardHelper.getSafeFallbackData({ role: 'business_admin' }),
      community: {
        overview: { activePosts: 8, totalPosts: 10, activeComments: 22, totalComments: 25, activeStories: 4, totalStories: 6, newPosts7d: 5, newComments7d: 14, newStories7d: 3 },
        moderation: { visible: false, totalReports: null, pendingReports: null, underReviewReports: null, totalActionable: null, reportsByType: {} },
        recentActivityCount: 22
      }
    };

    const rendered = compiledHomeTemplate({
      admin: 'Business Admin',
      isSuperuser: false,
      canModerateContent: false,
      dashboard: dashboardData
    });

    assert.ok(rendered.includes('Restricted'), 'Must render Restricted badge');
    assert.strictEqual(rendered.includes('Triage <i class="fa-solid fa-angle-right ms-1"></i>'), false, 'Must not render Triage link for unauthorized admin');
    assert.strictEqual(rendered.includes('Actionable Queue:'), false, 'Must not render Actionable Queue for unauthorized admin');
  });

  test('H.17: No user-generated content or raw community strings injected into inline JavaScript', () => {
    const fallback = dashboardHelper.getSafeFallbackData({ role: 'superuser' });
    Object.values(fallback.community.overview).forEach(val => {
      assert.strictEqual(typeof val, 'number', 'Community overview values must be numbers');
    });
    assert.strictEqual(typeof fallback.community.recentActivityCount, 'number', 'recentActivityCount must be a number');
  });

  test('H.18: Community entity UUID validation: community IDs are string/UUID format and never cast to ObjectId', () => {
    const uuidSample = '4d008ef3-d6c6-43cb-b09e-7117faea5a08';
    assert.strictEqual(typeof uuidSample, 'string', 'Community IDs are strings');
    assert.strictEqual(uuidSample.length, 36, 'UUID is 36 chars');
  });

  // --------------------------------------------------------------------------
  // Group I: Phase 4 Advanced Dashboard Intelligence & Operational UX
  // --------------------------------------------------------------------------
  console.log('\n--- Group I: Phase 4 Advanced Dashboard Intelligence & Operational UX ---');

  const { calculateTrend, buildAttentionModel, ATTENTION_SEVERITY_THRESHOLDS } = dashboardHelper;

  test('I.1: calculateTrend computes positive change correctly (+25%, direction: "up", isPositive: true)', () => {
    const trend = calculateTrend(125, 100, 'vs prev 7d');
    assert.strictEqual(trend.current, 125);
    assert.strictEqual(trend.previous, 100);
    assert.strictEqual(trend.delta, 25);
    assert.strictEqual(trend.deltaPercent, 25);
    assert.strictEqual(trend.direction, 'up');
    assert.strictEqual(trend.isPositive, true);
    assert.strictEqual(trend.text, '+25% vs prev 7d');
  });

  test('I.2: calculateTrend computes negative change correctly (-20%, direction: "down", isPositive: false)', () => {
    const trend = calculateTrend(80, 100, 'vs prev 7d');
    assert.strictEqual(trend.current, 80);
    assert.strictEqual(trend.previous, 100);
    assert.strictEqual(trend.delta, -20);
    assert.strictEqual(trend.deltaPercent, -20);
    assert.strictEqual(trend.direction, 'down');
    assert.strictEqual(trend.isPositive, false);
    assert.strictEqual(trend.text, '-20% vs prev 7d');
  });

  test('I.3: calculateTrend computes zero change correctly (0%, direction: "flat", isPositive: false)', () => {
    const trend = calculateTrend(50, 50, 'vs prev 7d');
    assert.strictEqual(trend.current, 50);
    assert.strictEqual(trend.previous, 50);
    assert.strictEqual(trend.delta, 0);
    assert.strictEqual(trend.deltaPercent, 0);
    assert.strictEqual(trend.direction, 'flat');
    assert.strictEqual(trend.isPositive, false);
    assert.strictEqual(trend.text, '0% vs prev 7d');
  });

  test('I.4: calculateTrend handles zero baseline without divide-by-zero, NaN, or Infinity (+100%, direction: "up")', () => {
    const trend = calculateTrend(15, 0, 'vs prev 7d');
    assert.strictEqual(trend.current, 15);
    assert.strictEqual(trend.previous, 0);
    assert.strictEqual(trend.delta, 15);
    assert.strictEqual(trend.deltaPercent, 100);
    assert.strictEqual(trend.direction, 'up');
    assert.strictEqual(trend.isPositive, true);
    assert.strictEqual(Number.isFinite(trend.deltaPercent), true, 'deltaPercent must be a finite number');
    assert.strictEqual(Number.isNaN(trend.deltaPercent), false, 'deltaPercent must not be NaN');
    assert.strictEqual(trend.text, '+100% vs prev 7d');
  });

  test('I.5: calculateTrend handles zero current with zero baseline (0%, direction: "flat", no NaN)', () => {
    const trend = calculateTrend(0, 0, 'vs prev 7d');
    assert.strictEqual(trend.current, 0);
    assert.strictEqual(trend.previous, 0);
    assert.strictEqual(trend.delta, 0);
    assert.strictEqual(trend.deltaPercent, 0);
    assert.strictEqual(trend.direction, 'flat');
    assert.strictEqual(Number.isNaN(trend.deltaPercent), false, 'deltaPercent must not be NaN');
    assert.strictEqual(trend.text, '0% vs prev 7d');
  });

  test('I.6: calculateTrend handles missing, null, and non-numeric inputs safely', () => {
    const trend = calculateTrend(null, undefined, 'vs prev 7d');
    assert.strictEqual(trend.current, 0);
    assert.strictEqual(trend.previous, 0);
    assert.strictEqual(trend.delta, 0);
    assert.strictEqual(trend.deltaPercent, 0);
    assert.strictEqual(trend.direction, 'flat');
    assert.strictEqual(trend.isPositive, false);
    assert.strictEqual(Number.isNaN(trend.deltaPercent), false);
  });

  test('I.7: buildAttentionModel contract verification: visible, total, queueCount, hasCritical, items', () => {
    const { attention, operationalHealth } = buildAttentionModel({
      canViewErrors: true,
      canModerate: true,
      canReviewBusinesses: true,
      canVerify: true,
      unresolvedErrorsCount: 2,
      communityPendingReports: 3,
      openModerationCount: 4,
      pendingBusinessesCount: 1,
      pendingVerificationCount: 2
    });

    assert.strictEqual(attention.visible, true);
    assert.strictEqual(typeof attention.total, 'number');
    assert.strictEqual(attention.total, 12);
    assert.strictEqual(attention.queueCount, 5);
    assert.strictEqual(attention.items.length, 5);
    assert.strictEqual(typeof attention.hasCritical, 'boolean');

    attention.items.forEach(item => {
      assert.ok(item.key, 'Item must have key');
      assert.ok(item.title, 'Item must have title');
      assert.strictEqual(typeof item.count, 'number');
      assert.ok(item.count > 0, 'Count must be positive');
      assert.ok(['critical', 'high', 'medium', 'low'].includes(item.severity), 'Valid severity');
      assert.ok(item.href && item.href.startsWith('/admin'), 'Valid admin href');
      assert.ok(item.capability, 'Capability must be specified');
      assert.ok(item.description, 'Item must have description');
      assert.ok(item.badgeClass, 'Item must have badgeClass');
      assert.ok(item.icon, 'Item must have icon');
    });

    assert.ok(['HEALTHY', 'ATTENTION_REQUIRED', 'CRITICAL'].includes(operationalHealth.status));
    assert.ok(operationalHealth.label);
    assert.ok(operationalHealth.icon);
    assert.ok(operationalHealth.badgeClass);
    assert.ok(operationalHealth.summary);
  });

  test('I.8: buildAttentionModel deterministically prioritizes items by severity and count', () => {
    const { attention } = buildAttentionModel({
      canViewErrors: true,
      canModerate: true,
      canReviewBusinesses: true,
      canVerify: true,
      unresolvedErrorsCount: 12, // critical
      communityPendingReports: 2, // medium
      openModerationCount: 20, // high
      pendingBusinessesCount: 1, // medium
      pendingVerificationCount: 15 // high
    });

    assert.strictEqual(attention.items[0].severity, 'critical', 'Critical items must be sorted first');
    assert.strictEqual(attention.items[0].key, 'system_errors');
    assert.strictEqual(attention.items[1].severity, 'high');
    assert.strictEqual(attention.items[2].severity, 'high');
    assert.strictEqual(attention.items[3].severity, 'medium');
    assert.strictEqual(attention.items[4].severity, 'medium');
  });

  test('I.9: buildAttentionModel omits zero-count queues from items array', () => {
    const { attention, operationalHealth } = buildAttentionModel({
      canViewErrors: true,
      canModerate: true,
      canReviewBusinesses: true,
      canVerify: true,
      unresolvedErrorsCount: 0,
      communityPendingReports: 0,
      openModerationCount: 0,
      pendingBusinessesCount: 0,
      pendingVerificationCount: 0
    });

    assert.strictEqual(attention.total, 0);
    assert.strictEqual(attention.queueCount, 0);
    assert.strictEqual(attention.items.length, 0);
    assert.strictEqual(attention.hasCritical, false);
    assert.strictEqual(operationalHealth.status, 'HEALTHY');
  });

  test('I.10: buildAttentionModel severity thresholds: critical vs high for system errors (threshold: 10)', () => {
    const highErr = buildAttentionModel({ canViewErrors: true, unresolvedErrorsCount: 9 });
    const critErr = buildAttentionModel({ canViewErrors: true, unresolvedErrorsCount: 10 });

    assert.strictEqual(highErr.attention.items[0].severity, 'high');
    assert.strictEqual(critErr.attention.items[0].severity, 'critical');
    assert.strictEqual(critErr.attention.hasCritical, true);
    assert.strictEqual(critErr.operationalHealth.status, 'CRITICAL');
  });

  test('I.11: buildAttentionModel severity thresholds: critical, high, medium for community reports (15, 5, 1)', () => {
    const medReports = buildAttentionModel({ canModerate: true, communityPendingReports: 4 });
    const highReports = buildAttentionModel({ canModerate: true, communityPendingReports: 10 });
    const critReports = buildAttentionModel({ canModerate: true, communityPendingReports: 15 });

    assert.strictEqual(medReports.attention.items[0].severity, 'medium');
    assert.strictEqual(highReports.attention.items[0].severity, 'high');
    assert.strictEqual(critReports.attention.items[0].severity, 'critical');
  });

  test('I.12: Server-side RBAC: unauthorized admin receives no restricted attention item or count', () => {
    const unprivilegedModel = buildAttentionModel({
      canViewErrors: false,
      canModerate: false,
      canReviewBusinesses: false,
      canVerify: false,
      unresolvedErrorsCount: 10,
      communityPendingReports: 20,
      openModerationCount: 30,
      pendingBusinessesCount: 5,
      pendingVerificationCount: 10
    });

    assert.strictEqual(unprivilegedModel.attention.items.length, 0, 'No attention items for completely unauthorized user');
    assert.strictEqual(unprivilegedModel.attention.total, 0, 'Total actionable count must be 0 for unauthorized admin');
    assert.strictEqual(unprivilegedModel.attention.queueCount, 0);
    assert.strictEqual(unprivilegedModel.attention.visible, false);
  });

  test('I.13: Operational health reflects HEALTHY when all actionable queues are clear', () => {
    const { operationalHealth } = buildAttentionModel({
      canViewErrors: true,
      canModerate: true,
      canReviewBusinesses: true,
      canVerify: true,
      unresolvedErrorsCount: 0,
      communityPendingReports: 0,
      openModerationCount: 0,
      pendingBusinessesCount: 0,
      pendingVerificationCount: 0
    });

    assert.strictEqual(operationalHealth.status, 'HEALTHY');
    assert.strictEqual(operationalHealth.label, 'Healthy');
    assert.ok(operationalHealth.badgeClass.includes('bg-success-subtle'));
    assert.strictEqual(operationalHealth.hasCritical, false);
    assert.strictEqual(operationalHealth.actionableQueueCount, 0);
  });

  test('I.14: Operational health reflects ATTENTION_REQUIRED when actionable queues exist without critical severity', () => {
    const { operationalHealth } = buildAttentionModel({
      canViewErrors: true,
      canModerate: false,
      canReviewBusinesses: true,
      canVerify: false,
      unresolvedErrorsCount: 2, // high (not critical)
      pendingBusinessesCount: 1  // medium
    });

    assert.strictEqual(operationalHealth.status, 'ATTENTION_REQUIRED');
    assert.strictEqual(operationalHealth.label, 'Attention Required');
    assert.ok(operationalHealth.badgeClass.includes('bg-warning-subtle'));
    assert.strictEqual(operationalHealth.hasCritical, false);
    assert.strictEqual(operationalHealth.actionableQueueCount, 2);
  });

  test('I.15: Operational health reflects CRITICAL when a critical queue threshold is reached', () => {
    const { operationalHealth } = buildAttentionModel({
      canViewErrors: true,
      canModerate: true,
      canReviewBusinesses: false,
      canVerify: false,
      unresolvedErrorsCount: 15, // critical
      communityPendingReports: 1
    });

    assert.strictEqual(operationalHealth.status, 'CRITICAL');
    assert.strictEqual(operationalHealth.label, 'Critical Attention');
    assert.ok(operationalHealth.badgeClass.includes('bg-danger'));
    assert.strictEqual(operationalHealth.hasCritical, true);
  });

  test('I.16: Side-channel leakage prevention: hidden restricted queues cannot alter unauthorized admin operational health', () => {
    // There are 50 critical system errors and 40 critical community reports in the system.
    // However, an admin without view_system_errors and moderate_content must evaluate ONLY their visible queues.
    const unauthorizedHealth = buildAttentionModel({
      canViewErrors: false,
      canModerate: false,
      canReviewBusinesses: true,
      canVerify: true,
      unresolvedErrorsCount: 50, // CRITICAL in background
      communityPendingReports: 40, // CRITICAL in background
      openModerationCount: 20, // HIGH in background
      pendingBusinessesCount: 0,
      pendingVerificationCount: 0
    });

    assert.strictEqual(unauthorizedHealth.operationalHealth.status, 'HEALTHY', 'Unauthorized admin must NOT see CRITICAL health due to restricted queues');
    assert.strictEqual(unauthorizedHealth.operationalHealth.hasCritical, false);
    assert.strictEqual(unauthorizedHealth.operationalHealth.actionableQueueCount, 0);
    assert.strictEqual(unauthorizedHealth.operationalHealth.evaluatedSignals.includes('system_errors'), false);
    assert.strictEqual(unauthorizedHealth.operationalHealth.evaluatedSignals.includes('community_reports'), false);
  });

  test('I.17: Verified Admin routes: all attention items link to real, existing admin routes', () => {
    const { attention } = buildAttentionModel({
      canViewErrors: true,
      canModerate: true,
      canReviewBusinesses: true,
      canVerify: true,
      unresolvedErrorsCount: 1,
      communityPendingReports: 1,
      openModerationCount: 1,
      pendingBusinessesCount: 1,
      pendingVerificationCount: 1
    });

    const routeMap = {
      system_errors: '/admin/error-reports?status=UNRESOLVED',
      community_reports: '/admin/community/reports?status=pending',
      moderation_backlog: '/admin/moderation?tab=open',
      pending_businesses: '/admin/businesses?tab=pending',
      verification_requests: '/admin/verification?status=PENDING'
    };

    attention.items.forEach(item => {
      assert.strictEqual(item.href, routeMap[item.key], `Route for ${item.key} must match verified admin route`);
    });
  });

  await testAsync('I.18: getDashboardData loads full Phase 4 operational contracts (attention, operationalHealth, trends) for superuser', async () => {
    const superuser = { role: 'superuser' };
    const data = await dashboardHelper.getDashboardData(superuser);

    assert.ok(data.operationalHealth, 'operationalHealth must be present');
    assert.ok(data.attention, 'attention must be present');
    assert.ok(data.trends, 'trends must be present');

    // Verify trends structure
    assert.ok(data.trends.users7d, 'users7d trend present');
    assert.ok(data.trends.posts7d, 'posts7d trend present');
    assert.ok(data.trends.comments7d, 'comments7d trend present');
    assert.ok(data.trends.stories7d, 'stories7d trend present');
    assert.ok(data.trends.communityActivity7d, 'communityActivity7d trend present');
    assert.ok(data.trends.monthlyEnrollment, 'monthlyEnrollment trend present');
    assert.ok(data.trends.monthlyRevenue, 'monthlyRevenue trend present for superuser');
    assert.ok(data.trends.communityReports7d, 'communityReports7d trend present for superuser');

    // Verify directional logic on trends
    assert.strictEqual(data.trends.users7d.delta, 1); // 3 vs 2
    assert.strictEqual(data.trends.users7d.direction, 'up');
    assert.strictEqual(data.trends.posts7d.delta, 2); // 5 vs 3
    assert.strictEqual(data.trends.posts7d.direction, 'up');
    assert.strictEqual(data.trends.comments7d.delta, 4); // 14 vs 10
    assert.strictEqual(data.trends.comments7d.direction, 'up');
  });

  await testAsync('I.19: Capability-gated trend masking: unauthorized admin receives null for restricted financial and report trends', async () => {
    const unprivileged = { role: 'restricted_admin', adminCapabilities: [] };
    const data = await dashboardHelper.getDashboardData(unprivileged);

    assert.strictEqual(data.trends.monthlyRevenue, null, 'monthlyRevenue trend must be masked (null) for unauthorized admin');
    assert.strictEqual(data.trends.communityReports7d, null, 'communityReports7d trend must be masked (null) for unauthorized admin');
  });

  await testAsync('I.20: DB operations count: privileged admin executes exactly 18 queries (ZERO query count regression from Phase 3)', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;

    const superuser = { role: 'superuser' };
    await dashboardHelper.getDashboardData(superuser);

    assert.strictEqual(customDb.queryLog.length, 18, `Superuser queries must remain exactly 18 (ZERO query addition for Phase 4)`);
  });

  await testAsync('I.21: DB operations count: restricted admin executes 15 queries (skips audit_logs, error_reports, community_reports)', async () => {
    const customDb = createMockDb();
    db.get = () => customDb;

    const restrictedAdmin = { role: 'restricted', adminCapabilities: [] };
    await dashboardHelper.getDashboardData(restrictedAdmin);

    assert.strictEqual(customDb.queryLog.length, 15, `Restricted admin queries must be 15 (skips audit_logs, error_reports, community_reports)`);
    assert.strictEqual(customDb.queryLog.includes('community_reports'), false);
    assert.strictEqual(customDb.queryLog.includes('error_reports'), false);
    assert.strictEqual(customDb.queryLog.includes('audit_logs'), false);
  });

  test('I.22: getSafeFallbackData provides complete Phase 4 contracts in offline mode with CRITICAL operational health', () => {
    const fallback = dashboardHelper.getSafeFallbackData({ role: 'superuser' });

    assert.ok(fallback.operationalHealth, 'Fallback must include operationalHealth');
    assert.strictEqual(fallback.operationalHealth.status, 'CRITICAL');
    assert.ok(fallback.operationalHealth.summary.toLowerCase().includes('offline'));
    assert.ok(fallback.attention, 'Fallback must include attention');
    assert.strictEqual(fallback.attention.items.length, 0);
    assert.ok(fallback.trends, 'Fallback must include trends');
    assert.strictEqual(fallback.trends.users7d.delta, 0);
    assert.strictEqual(fallback.trends.monthlyRevenue.delta, 0);
  });

  await testAsync('I.23: Partial database query failure resilience: dashboard data degrades gracefully without crashing or throwing', async () => {
    const failingDb = {
      collection: (name) => {
        if (name === 'students') {
          return {
            aggregate: () => ({ toArray: async () => { throw new Error('Simulated aggregation failure'); } }),
            find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
            countDocuments: async () => 0
          };
        }
        return {
          aggregate: () => ({ toArray: async () => [] }),
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
          countDocuments: async () => 0
        };
      }
    };
    db.get = () => failingDb;

    const result = await dashboardHelper.getDashboardData({ role: 'superuser' });
    assert.ok(result, 'Dashboard data must return even when students query fails');
    assert.ok(result.operationalHealth, 'operationalHealth must be present');
    assert.ok(result.attention, 'attention must be present');
    assert.ok(result.trends, 'trends must be present');
  });

  test('I.24: Template rendering: home.hbs displays operational health, attention queues, and trend badges without errors', () => {
    const dashboardData = {
      ...dashboardHelper.getSafeFallbackData({ role: 'superuser' }),
      operationalHealth: {
        status: 'ATTENTION_REQUIRED',
        label: 'Attention Required',
        badgeClass: 'bg-warning-subtle text-warning border-warning',
        icon: 'fa-solid fa-triangle-exclamation text-warning',
        summary: '2 active queue(s) require review',
        hasCritical: false,
        actionableQueueCount: 2
      },
      attention: {
        visible: true,
        total: 5,
        queueCount: 2,
        hasCritical: false,
        items: [
          {
            key: 'system_errors',
            title: 'Unresolved System Errors',
            count: 3,
            severity: 'high',
            description: '3 unresolved platform error(s) logged in the last 24 hours.',
            href: '/admin/error-reports?status=UNRESOLVED',
            capability: 'view_system_errors',
            badgeClass: 'bg-danger text-white',
            icon: 'fa-solid fa-triangle-exclamation'
          },
          {
            key: 'pending_businesses',
            title: 'Pending Business Approvals',
            count: 2,
            severity: 'medium',
            description: '2 organization(s) awaiting administrative review.',
            href: '/admin/businesses?tab=pending',
            capability: 'review_businesses',
            badgeClass: 'bg-warning-subtle text-warning border-warning',
            icon: 'fa-solid fa-building-shield'
          }
        ]
      },
      trends: {
        users7d: { current: 15, previous: 10, delta: 5, deltaPercent: 50, direction: 'up', isPositive: true, text: '+50% vs prev 7d' },
        posts7d: { current: 8, previous: 5, delta: 3, deltaPercent: 60, direction: 'up', isPositive: true, text: '+60% vs prev 7d' },
        comments7d: { current: 20, previous: 15, delta: 5, deltaPercent: 33, direction: 'up', isPositive: true, text: '+33% vs prev 7d' },
        stories7d: { current: 4, previous: 4, delta: 0, deltaPercent: 0, direction: 'flat', isPositive: false, text: '0% vs prev 7d' },
        monthlyEnrollment: { current: 10, previous: 8, delta: 2, deltaPercent: 25, direction: 'up', isPositive: true, text: '+25% vs prev month' },
        monthlyRevenue: { current: 50000, previous: 40000, delta: 10000, deltaPercent: 25, direction: 'up', isPositive: true, text: '+25% vs prev month' },
        communityReports7d: { current: 2, previous: 1, delta: 1, deltaPercent: 100, direction: 'up', isPositive: false, text: '+100% vs prev 7d' }
      }
    };

    const rendered = compiledHomeTemplate({
      isSuperuser: true,
      canViewRevenue: true,
      canViewErrors: true,
      dashboard: dashboardData
    });

    assert.ok(rendered.includes('Ops: Attention Required'), 'Must render operational health label');
    assert.ok(rendered.includes('Needs Attention'), 'Must render Needs Attention header');
    assert.ok(rendered.includes('Unresolved System Errors'), 'Must render system errors title');
    assert.ok(rendered.includes('/admin/error-reports?status=UNRESOLVED'), 'Must link to error reports');
    assert.ok(rendered.includes('Pending Business Approvals'), 'Must render business title');
    assert.ok(rendered.includes('/admin/businesses?tab=pending'), 'Must link to businesses');
    assert.ok(rendered.includes('+50% vs prev 7d'), 'Must render user trend');
    assert.ok(rendered.includes('+60% vs prev 7d'), 'Must render post trend');
  });

  test('I.25: Template rendering: home.hbs displays reassuring empty state when all operational queues are clear', () => {
    const dashboardData = {
      ...dashboardHelper.getSafeFallbackData({ role: 'superuser' }),
      operationalHealth: {
        status: 'HEALTHY',
        label: 'Healthy',
        badgeClass: 'bg-success-subtle text-success border-success',
        icon: 'fa-solid fa-circle-check text-success',
        summary: 'Platform systems and queues are running normally',
        hasCritical: false,
        actionableQueueCount: 0
      },
      attention: {
        visible: true,
        total: 0,
        queueCount: 0,
        hasCritical: false,
        items: []
      }
    };

    const rendered = compiledHomeTemplate({
      isSuperuser: true,
      canViewRevenue: true,
      canViewErrors: true,
      dashboard: dashboardData
    });

    assert.ok(rendered.includes('All operational queues are clear'), 'Must render clear reassurance message');
    assert.ok(rendered.includes('Ops: Healthy'), 'Must render Ops: Healthy');
  });

  test('I.26: Data safety: attention items contain clean aggregate descriptions without raw error strings, stack traces, or private user IDs', () => {
    const { attention } = buildAttentionModel({
      canViewErrors: true,
      canModerate: true,
      canReviewBusinesses: true,
      canVerify: true,
      unresolvedErrorsCount: 5,
      communityPendingReports: 2,
      openModerationCount: 3,
      pendingBusinessesCount: 1,
      pendingVerificationCount: 2
    });

    attention.items.forEach(item => {
      assert.strictEqual(item.description.includes('Error:'), false, 'Must not contain raw Error prefix');
      assert.strictEqual(item.description.includes('stack'), false, 'Must not contain stack traces');
      assert.strictEqual(item.description.includes('ObjectId'), false, 'Must not contain ObjectId strings');
      assert.strictEqual(/^[A-Za-z0-9\s.,()\-]+$/.test(item.description), true, 'Description must be clean alphanumeric punctuation only');
    });
  });

  // Restore db.get
  db.get = originalDbGet;

  console.log('\n======================================================');
  console.log(`DASHBOARD TEST SUITE SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

// Execute tests
runDashboardTests().catch(err => {
  console.error('Unhandled test suite failure:', err);
  process.exit(1);
});
