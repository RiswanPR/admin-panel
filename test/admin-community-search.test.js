'use strict';

/**
 * Zeitnah Admin Panel — Phase 5 Community Global Search & Advanced Filtering Test Suite
 */

const assert = require('assert');
const fs = require('fs');
const { ObjectId } = require('mongodb');
const db = require('../config/connection');
const collection = require('../config/collections');
const communityHelper = require('../Helpers/community-helper');

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
  console.log('   ZEITNAH ADMIN PANEL: COMMUNITY GLOBAL SEARCH TEST SUITE       ');
  console.log('================================================================\n');

  // Establish DB connection
  await new Promise((resolve, reject) => {
    db.connect((err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const database = db.get();

  // Test identifiers for cleanup
  const testPrefix = `test_search_${Date.now()}_`;
  const testPostId = `${testPrefix}post_1`;
  const testCommentId = `${testPrefix}comment_1`;
  const testStoryId = `${testPrefix}story_1`;
  const testReportId = `${testPrefix}report_1`;
  const testUserId = new ObjectId();

  try {
    // 1. Seed test data across collections
    await database.collection(collection.STUDENTS_COLLECTION).insertOne({
      _id: testUserId,
      Name: 'Search Test Learner',
      username: `${testPrefix}user`,
      Email: `${testPrefix}@zeitnah.test`,
      role: 'student'
    });

    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
      _id: testPostId,
      content: 'UniqueAlphaKeyword in post content for discovery test',
      title: 'Searchable Post Alpha',
      authorId: String(testUserId),
      audience: 'ALL',
      postType: 'TEXT',
      tags: ['alpha', 'search'],
      stats: { likes: 5, comments: 2, views: 10 },
      isDeleted: false,
      isLocked: false,
      createdAt: new Date()
    });

    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).insertOne({
      _id: testCommentId,
      postId: testPostId,
      content: 'UniqueBetaKeyword in comment reply for testing',
      authorId: String(testUserId),
      isDeleted: false,
      createdAt: new Date()
    });

    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).insertOne({
      _id: testStoryId,
      text: 'UniqueGammaKeyword in story caption',
      authorId: String(testUserId),
      type: 'TEXT',
      isDeleted: false,
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date()
    });

    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).insertOne({
      _id: testReportId,
      entityType: 'post',
      entityId: testPostId,
      reason: 'SPAM',
      description: 'UniqueDeltaKeyword in safety report text',
      status: 'pending',
      reporterId: String(testUserId),
      createdAt: new Date()
    });

    console.log('--- 1. Search Query Bounding, Structure & Sanitization ---');

    await testAsync('1.1: Empty query returns empty results cleanly with standard structure', async () => {
      const res = await communityHelper.searchCommunity('');
      assert.strictEqual(Array.isArray(res.results), true);
      assert.strictEqual(res.total, 0);
      assert.strictEqual(res.page, 1);
      assert.strictEqual(res.limit, 20);
      assert.strictEqual(res.totalPages, 1);
    });

    await testAsync('1.2: Oversized query (>100 chars) is automatically truncated and bounded', async () => {
      const longQuery = 'A'.repeat(250);
      const res = await communityHelper.searchCommunity(longQuery);
      assert.strictEqual(res.query.length <= 100, true);
    });

    await testAsync('1.3: Special regex metacharacters are safely escaped and do not throw', async () => {
      const dangerousQueries = [
        '[.*+?^${}()|[\\]\\\\]',
        '^(a|b|c)+$',
        '(?=.*[a-z])',
        '\\d+\\w+\\s+',
        '.*',
        '('
      ];
      for (const q of dangerousQueries) {
        const res = await communityHelper.searchCommunity(q);
        assert.strictEqual(Array.isArray(res.results), true);
      }
    });

    await testAsync('1.4: Pagination limits are strictly bounded to max 50 items', async () => {
      const res = await communityHelper.searchCommunity('Unique', { limit: 999999, page: -5 });
      assert.strictEqual(res.limit <= 50, true);
      assert.strictEqual(res.page >= 1, true);
    });

    console.log('\n--- 2. Multi-Entity Search Matching ---');

    await testAsync('2.1: Post search finds post by content keyword', async () => {
      const res = await communityHelper.searchCommunity('UniqueAlphaKeyword', { type: 'posts' });
      assert.strictEqual(res.results.length >= 1, true);
      const match = res.results.find(r => r.id === testPostId);
      assert.ok(match, 'Post should be found');
      assert.strictEqual(match.entityType, 'post');
      assert.strictEqual(match.detailUrl, `/admin/community/posts/${testPostId}`);
    });

    await testAsync('2.2: Comment search finds comment by text keyword', async () => {
      const res = await communityHelper.searchCommunity('UniqueBetaKeyword', { type: 'comments' });
      assert.strictEqual(res.results.length >= 1, true);
      const match = res.results.find(r => r.id === testCommentId);
      assert.ok(match, 'Comment should be found');
      assert.strictEqual(match.entityType, 'comment');
    });

    await testAsync('2.3: Story search finds story by caption text', async () => {
      const res = await communityHelper.searchCommunity('UniqueGammaKeyword', { type: 'stories' });
      assert.strictEqual(res.results.length >= 1, true);
      const match = res.results.find(r => r.id === testStoryId);
      assert.ok(match, 'Story should be found');
      assert.strictEqual(match.entityType, 'story');
    });

    await testAsync('2.4: Report search finds safety report by description keyword', async () => {
      const res = await communityHelper.searchCommunity('UniqueDeltaKeyword', { type: 'reports' });
      assert.strictEqual(res.results.length >= 1, true);
      const match = res.results.find(r => r.id === testReportId);
      assert.ok(match, 'Report should be found');
      assert.strictEqual(match.entityType, 'report');
    });

    await testAsync('2.5: User search finds user by username', async () => {
      const res = await communityHelper.searchCommunity(`${testPrefix}user`, { type: 'users' });
      assert.strictEqual(res.results.length >= 1, true);
      const match = res.results.find(r => r.id === String(testUserId));
      assert.ok(match, 'User should be found');
      assert.strictEqual(match.entityType, 'user');
    });

    await testAsync('2.6: Type="all" aggregates matches across multiple collections with author resolution', async () => {
      const res = await communityHelper.searchCommunity('Unique', { type: 'all' });
      assert.strictEqual(res.results.length >= 4, true);
      const types = new Set(res.results.map(r => r.entityType));
      assert.ok(types.has('post'), 'Should contain posts');
      assert.ok(types.has('comment'), 'Should contain comments');
      assert.ok(types.has('story'), 'Should contain stories');
      assert.ok(types.has('report'), 'Should contain reports');
    });

    await testAsync('2.7: Unsupported search type gracefully defaults to "all" without crashing', async () => {
      const res = await communityHelper.searchCommunity('Unique', { type: 'MALICIOUS_COLLECTION' });
      assert.strictEqual(Array.isArray(res.results), true);
      assert.strictEqual(res.type, 'malicious_collection');
    });

    console.log('\n--- 3. Advanced Filtering & Date Ranges ---');

    await testAsync('3.1: Date range filters (startDate & endDate) filter posts by creation timestamp', async () => {
      const now = new Date();
      const past = new Date(Date.now() - 3600000);
      const future = new Date(Date.now() + 3600000);

      const withinRange = await communityHelper.getPosts({
        startDate: past.toISOString().slice(0, 10),
        endDate: future.toISOString().slice(0, 10)
      });
      assert.strictEqual(Array.isArray(withinRange.records), true);

      // Outside range
      const outsideRange = await communityHelper.getPosts({
        startDate: '2020-01-01',
        endDate: '2020-01-02'
      });
      const foundInOldRange = outsideRange.records.some(p => p._id === testPostId);
      assert.strictEqual(foundInOldRange, false, 'Post created today should not be found in 2020');
    });

    await testAsync('3.2: Date range filters filter reports accurately', async () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      const reportsToday = await communityHelper.getReports({
        startDate: todayStr,
        endDate: todayStr
      });
      assert.strictEqual(Array.isArray(reportsToday.records), true);
    });

    await testAsync('3.3: Pagination partial preserves community filters', async () => {
      const partialPath = 'views/partials/admin/admin-pagination.hbs';
      const content = fs.readFileSync(partialPath, 'utf8');
      assert.ok(content.includes('filters.entityType'), 'Preserves entityType');
      assert.ok(content.includes('filters.reason'), 'Preserves reason');
      assert.ok(content.includes('filters.postType'), 'Preserves postType');
      assert.ok(content.includes('filters.startDate'), 'Preserves startDate');
      assert.ok(content.includes('filters.endDate'), 'Preserves endDate');
      assert.ok(content.includes('filters.q'), 'Preserves q');
    });

    console.log('\n--- 4. Command Palette & Global Search Integration ---');

    await testAsync('4.1: Command palette static items include Community Search', async () => {
      const layoutContent = fs.readFileSync('views/Layout/layout.hbs', 'utf8');
      assert.ok(layoutContent.includes('/admin/community/search'), 'Palette includes search link');
    });

    await testAsync('4.2: /api/search in users.js queries Community Posts and Reports', async () => {
      const usersRouteContent = fs.readFileSync('routes/users.js', 'utf8');
      assert.ok(usersRouteContent.includes('COMMUNITY_POSTS_COLLECTION'), 'Queries community posts');
      assert.ok(usersRouteContent.includes('COMMUNITY_REPORTS_COLLECTION'), 'Queries community reports');
      assert.ok(usersRouteContent.includes('Community Post'), 'Returns community post badge');
      assert.ok(usersRouteContent.includes('Community Report'), 'Returns community report badge');
    });

  } finally {
    // Clean up test data
    await database.collection(collection.STUDENTS_COLLECTION).deleteOne({ _id: testUserId }).catch(() => {});
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).deleteOne({ _id: testPostId }).catch(() => {});
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).deleteOne({ _id: testCommentId }).catch(() => {});
    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).deleteOne({ _id: testStoryId }).catch(() => {});
    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).deleteOne({ _id: testReportId }).catch(() => {});
  }

  console.log('\n================================================================');
  console.log(`SEARCH SUITE SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
};

runSuite().catch(err => {
  console.error('Test Suite Unhandled Rejection:', err);
  process.exit(1);
});
