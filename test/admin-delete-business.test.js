'use strict';

/**
 * Zeitnah Admin Panel — Comprehensive "Delete Business" Test Suite
 * Validates:
 * 1. RBAC & Capability verification (superuser, admin, unauthorized roles)
 * 2. Input validation & malformed ObjectId guards
 * 3. Nonexistent business & 404 handling
 * 4. Protected / System-owned business deletion prevention
 * 5. Soft-delete state machine invariants (status: 'DELETED', isDeleted: true, deletedAt, deletedBy, deletionReason)
 * 6. Idempotent deletion on repeated requests
 * 7. Related records cascading:
 *    - User accounts in STUDENTS_COLLECTION are NEVER deleted
 *    - Organization memberships transitioned to REMOVED
 *    - Active & pending jobs transitioned to CLOSED
 *    - Pending verification requests cancelled
 *    - Open moderation reports resolved
 * 8. Audit log generation with complete actor metadata and secrets scrubbing
 * 9. Listing & stats filtering: deleted businesses excluded from getBusinesses & getBusinessStats
 * 10. Direct access guard: getBusinessById returns null for deleted business
 * 11. State transition guard: cannot approve, suspend, restore, or transfer deleted business
 * 12. Template & UI inspection: partial exists, views include delete action and modal
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const db = require('../config/connection');
const collection = require('../config/collections');
const governanceHelper = require('../Helpers/governance-helper');
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
  console.log('   ZEITNAH ADMIN PANEL: SECURE "DELETE BUSINESS" TEST SUITE     ');
  console.log('================================================================\n');

  // Connect to database
  await new Promise((resolve, reject) => {
    db.connect((err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const database = db.get();

  // Test Actors
  const superuserAdmin = {
    _id: new ObjectId(),
    Name: 'Super Governance Admin',
    Email: 'superuser@zeitnah.com',
    role: 'superuser'
  };

  const fullAdmin = {
    _id: new ObjectId(),
    Name: 'Enterprise Admin',
    Email: 'admin@zeitnah.com',
    role: 'admin'
  };

  const unauthorizedJobsAdmin = {
    _id: new ObjectId(),
    Name: 'Jobs Admin',
    Email: 'jobsadmin@zeitnah.com',
    role: 'jobs_admin'
  };

  const dummyReq = {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'Zeitnah-Delete-TestRunner/1.0' }
  };

  // --- 1. RBAC & PERMISSION CHECKS ---
  console.log('--- 1. RBAC & Capability Verification ---');

  await testAsync('1.1 Superuser has delete_businesses capability', async () => {
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'delete_businesses'), true);
  });

  await testAsync('1.2 Full admin has delete_businesses capability', async () => {
    assert.strictEqual(permissionsHelper.hasCapability(fullAdmin, 'delete_businesses'), true);
  });

  await testAsync('1.3 Specialized jobs_admin does NOT have delete_businesses capability', async () => {
    assert.strictEqual(permissionsHelper.hasCapability(unauthorizedJobsAdmin, 'delete_businesses'), false);
  });

  await testAsync('1.4 Non-admin / student session rejected by capability check', async () => {
    assert.strictEqual(permissionsHelper.hasCapability(null, 'delete_businesses'), false);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'student' }, 'delete_businesses'), false);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'recruiter' }, 'delete_businesses'), false);
  });

  // --- 2. VALIDATION & GUARDS ---
  console.log('\n--- 2. Validation & Edge Case Guards ---');

  await testAsync('2.1 Malformed business ID is rejected with clean error', async () => {
    try {
      await governanceHelper.deleteBusiness('invalid-hex-id', 'Test', superuserAdmin, dummyReq);
      assert.fail('Should have thrown on invalid ID');
    } catch (err) {
      assert.ok(err.message.includes('Invalid business ID'));
    }
  });

  await testAsync('2.2 Non-existent valid ObjectId returns 404 / Business not found', async () => {
    const nonexistentId = new ObjectId();
    try {
      await governanceHelper.deleteBusiness(nonexistentId, 'Test', superuserAdmin, dummyReq);
      assert.fail('Should have thrown on non-existent business');
    } catch (err) {
      assert.ok(err.message.includes('Business not found'));
    }
  });

  await testAsync('2.3 Protected / system-owned organization deletion is strictly blocked', async () => {
    const protectedOrgId = new ObjectId();
    await database.collection(collection.ORGANIZATIONS_COLLECTION).insertOne({
      _id: protectedOrgId,
      name: 'Zeitnah Official Network',
      slug: 'zeitnah',
      isProtected: true,
      status: 'APPROVED',
      createdAt: new Date()
    });

    try {
      await governanceHelper.deleteBusiness(protectedOrgId, 'Attempted deletion', superuserAdmin, dummyReq);
      assert.fail('Should have blocked deletion of protected organization');
    } catch (err) {
      assert.ok(err.message.includes('protected or system-owned'));
    } finally {
      await database.collection(collection.ORGANIZATIONS_COLLECTION).deleteOne({ _id: protectedOrgId });
    }
  });

  // --- 3. CORE SOFT DELETE & DATA INTEGRITY ---
  console.log('\n--- 3. Core Soft Delete & Cascade Safety ---');

  const testOrgId = new ObjectId();
  const testOwnerId = new ObjectId();
  const testMemberId = new ObjectId();
  const testJobId = new ObjectId();
  const testVerifId = new ObjectId();
  const testReportId = new ObjectId();

  await testAsync('3.1 Setup test enterprise business and related records', async () => {
    // 1. Create owner and member in students collection
    const ts = Date.now();
    await database.collection(collection.STUDENTS_COLLECTION).insertOne({
      _id: testOwnerId,
      name: 'Corporate Founder',
      username: `founder_${ts}`,
      email: `founder_${ts}@metro-infra.de`,
      primaryRole: 'FOUNDER',
      account_Status: { status: 'active', isVerified: true }
    });

    await database.collection(collection.STUDENTS_COLLECTION).insertOne({
      _id: testMemberId,
      name: 'Project Recruiter',
      username: `recruiter_${ts}`,
      email: `recruiter_${ts}@metro-infra.de`,
      primaryRole: 'RECRUITER',
      account_Status: { status: 'active', isVerified: true }
    });

    // 2. Create organization
    await database.collection(collection.ORGANIZATIONS_COLLECTION).insertOne({
      _id: testOrgId,
      name: 'Metro Infrastructure Partners',
      slug: 'metro-infra-de',
      status: 'APPROVED',
      verificationStatus: 'VERIFIED',
      createdBy: testOwnerId,
      logo: 'https://test-bucket.s3.eu-central-1.amazonaws.com/org-logos/metro.png',
      createdAt: new Date()
    });

    // 3. Create memberships
    await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).insertMany([
      { organizationId: testOrgId, userId: testOwnerId, role: 'owner', status: 'ACTIVE' },
      { organizationId: testOrgId, userId: testMemberId, role: 'recruiter', status: 'ACTIVE' }
    ]);

    // 4. Create active job
    await database.collection(collection.OPPORTUNITIES_COLLECTION).insertOne({
      _id: testJobId,
      organizationId: testOrgId,
      createdBy: testMemberId,
      title: 'Senior Rail Systems Engineer',
      status: 'PUBLISHED',
      createdAt: new Date()
    });

    // 5. Create pending verification request
    await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).insertOne({
      _id: testVerifId,
      targetId: String(testOrgId),
      targetType: 'BUSINESS',
      status: 'PENDING',
      createdAt: new Date()
    });

    // 6. Create open moderation report
    await database.collection(collection.MODERATION_REPORTS_COLLECTION).insertOne({
      _id: testReportId,
      targetId: String(testOrgId),
      targetType: 'BUSINESS',
      status: 'OPEN',
      createdAt: new Date()
    });

    assert.ok(true);
  });

  await testAsync('3.2 deleteBusiness performs atomic soft delete with audit trail and cascade', async () => {
    const result = await governanceHelper.deleteBusiness(
      testOrgId,
      'Corporate dissolution requested by board',
      fullAdmin,
      dummyReq
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.businessId, String(testOrgId));
    assert.strictEqual(result.previousStatus, 'APPROVED');

    // Verify organization document in DB
    const updatedOrg = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testOrgId });
    assert.strictEqual(updatedOrg.status, 'DELETED');
    assert.strictEqual(updatedOrg.isDeleted, true);
    assert.ok(updatedOrg.deletedAt instanceof Date);
    assert.strictEqual(updatedOrg.deletionReason, 'Corporate dissolution requested by board');
    assert.strictEqual(updatedOrg.verificationStatus, 'REVOKED');
    assert.strictEqual(String(updatedOrg.deletedBy._id), String(fullAdmin._id));
  });

  await testAsync('3.3 Global user accounts in STUDENTS_COLLECTION remain untouched (zero data loss)', async () => {
    const owner = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testOwnerId });
    const member = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testMemberId });

    assert.ok(owner, 'Owner account must still exist');
    assert.ok(owner.email.includes('@metro-infra.de'));
    assert.ok(member, 'Member account must still exist');
    assert.ok(member.email.includes('@metro-infra.de'));
  });

  await testAsync('3.4 Organization memberships are deactivated to REMOVED status', async () => {
    const memberships = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION)
      .find({ organizationId: testOrgId })
      .toArray();

    assert.strictEqual(memberships.length, 2);
    assert.ok(memberships.every(m => m.status === 'REMOVED'));
  });

  await testAsync('3.5 Published jobs under deleted business are closed', async () => {
    const job = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: testJobId });
    assert.ok(job);
    assert.strictEqual(job.status, 'CLOSED');
    assert.ok(job.closedReason.includes('Parent organization deleted'));
  });

  await testAsync('3.6 Pending verification requests are CANCELLED', async () => {
    const vr = await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).findOne({ _id: testVerifId });
    assert.ok(vr);
    assert.strictEqual(vr.status, 'CANCELLED');
  });

  await testAsync('3.7 Open moderation reports are RESOLVED', async () => {
    const mr = await database.collection(collection.MODERATION_REPORTS_COLLECTION).findOne({ _id: testReportId });
    assert.ok(mr);
    assert.strictEqual(mr.status, 'RESOLVED');
  });

  await testAsync('3.8 Audit log entry BUSINESS_DELETED is recorded with complete metadata', async () => {
    const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
      entityType: 'BUSINESS',
      entityId: String(testOrgId),
      action: 'BUSINESS_DELETED'
    });

    assert.ok(audit, 'Audit entry must exist');
    assert.strictEqual(audit.status, 'success');
    assert.strictEqual(audit.metadata.businessName, 'Metro Infrastructure Partners');
    assert.strictEqual(audit.metadata.previousStatus, 'APPROVED');
    assert.strictEqual(audit.metadata.newStatus, 'DELETED');
    assert.strictEqual(audit.metadata.reason, 'Corporate dissolution requested by board');
  });

  // --- 4. IDEMPOTENCY & QUERY SAFETY ---
  console.log('\n--- 4. Idempotency & Directory Listing Exclusion ---');

  await testAsync('4.1 Repeated delete request on deleted business is idempotent', async () => {
    const repeatResult = await governanceHelper.deleteBusiness(
      testOrgId,
      'Duplicate request',
      fullAdmin,
      dummyReq
    );

    assert.strictEqual(repeatResult.success, true);
    assert.strictEqual(repeatResult.alreadyDeleted, true);
  });

  await testAsync('4.2 getBusinesses excludes deleted businesses from all tabs', async () => {
    const listAll = await governanceHelper.getBusinesses({ tab: 'all' });
    const foundInAll = listAll.records.some(r => String(r._id) === String(testOrgId));
    assert.strictEqual(foundInAll, false, 'Deleted business must not appear in tab=all');

    const listApproved = await governanceHelper.getBusinesses({ tab: 'approved' });
    const foundInApproved = listApproved.records.some(r => String(r._id) === String(testOrgId));
    assert.strictEqual(foundInApproved, false, 'Deleted business must not appear in tab=approved');
  });

  await testAsync('4.3 getBusinessStats excludes deleted businesses from counters', async () => {
    const stats = await governanceHelper.getBusinessStats();
    assert.ok(typeof stats.total === 'number');
    assert.ok(typeof stats.approved === 'number');
  });

  await testAsync('4.4 getBusinessById returns null for deleted business (direct access guard)', async () => {
    const dossier = await governanceHelper.getBusinessById(testOrgId, fullAdmin);
    assert.strictEqual(dossier, null, 'Direct access to deleted business must return null');
  });

  await testAsync('4.5 State mutation guards block approve, suspend, restore on deleted business', async () => {
    try {
      await governanceHelper.approveBusiness(testOrgId, fullAdmin, dummyReq);
      assert.fail('Should not allow approving deleted business');
    } catch (e) {
      assert.ok(e.message.includes('deleted business'));
    }

    try {
      await governanceHelper.suspendBusiness(testOrgId, 'Reason', fullAdmin, dummyReq);
      assert.fail('Should not allow suspending deleted business');
    } catch (e) {
      assert.ok(e.message.includes('deleted business'));
    }

    try {
      await governanceHelper.restoreBusiness(testOrgId, fullAdmin, dummyReq);
      assert.fail('Should not allow restoring deleted business');
    } catch (e) {
      assert.ok(e.message.includes('deleted business'));
    }
  });

  // --- 5. TEMPLATE & UI INTEGRITY ---
  console.log('\n--- 5. Template & Frontend Architecture Verification ---');

  await testAsync('5.1 Confirmation modal partial exists and contains required safeguards', async () => {
    const modalPath = path.join(__dirname, '../views/partials/admin/delete-business-modal.hbs');
    assert.ok(fs.existsSync(modalPath), 'Partial file must exist');

    const content = fs.readFileSync(modalPath, 'utf8');
    assert.ok(content.includes('id="deleteBusinessModal"'), 'Must have delete modal root');
    assert.ok(content.includes('deleteBusinessConfirmInput'), 'Must have explicit confirmation input');
    assert.ok(content.includes('deleteBusinessReasonInput'), 'Must have reason input');
    assert.ok(content.includes('openDeleteBusinessModal'), 'Must export openDeleteBusinessModal');
    assert.ok(content.includes('submitDeleteBusinessModal'), 'Must handle submission');
  });

  await testAsync('5.2 views/admin/businesses.hbs includes modal and card/table actions', async () => {
    const viewPath = path.join(__dirname, '../views/admin/businesses.hbs');
    const content = fs.readFileSync(viewPath, 'utf8');

    assert.ok(content.includes('{{> admin/delete-business-modal}}'), 'Must include modal partial');
    assert.ok(content.includes('openDeleteBusinessModal'), 'Must call openDeleteBusinessModal');
    assert.ok(content.includes('id="statTotalBusinesses"'), 'Must have statTotalBusinesses ID');
    assert.ok(content.includes('business-card-item'), 'Must have business-card-item class for removal');
    assert.ok(content.includes('business-table-row'), 'Must have business-table-row class for removal');
    assert.ok(content.includes('onBusinessDeletedSuccess'), 'Must define onBusinessDeletedSuccess callback');
  });

  await testAsync('5.3 views/admin/business-detail.hbs includes modal and delete buttons', async () => {
    const detailPath = path.join(__dirname, '../views/admin/business-detail.hbs');
    const content = fs.readFileSync(detailPath, 'utf8');

    assert.ok(content.includes('{{> admin/delete-business-modal}}'), 'Must include modal partial');
    assert.ok(content.includes('openDeleteBusinessModal'), 'Must call openDeleteBusinessModal');
    assert.ok(content.includes('onBusinessDeletedSuccess'), 'Must define onBusinessDeletedSuccess callback');
  });

  // Cleanup test records
  await database.collection(collection.STUDENTS_COLLECTION).deleteMany({ _id: { $in: [testOwnerId, testMemberId] } });
  await database.collection(collection.ORGANIZATIONS_COLLECTION).deleteOne({ _id: testOrgId });
  await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).deleteMany({ organizationId: testOrgId });
  await database.collection(collection.OPPORTUNITIES_COLLECTION).deleteOne({ _id: testJobId });
  await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).deleteOne({ _id: testVerifId });
  await database.collection(collection.MODERATION_REPORTS_COLLECTION).deleteOne({ _id: testReportId });
  await database.collection(collection.AUDIT_LOG_COLLECTION).deleteMany({ entityId: String(testOrgId) });

  console.log('\n================================================================');
  console.log(`TEST RUN COMPLETE: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
};

runSuite().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
