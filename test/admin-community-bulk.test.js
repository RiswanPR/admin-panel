'use strict';

/**
 * Zeitnah Admin Panel — Community Bulk Administration Test Suite
 * Validates:
 * 1. Batch validation: 1 ID, normal batch, exactly 50 IDs, 51 IDs rejected, empty array rejected, non-array rejected
 * 2. ID validation: valid Community UUID, malformed ID, nonexistent ID, mixed valid/invalid IDs, duplicate IDs
 * 3. Authorization: unauthenticated rejected, unauthorized rejected, authorized moderator succeeds, ZERO mutations on unauthorized
 * 4. Supported actions:
 *    - Posts: hide, restore, lock, unlock, pin, unpin
 *    - Comments: delete, restore
 *    - Stories: remove, restore
 *    - Reports: resolve, dismiss
 * 5. Results: accurate breakdown of succeeded, failed, and skipped
 * 6. Audit: aggregated bulk audit record creation with bulkOperationId and metadata
 */

const assert = require('assert');
const { ObjectId } = require('mongodb');
const db = require('../config/connection');
const collection = require('../config/collections');
const communityHelper = require('../Helpers/community-helper');
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

const createMockReqRes = (adminUser, body = {}, headers = {}) => {
  const req = {
    method: 'POST',
    session: {
      adminloggedIn: Boolean(adminUser),
      admin: adminUser || null
    },
    body,
    headers: {
      'x-forwarded-for': '127.0.0.1',
      'user-agent': 'ZeitnahBulkTestRunner/1.0',
      accept: 'application/json',
      ...headers
    },
    ip: '127.0.0.1'
  };

  const res = {
    statusCode: 200,
    headersSent: false,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.headersSent = true;
      return this;
    },
    render(view, data) {
      this.body = { view, data };
      this.headersSent = true;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      this.headersSent = true;
      return this;
    }
  };

  return { req, res };
};

const runSuite = async () => {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: COMMUNITY BULK MODERATION TEST SUITE    ');
  console.log('================================================================\n');

  // Connect to DB
  await new Promise((resolve, reject) => {
    db.connect((err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const database = db.get();

  // Test Actors
  const authorizedMod = {
    _id: new ObjectId(),
    Name: 'Community Moderator',
    Email: 'mod@zeitnah.com',
    role: 'moderation_admin'
  };

  const unauthorizedAdmin = {
    _id: new ObjectId(),
    Name: 'System Admin',
    Email: 'sys@zeitnah.com',
    role: 'system_admin'
  };

  const testActor = authorizedMod;
  const mockReq = {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'BulkTestRunner/1.0' },
    session: { admin: testActor }
  };

  const createdPostIds = [];
  const createdCommentIds = [];
  const createdStoryIds = [];
  const createdReportIds = [];

  try {
    // ─────────────────────────────────────────────────────────────
    console.log('--- 1. Batch Validation ---');
    // ─────────────────────────────────────────────────────────────

    // Seed test post for 1 ID test
    const pSingleId = 'bulk-test-post-single-01';
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
      _id: pSingleId,
      authorId: 'bulk-author-01',
      content: 'Bulk single post test',
      isDeleted: false,
      isLocked: false,
      isPinned: false,
      createdAt: new Date()
    });
    createdPostIds.push(pSingleId);

    await testAsync('1.1: 1 ID is accepted and processes successfully', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: [pSingleId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.requested, 1);
      assert.strictEqual(res.succeeded, 1);
      assert.strictEqual(res.failed, 0);
      assert.strictEqual(res.skipped, 0);

      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: pSingleId });
      assert.strictEqual(doc.isDeleted, true);
    });

    // Seed normal batch of 5 posts
    const normalBatchIds = [];
    for (let i = 1; i <= 5; i++) {
      const pId = `bulk-test-post-normal-${i}`;
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
        _id: pId,
        authorId: 'bulk-author-01',
        content: `Normal batch post ${i}`,
        isDeleted: false,
        isLocked: false,
        createdAt: new Date()
      });
      normalBatchIds.push(pId);
      createdPostIds.push(pId);
    }

    await testAsync('1.2: Normal batch (5 IDs) is accepted and processes all items', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: normalBatchIds,
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.requested, 5);
      assert.strictEqual(res.succeeded, 5);
      assert.strictEqual(res.failed, 0);
    });

    // Exactly 50 IDs boundary test
    const boundary50Ids = [];
    for (let i = 1; i <= 50; i++) {
      const pId = `bulk-test-post-boundary50-${i}`;
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
        _id: pId,
        authorId: 'bulk-author-boundary',
        content: `Boundary post ${i}`,
        isDeleted: false,
        createdAt: new Date()
      });
      boundary50Ids.push(pId);
      createdPostIds.push(pId);
    }

    await testAsync('1.3: Exactly 50 IDs (maximum batch limit) is accepted', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: boundary50Ids,
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.requested, 50);
      assert.strictEqual(res.succeeded, 50);
    });

    await testAsync('1.4: 51 IDs is strictly rejected with batch limit exceeded error', async () => {
      const overLimitIds = [...boundary50Ids, 'bulk-test-post-extra-51'];
      let rejected = false;
      try {
        await communityHelper.executeBulkAction({
          entityType: 'post',
          action: 'hide',
          ids: overLimitIds,
          actor: testActor,
          req: mockReq
        });
      } catch (err) {
        rejected = true;
        assert.ok(err.message.includes('Batch limit exceeded'), `Unexpected message: ${err.message}`);
      }
      assert.strictEqual(rejected, true, 'Should throw error when > 50 IDs provided');
    });

    await testAsync('1.5: Empty array [] is rejected with no items selected error', async () => {
      let rejected = false;
      try {
        await communityHelper.executeBulkAction({
          entityType: 'post',
          action: 'hide',
          ids: [],
          actor: testActor,
          req: mockReq
        });
      } catch (err) {
        rejected = true;
        assert.ok(err.message.includes('No items selected'), `Unexpected message: ${err.message}`);
      }
      assert.strictEqual(rejected, true, 'Should reject empty array');
    });

    await testAsync('1.6: Non-array payload is rejected with invalid IDs payload error', async () => {
      let rejected = false;
      try {
        await communityHelper.executeBulkAction({
          entityType: 'post',
          action: 'hide',
          ids: 'not-an-array',
          actor: testActor,
          req: mockReq
        });
      } catch (err) {
        rejected = true;
        assert.ok(err.message.includes('Expected an array'), `Unexpected message: ${err.message}`);
      }
      assert.strictEqual(rejected, true, 'Should reject non-array ids');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 2. ID Validation & Error Handling ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('2.1: Valid Community UUID/slug format is accepted', async () => {
      const validUuid = '123e4567-e89b-12d3-a456-426614174000';
      assert.strictEqual(communityHelper.isValidCommunityId(validUuid), true);
      assert.strictEqual(communityHelper.isValidCommunityId('post_abc-123_xyz'), true);
    });

    await testAsync('2.2: Malformed ID (special characters, objects, short strings) is rejected safely', async () => {
      assert.strictEqual(communityHelper.isValidCommunityId('bad$id!'), false);
      assert.strictEqual(communityHelper.isValidCommunityId('ab'), false);
      assert.strictEqual(communityHelper.isValidCommunityId('{"$gt":""}'), false);
      assert.strictEqual(communityHelper.isValidCommunityId(null), false);
      assert.strictEqual(communityHelper.isValidCommunityId(undefined), false);

      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: ['invalid$char*id'],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.failed, 1);
      assert.strictEqual(res.details[0].reason, 'Invalid identifier format');
    });

    await testAsync('2.3: Nonexistent ID with valid format is handled gracefully without crashing', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: ['nonexistent-uuid-valid-format-999'],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.failed, 1);
      assert.ok(res.details[0].reason.includes('not found') || res.details[0].reason.includes('Error'));
    });

    await testAsync('2.4: Mixed valid and invalid IDs: valid succeed, invalid recorded as failed', async () => {
      const validPId = 'bulk-test-mixed-valid-01';
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
        _id: validPId,
        authorId: 'bulk-author-mixed',
        content: 'Mixed batch valid post',
        isDeleted: false,
        createdAt: new Date()
      });
      createdPostIds.push(validPId);

      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: [validPId, 'invalid*metachar#id', 'bad$$id'],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.requested, 3);
      assert.strictEqual(res.succeeded, 1);
      assert.strictEqual(res.failed, 2);
    });

    await testAsync('2.5: Duplicate IDs in batch are processed idempotently without throwing', async () => {
      const dupPId = 'bulk-test-duplicate-01';
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
        _id: dupPId,
        authorId: 'bulk-author-dup',
        content: 'Duplicate test post',
        isDeleted: false,
        createdAt: new Date()
      });
      createdPostIds.push(dupPId);

      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: [dupPId, dupPId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.requested, 2);
      // First is succeeded, second is skipped because it was already hidden!
      assert.strictEqual(res.succeeded, 1);
      assert.strictEqual(res.skipped, 1);
      assert.strictEqual(res.failed, 0);
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 3. Authorization & Zero-Mutation Invariant ---');
    // ─────────────────────────────────────────────────────────────

    const authTargetPostId = 'bulk-test-auth-target-01';
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
      _id: authTargetPostId,
      authorId: 'auth-author',
      content: 'Critical post that must not be mutated without authorization',
      isDeleted: false,
      createdAt: new Date()
    });
    createdPostIds.push(authTargetPostId);

    await testAsync('3.1: Unauthenticated request is rejected with 401 Unauthorized', async () => {
      const { req, res } = createMockReqRes(null, {
        action: 'hide',
        ids: [authTargetPostId]
      });

      const middleware = permissionsHelper.requireCapability('moderate_content');
      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, false, 'Middleware should not allow unauthenticated call');
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body?.success, false);
    });

    await testAsync('3.2: Authenticated user lacking moderate_content (system_admin) is rejected with 403 Forbidden', async () => {
      const { req, res } = createMockReqRes(unauthorizedAdmin, {
        action: 'hide',
        ids: [authTargetPostId]
      });

      const middleware = permissionsHelper.requireCapability('moderate_content');
      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, false, 'Middleware should block unauthorized role');
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.success, false);
      assert.ok(res.body?.message?.includes('Insufficient privileges'));
    });

    await testAsync('3.3: CRITICAL INVARIANT: Unauthorized request results in ZERO mutations in the database', async () => {
      // Confirm the document in MongoDB remained completely untouched
      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: authTargetPostId });
      assert.strictEqual(doc.isDeleted, false, 'Doc must remain isDeleted: false');
      assert.strictEqual(doc.deletedAt, undefined, 'Doc must have no deletedAt');
    });

    await testAsync('3.4: Authorized moderator (moderation_admin) passes capability check and performs mutation', async () => {
      const { req, res } = createMockReqRes(authorizedMod, {
        action: 'hide',
        ids: [authTargetPostId]
      });

      const middleware = permissionsHelper.requireCapability('moderate_content');
      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });

      assert.strictEqual(nextCalled, true, 'Authorized moderator must pass middleware');

      // Execute mutation as authorized moderator
      const bulkRes = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: [authTargetPostId],
        actor: authorizedMod,
        req
      });
      assert.strictEqual(bulkRes.succeeded, 1);

      const docAfter = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: authTargetPostId });
      assert.strictEqual(docAfter.isDeleted, true, 'Post should now be soft-deleted');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 4. Supported Bulk Actions Across All Entities ---');
    // ─────────────────────────────────────────────────────────────

    // Posts: hide, restore, lock, unlock, pin, unpin
    const actionPostId = 'bulk-test-post-actions-01';
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
      _id: actionPostId,
      authorId: 'action-author',
      content: 'Post for testing all supported actions',
      isDeleted: false,
      isLocked: false,
      isPinned: false,
      createdAt: new Date()
    });
    createdPostIds.push(actionPostId);

    await testAsync('4.1: Posts - hide sets isDeleted: true', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: [actionPostId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: actionPostId });
      assert.strictEqual(doc.isDeleted, true);
    });

    await testAsync('4.2: Posts - restore restores isDeleted: false', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'restore',
        ids: [actionPostId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: actionPostId });
      assert.strictEqual(doc.isDeleted, false);
    });

    await testAsync('4.3: Posts - lock sets isLocked: true', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'lock',
        ids: [actionPostId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: actionPostId });
      assert.strictEqual(doc.isLocked, true);
    });

    await testAsync('4.4: Posts - unlock sets isLocked: false', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'unlock',
        ids: [actionPostId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: actionPostId });
      assert.strictEqual(doc.isLocked, false);
    });

    await testAsync('4.5: Posts - pin sets isPinned: true', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'pin',
        ids: [actionPostId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: actionPostId });
      assert.strictEqual(doc.isPinned, true);
    });

    await testAsync('4.6: Posts - unpin sets isPinned: false', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'unpin',
        ids: [actionPostId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: actionPostId });
      assert.strictEqual(doc.isPinned, false);
    });

    // Comments: delete (soft delete), restore
    const actionCommentId = 'bulk-test-comment-actions-01';
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).insertOne({
      _id: actionCommentId,
      postId: actionPostId,
      authorId: 'comment-author',
      text: 'Bulk test comment content',
      isDeleted: false,
      createdAt: new Date()
    });
    createdCommentIds.push(actionCommentId);

    await testAsync('4.7: Comments - delete performs soft-delete (isDeleted: true)', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'comment',
        action: 'delete',
        ids: [actionCommentId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: actionCommentId });
      assert.strictEqual(doc.isDeleted, true);
      assert.ok(doc.deletedAt instanceof Date);
    });

    await testAsync('4.8: Comments - restore restores soft-deleted comment (isDeleted: false)', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'comment',
        action: 'restore',
        ids: [actionCommentId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: actionCommentId });
      assert.strictEqual(doc.isDeleted, false);
      assert.strictEqual(doc.deletedAt, null);
    });

    // Stories: remove (soft delete), restore
    const actionStoryId = 'bulk-test-story-actions-01';
    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).insertOne({
      _id: actionStoryId,
      authorId: 'story-author',
      caption: 'Bulk test story caption',
      isDeleted: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000)
    });
    createdStoryIds.push(actionStoryId);

    await testAsync('4.9: Stories - remove performs soft-delete (isDeleted: true)', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'story',
        action: 'remove',
        ids: [actionStoryId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: actionStoryId });
      assert.strictEqual(doc.isDeleted, true);
      assert.ok(doc.deletedAt instanceof Date);
    });

    await testAsync('4.10: Stories - restore restores removed story (isDeleted: false)', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'story',
        action: 'restore',
        ids: [actionStoryId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: actionStoryId });
      assert.strictEqual(doc.isDeleted, false);
      assert.strictEqual(doc.deletedAt, null);
    });

    // Reports: resolve, dismiss
    const actionReportId = 'bulk-test-report-actions-01';
    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).insertOne({
      _id: actionReportId,
      reporterId: 'reporter-01',
      entityId: actionPostId,
      entityType: 'post',
      reason: 'Inappropriate content',
      status: 'pending',
      createdAt: new Date()
    });
    createdReportIds.push(actionReportId);

    await testAsync('4.11: Reports - resolve sets status: resolved', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'report',
        action: 'resolve',
        ids: [actionReportId],
        options: { notes: 'Bulk resolved' },
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: actionReportId });
      assert.strictEqual(doc.status, 'resolved');
    });

    // Reset report to pending
    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).updateOne(
      { _id: actionReportId },
      { $set: { status: 'pending' } }
    );

    await testAsync('4.12: Reports - dismiss sets status: dismissed', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'report',
        action: 'dismiss',
        ids: [actionReportId],
        options: { notes: 'Bulk dismissed' },
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.succeeded, 1);
      const doc = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: actionReportId });
      assert.strictEqual(doc.status, 'dismissed');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 5. Results Breakdown (Succeeded / Skipped / Failed) ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('5.1: Repeating an action on an item already in target state returns skipped', async () => {
      // actionReportId is already dismissed
      const res = await communityHelper.executeBulkAction({
        entityType: 'report',
        action: 'dismiss',
        ids: [actionReportId],
        actor: testActor,
        req: mockReq
      });
      assert.strictEqual(res.requested, 1);
      assert.strictEqual(res.succeeded, 0);
      assert.strictEqual(res.skipped, 1);
      assert.strictEqual(res.failed, 0);
      assert.strictEqual(res.details[0].skipped, true);
    });

    await testAsync('5.2: Multi-status response correctly distinguishes succeeded, skipped, and failed', async () => {
      const newPostId = 'bulk-test-post-breakdown-01';
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
        _id: newPostId,
        authorId: 'author-breakdown',
        content: 'Breakdown test post',
        isDeleted: false,
        createdAt: new Date()
      });
      createdPostIds.push(newPostId);

      // pSingleId is already isDeleted: true (from test 1.1)
      // newPostId is isDeleted: false
      // 'invalid$id' is invalid format
      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: [newPostId, pSingleId, 'invalid$bad@id'],
        actor: testActor,
        req: mockReq
      });

      assert.strictEqual(res.requested, 3);
      assert.strictEqual(res.succeeded, 1, 'newPostId should succeed');
      assert.strictEqual(res.skipped, 1, 'pSingleId should be skipped');
      assert.strictEqual(res.failed, 1, 'invalid ID should fail');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 6. Aggregated Bulk Audit Logging ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('6.1: Bulk operations create aggregated audit log with bulkOperationId and metadata', async () => {
      const auditPostId = 'bulk-test-audit-post-01';
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
        _id: auditPostId,
        authorId: 'author-audit',
        content: 'Audit logging test post',
        isDeleted: false,
        createdAt: new Date()
      });
      createdPostIds.push(auditPostId);

      const res = await communityHelper.executeBulkAction({
        entityType: 'post',
        action: 'hide',
        ids: [auditPostId],
        options: { reason: 'Violation of Terms §4' },
        actor: testActor,
        req: mockReq
      });

      assert.ok(res.bulkOperationId, 'Response must include bulkOperationId');

      // Verify audit log document was created in AUDIT_LOG_COLLECTION
      const auditLog = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        entityId: res.bulkOperationId
      });

      assert.ok(auditLog, 'Audit log record must exist with bulkOperationId');
      assert.strictEqual(auditLog.action, 'COMMUNITY_BULK_POST_ACTION');
      assert.strictEqual(auditLog.metadata?.action, 'hide');
      assert.strictEqual(auditLog.metadata?.entityType, 'post');
      assert.strictEqual(auditLog.metadata?.requestedCount, 1);
      assert.strictEqual(auditLog.metadata?.succeededCount, 1);
      assert.strictEqual(auditLog.metadata?.reason, 'Violation of Terms §4');
    });

  } finally {
    // Graceful test fixture teardown
    if (createdPostIds.length) {
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).deleteMany({ _id: { $in: createdPostIds } }).catch(() => {});
    }
    if (createdCommentIds.length) {
      await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).deleteMany({ _id: { $in: createdCommentIds } }).catch(() => {});
    }
    if (createdStoryIds.length) {
      await database.collection(collection.COMMUNITY_STORIES_COLLECTION).deleteMany({ _id: { $in: createdStoryIds } }).catch(() => {});
    }
    if (createdReportIds.length) {
      await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).deleteMany({ _id: { $in: createdReportIds } }).catch(() => {});
    }
  }

  console.log('\n================================================================');
  console.log(`BULK SUITE SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
};

runSuite().catch((err) => {
  console.error('Fatal suite failure:', err);
  process.exit(1);
});
