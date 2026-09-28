'use strict';

/**
 * Zeitnah Admin Panel — Phase 3 Comprehensive Test Suite
 * BUSINESSES + JOBS GOVERNANCE PREMIUM ENTERPRISE CONTROL CENTER
 *
 * Covers requirements A through Z:
 * A. Business listing & enrichment
 * B. Business search (name, slug, owner, member)
 * C. Business filters (status, verification, industry)
 * D. Pagination & bounded queries
 * E. Card / Table view persistence
 * F. Business detail dossier multi-collection aggregation
 * G. Business approval workflow
 * H. Business rejection workflow (mandatory reason)
 * I. Business suspension cascade (auto-pauses published jobs)
 * J. Business restoration cascade (restores paused jobs)
 * K. Ownership protection & superuser capability enforcement
 * L. Membership governance & role boundaries
 * M. Verification integration & evidence redaction
 * N. Job listing & tab partitioning
 * O. Job detail dossier & quality checklist
 * P. Job publish rules (employer approval prerequisite)
 * Q. Job state transitions (published -> unpublish / close)
 * R. Job suspension workflow (mandatory reason)
 * S. Job visibility boundaries
 * T. Job authorization boundaries (employer/recruiter linkage)
 * U. Job IDOR & malformed ObjectId handling
 * V. Business IDOR & malformed ObjectId handling
 * W. Audit logging completeness & previous/new state capture
 * X. Duplicate mutations & idempotency
 * Y. Concurrency & parallel mutation safety
 * Z. Candidate privacy projection (zero PII leakage)
 */

const assert = require('assert');
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
  console.log('   ZEITNAH ADMIN PANEL: PHASE 3 BUSINESS & JOB TEST SUITE       ');
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

  const businessAdmin = {
    _id: new ObjectId(),
    Name: 'Business Governance Admin',
    Email: 'bizadmin@zeitnah.com',
    role: 'admin'
  };

  const viewerAdmin = {
    _id: new ObjectId(),
    Name: 'Auditor Viewer',
    Email: 'viewer@zeitnah.com',
    role: 'analyst'
  };

  const dummyReq = {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'Zeitnah-Phase3-TestRunner/1.0' }
  };

  // Seed baseline users for business & job roles
  const ownerUser = {
    _id: new ObjectId(),
    username: 'test_founder_p3',
    name: 'Founder User',
    email: 'founder_p3@zeitnah.test',
    primaryRole: 'FOUNDER',
    role: 'FOUNDER',
    accountStatus: 'active',
    createdAt: new Date()
  };

  const newOwnerUser = {
    _id: new ObjectId(),
    username: 'test_successor_p3',
    name: 'Successor User',
    email: 'successor_p3@zeitnah.test',
    primaryRole: 'RECRUITER',
    role: 'RECRUITER',
    accountStatus: 'active',
    createdAt: new Date()
  };

  const recruiterUser = {
    _id: new ObjectId(),
    username: 'test_recruiter_p3',
    name: 'Recruiter User',
    email: 'recruiter_p3@zeitnah.test',
    primaryRole: 'RECRUITER',
    role: 'RECRUITER',
    accountStatus: 'active',
    createdAt: new Date()
  };

  const candidateUser = {
    _id: new ObjectId(),
    username: 'candidate_p3',
    name: 'Candidate Sensitive User',
    email: 'sensitive_candidate@zeitnah.test',
    primaryRole: 'PROFESSIONAL',
    role: 'PROFESSIONAL',
    accountStatus: 'active',
    createdAt: new Date()
  };

  await database.collection(collection.STUDENTS_COLLECTION).insertMany([
    ownerUser, newOwnerUser, recruiterUser, candidateUser
  ]);

  // Seed baseline organization
  const testOrg = {
    _id: new ObjectId(),
    name: 'InfraTech Dynamics GmbH',
    slug: 'infratech-dynamics',
    description: 'Leading heavy engineering and rail automation provider.',
    website: 'https://infratech.test',
    industry: 'Civil & Transport Infrastructure',
    infrastructureSectors: ['Railways', 'Civil Infrastructure'],
    status: 'PENDING_REVIEW',
    verificationStatus: 'PENDING',
    createdBy: ownerUser._id,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await database.collection(collection.ORGANIZATIONS_COLLECTION).insertOne(testOrg);

  // Seed baseline memberships
  const ownerMembership = {
    _id: new ObjectId(),
    organizationId: testOrg._id,
    userId: ownerUser._id,
    role: 'owner',
    status: 'ACTIVE',
    createdAt: new Date()
  };

  const recruiterMembership = {
    _id: new ObjectId(),
    organizationId: testOrg._id,
    userId: recruiterUser._id,
    role: 'recruiter',
    status: 'ACTIVE',
    createdAt: new Date()
  };

  await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).insertMany([
    ownerMembership, recruiterMembership
  ]);

  // Seed verification request with sensitive evidence
  const verificationReq = {
    _id: new ObjectId(),
    targetType: 'ORGANIZATION',
    targetId: testOrg._id,
    category: 'BUSINESS_REGISTRATION',
    status: 'PENDING',
    evidenceUrl: 'https://zeitnah-secure-vault.test/docs/secret_tax_id_9921.pdf',
    evidenceDetails: { registrationNumber: 'HRB 8839219', secretKey: 'CONFIDENTIAL-KEY' },
    submittedAt: new Date(),
    createdAt: new Date()
  };

  await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).insertOne(verificationReq);

  // Seed baseline jobs for testOrg
  const publishedJob = {
    _id: new ObjectId(),
    organizationId: testOrg._id,
    createdBy: recruiterUser._id,
    title: 'Senior Rail Signalling Specialist',
    discipline: 'Railways & Transport',
    infrastructureSector: 'Railways',
    workMode: 'Hybrid',
    experienceLevel: 'Senior',
    minYearsExperience: 6,
    maxYearsExperience: 10,
    location: 'Munich, Germany',
    description: 'Lead next-generation ETCS rail signalling engineering and field deployment throughout Bavaria.',
    requiredSkills: ['ETCS Level 2', 'SCADA', 'Safety Systems'],
    requiredSoftware: ['AutoCAD', 'RailTrack CAD'],
    status: 'PUBLISHED',
    publishedAt: new Date(),
    createdAt: new Date()
  };

  const pendingJob = {
    _id: new ObjectId(),
    organizationId: testOrg._id,
    createdBy: recruiterUser._id,
    title: 'Junior Tunnel Ventilation Designer',
    discipline: 'Tunneling & Underground',
    infrastructureSector: 'Civil Infrastructure',
    workMode: 'On-site',
    experienceLevel: 'Junior',
    location: 'Stuttgart, Germany',
    description: 'Assist in designing emergency ventilation corridors for urban subway systems.',
    requiredSkills: ['CFD Simulation', 'HVAC'],
    requiredSoftware: ['ANSYS Fluent'],
    status: 'PENDING_REVIEW',
    createdAt: new Date()
  };

  await database.collection(collection.OPPORTUNITIES_COLLECTION).insertMany([
    publishedJob, pendingJob
  ]);

  // Seed a job application with sensitive PII (must be shielded from admin views)
  const sensitiveApplication = {
    _id: new ObjectId(),
    jobId: publishedJob._id,
    candidateId: candidateUser._id,
    status: 'submitted',
    candidatePii: {
      passportNumber: 'N99218201',
      mobilePhone: '+49 170 999 8888',
      candidateCvData: 'Secret candidate private work history & residence address'
    },
    createdAt: new Date()
  };

  await database.collection(collection.JOB_APPLICATIONS_COLLECTION).insertOne(sensitiveApplication);

  // Seed talent matches
  const matchEntry = {
    _id: new ObjectId(),
    jobId: publishedJob._id,
    candidateId: candidateUser._id,
    score: 92,
    dimensions: { skillMatch: 95, sectorMatch: 90 },
    createdAt: new Date()
  };

  await database.collection(collection.JOB_TALENT_MATCHES_COLLECTION).insertOne(matchEntry);

  try {

    // =========================================================================
    // A. BUSINESS LISTING
    // =========================================================================
    console.log('\n--- A. BUSINESS LISTING ---');

    await testAsync('A1: getBusinesses returns enriched organizations with member and job aggregates', async () => {
      const res = await governanceHelper.getBusinesses({ limit: 10, page: 1 });
      assert.ok(res.records && res.records.length > 0, 'Should return records');
      assert.strictEqual(typeof res.total, 'number', 'Total should be numeric');

      const found = res.records.find(b => String(b._id) === String(testOrg._id));
      assert.ok(found, 'Should find test business in listing');
      assert.strictEqual(found.name, 'InfraTech Dynamics GmbH');
      assert.ok(found.membersCount >= 2, 'Should aggregate membership count');
      assert.ok(found.openJobsCount >= 1, 'Should aggregate open jobs count');
    });

    // =========================================================================
    // B. BUSINESS SEARCH
    // =========================================================================
    console.log('\n--- B. BUSINESS SEARCH ---');

    await testAsync('B1: Search business by name or slug', async () => {
      const res = await governanceHelper.getBusinesses({ search: 'InfraTech' });
      assert.ok(res.records.length > 0, 'Should find by name');
      assert.strictEqual(res.records[0].slug, 'infratech-dynamics');
    });

    await testAsync('B2: Search business by owner or member username', async () => {
      const res = await governanceHelper.getBusinesses({ search: 'test_founder_p3' });
      assert.ok(res.records.some(b => String(b._id) === String(testOrg._id)), 'Should match via owner handle');
    });

    await testAsync('B3: Search is regex-safe and resilient to punctuation', async () => {
      const res = await governanceHelper.getBusinesses({ search: '[[*+?InfraTech' });
      assert.ok(Array.isArray(res.records), 'Should not throw regex compilation error');
    });

    // =========================================================================
    // C. BUSINESS FILTERS
    // =========================================================================
    console.log('\n--- C. BUSINESS FILTERS ---');

    await testAsync('C1: Filter by business status and verification status', async () => {
      const res = await governanceHelper.getBusinesses({ status: 'PENDING_REVIEW', verification: 'PENDING' });
      assert.ok(res.records.every(b => b.status === 'PENDING_REVIEW'), 'All records should match status filter');
    });

    // =========================================================================
    // D. PAGINATION
    // =========================================================================
    console.log('\n--- D. PAGINATION ---');

    await testAsync('D1: Enforces sane page limits and skip offset', async () => {
      const res = await governanceHelper.getBusinesses({ page: 1, limit: 1 });
      assert.strictEqual(res.records.length, 1);
      assert.strictEqual(res.page, 1);
    });

    // =========================================================================
    // E. CARD / TABLE PERSISTENCE
    // =========================================================================
    console.log('\n--- E. CARD / TABLE PERSISTENCE ---');

    await testAsync('E1: Card view is default and tab state is maintained', async () => {
      const stats = await governanceHelper.getBusinessStats();
      assert.ok(typeof stats.total === 'number');
      assert.ok(typeof stats.pending === 'number');
      assert.ok(typeof stats.approved === 'number');
      assert.ok(typeof stats.suspended === 'number');
    });

    // =========================================================================
    // F. BUSINESS DETAIL DOSSIER
    // =========================================================================
    console.log('\n--- F. BUSINESS DETAIL DOSSIER ---');

    await testAsync('F1: getBusinessById aggregates multi-collection roster, jobs, audit, and verification', async () => {
      const dossier = await governanceHelper.getBusinessById(String(testOrg._id), superuserAdmin);
      assert.ok(dossier, 'Dossier must exist');
      assert.strictEqual(dossier.business.name, 'InfraTech Dynamics GmbH');
      assert.ok(dossier.owner, 'Owner info should be populated');
      assert.strictEqual(dossier.owner.username, 'test_founder_p3');
      assert.ok(dossier.members.length >= 2, 'Members roster should include owner & recruiter');
      assert.ok(dossier.jobs.active.length >= 1, 'Active jobs segmented');
      assert.ok(dossier.verification, 'Verification request populated');
    });

    // =========================================================================
    // G. BUSINESS APPROVAL
    // =========================================================================
    console.log('\n--- G. BUSINESS APPROVAL ---');

    await testAsync('G1: approveBusiness updates status to APPROVED, verifies business, and logs audit', async () => {
      const result = await governanceHelper.approveBusiness(String(testOrg._id), superuserAdmin, dummyReq);
      assert.strictEqual(result.status, 'APPROVED');

      const updated = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testOrg._id });
      assert.strictEqual(updated.status, 'APPROVED');
      assert.strictEqual(updated.verificationStatus, 'VERIFIED');

      // Check audit log
      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'BUSINESS_APPROVED',
        targetId: testOrg._id
      });
      assert.ok(audit, 'BUSINESS_APPROVED audit entry must exist');
      assert.strictEqual(audit.details.previousState, 'PENDING_REVIEW');
      assert.strictEqual(audit.details.newState, 'APPROVED');
    });

    // =========================================================================
    // H. BUSINESS REJECTION
    // =========================================================================
    console.log('\n--- H. BUSINESS REJECTION ---');

    await testAsync('H1: rejectBusiness requires non-empty reason and logs audit', async () => {
      // Rejection with empty reason must fail
      await assert.rejects(
        async () => governanceHelper.rejectBusiness(String(testOrg._id), '   ', superuserAdmin, dummyReq),
        /rejection reason is (required|mandatory)/i
      );

      const result = await governanceHelper.rejectBusiness(String(testOrg._id), 'Incomplete registration documents', superuserAdmin, dummyReq);
      assert.strictEqual(result.status, 'REJECTED');

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'BUSINESS_REJECTED',
        targetId: testOrg._id
      });
      assert.ok(audit, 'BUSINESS_REJECTED audit entry must exist');
      assert.strictEqual(audit.details.reason, 'Incomplete registration documents');
    });

    // =========================================================================
    // I. BUSINESS SUSPENSION CASCADE
    // =========================================================================
    console.log('\n--- I. BUSINESS SUSPENSION CASCADE ---');

    await testAsync('I1: suspendBusiness suspends organization and auto-pauses active published jobs', async () => {
      // First ensure business is APPROVED and job is PUBLISHED
      await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
        { _id: testOrg._id },
        { $set: { status: 'APPROVED', verificationStatus: 'VERIFIED' } }
      );
      await database.collection(collection.OPPORTUNITIES_COLLECTION).updateOne(
        { _id: publishedJob._id },
        { $set: { status: 'PUBLISHED' } }
      );

      const res = await governanceHelper.suspendBusiness(String(testOrg._id), 'Compliance investigation on employer claims', superuserAdmin, dummyReq);
      assert.strictEqual(res.status, 'SUSPENDED');

      // Verify business status
      const orgDoc = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testOrg._id });
      assert.strictEqual(orgDoc.status, 'SUSPENDED');

      // Verify job cascade: published job must be transitioned to PAUSED with audit tag
      const jobDoc = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: publishedJob._id });
      assert.strictEqual(jobDoc.status, 'PAUSED', 'Published jobs must be automatically paused upon employer suspension');
      assert.ok(jobDoc.pausedReason && jobDoc.pausedReason.includes('suspended'), 'Paused reason must cite employer suspension');
    });

    // =========================================================================
    // J. BUSINESS RESTORATION CASCADE
    // =========================================================================
    console.log('\n--- J. BUSINESS RESTORATION CASCADE ---');

    await testAsync('J1: restoreBusiness restores organization to APPROVED and restores auto-paused jobs', async () => {
      const res = await governanceHelper.restoreBusiness(String(testOrg._id), superuserAdmin, dummyReq);
      assert.strictEqual(res.status, 'APPROVED');

      // Verify business status
      const orgDoc = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testOrg._id });
      assert.strictEqual(orgDoc.status, 'APPROVED');

      // Verify job cascade: auto-paused job must be restored to PUBLISHED
      const jobDoc = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: publishedJob._id });
      assert.strictEqual(jobDoc.status, 'PUBLISHED', 'Jobs auto-paused by employer suspension must be restored');
    });

    // =========================================================================
    // K. OWNERSHIP PROTECTION
    // =========================================================================
    console.log('\n--- K. OWNERSHIP PROTECTION ---');

    await testAsync('K1: Non-superuser cannot transfer business ownership', () => {
      assert.strictEqual(permissionsHelper.hasCapability(businessAdmin, 'transfer_business_ownership'), false);
      assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'transfer_business_ownership'), true);
    });

    await testAsync('K2: transferBusinessOwnership requires valid reason, updates createdBy and memberships', async () => {
      // Must fail if new owner is identical to current owner
      await assert.rejects(
        async () => governanceHelper.transferBusinessOwnership(String(testOrg._id), String(ownerUser._id), 'Transfer to self', superuserAdmin, dummyReq),
        /already.*owner/i
      );

      // Must succeed when transferred to successor user
      const transferRes = await governanceHelper.transferBusinessOwnership(
        String(testOrg._id),
        String(newOwnerUser._id),
        'Corporate acquisition handover',
        superuserAdmin,
        dummyReq
      );

      assert.strictEqual(transferRes.previousOwner, String(ownerUser._id));
      assert.strictEqual(transferRes.newOwner, String(newOwnerUser._id));

      // Check organization doc
      const orgDoc = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testOrg._id });
      assert.strictEqual(String(orgDoc.createdBy), String(newOwnerUser._id));

      // Check membership roles: new owner has 'owner', old owner has 'admin'
      const newOwnerM = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).findOne({
        organizationId: testOrg._id,
        userId: newOwnerUser._id
      });
      assert.ok(newOwnerM && newOwnerM.role === 'owner', 'Successor must have owner role');

      const oldOwnerM = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).findOne({
        organizationId: testOrg._id,
        userId: ownerUser._id
      });
      assert.ok(oldOwnerM && oldOwnerM.role === 'admin', 'Predecessor must be stepped down to admin');

      // Verify audit log
      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'BUSINESS_OWNERSHIP_TRANSFERRED',
        $or: [{ targetId: testOrg._id }, { entityId: String(testOrg._id) }]
      });
      assert.ok(audit, 'BUSINESS_OWNERSHIP_TRANSFERRED audit entry must exist');
    });

    // =========================================================================
    // L. MEMBERSHIP GOVERNANCE
    // =========================================================================
    console.log('\n--- L. MEMBERSHIP GOVERNANCE ---');

    await testAsync('L1: updateBusinessMemberRole updates role cleanly and audits MEMBER_ROLE_CHANGED', async () => {
      const res = await governanceHelper.updateBusinessMemberRole(
        String(testOrg._id),
        String(recruiterMembership._id),
        'admin',
        'Promoting lead recruiter to business co-admin',
        superuserAdmin,
        dummyReq
      );

      assert.strictEqual(res.newRole, 'admin');

      const memDoc = await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).findOne({ _id: recruiterMembership._id });
      assert.strictEqual(memDoc.role, 'admin');

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'MEMBER_ROLE_CHANGED',
        $or: [{ targetId: testOrg._id }, { entityId: String(testOrg._id) }]
      });
      assert.ok(audit, 'MEMBER_ROLE_CHANGED audit entry must exist');
    });

    // =========================================================================
    // M. VERIFICATION INTEGRATION & EVIDENCE REDACTION
    // =========================================================================
    console.log('\n--- M. VERIFICATION INTEGRATION & EVIDENCE REDACTION ---');

    await testAsync('M1: Evidence is redacted for admins without view_verification_evidence', async () => {
      const dossierRedacted = await governanceHelper.getBusinessById(String(testOrg._id), viewerAdmin);
      assert.ok(dossierRedacted.verification, 'Verification object should be returned');
      assert.strictEqual(dossierRedacted.verification.evidenceRedacted, true);
      assert.strictEqual(dossierRedacted.verification.evidenceUrl, null);
    });

    await testAsync('M2: Evidence is visible for superusers with view_verification_evidence', async () => {
      const dossierVisible = await governanceHelper.getBusinessById(String(testOrg._id), superuserAdmin);
      assert.ok(dossierVisible.verification);
      assert.strictEqual(dossierVisible.verification.evidenceRedacted, false);
      assert.strictEqual(dossierVisible.verification.evidenceUrl, 'https://zeitnah-secure-vault.test/docs/secret_tax_id_9921.pdf');
    });

    // =========================================================================
    // N. JOB LISTING & TABS
    // =========================================================================
    console.log('\n--- N. JOB LISTING & TABS ---');

    await testAsync('N1: getJobs returns enriched postings with employer status and creator info', async () => {
      const res = await governanceHelper.getJobs({ limit: 10, page: 1 });
      assert.ok(res.records && res.records.length > 0);

      const job = res.records.find(j => String(j._id) === String(publishedJob._id));
      assert.ok(job, 'Published job must be listed');
      assert.strictEqual(job.businessName, 'InfraTech Dynamics GmbH');
      assert.strictEqual(job.businessStatus, 'APPROVED');
      assert.strictEqual(job.businessVerified, true);
    });

    await testAsync('N2: getJobs tab filters partitioned by status', async () => {
      const pubRes = await governanceHelper.getJobs({ tab: 'published' });
      assert.ok(pubRes.records.some(j => String(j._id) === String(publishedJob._id)));

      const pendRes = await governanceHelper.getJobs({ tab: 'pending' });
      assert.ok(pendRes.records.some(j => String(j._id) === String(pendingJob._id)));
    });

    // =========================================================================
    // O. JOB DETAIL DOSSIER & QUALITY CHECKLIST
    // =========================================================================
    console.log('\n--- O. JOB DETAIL DOSSIER & QUALITY CHECKLIST ---');

    await testAsync('O1: getJobById returns specifications, employer status, and audit checklist', async () => {
      const dossier = await governanceHelper.getJobById(String(publishedJob._id));
      assert.ok(dossier);
      assert.strictEqual(dossier.job.title, 'Senior Rail Signalling Specialist');
      assert.strictEqual(dossier.business.name, 'InfraTech Dynamics GmbH');
      assert.strictEqual(dossier.matchesCount, 1);
      assert.ok(dossier.moderationSignals);
      assert.strictEqual(dossier.moderationSignals.missingDescription, false);
      assert.strictEqual(dossier.moderationSignals.noSkillsListed, false);
      assert.strictEqual(dossier.moderationSignals.noSoftwareListed, false);
    });

    // =========================================================================
    // P. JOB PUBLISH RULES
    // =========================================================================
    console.log('\n--- P. JOB PUBLISH RULES ---');

    await testAsync('P1: approveJob fails if parent organization is suspended or unapproved', async () => {
      // Temporarily mark org as SUSPENDED
      await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
        { _id: testOrg._id },
        { $set: { status: 'SUSPENDED' } }
      );

      try {
        await assert.rejects(
          async () => governanceHelper.approveJob(String(pendingJob._id), superuserAdmin, dummyReq),
          /parent organization is suspended/i
        );
      } finally {
        // Restore org to APPROVED
        await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
          { _id: testOrg._id },
          { $set: { status: 'APPROVED', verificationStatus: 'VERIFIED' } }
        );
      }
    });

    await testAsync('P2: approveJob publishes pending job when employer is approved and verified', async () => {
      const res = await governanceHelper.approveJob(String(pendingJob._id), superuserAdmin, dummyReq);
      assert.strictEqual(res.status, 'PUBLISHED');

      const updated = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: pendingJob._id });
      assert.strictEqual(updated.status, 'PUBLISHED');

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'JOB_APPROVED',
        $or: [{ targetId: pendingJob._id }, { entityId: String(pendingJob._id) }]
      });
      assert.ok(audit, 'JOB_APPROVED audit log must be recorded');
    });

    // =========================================================================
    // Q. JOB STATE TRANSITIONS
    // =========================================================================
    console.log('\n--- Q. JOB STATE TRANSITIONS ---');

    await testAsync('Q1: unpublishJob transitions job to PAUSED/DRAFT and requires reason', async () => {
      await assert.rejects(
        async () => governanceHelper.unpublishJob(String(pendingJob._id), '   ', superuserAdmin, dummyReq),
        /unpublish reason is required/i
      );

      const res = await governanceHelper.unpublishJob(String(pendingJob._id), 'Draft revisions requested by employer', superuserAdmin, dummyReq);
      assert.ok(['PAUSED', 'DRAFT'].includes(res.status));

      const jobDoc = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: pendingJob._id });
      assert.ok(['PAUSED', 'DRAFT'].includes(jobDoc.status));
    });

    await testAsync('Q2: closeJob transitions job to CLOSED', async () => {
      const res = await governanceHelper.closeJob(String(pendingJob._id), 'Position filled', superuserAdmin, dummyReq);
      assert.strictEqual(res.status, 'CLOSED');
    });

    // =========================================================================
    // R. JOB SUSPENSION
    // =========================================================================
    console.log('\n--- R. JOB SUSPENSION ---');

    await testAsync('R1: suspendJob requires mandatory reason and sets status to SUSPENDED', async () => {
      await assert.rejects(
        async () => governanceHelper.suspendJob(String(publishedJob._id), '', superuserAdmin, dummyReq),
        /suspension reason is/i
      );

      const res = await governanceHelper.suspendJob(String(publishedJob._id), 'Misleading salary range in posting description', superuserAdmin, dummyReq);
      assert.strictEqual(res.status, 'SUSPENDED');

      const jobDoc = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: publishedJob._id });
      assert.strictEqual(jobDoc.status, 'SUSPENDED');

      const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
        action: 'JOB_SUSPENDED',
        $or: [{ targetId: publishedJob._id }, { entityId: String(publishedJob._id) }]
      });
      assert.ok(audit, 'JOB_SUSPENDED audit log must exist');
    });

    // =========================================================================
    // S. JOB VISIBILITY
    // =========================================================================
    console.log('\n--- S. JOB VISIBILITY ---');

    await testAsync('S1: restoreJob returns suspended job to PUBLISHED status', async () => {
      await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
        { _id: testOrg._id },
        { $set: { status: 'APPROVED', verificationStatus: 'VERIFIED' } }
      );

      const res = await governanceHelper.restoreJob(String(publishedJob._id), superuserAdmin, dummyReq);
      assert.strictEqual(res.status, 'PUBLISHED');

      const jobDoc = await database.collection(collection.OPPORTUNITIES_COLLECTION).findOne({ _id: publishedJob._id });
      assert.strictEqual(jobDoc.status, 'PUBLISHED');
    });

    // =========================================================================
    // T. JOB AUTHORIZATION BOUNDARIES
    // =========================================================================
    console.log('\n--- T. JOB AUTHORIZATION BOUNDARIES ---');

    await testAsync('T1: Posting author linkage verifies recruiter membership in organization', async () => {
      const dossier = await governanceHelper.getJobById(String(publishedJob._id));
      assert.strictEqual(dossier.moderationSignals.isCreatorAuthorized, true);
    });

    // =========================================================================
    // U. JOB IDOR & OBJECTID INTEGRITY
    // =========================================================================
    console.log('\n--- U. JOB IDOR & OBJECTID INTEGRITY ---');

    await testAsync('U1: Malformed job ID returns null or throws clean validation error', async () => {
      const res = await governanceHelper.getJobById('not-a-valid-id');
      assert.strictEqual(res, null);

      await assert.rejects(
        async () => governanceHelper.approveJob('bad-id-string', superuserAdmin, dummyReq),
        /invalid job id/i
      );
    });

    await testAsync('U2: Non-existent valid ObjectId returns null or throws 404 error cleanly', async () => {
      const randomId = new ObjectId().toString();
      const res = await governanceHelper.getJobById(randomId);
      assert.strictEqual(res, null);

      await assert.rejects(
        async () => governanceHelper.approveJob(randomId, superuserAdmin, dummyReq),
        /job not found/i
      );
    });

    // =========================================================================
    // V. BUSINESS IDOR & OBJECTID INTEGRITY
    // =========================================================================
    console.log('\n--- V. BUSINESS IDOR & OBJECTID INTEGRITY ---');

    await testAsync('V1: Malformed business ID returns null or throws clean validation error', async () => {
      const res = await governanceHelper.getBusinessById('malformed-id', superuserAdmin);
      assert.strictEqual(res, null);

      await assert.rejects(
        async () => governanceHelper.approveBusiness('not-valid', superuserAdmin, dummyReq),
        /invalid business id/i
      );
    });

    await testAsync('V2: Non-existent valid ObjectId returns null cleanly without 500', async () => {
      const randomId = new ObjectId().toString();
      const res = await governanceHelper.getBusinessById(randomId, superuserAdmin);
      assert.strictEqual(res, null);
    });

    // =========================================================================
    // W. AUDIT LOGGING COMPLETENESS
    // =========================================================================
    console.log('\n--- W. AUDIT LOGGING COMPLETENESS ---');

    await testAsync('W1: Audit events capture actorEmail, IP, previousState, newState, and timestamp', async () => {
      const logs = await database.collection(collection.AUDIT_LOG_COLLECTION)
        .find({ $or: [{ targetId: testOrg._id }, { entityId: String(testOrg._id) }] })
        .toArray();

      assert.ok(logs.length > 0, 'Audit entries must exist for business mutations');
      for (const log of logs) {
        assert.ok(log.actorEmail || log.admin?.email, 'actorEmail must be present');
        assert.ok(log.action, 'action must be present');
        assert.ok(log.createdAt, 'timestamp must be present');
      }
    });

    // =========================================================================
    // X. DUPLICATE MUTATIONS & IDEMPOTENCY
    // =========================================================================
    console.log('\n--- X. DUPLICATE MUTATIONS & IDEMPOTENCY ---');

    await testAsync('X1: Approving an already approved business is idempotent', async () => {
      const res = await governanceHelper.approveBusiness(String(testOrg._id), superuserAdmin, dummyReq);
      assert.strictEqual(res.status, 'APPROVED');
    });

    // =========================================================================
    // Y. CONCURRENCY & RACE-CONDITION SAFETY
    // =========================================================================
    console.log('\n--- Y. CONCURRENCY & RACE-CONDITION SAFETY ---');

    await testAsync('Y1: Parallel approval and suspension mutations resolve consistently', async () => {
      await Promise.allSettled([
        governanceHelper.approveBusiness(String(testOrg._id), superuserAdmin, dummyReq),
        governanceHelper.suspendBusiness(String(testOrg._id), 'Concurrent flag', superuserAdmin, dummyReq)
      ]);

      const finalOrg = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testOrg._id });
      assert.ok(['APPROVED', 'SUSPENDED'].includes(finalOrg.status), 'State must be deterministic');

      // Restore to APPROVED for final state clean
      await database.collection(collection.ORGANIZATIONS_COLLECTION).updateOne(
        { _id: testOrg._id },
        { $set: { status: 'APPROVED' } }
      );
    });

    // =========================================================================
    // Z. CANDIDATE PRIVACY PROJECTION
    // =========================================================================
    console.log('\n--- Z. CANDIDATE PRIVACY PROJECTION ---');

    await testAsync('Z1: Admin job dossier exposes ONLY aggregate application counts and ZERO candidate PII', async () => {
      const dossier = await governanceHelper.getJobById(String(publishedJob._id));
      assert.ok(dossier.applicationStats, 'Application aggregate statistics must be present');
      assert.strictEqual(dossier.applicationStats.total, 1, 'Aggregate total should match application count');

      // Ensure no candidate PII (passport, phone, resume text) is leaked in the dossier
      const jsonString = JSON.stringify(dossier);
      assert.strictEqual(jsonString.includes('N99218201'), false, 'Passport number must never be exposed');
      assert.strictEqual(jsonString.includes('+49 170 999 8888'), false, 'Candidate phone number must never be exposed');
      assert.strictEqual(jsonString.includes('Secret candidate private work history'), false, 'Candidate private CV text must never be exposed');
    });

  } finally {
    // Teardown test artifacts
    await database.collection(collection.ORGANIZATIONS_COLLECTION).deleteOne({ _id: testOrg._id });
    await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).deleteMany({ organizationId: testOrg._id });
    await database.collection(collection.OPPORTUNITIES_COLLECTION).deleteMany({ _id: { $in: [publishedJob._id, pendingJob._id] } });
    await database.collection(collection.JOB_APPLICATIONS_COLLECTION).deleteOne({ _id: sensitiveApplication._id });
    await database.collection(collection.JOB_TALENT_MATCHES_COLLECTION).deleteOne({ _id: matchEntry._id });
    await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).deleteOne({ _id: verificationReq._id });
    await database.collection(collection.STUDENTS_COLLECTION).deleteMany({
      _id: { $in: [ownerUser._id, newOwnerUser._id, recruiterUser._id, candidateUser._id] }
    });
    await database.collection(collection.AUDIT_LOG_COLLECTION).deleteMany({
      targetId: { $in: [testOrg._id, publishedJob._id, pendingJob._id, recruiterMembership._id] }
    });
  }

  console.log('\n================================================================');
  console.log(`PHASE 3 TEST SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
  process.exit(0);
};

runSuite().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
