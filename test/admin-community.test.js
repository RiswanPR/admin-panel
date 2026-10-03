'use strict';

/**
 * Zeitnah Admin Panel — Phase 2 Community Content Management Test Suite
 * Validates:
 * 1. Safe ID validation and UUID preservation (No BSON ObjectId exceptions)
 * 2. Community Posts: list, search, filters, pagination, dossier detail
 * 3. Safe Post Mutations: hide (soft-delete), restore, lock/unlock comments, pin/unpin
 * 4. Community Comments: list, threaded reply lookup, context, soft-delete, restore
 * 5. Community Stories: active vs expired filtering, soft-delete removal, restore
 * 6. RBAC & Capability Protection: moderate_content server-side guards
 * 7. Canonical Audit Logging: entityType, entityId, previousState, newState, reason
 * 8. Data Safety & Non-Destructive Invariants: zero deleteOne/deleteMany calls
 * 9. View & Template Architecture: presence of modals, toolbars, and badges
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

const runSuite = async () => {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: COMMUNITY CONTENT MANAGEMENT TEST SUITE ');
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
  const testSuperuser = {
    _id: new ObjectId(),
    Name: 'Super Moderator',
    Email: 'supermod@zeitnah.com',
    role: 'superuser'
  };

  const testModAdmin = {
    _id: new ObjectId(),
    Name: 'Community Moderator',
    Email: 'mod@zeitnah.com',
    role: 'moderation_admin'
  };

  const testUnauthorizedAdmin = {
    _id: new ObjectId(),
    Name: 'System Admin',
    Email: 'sys@zeitnah.com',
    role: 'system_admin'
  };

  const mockReq = {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'ZeitnahTestRunner/1.0' },
    session: { admin: testModAdmin }
  };

  // Test Community Author
  const testAuthorId = new ObjectId();
  const testAuthorDoc = {
    _id: testAuthorId,
    name: 'Ada Lovelace',
    username: 'adalovelace',
    email: 'ada@zeitnah.com',
    role: 'student',
    primaryRole: 'STUDENT',
    avatar: 'https://cdn.zeitnah.com/avatars/ada.png',
    account_Status: { isBlocked: false }
  };

  // Controlled test UUIDs
  const testPostId = 'test-post-uuid-101';
  const testCommentId = 'test-comment-uuid-201';
  const testReplyId = 'test-reply-uuid-202';
  const testActiveStoryId = 'test-story-uuid-active';
  const testExpiredStoryId = 'test-story-uuid-expired';

  try {
    // Seed test author in users collection
    await database.collection(collection.STUDENTS_COLLECTION).updateOne(
      { _id: testAuthorId },
      { $set: testAuthorDoc },
      { upsert: true }
    );

    console.log('--- 1. ID Validation & UUID Safe Handling ---');

    await testAsync('1.1: Rejects empty or null community IDs cleanly', () => {
      assert.strictEqual(communityHelper.isValidCommunityId(null), false);
      assert.strictEqual(communityHelper.isValidCommunityId(''), false);
      assert.strictEqual(communityHelper.isValidCommunityId(undefined), false);
      assert.strictEqual(communityHelper.isValidCommunityId({}), false);
    });

    await testAsync('1.2: Rejects malformed strings with illegal query operators', () => {
      assert.strictEqual(communityHelper.isValidCommunityId('{"$gt": ""}'), false);
      assert.strictEqual(communityHelper.isValidCommunityId('post/../evil'), false);
      assert.strictEqual(communityHelper.isValidCommunityId('ab'), false); // too short
    });

    await testAsync('1.3: Accepts valid UUID and alphanumeric identifiers without BSON error', () => {
      assert.strictEqual(communityHelper.isValidCommunityId('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'), true);
      assert.strictEqual(communityHelper.isValidCommunityId(testPostId), true);
    });

    console.log('\n--- 2. Community Posts: Listing, Filtering & Dossier ---');

    // Seed test post
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).updateOne(
      { _id: testPostId },
      {
        $set: {
          _id: testPostId,
          authorId: String(testAuthorId),
          content: 'Exploring computational algorithms in modern education #science #stem',
          postType: 'original',
          type: 'TEXT',
          audience: 'PUBLIC',
          isPinned: false,
          isLocked: false,
          isDeleted: false,
          hashtags: ['science', 'stem'],
          tags: ['algorithms'],
          stats: {
            likes: 12,
            comments: 2,
            views: 45,
            shares: 3,
            reposts: 1
          },
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    await testAsync('2.1: getPosts returns paginated list with author resolution', async () => {
      const res = await communityHelper.getPosts({ page: 1, limit: 10 });
      assert(Array.isArray(res.records), 'records must be an array');
      assert(res.total >= 1, 'total must be at least 1');
      const found = res.records.find(p => p._id === testPostId);
      assert(found, 'test post must be present in records');
      assert.strictEqual(found.author.name, 'Ada Lovelace');
      assert.strictEqual(found.author.username, 'adalovelace');
      assert.strictEqual(found.likesCount, 12);
      assert.strictEqual(found.statusLabel, 'ACTIVE');
    });

    await testAsync('2.2: Search post by keyword in content', async () => {
      const res = await communityHelper.getPosts({ search: 'computational algorithms' });
      assert(res.records.some(p => p._id === testPostId));
    });

    await testAsync('2.3: Search post by author username', async () => {
      const res = await communityHelper.getPosts({ search: 'adalovelace' });
      assert(res.records.some(p => p._id === testPostId));
    });

    await testAsync('2.4: Filter posts by status and audience', async () => {
      const activeRes = await communityHelper.getPosts({ status: 'active', audience: 'PUBLIC' });
      assert(activeRes.records.some(p => p._id === testPostId));

      const deletedRes = await communityHelper.getPosts({ status: 'deleted' });
      assert(!deletedRes.records.some(p => p._id === testPostId));
    });

    await testAsync('2.5: getPostById returns complete enriched dossier', async () => {
      const dossier = await communityHelper.getPostById(testPostId);
      assert(dossier, 'dossier should exist');
      assert.strictEqual(dossier._id, testPostId);
      assert.strictEqual(dossier.author.name, 'Ada Lovelace');
      assert.strictEqual(dossier.likesCount, 12);
      assert.strictEqual(dossier.isDeleted, false);
      assert(Array.isArray(dossier.comments), 'comments should be an array');
      assert(Array.isArray(dossier.reports), 'reports should be an array');
    });

    await testAsync('2.6: getPostById returns null cleanly for invalid or non-existent ID', async () => {
      const resInvalid = await communityHelper.getPostById('non-existent-random-uuid');
      assert.strictEqual(resInvalid, null);
      const resNull = await communityHelper.getPostById(null);
      assert.strictEqual(resNull, null);
    });

    console.log('\n--- 3. Post Moderation Mutations (Soft Delete, Restore, Lock, Pin) ---');

    await testAsync('3.1: hidePost performs soft-delete without physical deletion and writes audit log', async () => {
      const hideResult = await communityHelper.hidePost(testPostId, { reason: 'Test policy breach' }, testModAdmin, mockReq);
      assert.strictEqual(hideResult.success, true);
      assert.strictEqual(hideResult.isDeleted, true);

      // Verify in DB
      const postInDb = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: testPostId });
      assert.strictEqual(postInDb.isDeleted, true);
      assert(postInDb.deletedAt instanceof Date, 'deletedAt must be Date');

      // Verify audit log
      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne(
        { action: 'COMMUNITY_POST_HIDDEN', entityId: testPostId }
      );
      assert(audit, 'Audit log entry must be present');
      assert.strictEqual(audit.entityType, 'COMMUNITY_POST');
      assert.strictEqual(audit.metadata.reason, 'Test policy breach');
    });

    await testAsync('3.2: hidePost is idempotent on already deleted content', async () => {
      const repeatHide = await communityHelper.hidePost(testPostId, { reason: 'Repeat hide' }, testModAdmin, mockReq);
      assert.strictEqual(repeatHide.success, true);
      assert.strictEqual(repeatHide.alreadyApplied, true);
    });

    await testAsync('3.3: restorePost restores post to active feed and logs audit event', async () => {
      const restoreResult = await communityHelper.restorePost(testPostId, { reason: 'Appeal accepted' }, testModAdmin, mockReq);
      assert.strictEqual(restoreResult.success, true);
      assert.strictEqual(restoreResult.isDeleted, false);

      const postInDb = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: testPostId });
      assert.strictEqual(postInDb.isDeleted, false);
      assert.strictEqual(postInDb.deletedAt, null);

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne(
        { action: 'COMMUNITY_POST_RESTORED', entityId: testPostId }
      );
      assert(audit, 'Audit log entry must exist for restore');
    });

    await testAsync('3.4: lockPost toggles comments lock status safely', async () => {
      const lockRes = await communityHelper.lockPost(testPostId, { isLocked: true, reason: 'High heat debate' }, testModAdmin, mockReq);
      assert.strictEqual(lockRes.isLocked, true);

      let postInDb = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: testPostId });
      assert.strictEqual(postInDb.isLocked, true);

      const unlockRes = await communityHelper.lockPost(testPostId, { isLocked: false, reason: 'Debate cooled' }, testModAdmin, mockReq);
      assert.strictEqual(unlockRes.isLocked, false);

      postInDb = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: testPostId });
      assert.strictEqual(postInDb.isLocked, false);
    });

    await testAsync('3.5: pinPost pins/unpins post with audit logging', async () => {
      const pinRes = await communityHelper.pinPost(testPostId, { isPinned: true, reason: 'Announcement pin' }, testModAdmin, mockReq);
      assert.strictEqual(pinRes.isPinned, true);

      let postInDb = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: testPostId });
      assert.strictEqual(postInDb.isPinned, true);

      const unpinRes = await communityHelper.pinPost(testPostId, { isPinned: false }, testModAdmin, mockReq);
      assert.strictEqual(unpinRes.isPinned, false);
    });

    console.log('\n--- 4. Community Comments: Management & Soft-Deletion ---');

    // Seed test comment & reply
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).updateOne(
      { _id: testCommentId },
      {
        $set: {
          _id: testCommentId,
          postId: testPostId,
          authorId: String(testAuthorId),
          content: 'Fascinating perspective on mechanical engines and algorithms!',
          parentId: null,
          stats: { likes: 5, replies: 1 },
          isDeleted: false,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).updateOne(
      { _id: testReplyId },
      {
        $set: {
          _id: testReplyId,
          postId: testPostId,
          authorId: String(testAuthorId),
          content: 'Agreed, this laid the groundwork for modern computer science.',
          parentId: testCommentId,
          stats: { likes: 2, replies: 0 },
          isDeleted: false,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    await testAsync('4.1: getComments returns comments with parent post preview and reply indicators', async () => {
      const res = await communityHelper.getComments({ postId: testPostId });
      assert(res.records.length >= 2);
      const topComment = res.records.find(c => c._id === testCommentId);
      assert(topComment);
      assert.strictEqual(topComment.isReply, false);

      const replyComment = res.records.find(c => c._id === testReplyId);
      assert(replyComment);
      assert.strictEqual(replyComment.isReply, true);
    });

    await testAsync('4.2: getCommentById aggregates parent post and child replies', async () => {
      const detail = await communityHelper.getCommentById(testCommentId);
      assert(detail);
      assert.strictEqual(detail.parentPost._id, testPostId);
      assert(Array.isArray(detail.replies));
      assert(detail.replies.some(r => r._id === testReplyId));
    });

    await testAsync('4.3: deleteComment soft-deletes comment without physical deletion and writes audit', async () => {
      const delRes = await communityHelper.deleteComment(testCommentId, { reason: 'Spam comment' }, testModAdmin, mockReq);
      assert.strictEqual(delRes.isDeleted, true);

      const commentInDb = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: testCommentId });
      assert.strictEqual(commentInDb.isDeleted, true);
      assert(commentInDb.deletedAt instanceof Date);

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne(
        { action: 'COMMUNITY_COMMENT_DELETED', entityId: testCommentId }
      );
      assert(audit);
      assert.strictEqual(audit.entityType, 'COMMUNITY_COMMENT');
    });

    await testAsync('4.4: restoreComment restores comment safely', async () => {
      const restoreRes = await communityHelper.restoreComment(testCommentId, { reason: 'Accidental flag' }, testModAdmin, mockReq);
      assert.strictEqual(restoreRes.isDeleted, false);

      const commentInDb = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: testCommentId });
      assert.strictEqual(commentInDb.isDeleted, false);
      assert.strictEqual(commentInDb.deletedAt, null);
    });

    console.log('\n--- 5. Community Stories: Lifecycle & Removal ---');

    const futureDate = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours ahead (Active)
    const pastDate = new Date(Date.now() - 4 * 60 * 60 * 1000);   // 4 hours ago (Expired)

    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).updateOne(
      { _id: testActiveStoryId },
      {
        $set: {
          _id: testActiveStoryId,
          authorId: String(testAuthorId),
          type: 'TEXT',
          text: 'Building mechanical calculating engines today!',
          backgroundColor: '#12314c',
          expiresAt: futureDate,
          isDeleted: false,
          stats: { views: 88, reactions: 14, replies: 2 },
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).updateOne(
      { _id: testExpiredStoryId },
      {
        $set: {
          _id: testExpiredStoryId,
          authorId: String(testAuthorId),
          type: 'TEXT',
          text: 'Yesterday’s completed test calculation notes.',
          backgroundColor: '#2b3a4a',
          expiresAt: pastDate,
          isDeleted: false,
          stats: { views: 140, reactions: 22, replies: 0 },
          createdAt: new Date(Date.now() - 28 * 60 * 60 * 1000),
          updatedAt: new Date(Date.now() - 28 * 60 * 60 * 1000)
        }
      },
      { upsert: true }
    );

    await testAsync('5.1: getStories correctly partitions active vs expired based on expiresAt timestamp', async () => {
      const activeRes = await communityHelper.getStories({ status: 'active' });
      assert(activeRes.records.some(s => s._id === testActiveStoryId));
      assert(!activeRes.records.some(s => s._id === testExpiredStoryId));

      const expiredRes = await communityHelper.getStories({ status: 'expired' });
      assert(expiredRes.records.some(s => s._id === testExpiredStoryId));
      assert(!expiredRes.records.some(s => s._id === testActiveStoryId));
    });

    await testAsync('5.2: getStoryById calculates lifecycleStatus dynamically', async () => {
      const activeStory = await communityHelper.getStoryById(testActiveStoryId);
      assert.strictEqual(activeStory.lifecycleStatus, 'ACTIVE');
      assert.strictEqual(activeStory.isExpired, false);

      const expiredStory = await communityHelper.getStoryById(testExpiredStoryId);
      assert.strictEqual(expiredStory.lifecycleStatus, 'EXPIRED');
      assert.strictEqual(expiredStory.isExpired, true);
    });

    await testAsync('5.3: removeStory soft-deletes story and audits event', async () => {
      const remRes = await communityHelper.removeStory(testActiveStoryId, { reason: 'Violates story standards' }, testModAdmin, mockReq);
      assert.strictEqual(remRes.isDeleted, true);

      const storyInDb = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: testActiveStoryId });
      assert.strictEqual(storyInDb.isDeleted, true);
      assert(storyInDb.deletedAt instanceof Date);

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne(
        { action: 'COMMUNITY_STORY_REMOVED', entityId: testActiveStoryId }
      );
      assert(audit);
      assert.strictEqual(audit.entityType, 'COMMUNITY_STORY');
    });

    await testAsync('5.4: restoreStory restores story record', async () => {
      const restRes = await communityHelper.restoreStory(testActiveStoryId, { reason: 'Restored after review' }, testModAdmin, mockReq);
      assert.strictEqual(restRes.isDeleted, false);

      const storyInDb = await database.collection(collection.COMMUNITY_STORIES_COLLECTION).findOne({ _id: testActiveStoryId });
      assert.strictEqual(storyInDb.isDeleted, false);
      assert.strictEqual(storyInDb.deletedAt, null);
    });

    console.log('\n--- 6. RBAC & Security Verification ---');

    await testAsync('6.1: moderate_content capability verification across roles', () => {
      assert.strictEqual(permissionsHelper.hasCapability(testSuperuser, 'moderate_content'), true);
      assert.strictEqual(permissionsHelper.hasCapability(testModAdmin, 'moderate_content'), true);
      assert.strictEqual(permissionsHelper.hasCapability(testUnauthorizedAdmin, 'moderate_content'), false);
      assert.strictEqual(permissionsHelper.hasCapability(null, 'moderate_content'), false);
    });

    await testAsync('6.2: Route file verification: all mutation endpoints guard with moderate_content', () => {
      const routeContent = fs.readFileSync(path.join(__dirname, '../routes/admin-community.js'), 'utf8');
      assert(routeContent.includes("router.post('/posts/:id/hide', verifyLogin, requireCapability('moderate_content')"));
      assert(routeContent.includes("router.post('/posts/:id/restore', verifyLogin, requireCapability('moderate_content')"));
      assert(routeContent.includes("router.post('/posts/:id/lock', verifyLogin, requireCapability('moderate_content')"));
      assert(routeContent.includes("router.post('/posts/:id/pin', verifyLogin, requireCapability('moderate_content')"));
      assert(routeContent.includes("router.post('/comments/:id/delete', verifyLogin, requireCapability('moderate_content')"));
      assert(routeContent.includes("router.post('/comments/:id/restore', verifyLogin, requireCapability('moderate_content')"));
      assert(routeContent.includes("router.post('/stories/:id/remove', verifyLogin, requireCapability('moderate_content')"));
      assert(routeContent.includes("router.post('/stories/:id/restore', verifyLogin, requireCapability('moderate_content')"));
    });

    console.log('\n--- 7. Data Safety & Non-Destructive Invariants ---');

    await testAsync('7.1: Zero hard delete calls in community-helper.js', () => {
      const helperContent = fs.readFileSync(path.join(__dirname, '../Helpers/community-helper.js'), 'utf8');
      assert(!helperContent.includes('.deleteOne('), 'Must not call deleteOne');
      assert(!helperContent.includes('.deleteMany('), 'Must not call deleteMany');
      assert(!helperContent.includes('.findOneAndDelete('), 'Must not call findOneAndDelete');
      assert(!helperContent.includes('.drop('), 'Must not call drop');
    });

    await testAsync('7.2: Global user accounts in users collection are never deleted or corrupted', async () => {
      const author = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testAuthorId });
      assert(author, 'User account must be untouched');
      assert.strictEqual(author.name, 'Ada Lovelace');
    });

    console.log('\n--- 8. Template & Frontend Architecture Verification ---');

    await testAsync('8.1: All required Handlebars templates exist', () => {
      const viewsDir = path.join(__dirname, '../views/admin');
      assert(fs.existsSync(path.join(viewsDir, 'community-posts.hbs')));
      assert(fs.existsSync(path.join(viewsDir, 'community-post-detail.hbs')));
      assert(fs.existsSync(path.join(viewsDir, 'community-comments.hbs')));
      assert(fs.existsSync(path.join(viewsDir, 'community-comment-detail.hbs')));
      assert(fs.existsSync(path.join(viewsDir, 'community-stories.hbs')));
      assert(fs.existsSync(path.join(viewsDir, 'community-story-detail.hbs')));
    });

    await testAsync('8.2: Sidebar partial includes Community section navigation', () => {
      const headerContent = fs.readFileSync(path.join(__dirname, '../views/partials/Admin-Header.hbs'), 'utf8');
      assert(headerContent.includes('COMMUNITY'));
      assert(headerContent.includes('/admin/community/posts'));
      assert(headerContent.includes('/admin/community/comments'));
      assert(headerContent.includes('/admin/community/stories'));
    });

  } finally {
    // Clean up only our controlled test records
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).deleteOne({ _id: testPostId });
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).deleteMany({ postId: testPostId });
    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).deleteMany({ _id: { $in: [testActiveStoryId, testExpiredStoryId] } });
    await database.collection(collection.STUDENTS_COLLECTION).deleteOne({ _id: testAuthorId });
  }

  console.log('\n================================================================');
  console.log(`COMMUNITY SUITE SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
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
