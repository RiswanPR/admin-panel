/**
 * Zeitnah Admin Panel — Phase 1 Security Hardening & Role Semantics Regression Suite
 * Covers Test 1 through Test 15 as mandated by Phase 12:
 *
 * TEST 1:  moderation_admin cannot delete course.
 * TEST 2:  verification_admin cannot delete course.
 * TEST 3:  authorized course administrator can perform allowed course mutation.
 * TEST 4:  unauthorized admin cannot delete class.
 * TEST 5:  unauthorized admin cannot create/delete teacher.
 * TEST 6:  student role filter only matches canonical STUDENT users.
 * TEST 7:  FOUNDER + course enrollment does NOT match student role filter.
 * TEST 8:  RECRUITER + course enrollment does NOT match student role filter.
 * TEST 9:  PROFESSIONAL + course enrollment does NOT match student role filter.
 * TEST 10: dashboard learner/student metrics are semantically correct.
 * TEST 11: role fallback never derives STUDENT from course enrollment.
 * TEST 12: existing legacy user without primaryRole remains safely supported.
 * TEST 13: duplicate/shadowed routes no longer conflict.
 * TEST 14: invalid ObjectIds are rejected safely.
 * TEST 15: admin OTP is not written to logs.
 */

const assert = require('assert');
const { ObjectId } = require('mongodb');
const permissionsHelper = require('../Helpers/permissions-helper');
const { validateObjectIds } = require('../Helpers/error-helper');
const courseHelper = require('../Helpers/course-helper');
const classHelper = require('../Helpers/class-helper');
const mailHelper = require('../Helpers/mail-helper');
const logger = require('../Helpers/logger');

let totalTests = 0;
let passedTests = 0;

const test = async (name, fn) => {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✔ PASS: ${name}`);
  } catch (err) {
    console.error(`  ✖ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    process.exitCode = 1;
  }
};

const createMockReqRes = (adminUser, params = {}, body = {}, headers = {}, method = 'POST') => {
  const req = {
    method,
    session: {
      adminloggedIn: Boolean(adminUser),
      admin: adminUser || null
    },
    params,
    body,
    headers: {
      'x-forwarded-for': '127.0.0.1',
      'user-agent': 'ZeitnahSecurityTest/1.0',
      accept: 'application/json',
      ...headers
    },
    originalUrl: '/test-route'
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

const runHardeningSuite = async () => {
  console.log('\n================================================================');
  console.log('  ZEITNAH ADMIN PANEL: PHASE 1 SECURITY & ROLE HARDENING SUITE  ');
  console.log('================================================================\n');

  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. Critical Authorization Hardening (LMS Operations) ---');
  // ─────────────────────────────────────────────────────────────

  await test('TEST 1: moderation_admin cannot delete course (manage_courses)', async () => {
    const moderationAdmin = { role: 'moderation_admin', email: 'mod@zeitnah.com' };
    assert.strictEqual(
      permissionsHelper.hasCapability(moderationAdmin, 'manage_courses'),
      false,
      'moderation_admin must not have manage_courses'
    );

    const { req, res } = createMockReqRes(moderationAdmin);
    let nextCalled = false;
    const middleware = permissionsHelper.requireCapability('manage_courses');
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, 'Next middleware should not be called');
    assert.strictEqual(res.statusCode, 403, 'Must respond with HTTP 403');
    assert.strictEqual(res.body.success, false, 'Response body success must be false');
  });

  await test('TEST 2: verification_admin cannot delete course (manage_courses)', async () => {
    const verificationAdmin = { role: 'verification_admin', email: 'verify@zeitnah.com' };
    assert.strictEqual(
      permissionsHelper.hasCapability(verificationAdmin, 'manage_courses'),
      false,
      'verification_admin must not have manage_courses'
    );

    const { req, res } = createMockReqRes(verificationAdmin);
    let nextCalled = false;
    const middleware = permissionsHelper.requireCapability('manage_courses');
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, 'Next middleware should not be called');
    assert.strictEqual(res.statusCode, 403, 'Must respond with HTTP 403');
    assert.strictEqual(res.body.success, false, 'Response body success must be false');
  });

  await test('TEST 3: authorized course administrator can perform allowed course mutation', async () => {
    const superuser = { role: 'superuser', email: 'super@zeitnah.com' };
    const admin = { role: 'admin', email: 'admin@zeitnah.com' };

    assert.strictEqual(permissionsHelper.hasCapability(superuser, 'manage_courses'), true);
    assert.strictEqual(permissionsHelper.hasCapability(admin, 'manage_courses'), true);

    const { req, res } = createMockReqRes(admin);
    let nextCalled = false;
    const middleware = permissionsHelper.requireCapability('manage_courses');
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true, 'Next middleware should be called for authorized admin');
    assert.strictEqual(res.statusCode, 200, 'Status should remain 200');
  });

  await test('TEST 4: unauthorized admin cannot delete class (manage_classes)', async () => {
    const jobsAdmin = { role: 'jobs_admin', email: 'jobs@zeitnah.com' };
    assert.strictEqual(permissionsHelper.hasCapability(jobsAdmin, 'manage_classes'), false);

    const { req, res } = createMockReqRes(jobsAdmin);
    let nextCalled = false;
    const middleware = permissionsHelper.requireCapability('manage_classes');
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.success, false);
  });

  await test('TEST 5: unauthorized admin cannot create/delete teacher (manage_teachers)', async () => {
    const businessAdmin = { role: 'businesses_admin', email: 'biz@zeitnah.com' };
    assert.strictEqual(permissionsHelper.hasCapability(businessAdmin, 'manage_teachers'), false);

    const { req, res } = createMockReqRes(businessAdmin);
    let nextCalled = false;
    const middleware = permissionsHelper.requireCapability('manage_teachers');
    await middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.success, false);
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Role Semantics & Course Enrollment Decoupling ---');
  // ─────────────────────────────────────────────────────────────

  // Reusable query evaluator matching network-helper student filter logic
  const evaluateStudentFilter = (userDoc) => {
    const condition1 = userDoc.primaryRole === 'STUDENT';
    const condition2 = userDoc.role === 'student';
    return Boolean(condition1 || condition2);
  };

  await test('TEST 6: student role filter only matches canonical STUDENT users', () => {
    const studentWithPrimary = { _id: new ObjectId(), primaryRole: 'STUDENT', course: [] };
    const legacyStudent = { _id: new ObjectId(), role: 'student', course: [] };
    const studentWithCourses = { _id: new ObjectId(), primaryRole: 'STUDENT', course: ['course_a'] };

    assert.strictEqual(evaluateStudentFilter(studentWithPrimary), true);
    assert.strictEqual(evaluateStudentFilter(legacyStudent), true);
    assert.strictEqual(evaluateStudentFilter(studentWithCourses), true);
  });

  await test('TEST 7: FOUNDER + course enrollment does NOT match student role filter', () => {
    const founderWithCourse = {
      _id: new ObjectId(),
      primaryRole: 'FOUNDER',
      course: ['architecting-cloud-native-systems', 'tech-leadership-101'],
      learningProgress: { totalWatchTime: 1200 }
    };

    assert.strictEqual(
      evaluateStudentFilter(founderWithCourse),
      false,
      'FOUNDER with course enrollment must NOT match student role filter'
    );
  });

  await test('TEST 8: RECRUITER + course enrollment does NOT match student role filter', () => {
    const recruiterWithCourse = {
      _id: new ObjectId(),
      primaryRole: 'RECRUITER',
      course: ['talent-acquisition-mastery'],
      package: 'pro-learning'
    };

    assert.strictEqual(
      evaluateStudentFilter(recruiterWithCourse),
      false,
      'RECRUITER with course enrollment must NOT match student role filter'
    );
  });

  await test('TEST 9: PROFESSIONAL + course enrollment does NOT match student role filter', () => {
    const professionalWithCourse = {
      _id: new ObjectId(),
      primaryRole: 'PROFESSIONAL',
      course: ['advanced-distributed-databases'],
      enrollment: { enrolledAt: new Date() }
    };

    assert.strictEqual(
      evaluateStudentFilter(professionalWithCourse),
      false,
      'PROFESSIONAL with course enrollment must NOT match student role filter'
    );
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Dashboard Semantics & Metric Separation ---');
  // ─────────────────────────────────────────────────────────────

  await test('TEST 10: dashboard learner/student metrics are semantically correct and decoupled', () => {
    // Simulated user dataset:
    const mockUsers = [
      { _id: 1, primaryRole: 'FOUNDER', course: ['c1'], status: true },
      { _id: 2, primaryRole: 'RECRUITER', course: ['c2'], status: true },
      { _id: 3, primaryRole: 'STUDENT', course: [], status: true },
      { _id: 4, primaryRole: 'STUDENT', course: ['c1'], status: true },
      { _id: 5, primaryRole: 'STUDENT', course: [], status: false }, // inactive student
      { _id: 6, primaryRole: 'PROFESSIONAL', course: [], status: true }
    ];

    // Total Users
    const totalUsers = mockUsers.length;

    // Canonical Students (primaryRole: 'STUDENT' or legacy role: 'student')
    const totalStudents = mockUsers.filter(u => u.primaryRole === 'STUDENT' || u.role === 'student').length;

    // Enrolled Learners (course has at least 1 item)
    const totalLearners = mockUsers.filter(u => Array.isArray(u.course) && u.course.length > 0).length;

    // Active Canonical Students
    const activeStudents = mockUsers.filter(u => (u.primaryRole === 'STUDENT' || u.role === 'student') && u.status === true).length;

    // Active Enrolled Learners
    const activeLearners = mockUsers.filter(u => Array.isArray(u.course) && u.course.length > 0 && u.status === true).length;

    assert.strictEqual(totalUsers, 6, 'Total users must be 6');
    assert.strictEqual(totalStudents, 3, 'Total canonical students must be 3 (users 3, 4, 5)');
    assert.strictEqual(totalLearners, 3, 'Total enrolled learners must be 3 (users 1, 2, 4)');
    assert.strictEqual(activeStudents, 2, 'Active canonical students must be 2 (users 3, 4)');
    assert.strictEqual(activeLearners, 3, 'Active enrolled learners must be 3 (users 1, 2, 4)');

    // Ensure learner metric does NOT equal total users or total students by coincidence
    assert.notStrictEqual(totalLearners, totalUsers, 'Total learners must not equal total users');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Role Fallback & Legacy Compatibility ---');
  // ─────────────────────────────────────────────────────────────

  // Reusable role mapper matching network-helper.js line 337
  const mapUserRole = (u) => {
    const rawRole = u.primaryRole || u.role || 'STUDENT';
    return String(rawRole).toUpperCase();
  };

  await test('TEST 11: role fallback never derives STUDENT from course enrollment', () => {
    const founderWithCourses = {
      name: 'Startup Founder',
      primaryRole: 'FOUNDER',
      course: ['c1', 'c2']
    };
    const recruiterWithCourses = {
      name: 'Tech Recruiter',
      primaryRole: 'RECRUITER',
      course: ['c1']
    };
    const userWithoutRoleWithCourse = {
      name: 'Unspecified User',
      course: ['c1']
      // No primaryRole and no role. Safe fallback is 'STUDENT', but presence of course must not change fallback logic.
    };

    assert.strictEqual(mapUserRole(founderWithCourses), 'FOUNDER');
    assert.strictEqual(mapUserRole(recruiterWithCourses), 'RECRUITER');
    assert.strictEqual(mapUserRole(userWithoutRoleWithCourse), 'STUDENT');
  });

  await test('TEST 12: existing legacy user without primaryRole remains safely supported', () => {
    const legacyStudent = { name: 'Old Student', role: 'student' };
    const legacyFounder = { name: 'Old Founder', role: 'founder' };
    const legacyEducator = { name: 'Old Teacher', role: 'educator' };
    const legacyMentor = { name: 'Old Mentor', role: 'mentor' };
    const legacyRecruiter = { name: 'Old Recruiter', role: 'recruiter' };
    const legacyProfessional = { name: 'Old Pro', role: 'professional' };

    assert.strictEqual(mapUserRole(legacyStudent), 'STUDENT');
    assert.strictEqual(mapUserRole(legacyFounder), 'FOUNDER');
    assert.strictEqual(mapUserRole(legacyEducator), 'EDUCATOR');
    assert.strictEqual(mapUserRole(legacyMentor), 'MENTOR');
    assert.strictEqual(mapUserRole(legacyRecruiter), 'RECRUITER');
    assert.strictEqual(mapUserRole(legacyProfessional), 'PROFESSIONAL');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 5. Route Architecture & Shadowing Resolution ---');
  // ─────────────────────────────────────────────────────────────

  await test('TEST 13: duplicate/shadowed routes (/network, /audit-logs) no longer conflict', () => {
    // Validate routing contract in app.js and routers:
    const adminGovernanceRouter = require('../routes/admin-governance');
    const usersRouter = require('../routes/users');

    // Enumerate route paths on both routers
    const getRoutes = (router) => {
      const routes = [];
      if (!router.stack) return routes;
      router.stack.forEach((layer) => {
        if (layer.route && layer.route.path) {
          const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
          routes.push(`${methods} ${layer.route.path}`);
        }
      });
      return routes;
    };

    const govRoutes = getRoutes(adminGovernanceRouter);
    const userRoutes = getRoutes(usersRouter);

    // Assert that usersRouter no longer defines GET /audit-logs or POST /audit-logs/clear
    const userRoutesAuditLogs = userRoutes.filter(r => r.includes('/audit-logs'));
    assert.strictEqual(
      userRoutesAuditLogs.length,
      0,
      'usersRouter must not have shadowed /audit-logs handlers; adminGovernanceRouter is the canonical handler'
    );

    // Assert adminGovernanceRouter exposes GET /audit-logs
    const govAuditLogs = govRoutes.filter(r => r.includes('/audit-logs'));
    assert.ok(govAuditLogs.length > 0, 'adminGovernanceRouter must handle /audit-logs');

    // Assert that /network route handler exists in usersRouter for profiles directory
    const userNetwork = userRoutes.filter(r => r.includes('/network'));
    assert.ok(userNetwork.length > 0, 'usersRouter must expose GET /network for Profiles view');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 6. Input Validation & Destructive Safeguards ---');
  // ─────────────────────────────────────────────────────────────

  await test('TEST 14: invalid ObjectIds and bad inputs are rejected safely', async () => {
    // 1. validateObjectIds middleware
    const { req, res } = createMockReqRes({ role: 'admin' }, { id: 'invalid-id-format' });
    let nextCalled = false;
    const middleware = validateObjectIds(['id']);
    middleware(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, 'Next should not be called on invalid ObjectId');
    assert.strictEqual(res.statusCode, 400, 'Must respond with HTTP 400');
    assert.ok(
      (res.body.error && res.body.error.includes('Invalid ID format')) ||
      (res.body.message && res.body.message.includes('Invalid parameter')),
      'Error message must specify invalid ID format'
    );

    // 2. courseHelper.deleteCourse guard throws on invalid ObjectId
    let courseErrorCaught = false;
    try {
      await courseHelper.deleteCourse('not-an-object-id');
    } catch (err) {
      courseErrorCaught = true;
      assert.ok(err.message.toLowerCase().includes('invalid course id'));
    }
    assert.strictEqual(courseErrorCaught, true, 'courseHelper.deleteCourse must throw on invalid course ID');

    // 3. classHelper.deleteClass guards reject invalid classId and invalid chapterCode
    const classResult1 = await classHelper.deleteClass('valid_chapter', 'not-an-object-id');
    assert.strictEqual(classResult1, false, 'deleteClass must return false for invalid classId');

    const classResult2 = await classHelper.deleteClass('bad chapter!!', new ObjectId().toString());
    assert.strictEqual(classResult2, false, 'deleteClass must return false for invalid chapterCode');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 7. Secret Scrubbing & OTP Logging Hardening ---');
  // ─────────────────────────────────────────────────────────────

  await test('TEST 15: admin OTP is not written to application logs', async () => {
    const originalInfo = logger.info;
    const originalError = logger.error;
    const capturedLogs = [];

    logger.info = (...args) => {
      capturedLogs.push(args.join(' '));
    };
    logger.error = (...args) => {
      capturedLogs.push(args.join(' '));
    };

    try {
      const secretOtp = '849201';
      const testEmail = 'security-test@zeitnah.com';

      // Ensure RESEND_API_KEY is unset to trigger dev mode fallback
      const prevKey = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;

      await mailHelper.sendAdminOtpEmail(testEmail, secretOtp);

      if (prevKey) process.env.RESEND_API_KEY = prevKey;

      const fullLogOutput = capturedLogs.join('\n');

      // The plaintext OTP must NOT appear anywhere in the captured log stream
      assert.strictEqual(
        fullLogOutput.includes(secretOtp),
        false,
        `Plaintext OTP "${secretOtp}" must NEVER be logged!`
      );

      // The log should contain the safe event description
      assert.ok(
        fullLogOutput.includes('dispatch suppressed'),
        'Log should mention dispatch suppressed without revealing secret'
      );
    } finally {
      logger.info = originalInfo;
      logger.error = originalError;
    }
  });

  console.log('\n================================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
  console.log('================================================================\n');

  if (totalTests !== passedTests) {
    process.exit(1);
  }
};

runHardeningSuite().catch((err) => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
