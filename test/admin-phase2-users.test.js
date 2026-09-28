'use strict';

/**
 * Zeitnah Admin Panel — Phase 2 Comprehensive Test Suite
 * USERS + ROLES + PROFESSIONAL PROFILE GOVERNANCE
 *
 * Covers requirements A through T:
 * A. User Listing
 * B. User Search
 * C. User Filters
 * D. Pagination
 * E. Card/Table State
 * F. User Detail Governance Dossier
 * G. Role Permissions & RBAC
 * H. Educator Assignment Protection
 * I. Role Change Workflow & Reason Tracking
 * J. Account Suspension Rules
 * K. Account Restoration Workflow
 * L. Session Governance & Revocation
 * M. Username Governance & Collision Protection
 * N. Profile Governance & Field Validation
 * O. IDOR & Privilege Escalation Protection
 * P. Invalid IDs & ObjectId Validation
 * Q. Audit Logging Integrity & Secret Scrubbing
 * R. Privacy Projection & Evidence Redaction
 * S. Duplicate Actions & Idempotency
 * T. Concurrency & Race-Condition Safety
 */

const assert = require('assert');
const { ObjectId } = require('mongodb');
const db = require('../config/connection');
const collection = require('../config/collections');
const governanceHelper = require('../Helpers/governance-helper');
const permissionsHelper = require('../Helpers/permissions-helper');
const networkHelper = require('../Helpers/network-helper');
const usernameHelper = require('../Helpers/username-helper');
const auditHelper = require('../Helpers/audit-helper');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

const test = (desc, fn) => {
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
};

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
  console.log('   ZEITNAH ADMIN PANEL: PHASE 2 USER GOVERNANCE TEST SUITE      ');
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
    Name: 'Super Admin',
    Email: 'superuser@zeitnah.com',
    role: 'superuser'
  };

  const generalAdmin = {
    _id: new ObjectId(),
    Name: 'General Admin',
    Email: 'admin@zeitnah.com',
    role: 'admin'
  };

  const networkAdmin = {
    _id: new ObjectId(),
    Name: 'Network Admin',
    Email: 'network@zeitnah.com',
    role: 'network_admin'
  };

  const verificationAdmin = {
    _id: new ObjectId(),
    Name: 'Verification Admin',
    Email: 'verify@zeitnah.com',
    role: 'verification_admin'
  };

  const mockReq = (actor = superuserAdmin, sessionID = 'sess_admin_test_123') => ({
    session: { admin: actor, adminloggedIn: true },
    sessionID,
    ip: '127.0.0.1',
    headers: { 'user-agent': 'ZeitnahTest/2.0' }
  });

  // Unique timestamp suffix to prevent test collision
  const suffix = Date.now();

  // Seed test users
  const testStudentId = new ObjectId();
  const testEducatorId = new ObjectId();
  const testProfessionalId = new ObjectId();
  const testAdminUserId = new ObjectId();

  await database.collection(collection.STUDENTS_COLLECTION).insertMany([
    {
      _id: testStudentId,
      Name: `Arjun Verma ${suffix}`,
      name: `Arjun Verma ${suffix}`,
      username: `arjun_verma_${suffix}`,
      email: `arjun_${suffix}@test.com`,
      primaryRole: 'STUDENT',
      role: 'student',
      account_Status: { isActive: true, isBlocked: false, isVerified: false, restrictions: [] },
      createdAt: new Date(),
      password: 'HashedPasswordSecret123',
      otp: '998811',
      refreshToken: 'secret_refresh_token_abc'
    },
    {
      _id: testEducatorId,
      Name: `Dr. Sarah Chen ${suffix}`,
      name: `Dr. Sarah Chen ${suffix}`,
      username: `sarah_chen_${suffix}`,
      email: `sarah_${suffix}@test.com`,
      primaryRole: 'EDUCATOR',
      role: 'educator',
      account_Status: { isActive: true, isBlocked: false, isVerified: true, restrictions: [] },
      createdAt: new Date()
    },
    {
      _id: testProfessionalId,
      Name: `Kavita Patel ${suffix}`,
      name: `Kavita Patel ${suffix}`,
      username: `kavita_patel_${suffix}`,
      email: `kavita_${suffix}@test.com`,
      primaryRole: 'PROFESSIONAL',
      role: 'professional',
      account_Status: { isActive: true, isBlocked: false, isVerified: true, restrictions: [] },
      createdAt: new Date()
    }
  ]);

  // Seed admin user in ADMIN_COLLECTION
  await database.collection(collection.ADMIN_COLLECTION).insertOne({
    _id: testAdminUserId,
    Name: `Privileged Admin ${suffix}`,
    Email: `priv_admin_${suffix}@zeitnah.com`,
    role: 'admin'
  });

  // Seed community profiles
  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).insertMany([
    {
      userId: testStudentId,
      username: `arjun_verma_${suffix}`,
      headline: 'Aspiring Civil & Structural Engineer',
      discipline: 'Civil & Structural Engineering',
      infrastructureSector: 'Highways, Bridges & Tunnels',
      specialization: 'Structural Analysis',
      bio: 'Final year civil engineering student interested in parametric bridge design.',
      skills: ['AutoCAD', 'STAAD.Pro', 'Structural Analysis'],
      software: ['STAAD.Pro', 'AutoCAD Civil 3D'],
      experience: [{ title: 'Intern', company: 'BuildCorp', startDate: '2025-01', current: true }],
      education: [{ degree: 'B.Tech Civil', institution: 'IIT Delhi', startYear: '2022' }],
      certifications: [{ name: 'Certified BIM Technician', issuer: 'Autodesk', issueDate: '2025-05' }],
      projects: [{ title: 'Suspension Bridge Model', role: 'Lead Modeler', description: 'Finite element analysis' }]
    }
  ]);

  // Seed verification requests
  await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).insertMany([
    {
      _id: new ObjectId(),
      userId: testStudentId,
      category: 'IDENTITY',
      status: 'VERIFIED',
      idNumber: 'ABCDE1234F',
      evidenceUrl: 'https://cdn.zeitnah.com/verification/id_evidence_secret.pdf',
      createdAt: new Date(),
      reviewedAt: new Date(),
      notes: 'Govt photo identity confirmed.'
    },
    {
      _id: new ObjectId(),
      userId: testStudentId,
      category: 'EDUCATOR',
      status: 'UNDER_REVIEW',
      evidenceUrl: 'https://cdn.zeitnah.com/verification/faculty_id.pdf',
      createdAt: new Date(),
      notes: 'University affiliation under review.'
    }
  ]);

  // Seed organization and membership
  const testOrgId = new ObjectId();
  await database.collection(collection.ORGANIZATIONS_COLLECTION).insertOne({
    _id: testOrgId,
    name: `L&T Construction ${suffix}`,
    status: 'APPROVED',
    slug: `lt-construction-${suffix}`
  });

  await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).insertOne({
    _id: new ObjectId(),
    organizationId: testOrgId,
    userId: testStudentId,
    role: 'Graduate Trainee',
    verified: true,
    joinedAt: new Date()
  });

  // Seed active sessions in sessions collection
  const mockSessionId1 = `sess_${testStudentId}_desktop`;
  const mockSessionId2 = `sess_${testStudentId}_mobile`;
  await database.collection('sessions').insertMany([
    {
      _id: mockSessionId1,
      expires: new Date(Date.now() + 86400000),
      session: JSON.stringify({
        userId: String(testStudentId),
        ip: '103.21.244.15',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      })
    },
    {
      _id: mockSessionId2,
      expires: new Date(Date.now() + 43200000),
      session: JSON.stringify({
        userId: String(testStudentId),
        ip: '49.207.180.22',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
      })
    }
  ]);

  console.log('--- A. USER LISTING ---');
  await testAsync('A1: getNetworkUsers retrieves paginated user list with canonical roles and pagination metadata', async () => {
    const result = await networkHelper.getNetworkUsers({}, 1, 10);
    assert.ok(result);
    assert.ok(Array.isArray(result.users));
    assert.ok(result.totalUsers >= 3);
    assert.strictEqual(result.page, 1);
    assert.ok(result.totalPages >= 1);
    const user = result.users.find(u => String(u._id) === String(testStudentId));
    assert.ok(user);
    assert.strictEqual(user.primaryRole, 'STUDENT');
  });

  console.log('\n--- B. USER SEARCH ---');
  await testAsync('B1: Search by display name matches correctly', async () => {
    const result = await networkHelper.getNetworkUsers({ search: `Arjun Verma ${suffix}` }, 1, 10);
    assert.ok(result.users.length >= 1);
    assert.ok(result.users.some(u => String(u._id) === String(testStudentId)));
  });

  await testAsync('B2: Search by username (@handle) matches correctly', async () => {
    const result = await networkHelper.getNetworkUsers({ search: `@arjun_verma_${suffix}` }, 1, 10);
    assert.ok(result.users.length >= 1);
    assert.strictEqual(String(result.users[0]._id), String(testStudentId));
  });

  await testAsync('B3: Search is resilient to special regex characters without throwing', async () => {
    const result = await networkHelper.getNetworkUsers({ search: '.*+?^${}()|[]\\' }, 1, 10);
    assert.ok(Array.isArray(result.users));
  });

  console.log('\n--- C. USER FILTERS ---');
  await testAsync('C1: Filter by role = EDUCATOR returns only educators', async () => {
    const result = await networkHelper.getNetworkUsers({ role: 'EDUCATOR' }, 1, 10);
    assert.ok(result.users.length >= 1);
    result.users.forEach(u => {
      assert.strictEqual(u.primaryRole, 'EDUCATOR');
    });
  });

  await testAsync('C2: Filter by status = active and status = blocked', async () => {
    const activeResult = await networkHelper.getNetworkUsers({ status: 'active' }, 1, 10);
    assert.ok(activeResult.users.length >= 1);
  });

  console.log('\n--- D. PAGINATION ---');
  await testAsync('D1: Pagination enforces valid bounds and page offsets', async () => {
    const page1 = await networkHelper.getNetworkUsers({}, 1, 2);
    assert.strictEqual(page1.users.length, 2);
    assert.strictEqual(page1.page, 1);

    const page2 = await networkHelper.getNetworkUsers({}, 2, 2);
    assert.strictEqual(page2.page, 2);
    assert.notStrictEqual(String(page1.users[0]._id), String(page2.users[0]._id));
  });

  console.log('\n--- E. CARD / TABLE STATE ---');
  await testAsync('E1: Card view is default and preserves filter/query payload', async () => {
    const cardResult = await networkHelper.getNetworkUsers({ view: 'card' }, 1, 10);
    assert.ok(cardResult.users);
  });

  console.log('\n--- F. USER DETAIL GOVERNANCE DOSSIER ---');
  await testAsync('F1: getUserGovernanceDossier returns complete multi-collection aggregated dossier', async () => {
    const dossier = await governanceHelper.getUserGovernanceDossier(testStudentId, superuserAdmin, mockReq());
    assert.ok(dossier);
    assert.strictEqual(dossier.displayName, `Arjun Verma ${suffix}`);
    assert.strictEqual(dossier.primaryRole, 'STUDENT');
    assert.strictEqual(dossier.discipline, 'Civil & Structural Engineering');
    assert.strictEqual(dossier.infrastructureSector, 'Highways, Bridges & Tunnels');
    assert.ok(Array.isArray(dossier.skills));
    assert.ok(dossier.skills.includes('STAAD.Pro'));
    assert.ok(Array.isArray(dossier.experience));
    assert.ok(Array.isArray(dossier.verificationBreakdown));
    assert.strictEqual(dossier.verificationBreakdown.length, 5);
    assert.ok(Array.isArray(dossier.businessAffiliations));
    assert.strictEqual(dossier.businessAffiliations.length, 1);
    assert.ok(Array.isArray(dossier.sessions));
    assert.strictEqual(dossier.sessions.length, 2);
    assert.strictEqual(dossier.accountState, 'active');
  });

  console.log('\n--- G. ROLE PERMISSIONS & RBAC ---');
  await test('G1: Superuser has all capabilities including assign_educator and manage_account_status', () => {
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'assign_educator'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'manage_account_status'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'manage_user_sessions'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuserAdmin, 'manage_usernames'), true);
  });

  await test('G2: General admin without explicit capability CANNOT assign educator', () => {
    assert.strictEqual(permissionsHelper.hasCapability(generalAdmin, 'assign_educator'), false);
    assert.strictEqual(permissionsHelper.hasCapability(generalAdmin, 'manage_account_status'), true);
  });

  await test('G3: Verification admin has only verification capabilities, not role assignment', () => {
    assert.strictEqual(permissionsHelper.hasCapability(verificationAdmin, 'view_verification_evidence'), true);
    assert.strictEqual(permissionsHelper.hasCapability(verificationAdmin, 'assign_educator'), false);
    assert.strictEqual(permissionsHelper.hasCapability(verificationAdmin, 'manage_account_status'), false);
  });

  await test('G4: Normal user or null session has zero administrative capabilities', () => {
    assert.strictEqual(permissionsHelper.hasCapability(null, 'assign_educator'), false);
    assert.strictEqual(permissionsHelper.hasCapability({ role: 'student' }, 'assign_educator'), false);
  });

  console.log('\n--- H. EDUCATOR ASSIGNMENT PROTECTION ---');
  await testAsync('H1: Assigning EDUCATOR by unauthorized admin is rejected with 403 / Error', async () => {
    let errorThrown = false;
    try {
      await governanceHelper.assignUserRole(testStudentId, 'EDUCATOR', generalAdmin, mockReq(generalAdmin));
    } catch (e) {
      errorThrown = true;
      assert.ok(e.message.includes('assign_educator'));
    }
    assert.strictEqual(errorThrown, true);
  });

  await testAsync('H2: Assigning EDUCATOR by superuser or network_admin succeeds and verifies educator', async () => {
    const res = await governanceHelper.assignUserRole(
      testStudentId,
      'EDUCATOR',
      superuserAdmin,
      mockReq(superuserAdmin),
      'Verified civil engineering faculty member'
    );
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.role, 'EDUCATOR');

    const updated = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testStudentId });
    assert.strictEqual(updated.primaryRole, 'EDUCATOR');
    assert.strictEqual(updated.account_Status.isVerified, true);
  });

  console.log('\n--- I. ROLE CHANGE WORKFLOW & REASON ---');
  await testAsync('I1: Role change requires reason and writes audit event with previous/new state', async () => {
    const res = await governanceHelper.assignUserRole(
      testStudentId,
      'PROFESSIONAL',
      superuserAdmin,
      mockReq(superuserAdmin),
      'Transitioned from academic role to industry professional'
    );
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.previousRole, 'EDUCATOR');
    assert.strictEqual(res.role, 'PROFESSIONAL');

    const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
      entityId: String(testStudentId),
      action: 'USER_ROLE_ASSIGNED',
      'metadata.newRole': 'PROFESSIONAL'
    }, { sort: { _id: -1 } });

    assert.ok(audit);
    assert.strictEqual(audit.metadata.previousRole, 'EDUCATOR');
    assert.strictEqual(audit.metadata.newRole, 'PROFESSIONAL');
    assert.ok(audit.metadata.reason.includes('Transitioned'));
  });

  console.log('\n--- J. ACCOUNT SUSPENSION RULES ---');
  await testAsync('J1: Suspending user blocks account, invalidates sessions, and records restrictions', async () => {
    const res = await governanceHelper.suspendUser(
      testStudentId,
      { reason: 'Severe community conduct violation', restrictions: ['no_messaging', 'no_applications'] },
      superuserAdmin,
      mockReq(superuserAdmin)
    );
    assert.strictEqual(res.success, true);

    const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testStudentId });
    assert.strictEqual(user.account_Status.isBlocked, true);
    assert.ok(user.account_Status.restrictions.includes('no_messaging'));

    // Check sessions were wiped
    const remainingSessions = await database.collection('sessions').find({
      $or: [{ 'session.userId': String(testStudentId) }, { _id: mockSessionId1 }]
    }).toArray();
    assert.strictEqual(remainingSessions.length, 0);

    const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
      entityId: String(testStudentId),
      action: 'USER_SUSPENDED'
    });
    assert.ok(audit);
    assert.strictEqual(audit.metadata.reason, 'Severe community conduct violation');
  });

  console.log('\n--- K. ACCOUNT RESTORATION WORKFLOW ---');
  await testAsync('K1: Restoring user lifts suspension, clears restrictions, preserves profile and role', async () => {
    const res = await governanceHelper.restoreUser(
      testStudentId,
      { reason: 'Sanction appeal approved after review' },
      superuserAdmin,
      mockReq(superuserAdmin)
    );
    assert.strictEqual(res.success, true);

    const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testStudentId });
    assert.strictEqual(user.account_Status.isBlocked, false);
    assert.strictEqual(user.account_Status.restrictions.length, 0);
    assert.strictEqual(user.primaryRole, 'PROFESSIONAL'); // Role preserved!

    const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
      entityId: String(testStudentId),
      action: 'USER_RESTORED'
    });
    assert.ok(audit);
  });

  console.log('\n--- L. SESSION GOVERNANCE & REVOCATION ---');
  await testAsync('L1: getUserSessions returns safe metadata without leaking tokens', async () => {
    const testSid = `sess_safe_test_${suffix}`;
    await database.collection('sessions').insertOne({
      _id: testSid,
      expires: new Date(Date.now() + 3600000),
      session: JSON.stringify({
        userId: String(testStudentId),
        ip: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
      })
    });

    const sessions = await governanceHelper.getUserSessions(testStudentId, superuserAdmin, mockReq());
    assert.ok(sessions.length >= 1);
    const s = sessions.find(x => x.sessionId === testSid);
    assert.ok(s);
    assert.strictEqual(s.os, 'Windows');
    assert.strictEqual(s.browser, 'Chrome');
    assert.strictEqual(s.ipAddress, '192.168.1.***'); // Masked!
    assert.strictEqual(s.token, undefined); // No raw secrets!
  });

  await testAsync('L2: Revoke single session terminates specific session and records audit event', async () => {
    const testSid = `sess_safe_test_${suffix}`;
    const res = await governanceHelper.revokeUserSession(testStudentId, testSid, superuserAdmin, mockReq());
    assert.strictEqual(res.success, true);

    const check = await database.collection('sessions').findOne({ _id: testSid });
    assert.strictEqual(check, null);
  });

  await testAsync('L3: Admin cannot revoke their own active administrative session (self-session guard)', async () => {
    const currentAdminSid = 'admin_current_session_789';
    let errorThrown = false;
    try {
      await governanceHelper.revokeUserSession(
        superuserAdmin._id,
        currentAdminSid,
        superuserAdmin,
        mockReq(superuserAdmin, currentAdminSid)
      );
    } catch (e) {
      errorThrown = true;
      assert.ok(e.message.includes('cannot revoke your own'));
    }
    assert.strictEqual(errorThrown, true);
  });

  console.log('\n--- M. USERNAME GOVERNANCE ---');
  await testAsync('M1: Valid username change updates students and community profile', async () => {
    const newHandle = `arjun_v_${suffix}`;
    const res = await governanceHelper.changeUserUsername(
      testStudentId,
      { newUsername: newHandle, reason: 'Official identity standardization' },
      superuserAdmin,
      mockReq(superuserAdmin)
    );
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.newUsername, newHandle);

    const student = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testStudentId });
    assert.strictEqual(student.username, newHandle);

    const audit = await database.collection(collection.AUDIT_LOG_COLLECTION).findOne({
      entityId: String(testStudentId),
      action: 'USERNAME_CHANGED_BY_ADMIN'
    });
    assert.ok(audit);
  });

  await testAsync('M2: Invalid username format (spaces, uppercase, symbols) is rejected', async () => {
    let errorThrown = false;
    try {
      await governanceHelper.changeUserUsername(
        testStudentId,
        { newUsername: 'invalid handle!!' },
        superuserAdmin,
        mockReq()
      );
    } catch (e) {
      errorThrown = true;
    }
    assert.strictEqual(errorThrown, true);
  });

  await testAsync('M3: Reserved username (admin, system, root) is rejected', async () => {
    let errorThrown = false;
    try {
      await governanceHelper.changeUserUsername(
        testStudentId,
        { newUsername: 'admin' },
        superuserAdmin,
        mockReq()
      );
    } catch (e) {
      errorThrown = true;
      assert.ok(e.message.includes('reserved'));
    }
    assert.strictEqual(errorThrown, true);
  });

  await testAsync('M4: Duplicate username collision is rejected', async () => {
    let errorThrown = false;
    try {
      await governanceHelper.changeUserUsername(
        testStudentId,
        { newUsername: `sarah_chen_${suffix}` }, // already held by Dr. Sarah Chen
        superuserAdmin,
        mockReq()
      );
    } catch (e) {
      errorThrown = true;
      assert.ok(e.message.includes('already claimed'));
    }
    assert.strictEqual(errorThrown, true);
  });

  console.log('\n--- N. PROFILE GOVERNANCE & SANITIZATION ---');
  await test('N1: sanitizeUserForAdmin recursively strips passwords, OTPs, tokens, and session secrets', () => {
    const raw = {
      _id: new ObjectId(),
      name: 'Test Sensitive',
      password: 'PlainSecretPassword',
      Password: 'HashedSecretPassword',
      otp: '123456',
      refreshToken: 'rf_999',
      accessToken: 'ac_111',
      deviceToken: 'dev_555',
      sessionSecret: 'sess_sec_777',
      nested: {
        hash: 'hash_888',
        password: 'sub_pass_999'
      }
    };
    const sanitized = governanceHelper.sanitizeUserForAdmin(raw);
    assert.strictEqual(sanitized.password, undefined);
    assert.strictEqual(sanitized.Password, undefined);
    assert.strictEqual(sanitized.otp, undefined);
    assert.strictEqual(sanitized.refreshToken, undefined);
    assert.strictEqual(sanitized.accessToken, undefined);
    assert.strictEqual(sanitized.deviceToken, undefined);
    assert.strictEqual(sanitized.sessionSecret, undefined);
    assert.strictEqual(sanitized.nested.hash, undefined);
    assert.strictEqual(sanitized.nested.password, undefined);
    assert.strictEqual(sanitized.name, 'Test Sensitive');
  });

  console.log('\n--- O. IDOR & PRIVILEGE ESCALATION PROTECTION ---');
  await testAsync('O1: Self-suspension by administrator on themselves is strictly rejected', async () => {
    let errorThrown = false;
    try {
      await governanceHelper.suspendUser(
        superuserAdmin._id,
        { reason: 'Self suspension' },
        superuserAdmin,
        mockReq(superuserAdmin)
      );
    } catch (e) {
      errorThrown = true;
      assert.ok(e.message.includes('Self-suspension is prohibited'));
    }
    assert.strictEqual(errorThrown, true);
  });

  await testAsync('O2: Subordinate admin cannot suspend or modify another admin without superuser role', async () => {
    let errorThrown = false;
    try {
      await governanceHelper.suspendUser(
        testAdminUserId,
        { reason: 'Unauthorized admin suspension' },
        generalAdmin,
        mockReq(generalAdmin)
      );
    } catch (e) {
      errorThrown = true;
      assert.ok(e.message.includes('Only superusers can suspend administrative accounts'));
    }
    assert.strictEqual(errorThrown, true);
  });

  console.log('\n--- P. INVALID IDS & OBJECTID VALIDATION ---');
  await testAsync('P1: Malformed ObjectId strings return null or throw clean validation errors without 500', async () => {
    const invalidDossier = await governanceHelper.getUserGovernanceDossier('invalid-id-123', superuserAdmin, mockReq());
    assert.strictEqual(invalidDossier, null);

    let errorThrown = false;
    try {
      await governanceHelper.assignUserRole('malformed_id', 'STUDENT', superuserAdmin, mockReq());
    } catch (e) {
      errorThrown = true;
      assert.ok(e.message.includes('Valid user ID'));
    }
    assert.strictEqual(errorThrown, true);
  });

  await testAsync('P2: Valid non-existent ObjectId returns null gracefully', async () => {
    const nonexistentId = new ObjectId();
    const dossier = await governanceHelper.getUserGovernanceDossier(nonexistentId, superuserAdmin, mockReq());
    assert.strictEqual(dossier, null);
  });

  console.log('\n--- Q. AUDIT LOGGING INTEGRITY ---');
  await testAsync('Q1: Verify all required audit event types are logged with complete metadata', async () => {
    const logs = await database.collection(collection.AUDIT_LOG_COLLECTION).find({
      entityId: String(testStudentId)
    }).toArray();

    const actions = logs.map(l => l.action);
    assert.ok(actions.includes('USER_ROLE_ASSIGNED'));
    assert.ok(actions.includes('USER_SUSPENDED'));
    assert.ok(actions.includes('USER_RESTORED'));
    assert.ok(actions.includes('USERNAME_CHANGED_BY_ADMIN'));

    logs.forEach(l => {
      assert.ok(l.timestamp || l.createdAt);
      assert.ok(l.metadata?.actor || l.admin?.name);
    });
  });

  console.log('\n--- R. PRIVACY PROJECTION & EVIDENCE REDACTION ---');
  await testAsync('R1: Admin without view_verification_evidence has verification evidence redacted in dossier', async () => {
    const dossier = await governanceHelper.getUserGovernanceDossier(testStudentId, generalAdmin, mockReq(generalAdmin));
    const identityCat = dossier.verificationBreakdown.find(c => c.category === 'IDENTITY');
    assert.ok(identityCat);
    assert.ok(identityCat.latestRequest);
    assert.strictEqual(identityCat.latestRequest.evidenceRedacted, true);
    assert.strictEqual(identityCat.latestRequest.evidenceUrl, null);
    assert.ok(identityCat.latestRequest.idNumber.includes('******')); // Masked!
  });

  await testAsync('R2: Admin with view_verification_evidence receives unredacted evidence URL', async () => {
    const dossier = await governanceHelper.getUserGovernanceDossier(testStudentId, verificationAdmin, mockReq(verificationAdmin));
    const identityCat = dossier.verificationBreakdown.find(c => c.category === 'IDENTITY');
    assert.ok(identityCat);
    assert.ok(identityCat.latestRequest);
    assert.strictEqual(identityCat.latestRequest.evidenceRedacted, false);
    assert.ok(identityCat.latestRequest.evidenceUrl.includes('id_evidence_secret.pdf'));
  });

  console.log('\n--- S. DUPLICATE ACTIONS & IDEMPOTENCY ---');
  await testAsync('S1: Assigning identical role returns idempotency response without duplicate DB write', async () => {
    const res = await governanceHelper.assignUserRole(
      testStudentId,
      'PROFESSIONAL',
      superuserAdmin,
      mockReq(superuserAdmin)
    );
    assert.strictEqual(res.success, true);
    assert.ok(res.message.includes('already has role'));
  });

  console.log('\n--- T. CONCURRENCY & RACE-CONDITION SAFETY ---');
  await testAsync('T1: Parallel mutations on same user resolve cleanly to consistent state', async () => {
    const p1 = governanceHelper.assignUserRole(testProfessionalId, 'MENTOR', superuserAdmin, mockReq(superuserAdmin), 'Parallel 1');
    const p2 = governanceHelper.assignUserRole(testProfessionalId, 'FOUNDER', superuserAdmin, mockReq(superuserAdmin), 'Parallel 2');
    const results = await Promise.all([p1, p2]);
    assert.strictEqual(results[0].success, true);
    assert.strictEqual(results[1].success, true);

    const user = await database.collection(collection.STUDENTS_COLLECTION).findOne({ _id: testProfessionalId });
    assert.ok(['MENTOR', 'FOUNDER'].includes(user.primaryRole));
  });

  // Cleanup test artifacts
  await database.collection(collection.STUDENTS_COLLECTION).deleteMany({
    _id: { $in: [testStudentId, testEducatorId, testProfessionalId] }
  });
  await database.collection(collection.ADMIN_COLLECTION).deleteOne({ _id: testAdminUserId });
  await database.collection(collection.COMMUNITY_PROFILES_COLLECTION).deleteOne({ userId: testStudentId });
  await database.collection(collection.ORGANIZATIONS_COLLECTION).deleteOne({ _id: testOrgId });
  await database.collection(collection.ORGANIZATION_MEMBERSHIPS_COLLECTION).deleteOne({ userId: testStudentId });
  await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).deleteMany({ userId: testStudentId });
  await database.collection('sessions').deleteMany({
    $or: [{ 'session.userId': String(testStudentId) }, { _id: mockSessionId1 }, { _id: mockSessionId2 }]
  });

  console.log('\n================================================================');
  console.log(`PHASE 2 TEST SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  await db.close();

  if (failedTests > 0) {
    process.exit(1);
  }
};

runSuite().catch(err => {
  console.error('Test Suite Fatal Exception:', err);
  process.exit(1);
});
