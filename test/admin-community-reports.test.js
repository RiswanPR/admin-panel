'use strict';

/**
 * Zeitnah Admin Panel — Phase 3 Community Reports & Moderation Test Suite
 * Validates:
 * 1. Safe ID validation and UUID preservation (no BSON ObjectId exceptions on reports)
 * 2. Community Reports listing: search, status filter, entityType filter, reason filter, pagination
 * 3. Report Dossier: entity resolution (post, comment, story, user), missing entity fallback, unsupported type fallback
 * 4. Multi-report entity aggregation: multiple reports against the same content
 * 5. Safe Report Mutations: dismissReport, resolveReport, addReportNote
 * 6. RBAC & Capability Protection: moderate_content server-side guards
 * 7. Canonical Audit Logging: COMMUNITY_REPORT_DISMISSED, COMMUNITY_REPORT_RESOLVED, COMMUNITY_REPORT_NOTE_ADDED
 * 8. Data Safety & Non-Destructive Invariants: zero deleteOne/deleteMany calls on reports
 * 9. Template & Navigation Architecture: presence of reports views and navigation items
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
  console.log('   ZEITNAH ADMIN PANEL: COMMUNITY REPORTS & SAFETY TEST SUITE   ');
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
    Email: 'superuser@zeitnah.test',
    Name: 'Community Lead',
    role: 'superuser'
  };

  const testAiAdmin = {
    _id: new ObjectId(),
    Email: 'ai@zeitnah.test',
    Name: 'AI Admin',
    role: 'ai_admin'
  };

  const testModerationAdmin = {
    _id: new ObjectId(),
    Email: 'moderator@zeitnah.test',
    Name: 'Community Moderator',
    role: 'moderation_admin'
  };

  // Mock Request helper
  const makeMockReq = (actor) => ({
    session: { adminloggedIn: true, admin: actor },
    ip: '127.0.0.1',
    headers: { 'user-agent': 'TestAgent/1.0' }
  });

  // Unique test IDs
  const ts = Date.now();
  const testReporterId = new ObjectId().toString();
  const testPostId = `report_test_post_${ts}`;
  const testCommentId = `report_test_comment_${ts}`;
  const testStoryId = `report_test_story_${ts}`;
  const testReport1Id = `report_test_r1_${ts}`;
  const testReport2Id = `report_test_r2_${ts}`;
  const testReport3Id = `report_test_r3_${ts}`;
  const testReport4Id = `report_test_r4_${ts}`;

  try {
    // ── Setup Fixtures ──
    // 1. Reporter User
    await database.collection(collection.STUDENTS_COLLECTION).insertOne({
      _id: new ObjectId(testReporterId),
      Name: 'Sarah Connor',
      username: `sarah_${ts}`,
      Email: `sarah_${ts}@example.com`,
      role: 'student',
      account_Status: { isBlocked: false }
    });

    // 2. Reported Post
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
      _id: testPostId,
      authorId: testReporterId,
      content: 'This is a controversial test post flagged for harassment.',
      type: 'TEXT',
      audience: 'PUBLIC',
      isDeleted: false,
      isLocked: false,
      createdAt: new Date()
    });

    // 3. Reported Comment
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).insertOne({
      _id: testCommentId,
      postId: testPostId,
      authorId: testReporterId,
      content: 'Flagged spam comment containing promotional links.',
      isDeleted: false,
      createdAt: new Date()
    });

    // 4. Reported Story
    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).insertOne({
      _id: testStoryId,
      authorId: testReporterId,
      text: 'Ephemeral flagged story',
      type: 'TEXT',
      expiresAt: new Date(Date.now() + 86400000), // active
      isDeleted: false,
      createdAt: new Date()
    });

    // 5. Reports Fixtures
    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).insertMany([
      {
        _id: testReport1Id,
        reporterId: testReporterId,
        entityId: testPostId,
        entityType: 'post',
        reason: 'harassment',
        description: 'Contains targeted insults towards classmates.',
        status: 'pending',
        createdAt: new Date(Date.now() - 3600000),
        updatedAt: new Date(Date.now() - 3600000)
      },
      {
        _id: testReport2Id,
        reporterId: testReporterId,
        entityId: testPostId,
        entityType: 'post',
        reason: 'inappropriate',
        description: 'Second report against the same post.',
        status: 'pending',
        createdAt: new Date(Date.now() - 1800000),
        updatedAt: new Date(Date.now() - 1800000)
      },
      {
        _id: testReport3Id,
        reporterId: testReporterId,
        entityId: testCommentId,
        entityType: 'comment',
        reason: 'spam',
        description: 'Blatant affiliate spam link.',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        _id: testReport4Id,
        reporterId: testReporterId,
        entityId: testStoryId,
        entityType: 'story',
        reason: 'inappropriate',
        description: 'Inappropriate image story.',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]);

    // =========================================================================
    // 1. ID Validation & UUID Safe Handling
    // =========================================================================
    console.log('--- 1. ID Validation & UUID Safe Handling ---');

    await testAsync('1.1: Rejects null or non-string report IDs cleanly', async () => {
      assert.strictEqual(communityHelper.isValidCommunityId(null), false);
      assert.strictEqual(communityHelper.isValidCommunityId(undefined), false);
      assert.strictEqual(communityHelper.isValidCommunityId({}), false);
    });

    await testAsync('1.2: Rejects malformed strings with MongoDB query operators', async () => {
      assert.strictEqual(communityHelper.isValidCommunityId('{"$gt":""}'), false);
      assert.strictEqual(communityHelper.isValidCommunityId('report; DROP TABLE'), false);
    });

    await testAsync('1.3: Accepts valid UUIDs and alphanumeric identifiers', async () => {
      assert.strictEqual(communityHelper.isValidCommunityId('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'), true);
      assert.strictEqual(communityHelper.isValidCommunityId(testReport1Id), true);
    });

    // =========================================================================
    // 2. Report Listing, Filtering & Pagination
    // =========================================================================
    console.log('\n--- 2. Report Listing, Filtering & Pagination ---');

    await testAsync('2.1: getReports returns paginated list with resolved reporter and target', async () => {
      const result = await communityHelper.getReports({ page: 1, limit: 10 });
      assert(Array.isArray(result.records), 'records must be an array');
      assert(result.total >= 4, 'total reports should be at least 4');
      const found = result.records.find(r => r._id === testReport1Id);
      assert(found, 'test report 1 must be present in records');
      assert.strictEqual(found.reporter.name, 'Sarah Connor');
      assert.strictEqual(found.entityType, 'post');
      assert.strictEqual(found.targetStatus, 'ACTIVE');
      assert(found.entityReportsTotal >= 2, 'target entity report total should count multiple reports');
    });

    await testAsync('2.2: Filter reports by status', async () => {
      const result = await communityHelper.getReports({ status: 'pending' });
      assert(result.records.every(r => r.status === 'pending'), 'all records must be pending');
    });

    await testAsync('2.3: Filter reports by entityType', async () => {
      const result = await communityHelper.getReports({ entityType: 'comment' });
      assert(result.records.some(r => r._id === testReport3Id), 'comment report must be present');
      assert(result.records.every(r => r.entityType === 'comment'), 'all records must be comment reports');
    });

    await testAsync('2.4: Filter reports by reason category', async () => {
      const result = await communityHelper.getReports({ reason: 'spam' });
      assert(result.records.some(r => r._id === testReport3Id), 'spam report must be present');
      assert(result.records.every(r => r.reason === 'spam'), 'all records must match reason spam');
    });

    await testAsync('2.5: Search reports by description keyword', async () => {
      const result = await communityHelper.getReports({ search: 'targeted insults' });
      assert(result.records.some(r => r._id === testReport1Id), 'search should locate report by description text');
    });

    // =========================================================================
    // 3. Report Dossier Detail & Entity Resolution
    // =========================================================================
    console.log('\n--- 3. Report Dossier Detail & Entity Resolution ---');

    await testAsync('3.1: getReportById returns full dossier with resolved post target', async () => {
      const dossier = await communityHelper.getReportById(testReport1Id);
      assert(dossier, 'dossier should exist');
      assert.strictEqual(dossier._id, testReport1Id);
      assert.strictEqual(dossier.reporter.name, 'Sarah Connor');
      assert(dossier.targetEntity, 'targetEntity must be resolved');
      assert.strictEqual(dossier.targetEntity._id, testPostId);
      assert.strictEqual(dossier.targetUnavailable, false);
      assert(dossier.otherReportsCount >= 1, 'other reports on this post must be detected');
    });

    await testAsync('3.2: getReportById resolves comment target with parent context', async () => {
      const dossier = await communityHelper.getReportById(testReport3Id);
      assert(dossier, 'comment report dossier should exist');
      assert.strictEqual(dossier.targetEntity._id, testCommentId);
      assert.strictEqual(dossier.targetEntity.statusLabel, 'ACTIVE');
    });

    await testAsync('3.3: getReportById resolves story target with lifecycle telemetry', async () => {
      const dossier = await communityHelper.getReportById(testReport4Id);
      assert(dossier, 'story report dossier should exist');
      assert.strictEqual(dossier.targetEntity._id, testStoryId);
      assert.strictEqual(dossier.targetEntity.statusLabel, 'ACTIVE');
    });

    await testAsync('3.4: Gracefully handles missing/deleted target content without crashing', async () => {
      // Create a report with a non-existent post entityId
      const phantomReportId = `phantom_rep_${ts}`;
      await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).insertOne({
        _id: phantomReportId,
        reporterId: testReporterId,
        entityId: 'non-existent-entity-uuid',
        entityType: 'post',
        reason: 'spam',
        status: 'pending',
        createdAt: new Date()
      });

      const dossier = await communityHelper.getReportById(phantomReportId);
      assert(dossier, 'dossier should still return for report with missing content');
      assert.strictEqual(dossier.targetUnavailable, true);
      assert.strictEqual(dossier.targetEntity, null);

      // Clean up phantom
      await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).deleteOne({ _id: phantomReportId });
    });

    await testAsync('3.5: Gracefully handles unsupported entity types', async () => {
      const weirdReportId = `weird_rep_${ts}`;
      await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).insertOne({
        _id: weirdReportId,
        reporterId: testReporterId,
        entityId: 'some-external-id',
        entityType: 'podcast', // unsupported
        reason: 'other',
        status: 'pending',
        createdAt: new Date()
      });

      const dossier = await communityHelper.getReportById(weirdReportId);
      assert(dossier, 'dossier should load');
      assert.strictEqual(dossier.targetUnsupported, true);

      await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).deleteOne({ _id: weirdReportId });
    });

    await testAsync('3.6: getReportById returns null cleanly for malformed or non-existent ID', async () => {
      const invalid = await communityHelper.getReportById('malformed$$');
      assert.strictEqual(invalid, null);

      const nonExistent = await communityHelper.getReportById('00000000-0000-0000-0000-000000000000');
      assert.strictEqual(nonExistent, null);
    });

    // =========================================================================
    // 4. Report Moderation Mutations (Dismiss, Resolve, Note)
    // =========================================================================
    console.log('\n--- 4. Report Moderation Mutations ---');

    await testAsync('4.1: dismissReport updates status to dismissed and writes audit log', async () => {
      const req = makeMockReq(testModerationAdmin);
      const res = await communityHelper.dismissReport(testReport1Id, { notes: 'False claim; verified compliant.' }, testModerationAdmin, req);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.status, 'dismissed');

      // Check database update
      const updated = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: testReport1Id });
      assert.strictEqual(updated.status, 'dismissed');
      assert.strictEqual(updated.actionTaken, 'dismissed');
      assert(updated.resolvedAt instanceof Date, 'resolvedAt should be recorded');
      assert.strictEqual(updated.moderatorNotes, 'False claim; verified compliant.');

      // Check canonical audit log
      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'COMMUNITY_REPORT_DISMISSED',
        entityId: testReport1Id
      });
      assert(audit, 'audit log COMMUNITY_REPORT_DISMISSED must be recorded');
    });

    await testAsync('4.2: dismissReport is idempotent on already dismissed report', async () => {
      const req = makeMockReq(testModerationAdmin);
      const res = await communityHelper.dismissReport(testReport1Id, { notes: 'Dismissing again' }, testModerationAdmin, req);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.alreadyApplied, true);
    });

    await testAsync('4.3: resolveReport marks report resolved with actionTaken and writes audit', async () => {
      const req = makeMockReq(testSuperuser);
      const res = await communityHelper.resolveReport(testReport2Id, { notes: 'Post was moderated and hidden.', actionTaken: 'post_hidden' }, testSuperuser, req);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.status, 'resolved');
      assert.strictEqual(res.actionTaken, 'post_hidden');

      const updated = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: testReport2Id });
      assert.strictEqual(updated.status, 'resolved');
      assert.strictEqual(updated.actionTaken, 'post_hidden');

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'COMMUNITY_REPORT_RESOLVED',
        entityId: testReport2Id
      });
      assert(audit, 'audit log COMMUNITY_REPORT_RESOLVED must be recorded');
    });

    await testAsync('4.4: resolveReport is idempotent on already resolved report', async () => {
      const req = makeMockReq(testSuperuser);
      const res = await communityHelper.resolveReport(testReport2Id, {}, testSuperuser, req);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.alreadyApplied, true);
    });

    await testAsync('4.5: addReportNote appends moderator note and logs audit event', async () => {
      const req = makeMockReq(testModerationAdmin);
      const res = await communityHelper.addReportNote(testReport3Id, { notes: 'Awaiting second moderator review.' }, testModerationAdmin, req);

      assert.strictEqual(res.success, true);
      assert(res.moderatorNotes.includes('Awaiting second moderator review.'));

      const updated = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: testReport3Id });
      assert(updated.moderatorNotes.includes('Awaiting second moderator review.'));

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'COMMUNITY_REPORT_NOTE_ADDED',
        entityId: testReport3Id
      });
      assert(audit, 'audit log COMMUNITY_REPORT_NOTE_ADDED must be recorded');
    });

    // =========================================================================
    // 5. RBAC & Security Verification
    // =========================================================================
    console.log('\n--- 5. RBAC & Security Verification ---');

    await testAsync('5.1: moderate_content capability verification across roles', async () => {
      assert.strictEqual(permissionsHelper.hasCapability(testSuperuser, 'moderate_content'), true);
      assert.strictEqual(permissionsHelper.hasCapability(testModerationAdmin, 'moderate_content'), true);
      assert.strictEqual(permissionsHelper.hasCapability(testAiAdmin, 'moderate_content'), false);
      assert.strictEqual(permissionsHelper.hasCapability(null, 'moderate_content'), false);
    });

    await testAsync('5.2: Route file verification: all report mutation endpoints guard with moderate_content', async () => {
      const routeContent = fs.readFileSync(path.join(__dirname, '../routes/admin-community.js'), 'utf8');

      assert(routeContent.includes("router.post('/reports/:id/dismiss', verifyLogin, requireCapability('moderate_content')"),
        'dismiss report route must have requireCapability(moderate_content)');
      assert(routeContent.includes("router.post('/reports/:id/resolve', verifyLogin, requireCapability('moderate_content')"),
        'resolve report route must have requireCapability(moderate_content)');
      assert(routeContent.includes("router.post('/reports/:id/note', verifyLogin, requireCapability('moderate_content')"),
        'add note route must have requireCapability(moderate_content)');
    });

    // =========================================================================
    // 6. Data Safety & Non-Destructive Invariants
    // =========================================================================
    console.log('\n--- 6. Data Safety & Non-Destructive Invariants ---');

    await testAsync('6.1: Zero hard delete calls in community-helper.js', async () => {
      const helperContent = fs.readFileSync(path.join(__dirname, '../Helpers/community-helper.js'), 'utf8');
      assert(!helperContent.includes('deleteOne('), 'Helper must not call deleteOne');
      assert(!helperContent.includes('deleteMany('), 'Helper must not call deleteMany');
      assert(!helperContent.includes('findOneAndDelete('), 'Helper must not call findOneAndDelete');
    });

    await testAsync('6.2: Reports and reported entities are preserved intact during resolution/dismissal', async () => {
      const report1Doc = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: testReport1Id });
      assert(report1Doc, 'Dismissed report document must remain preserved in database');

      const report2Doc = await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).findOne({ _id: testReport2Id });
      assert(report2Doc, 'Resolved report document must remain preserved in database');

      const postDoc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: testPostId });
      assert(postDoc, 'Reported post document must remain preserved in database');
    });

    // =========================================================================
    // 7. Template & Frontend Architecture Verification
    // =========================================================================
    console.log('\n--- 7. Template & Frontend Architecture Verification ---');

    await testAsync('7.1: All required Handlebars templates exist and have zero unescaped triple-stashes', async () => {
      const templates = [
        'views/admin/community-reports.hbs',
        'views/admin/community-report-detail.hbs'
      ];

      for (const t of templates) {
        const fullPath = path.join(__dirname, '..', t);
        assert(fs.existsSync(fullPath), `Template ${t} must exist`);
        const content = fs.readFileSync(fullPath, 'utf8');
        assert(!content.includes('{{{'), `Template ${t} must not contain unescaped triple-stashes {{{}}}`);
      }
    });

    await testAsync('7.2: Sidebar partial includes Reports navigation link', async () => {
      const headerContent = fs.readFileSync(path.join(__dirname, '../views/partials/Admin-Header.hbs'), 'utf8');
      assert(headerContent.includes('/admin/community/reports'), 'Admin-Header.hbs must contain /admin/community/reports link');
    });

    await testAsync('7.3: Layout command palette includes Community Reports', async () => {
      const layoutContent = fs.readFileSync(path.join(__dirname, '../views/Layout/layout.hbs'), 'utf8');
      assert(layoutContent.includes('Community Reports'), 'layout.hbs command palette must include Community Reports');
    });

  } finally {
    // ── Safe Cleanup of test fixtures only ──
    await database.collection(collection.COMMUNITY_REPORTS_COLLECTION).deleteMany({
      _id: { $in: [testReport1Id, testReport2Id, testReport3Id, testReport4Id] }
    });
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).deleteMany({ _id: testPostId });
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).deleteMany({ _id: testCommentId });
    await database.collection(collection.COMMUNITY_STORIES_COLLECTION).deleteMany({ _id: testStoryId });
    await database.collection(collection.STUDENTS_COLLECTION).deleteMany({ _id: new ObjectId(testReporterId) });
    await database.collection(collection.AUDIT_LOG_COLLECTION).deleteMany({
      entityId: { $in: [testReport1Id, testReport2Id, testReport3Id, testReport4Id] }
    });
    await database.collection(collection.COMMUNITY_MODERATION_LOGS_COLLECTION).deleteMany({
      entityId: { $in: [testPostId, testCommentId, testStoryId] }
    });
  }

  console.log('\n================================================================');
  console.log(`REPORTS SUITE SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
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
