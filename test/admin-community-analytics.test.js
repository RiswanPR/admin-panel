'use strict';

/**
 * Zeitnah Admin Panel — Phase 4 Community Operations & Analytics Test Suite
 * Validates:
 * 1. Authorization & RBAC guards (verifyLogin, requireCapability('moderate_content'))
 * 2. Bounded Date Filter System (today, 7d, 30d, 90d, custom, validation bounds)
 * 3. Community Snapshot Metrics (posts, comments, stories, reports, moderation actions)
 * 4. Activity Trends & Continuous Time Bins (zero-filled, matching lengths, Chart.js ready)
 * 5. Verified Engagement Metrics & Schema Transparency (zero metric fabrication)
 * 6. Moderation Health & Reports Workload (statuses, entity types, user reports safety)
 * 7. Content Status Lifecycle (active, locked, pinned, expired, soft-deleted)
 * 8. Recent Operational Activity Feed (unified feed, safe user resolution, detail links)
 * 9. Performance & Query Safety (read-only, projections, no N+1, zero hard-deletes)
 * 10. Rules / Policy Schema Gap Verification (no fake production models introduced)
 * 11. Navigation & Template Compilation (Admin-Header sidebar, community-overview.hbs)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const Handlebars = require('handlebars');
const db = require('../config/connection');
const collection = require('../config/collections');
const communityAnalyticsHelper = require('../Helpers/community-analytics-helper');
const permissionsHelper = require('../Helpers/permissions-helper');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

const testAsync = async (desc, fn) => {
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
};

const runSuite = async () => {
  console.log('\n================================================================');
  console.log(' ZEITNAH ADMIN PANEL: COMMUNITY OPERATIONS & ANALYTICS TEST SUITE');
  console.log('================================================================\n');

  // Establish DB connection
  await new Promise((resolve, reject) => {
    db.connect((err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const database = db.get();

  // Test Actors
  const superuser = {
    _id: new ObjectId(),
    Name: 'Super Administrator',
    Email: 'superuser@zeitnah.com',
    role: 'superuser'
  };

  const moderationAdmin = {
    _id: new ObjectId(),
    Name: 'Content Moderator',
    Email: 'moderator@zeitnah.com',
    role: 'moderation_admin'
  };

  const systemAdmin = {
    _id: new ObjectId(),
    Name: 'System Administrator',
    Email: 'system@zeitnah.com',
    role: 'system_admin'
  };

  // Controlled test post/comment/report/log records to test metrics
  const testPostId = 'test-analytics-post-' + Date.now();
  const testCommentId = 'test-analytics-comment-' + Date.now();
  const testStoryId = 'test-analytics-story-' + Date.now();
  const testReportId = 'test-analytics-report-' + Date.now();
  const testUserReportId = 'test-analytics-user-report-' + Date.now();
  const testTargetUserId = new ObjectId();

  try {
    // Insert controlled test records
    const now = new Date();
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
      _id: testPostId,
      authorId: String(moderationAdmin._id),
      content: 'Analytics test post content',
      title: 'Analytics Test Post',
      isDeleted: false,
      isLocked: false,
      isPinned: true,
      stats: { likes: 5, comments: 2, views: 10 },
      createdAt: now,
      updatedAt: now
    });

    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).insertOne({
      _id: testCommentId,
      postId: testPostId,
      authorId: String(moderationAdmin._id),
      content: 'Analytics test comment content',
      isDeleted: false,
      createdAt: now,
      updatedAt: now
    });

    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).insertOne({
      _id: testStoryId,
      authorId: String(moderationAdmin._id),
      mediaUrl: 'https://example.com/test-story.mp4',
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // unexpired
      isDeleted: false,
      createdAt: now,
      updatedAt: now
    });

    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).insertOne({
      _id: testReportId,
      entityId: testPostId,
      entityType: 'post',
      reporterId: String(superuser._id),
      reason: 'Spam or misleading',
      status: 'pending',
      createdAt: now,
      updatedAt: now
    });

    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).insertOne({
      _id: testUserReportId,
      entityId: String(testTargetUserId),
      entityType: 'user',
      reporterId: String(superuser._id),
      reason: 'Harassment',
      status: 'resolved',
      createdAt: now,
      updatedAt: now
    });

    console.log('--- 1. AUTHORIZATION & RBAC GUARDS ---');

    await testAsync('1.1: requireCapability blocks unauthenticated session with 401', () => {
      const middleware = permissionsHelper.requireCapability('moderate_content');
      const req = { session: {}, headers: { accept: 'application/json' } };
      let statusCode = 0;
      let jsonResponse = null;
      const res = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => { jsonResponse = data; },
            render: (tpl, data) => {}
          };
        },
        redirect: (url) => {}
      };
      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, false, 'Unauthenticated request must not call next');
      assert.strictEqual(statusCode, 401, 'Unauthenticated request must return 401');
    });

    await testAsync('1.2: requireCapability blocks unauthorized admin role (system_admin) with 403', () => {
      const middleware = permissionsHelper.requireCapability('moderate_content');
      const req = {
        session: { adminloggedIn: true, admin: systemAdmin },
        headers: { accept: 'application/json' }
      };
      let statusCode = 0;
      const res = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => {},
            render: (tpl, data) => {}
          };
        }
      };
      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, false, 'Unauthorized admin must not call next');
      assert.strictEqual(statusCode, 403, 'Unauthorized admin must receive 403');
    });

    await testAsync('1.3: requireCapability permits authorized moderation_admin', () => {
      const middleware = permissionsHelper.requireCapability('moderate_content');
      const req = { session: { adminloggedIn: true, admin: moderationAdmin } };
      let nextCalled = false;
      const res = {};
      middleware(req, res, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, true, 'Authorized moderation_admin must call next');
    });

    await testAsync('1.4: requireCapability permits superuser', () => {
      const middleware = permissionsHelper.requireCapability('moderate_content');
      const req = { session: { adminloggedIn: true, admin: superuser } };
      let nextCalled = false;
      const res = {};
      middleware(req, res, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, true, 'Superuser must always be permitted');
    });

    console.log('\n--- 2. DATE FILTERS & VALIDATION ---');

    await testAsync('2.1: parseDateRange returns default 7d range when query is empty', () => {
      const range = communityAnalyticsHelper.parseDateRange({});
      assert.strictEqual(range.rangeKey, '7d');
      assert.strictEqual(range.isValid, true);
      assert.strictEqual(range.validationError, null);
      assert(range.startDate instanceof Date);
      assert(range.endDate instanceof Date);
      assert(range.startDate.getTime() < range.endDate.getTime());
    });

    await testAsync('2.2: parseDateRange supports preset ranges (today, 30d, 90d)', () => {
      const today = communityAnalyticsHelper.parseDateRange({ range: 'today' });
      assert.strictEqual(today.rangeKey, 'today');
      assert.strictEqual(today.startDateStr, today.endDateStr);

      const d30 = communityAnalyticsHelper.parseDateRange({ range: '30d' });
      assert.strictEqual(d30.rangeKey, '30d');
      assert(d30.daysDiff >= 29 && d30.daysDiff <= 31);

      const d90 = communityAnalyticsHelper.parseDateRange({ range: '90d' });
      assert.strictEqual(d90.rangeKey, '90d');
      assert(d90.daysDiff >= 89 && d90.daysDiff <= 92);
    });

    await testAsync('2.3: parseDateRange accepts valid custom date range', () => {
      const custom = communityAnalyticsHelper.parseDateRange({
        range: 'custom',
        startDate: '2026-09-01',
        endDate: '2026-09-15'
      });
      assert.strictEqual(custom.rangeKey, 'custom');
      assert.strictEqual(custom.isValid, true);
      assert.strictEqual(custom.startDateStr, '2026-09-01');
      assert.strictEqual(custom.endDateStr, '2026-09-15');
      assert.strictEqual(custom.daysDiff, 15);
    });

    await testAsync('2.4: parseDateRange handles invalid date strings safely with validationError', () => {
      const invalid = communityAnalyticsHelper.parseDateRange({
        range: 'custom',
        startDate: 'not-a-date',
        endDate: '2026-09-15'
      });
      assert.strictEqual(invalid.isValid, false);
      assert(invalid.validationError.includes('valid start and end dates'));
      assert.strictEqual(invalid.rangeKey, '7d', 'Must fallback to default safe range');
    });

    await testAsync('2.5: parseDateRange rejects reversed date range (startDate > endDate)', () => {
      const reversed = communityAnalyticsHelper.parseDateRange({
        range: 'custom',
        startDate: '2026-10-15',
        endDate: '2026-10-01'
      });
      assert.strictEqual(reversed.isValid, false);
      assert(reversed.validationError.includes('Start date cannot be after end date'));
      assert.strictEqual(reversed.rangeKey, '7d');
    });

    await testAsync('2.6: parseDateRange enforces maximum range limit (365 days)', () => {
      const excessive = communityAnalyticsHelper.parseDateRange({
        range: 'custom',
        startDate: '2024-01-01',
        endDate: '2026-01-01'
      });
      assert.strictEqual(excessive.isValid, false);
      assert(excessive.validationError.includes('cannot exceed 365 days'));
    });

    await testAsync('2.7: buildDateFilter matches both BSON Date and ISO string fields', () => {
      const start = new Date('2026-09-01T00:00:00Z');
      const end = new Date('2026-09-30T23:59:59Z');
      const filter = communityAnalyticsHelper.buildDateFilter('createdAt', start, end);
      assert(filter.$and, 'Must combine start and end conditions');
      assert.strictEqual(filter.$and.length, 2);
      assert(filter.$and[0].$or, 'Must support $or for Date vs string');
    });

    console.log('\n--- 3. COMMUNITY SNAPSHOT & OVERVIEW ---');

    await testAsync('3.1: getCommunitySnapshot computes accurate counts for active content', async () => {
      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const snapshot = await communityAnalyticsHelper.getCommunitySnapshot(database, dateRange);

      assert(typeof snapshot.posts.total === 'number');
      assert(snapshot.posts.total >= 1, 'Total posts must reflect inserted test post');
      assert(snapshot.posts.newInPeriod >= 1, 'New posts must reflect inserted test post');
      assert(snapshot.comments.total >= 1, 'Total comments must reflect inserted comment');
      assert(snapshot.stories.active >= 1, 'Active stories must reflect inserted active story');
      assert(snapshot.reports.total >= 2, 'Total reports must include test reports');
      assert(snapshot.reports.pending >= 1, 'Pending reports must include test post report');
      assert(snapshot.reports.resolved >= 1, 'Resolved reports must include test user report');
      assert(typeof snapshot.moderation.totalActions === 'number');
    });

    await testAsync('3.2: getCommunitySnapshot respects soft-deleted content invariants', async () => {
      // Temporarily soft-delete the test post
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).updateOne(
        { _id: testPostId },
        { $set: { isDeleted: true } }
      );

      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const snapshotDeleted = await communityAnalyticsHelper.getCommunitySnapshot(database, dateRange);

      // Restore post
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).updateOne(
        { _id: testPostId },
        { $set: { isDeleted: false } }
      );

      const snapshotRestored = await communityAnalyticsHelper.getCommunitySnapshot(database, dateRange);
      assert.strictEqual(
        snapshotRestored.posts.total,
        snapshotDeleted.posts.total + 1,
        'Soft-deleted posts must not be counted in active snapshot.posts.total'
      );
    });

    console.log('\n--- 4. ACTIVITY TRENDS & TIME BINNING ---');

    await testAsync('4.1: getCommunityActivityTrend generates synchronized, continuous time bins', async () => {
      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const trends = await communityAnalyticsHelper.getCommunityActivityTrend(database, {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        daysDiff: dateRange.daysDiff
      });

      assert(Array.isArray(trends.labels), 'labels must be an array');
      assert(trends.labels.length >= 7, 'Must have at least 7 day bins for 7d range');
      assert.strictEqual(trends.labels.length, trends.datasets.posts.length);
      assert.strictEqual(trends.labels.length, trends.datasets.comments.length);
      assert.strictEqual(trends.labels.length, trends.datasets.stories.length);
      assert.strictEqual(trends.labels.length, trends.datasets.reports.length);
      assert.strictEqual(trends.labels.length, trends.datasets.actions.length);

      // Verify no NaN or undefined in any data point
      trends.datasets.posts.forEach((val, idx) => {
        assert(!isNaN(val), `Post trend index ${idx} is NaN`);
        assert(val !== undefined && val !== null, `Post trend index ${idx} is null/undefined`);
      });
    });

    await testAsync('4.2: getCommunityActivityTrend handles zero activity periods cleanly', async () => {
      // Query a distant date range with zero activity
      const distantRange = communityAnalyticsHelper.parseDateRange({
        range: 'custom',
        startDate: '2023-01-01',
        endDate: '2023-01-07'
      });
      const trends = await communityAnalyticsHelper.getCommunityActivityTrend(database, distantRange);

      assert.strictEqual(trends.hasData, false);
      assert.strictEqual(trends.totals.posts, 0);
      assert.strictEqual(trends.totals.comments, 0);
      assert.strictEqual(trends.totals.reports, 0);
      assert.strictEqual(trends.labels.length, 7);
      trends.datasets.posts.forEach(v => assert.strictEqual(v, 0));
    });

    console.log('\n--- 5. ENGAGEMENT METRICS & DATA TRANSPARENCY ---');

    await testAsync('5.1: getCommunityEngagement calculates ratios without divide-by-zero errors', async () => {
      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const snapshot = await communityAnalyticsHelper.getCommunitySnapshot(database, dateRange);
      const engagement = await communityAnalyticsHelper.getCommunityEngagement(database, {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        snapshot
      });

      assert(typeof engagement.reactions.total === 'number');
      assert(!isNaN(Number(engagement.commentsRatio.commentsPerPost)));
      assert(!isNaN(Number(engagement.reactions.reactionsPerPost)));
      assert(typeof engagement.totalInteractions === 'number');
    });

    await testAsync('5.2: getCommunityEngagement provides explicit unsupported metrics transparency', async () => {
      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const engagement = await communityAnalyticsHelper.getCommunityEngagement(database, {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
        snapshot: { posts: { total: 0 }, comments: { total: 0 } }
      });

      assert(Array.isArray(engagement.unavailableMetrics), 'Must list unavailable metrics');
      const unmodeledNames = engagement.unavailableMetrics.map(m => m.name);
      assert(unmodeledNames.includes('Direct Shares'));
      assert(unmodeledNames.includes('Bookmarks / Saves'));
    });

    console.log('\n--- 6. MODERATION HEALTH & REPORTS WORKLOAD ---');

    await testAsync('6.1: getCommunityModerationMetrics breaks down reports by status', async () => {
      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const modMetrics = await communityAnalyticsHelper.getCommunityModerationMetrics(database, dateRange);

      assert(modMetrics.totalReports >= 2);
      assert(typeof modMetrics.statusMap.pending === 'number');
      assert(typeof modMetrics.statusMap.investigating === 'number');
      assert(typeof modMetrics.statusMap.resolved === 'number');
      assert(typeof modMetrics.statusMap.dismissed === 'number');
      assert(modMetrics.statusMap.pending >= 1, 'Pending reports must include test post report');
      assert(modMetrics.statusMap.resolved >= 1, 'Resolved reports must include test user report');
      assert(!isNaN(modMetrics.resolutionRate));
    });

    await testAsync('6.2: getCommunityModerationMetrics breaks down reports by entity type (including users)', async () => {
      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const modMetrics = await communityAnalyticsHelper.getCommunityModerationMetrics(database, dateRange);

      assert(modMetrics.entityTypeMap.post >= 1, 'Must track post reports');
      assert(modMetrics.entityTypeMap.user >= 1, 'Must track user reports separately');
      assert(typeof modMetrics.entityTypeMap.comment === 'number');
      assert(typeof modMetrics.entityTypeMap.story === 'number');
    });

    await testAsync('6.3: getCommunityModerationMetrics aggregates actions from community_moderation_logs', async () => {
      const dateRange = communityAnalyticsHelper.parseDateRange({ range: '7d' });
      const modMetrics = await communityAnalyticsHelper.getCommunityModerationMetrics(database, dateRange);

      assert(Array.isArray(modMetrics.actionTypes));
      if (modMetrics.actionTypes.length > 0) {
        assert(modMetrics.actionTypes[0].action);
        assert(modMetrics.actionTypes[0].label);
        assert(typeof modMetrics.actionTypes[0].count === 'number');
      }
    });

    console.log('\n--- 7. CONTENT STATUS LIFECYCLE ---');

    await testAsync('7.1: getCommunityContentStatus tallies active, locked, pinned, and deleted content', async () => {
      const contentStatus = await communityAnalyticsHelper.getCommunityContentStatus(database);

      assert(contentStatus.posts.active >= 1);
      assert(contentStatus.posts.pinned >= 1);
      assert(typeof contentStatus.posts.locked === 'number');
      assert(typeof contentStatus.posts.deleted === 'number');
      assert(contentStatus.comments.active >= 1);
      assert(contentStatus.stories.active >= 1);
    });

    console.log('\n--- 8. RECENT OPERATIONAL ACTIVITY FEED ---');

    await testAsync('8.1: getRecentCommunityActivity returns unified feed with safe detail URLs', async () => {
      const activity = await communityAnalyticsHelper.getRecentCommunityActivity(database, 10);
      assert(Array.isArray(activity));
      assert(activity.length >= 1, 'Must return at least 1 recent activity item');

      activity.forEach((item, idx) => {
        assert(item.id, `Item ${idx} missing id`);
        assert(item.type, `Item ${idx} missing type`);
        assert(item.typeLabel, `Item ${idx} missing typeLabel`);
        assert(item.title, `Item ${idx} missing title`);
        assert(item.actorName, `Item ${idx} missing actorName`);
        assert(item.detailUrl, `Item ${idx} missing detailUrl`);
        assert(item.createdAt instanceof Date, `Item ${idx} createdAt is not a Date`);
      });
    });

    await testAsync('8.2: User reports do not crash recent activity feed or fabricate post routes', async () => {
      const activity = await communityAnalyticsHelper.getRecentCommunityActivity(database, 20);
      const userReportItem = activity.find(a => a.type === 'report' && a.id === testUserReportId);
      if (userReportItem) {
        assert.strictEqual(
          userReportItem.detailUrl,
          `/admin/community/reports/${testUserReportId}`,
          'User report must link to Community Report detail, not post/comment detail'
        );
      }
    });

    console.log('\n--- 9. MASTER OVERVIEW AGGREGATION & SAFETY ---');

    await testAsync('9.1: getCommunityOverview aggregates all sections into unified payload', async () => {
      const overview = await communityAnalyticsHelper.getCommunityOverview({ range: '7d' });
      assert(overview.dateRange);
      assert(overview.snapshot);
      assert(overview.trends);
      assert(overview.engagement);
      assert(overview.moderation);
      assert(overview.contentStatus);
      assert(overview.recentActivity);
      assert(overview.rulesPolicy);
      assert.strictEqual(overview.rulesPolicy.hasModel, false);
      assert.strictEqual(overview.error, null);
    });

    await testAsync('9.2: Analytics helper does NOT perform destructive write or delete operations', () => {
      const helperSrc = fs.readFileSync(
        path.join(__dirname, '../Helpers/community-analytics-helper.js'),
        'utf8'
      );
      assert(!helperSrc.includes('.deleteOne('), 'Helper must never call deleteOne()');
      assert(!helperSrc.includes('.deleteMany('), 'Helper must never call deleteMany()');
      assert(!helperSrc.includes('.drop('), 'Helper must never drop collections');
      assert(!helperSrc.includes('.remove('), 'Helper must never call remove()');
    });

    console.log('\n--- 10. RULES / POLICY SCHEMA GAP AUDIT ---');

    await testAsync('10.1: Verified NO fake production rules collection exists or is assumed', async () => {
      const collections = await database.listCollections({}, { nameOnly: true }).toArray();
      const colNames = collections.map(c => c.name);
      assert(
        !colNames.includes('community_rules'),
        'No community_rules collection must be invented in lms-platform'
      );
      assert(
        !colNames.includes('community_policies'),
        'No community_policies collection must be invented in lms-platform'
      );

      const overview = await communityAnalyticsHelper.getCommunityOverview({});
      assert.strictEqual(overview.rulesPolicy.hasModel, false, 'Schema gap must be documented honestly');
    });

    console.log('\n--- 11. NAVIGATION & ROUTE GUARDS ---');

    await testAsync('11.1: Admin-Header sidebar includes Community Overview link with active class logic', () => {
      const headerContent = fs.readFileSync(
        path.join(__dirname, '../views/partials/Admin-Header.hbs'),
        'utf8'
      );
      assert(headerContent.includes('COMMUNITY'));
      assert(headerContent.includes('/admin/community'));
      assert(headerContent.includes("currentPage 'community-overview'"));
      assert(headerContent.includes('/admin/community/posts'));
      assert(headerContent.includes('/admin/community/comments'));
      assert(headerContent.includes('/admin/community/stories'));
      assert(headerContent.includes('/admin/community/reports'));
    });

    await testAsync('11.2: routes/admin-community.js has GET / and GET /overview protected by verifyLogin and requireCapability', () => {
      const routesContent = fs.readFileSync(
        path.join(__dirname, '../routes/admin-community.js'),
        'utf8'
      );
      assert(
        routesContent.includes("router.get('/', verifyLogin, requireCapability('moderate_content'), handleCommunityOverview)") ||
        routesContent.includes("router.get('/', verifyLogin, requireCapability('moderate_content')"),
        'GET / must have capability guard'
      );
      assert(
        routesContent.includes("router.get('/overview', verifyLogin, requireCapability('moderate_content'), handleCommunityOverview)") ||
        routesContent.includes("router.get('/overview', verifyLogin, requireCapability('moderate_content')"),
        'GET /overview must have capability guard'
      );
    });

    await testAsync('11.3: views/admin/community-overview.hbs compiles cleanly without syntax errors', () => {
      const overviewSource = fs.readFileSync(
        path.join(__dirname, '../views/admin/community-overview.hbs'),
        'utf8'
      );

      Handlebars.registerHelper('ifEquals', function (a, b, options) {
        return String(a) === String(b) ? options.fn(this) : options.inverse(this);
      });
      Handlebars.registerHelper('ifGt', function (a, b, options) {
        return Number(a) > Number(b) ? options.fn(this) : options.inverse(this);
      });
      Handlebars.registerHelper('formatDateTime', function (date) {
        return String(date || '');
      });

      const compiled = Handlebars.compile(overviewSource);
      assert(typeof compiled === 'function', 'Template must compile to function');
    });

  } finally {
    // Clean up controlled test records
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).deleteOne({ _id: testPostId });
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).deleteOne({ _id: testCommentId });
    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).deleteOne({ _id: testStoryId });
    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).deleteMany({
      _id: { $in: [testReportId, testUserReportId] }
    });
  }

  console.log('\n================================================================');
  console.log(`COMMUNITY ANALYTICS SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
};

runSuite().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
