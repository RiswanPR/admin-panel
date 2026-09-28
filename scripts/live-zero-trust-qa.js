/**
 * Zeitnah Admin Panel — Live Zero-Trust QA Test Engine
 * Executes live HTTP requests against running Express server on http://127.0.0.1:2000
 */

const http = require('http');
const assert = require('assert');
const { ObjectId } = require('mongodb');
const signature = require('cookie-signature');
const db = require('../config/connection');
const collection = require('../config/collections');

const BASE_URL = 'http://127.0.0.1:2000';
const SESSION_SECRET = process.env.SESSION_SECRET || '1f3a08062f2e2bd13b3d7d8aec8357d7c0b7c39123d93204d4a6235d07a34831db03766bb1148ac3840d1d646fb37445f7c39af9efee7c8f403bdc4dfef90cb1';

// HTTP Request Helper
const makeRequest = (options, postData = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path || '/', BASE_URL);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Zeitnah-QA-Engine/1.0',
        ...(options.headers || {})
      }
    };

    if (postData) {
      if (typeof postData === 'object' && !reqOptions.headers['Content-Type']) {
        reqOptions.headers['Content-Type'] = 'application/json';
        postData = JSON.stringify(postData);
      }
      reqOptions.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json
        });
      });
    });

    req.on('error', (err) => reject(err));

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
};

// QA Test Suite Runner
const testResults = {
  total: 0,
  passed: 0,
  failed: 0,
  failures: []
};

const runTest = async (category, name, fn) => {
  testResults.total++;
  process.stdout.write(`  [${category}] ${name} ... `);
  try {
    await fn();
    testResults.passed++;
    console.log('✔ PASS');
  } catch (err) {
    testResults.failed++;
    console.log('✖ FAIL');
    console.error(`     Error: ${err.message}`);
    testResults.failures.push({ category, name, error: err.message });
  }
};

const createSessionInDb = async (database, sid, adminData) => {
  const sessionDoc = {
    _id: sid,
    session: JSON.stringify({
      cookie: {
        originalMaxAge: 86400000,
        expires: new Date(Date.now() + 86400000).toISOString(),
        secure: false,
        httpOnly: true,
        path: '/',
        sameSite: 'lax'
      },
      adminloggedIn: true,
      admin: adminData
    }),
    expires: new Date(Date.now() + 86400000)
  };
  await database.collection('sessions').updateOne(
    { _id: sid },
    { $set: sessionDoc },
    { upsert: true }
  );
  return `zeitnah.sid=s:${signature.sign(sid, SESSION_SECRET)}`;
};

const main = async () => {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: LIVE ZERO-TRUST QA VALIDATION RUNNER     ');
  console.log('================================================================\n');

  // Connect to DB directly for fixtures and verification
  await new Promise((resolve, reject) => {
    db.connect((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  const database = db.get();

  // Create Fixture Users & Admins for Testing
  const superuserSid = 'qa-superuser-' + Date.now();
  const superuserCookie = await createSessionInDb(database, superuserSid, {
    _id: new ObjectId(),
    Name: 'QA Super Admin',
    Email: 'super-qa@zeitnah.com',
    role: 'superuser'
  });

  const generalAdminSid = 'qa-admin-' + Date.now();
  const generalAdminCookie = await createSessionInDb(database, generalAdminSid, {
    _id: new ObjectId(),
    Name: 'QA General Admin',
    Email: 'admin-qa@zeitnah.com',
    role: 'admin'
  });

  const verificationAdminSid = 'qa-verif-admin-' + Date.now();
  const verificationAdminCookie = await createSessionInDb(database, verificationAdminSid, {
    _id: new ObjectId(),
    Name: 'QA Verification Admin',
    Email: 'verif-qa@zeitnah.com',
    role: 'verification_admin'
  });

  const businessAdminSid = 'qa-biz-admin-' + Date.now();
  const businessAdminCookie = await createSessionInDb(database, businessAdminSid, {
    _id: new ObjectId(),
    Name: 'QA Business Admin',
    Email: 'biz-qa@zeitnah.com',
    role: 'business_admin'
  });

  // Seed fixture test records
  const testStudentId = new ObjectId();
  await database.collection(collection.STUDENTS_COLLECTION).insertOne({
    _id: testStudentId,
    Name: 'QA Candidate Student',
    Email: 'qa-student@zeitnah.com',
    primaryRole: 'STUDENT',
    role: 'student',
    account_Status: { isActive: true },
    status: true,
    createdAt: new Date()
  });

  const testBusinessId = new ObjectId();
  await database.collection(collection.ORGANIZATIONS_COLLECTION).insertOne({
    _id: testBusinessId,
    name: 'QA Infrastructure Engineering Ltd',
    slug: 'qa-infra-' + Date.now(),
    ownerId: testStudentId,
    ownerEmail: 'qa-student@zeitnah.com',
    ownerName: 'QA Candidate Student',
    ownerRole: 'FOUNDER',
    industry: 'Highways & Bridges',
    status: 'PENDING',
    createdAt: new Date()
  });

  const testJobId = new ObjectId();
  await database.collection(collection.OPPORTUNITIES_COLLECTION).insertOne({
    _id: testJobId,
    title: 'Senior Geotechnical Engineer',
    organizationId: testBusinessId,
    organizationName: 'QA Infrastructure Engineering Ltd',
    discipline: 'Geotechnical Engineering',
    status: 'PUBLISHED',
    workMode: 'HYBRID',
    location: 'Mumbai, MH',
    createdAt: new Date()
  });

  const testVerificationId = new ObjectId();
  await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).insertOne({
    _id: testVerificationId,
    targetType: 'STUDENT',
    targetId: testStudentId,
    targetName: 'QA Candidate Student',
    targetEmail: 'qa-student@zeitnah.com',
    category: 'IDENTITY',
    idNumber: '9876543210',
    evidenceUrl: 'https://zeitnah.s3.amazonaws.com/sensitive-docs/passport.pdf',
    status: 'PENDING',
    createdAt: new Date()
  });

  const testReportId = new ObjectId();
  await database.collection(collection.MODERATION_REPORTS_COLLECTION).insertOne({
    _id: testReportId,
    targetType: 'USER',
    targetId: String(testStudentId),
    reason: 'Suspicious profile credential activity',
    status: 'PENDING',
    reportedBy: 'qa-reporter@zeitnah.com',
    createdAt: new Date()
  });

  console.log('✅ QA Fixtures seeded successfully.\n');

  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. LIVE ADMIN BROWSER QA (PAGE LOADS & CARD VIEW DEFAULT) ---');
  // ─────────────────────────────────────────────────────────────

  const pagesToTest = [
    { name: 'Dashboard', path: '/' },
    { name: 'Network Users', path: '/admin/network/users' },
    { name: 'Network Profiles', path: '/network' },
    { name: 'Role Governance', path: '/admins' },
    { name: 'Businesses', path: '/admin/businesses' },
    { name: 'Jobs Governance', path: '/admin/jobs' },
    { name: 'Verification Review', path: '/admin/verification' },
    { name: 'Moderation Center', path: '/admin/moderation' },
    { name: 'Audit Logs', path: '/admin/audit-logs' },
    { name: 'Error Reports', path: '/admin/error-reports' },
    { name: 'Platform Analytics', path: '/admin/analytics' },
    { name: 'Settings', path: '/settings' }
  ];

  for (const p of pagesToTest) {
    await runTest('Page Load', `${p.name} (${p.path}) loads 200 OK without errors`, async () => {
      const res = await makeRequest({
        path: p.path,
        headers: { Cookie: superuserCookie }
      });
      assert.strictEqual(res.statusCode, 200, `Expected 200 OK for ${p.path}, got ${res.statusCode}`);
      assert.ok(!res.body.includes('Cannot read properties of undefined'), 'No template undefined errors');
      assert.ok(!res.body.includes('Error: Failed to lookup view'), 'No missing template view errors');
    });
  }

  await runTest('Card View Default', 'Listing pages render Card View as default when view query is absent', async () => {
    const res = await makeRequest({
      path: '/admin/businesses',
      headers: { Cookie: superuserCookie }
    });
    assert.strictEqual(res.statusCode, 200);
    // Card view active, table view hidden (d-none)
    assert.ok(res.body.includes('data-section="businesses"'), 'Businesses listing rendered');
    assert.ok(res.body.includes('admin-cards-container'), 'Admin cards container present');
    assert.ok(res.body.includes('id="businessesTableView"') && res.body.includes('admin-table-container d-none'), 'Table view is hidden by default');
  });

  await runTest('Table View Explicit', 'Explicit ?view=table activates Table View container', async () => {
    const res = await makeRequest({
      path: '/admin/businesses?view=table',
      headers: { Cookie: superuserCookie }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.includes('id="businessesCardView" data-section="businesses"') && res.body.includes('admin-cards-container d-none'), 'Card view is hidden when ?view=table');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. PRIVILEGE & RBAC ENFORCEMENT ---');
  // ─────────────────────────────────────────────────────────────

  await runTest('RBAC', 'Unauthenticated request to protected route is redirected or returns 401', async () => {
    const res = await makeRequest({ path: '/admin/jobs' });
    assert.ok(res.statusCode === 302 || res.statusCode === 401);
  });

  await runTest('RBAC', 'Verification Admin CANNOT approve businesses (Returns 403 Forbidden)', async () => {
    const res = await makeRequest({
      path: `/admin/businesses/${testBusinessId}/approve`,
      method: 'POST',
      headers: {
        Cookie: verificationAdminCookie,
        Accept: 'application/json'
      }
    }, {});
    assert.strictEqual(res.statusCode, 403, `Expected 403 Forbidden, got ${res.statusCode}`);
    assert.ok(res.json?.message?.includes('Permission denied') || res.json?.success === false);
  });

  await runTest('RBAC', 'Business Admin CANNOT modify AI configuration (Returns 403 Forbidden)', async () => {
    const res = await makeRequest({
      path: '/admin/ai/config',
      method: 'POST',
      headers: {
        Cookie: businessAdminCookie,
        Accept: 'application/json'
      }
    }, { weights: { experience: 0.5 } });
    assert.strictEqual(res.statusCode, 403);
  });

  await runTest('RBAC', 'General Admin without assign_educator CANNOT promote user to EDUCATOR', async () => {
    const limitedAdminCookie = await createSessionInDb(database, 'limited-admin-' + Date.now(), {
      _id: new ObjectId(),
      Name: 'Limited Admin',
      Email: 'limited@zeitnah.com',
      role: 'moderation_admin' // moderation admin has no assign_educator
    });

    const res = await makeRequest({
      path: `/admin/network/users/${testStudentId}/role`,
      method: 'POST',
      headers: {
        Cookie: limitedAdminCookie,
        Accept: 'application/json'
      }
    }, { role: 'EDUCATOR' });
    assert.strictEqual(res.statusCode, 403);
  });

  await runTest('RBAC', 'Superuser CAN promote user to EDUCATOR and records previous/new state', async () => {
    const res = await makeRequest({
      path: `/admin/network/users/${testStudentId}/role`,
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, { role: 'EDUCATOR' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.success, true);
    assert.strictEqual(res.json.newRole, 'EDUCATOR');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. IDOR & OBJECTID INTEGRITY ---');
  // ─────────────────────────────────────────────────────────────

  await runTest('IDOR', 'Malformed/Invalid ObjectId in URL parameter returns 400 Bad Request', async () => {
    const res = await makeRequest({
      path: '/admin/businesses/not-a-valid-object-id/approve',
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, {});
    assert.strictEqual(res.statusCode, 400, `Expected 400 Bad Request, got ${res.statusCode}`);
    assert.ok(res.json?.message?.includes('Invalid identifier'));
  });

  await runTest('IDOR', 'Non-existent valid ObjectId returns 404 Not Found without leaking details', async () => {
    const nonExistentId = new ObjectId().toString();
    const res = await makeRequest({
      path: `/admin/verification/${nonExistentId}`,
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    });
    assert.strictEqual(res.statusCode, 404);
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. EVIDENCE PROTECTION & PRIVACY ---');
  // ─────────────────────────────────────────────────────────────

  await runTest('Privacy', 'Superuser (with view_verification_evidence) sees raw evidence document URL', async () => {
    const res = await makeRequest({
      path: `/admin/verification/${testVerificationId}`,
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.details.evidenceRedacted, false);
    assert.ok(res.json.details.evidenceUrl.includes('passport.pdf'));
  });

  await runTest('Privacy', 'General Admin (WITHOUT view_verification_evidence) receives redacted evidence', async () => {
    const res = await makeRequest({
      path: `/admin/verification/${testVerificationId}`,
      headers: {
        Cookie: generalAdminCookie,
        Accept: 'application/json'
      }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.details.evidenceRedacted, true);
    assert.strictEqual(res.json.details.evidenceUrl, null);
    assert.strictEqual(res.json.details.idNumber, '98******10');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 5. BUSINESS & MODERATION ACTION MUTATIONS ---');
  // ─────────────────────────────────────────────────────────────

  await runTest('Business Mutation', 'Superuser can approve business entity', async () => {
    const res = await makeRequest({
      path: `/admin/businesses/${testBusinessId}/approve`,
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.success, true);

    const doc = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testBusinessId });
    assert.strictEqual(doc.status, 'APPROVED');
  });

  await runTest('Business Mutation', 'Superuser can suspend business with reason', async () => {
    const res = await makeRequest({
      path: `/admin/businesses/${testBusinessId}/suspend`,
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, { reason: 'Compliance audit pending' });
    assert.strictEqual(res.statusCode, 200);

    const doc = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testBusinessId });
    assert.strictEqual(doc.status, 'SUSPENDED');
  });

  await runTest('Business Mutation', 'Superuser can restore suspended business', async () => {
    const res = await makeRequest({
      path: `/admin/businesses/${testBusinessId}/restore`,
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, {});
    assert.strictEqual(res.statusCode, 200);

    const doc = await database.collection(collection.ORGANIZATIONS_COLLECTION).findOne({ _id: testBusinessId });
    assert.strictEqual(doc.status, 'APPROVED');
  });

  await runTest('Moderation Mutation', 'Superuser can resolve moderation report', async () => {
    const res = await makeRequest({
      path: `/admin/moderation/reports/${testReportId}/resolve`,
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, {
      status: 'RESOLVED',
      actionTaken: 'WARNING_ISSUED',
      moderatorNotes: 'Addressed during zero-trust live QA run'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.success, true);
  });

  await runTest('Verification Mutation', 'Superuser can approve verification request', async () => {
    const res = await makeRequest({
      path: `/admin/verification/${testVerificationId}/review`,
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, {
      status: 'VERIFIED',
      notes: 'Credentials validated via authoritative database'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.status, 'VERIFIED');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 6. AUDIT LOG & SECRET SCRUBBING VERIFICATION ---');
  // ─────────────────────────────────────────────────────────────

  await runTest('Audit Trail', 'Every privileged mutation generated an immutable audit log entry', async () => {
    const logs = await database.collection(collection.AUDIT_LOG_COLLECTION)
      .find({ 'admin.email': 'super-qa@zeitnah.com' })
      .toArray();
    assert.ok(logs.length >= 4, `Expected at least 4 audit logs, got ${logs.length}`);

    for (const log of logs) {
      assert.ok(log.action, 'Audit action is recorded');
      assert.ok(log.entityType, 'Entity type is recorded');
      assert.ok(log.status, 'Status is recorded');
      assert.ok(log.createdAt, 'Timestamp is recorded');

      // Verify NO passwords, tokens, or raw secrets are present anywhere in metadata
      const jsonStr = JSON.stringify(log);
      assert.ok(!jsonStr.includes('superSecretPassword'), 'No passwords logged');
      assert.ok(!jsonStr.includes('Bearer eyJ'), 'No bearer tokens logged');
    }
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 7. ERROR REPORTING & TELEMETRY API ---');
  // ─────────────────────────────────────────────────────────────

  await runTest('Error Reporting', 'Error report status can be updated (INVESTIGATING / RESOLVED)', async () => {
    // Insert a dummy error report
    const errId = new ObjectId();
    await database.collection(collection.ERROR_REPORTS_COLLECTION).insertOne({
      _id: errId,
      signature: 'test-qa-err-signature',
      category: 'Application',
      route: '/api/v1/test',
      method: 'GET',
      message: 'QA injected test failure',
      statusCode: 500,
      frequency: 1,
      affectedUsersCount: 1,
      status: 'UNRESOLVED',
      createdAt: new Date(),
      lastOccurred: new Date()
    });

    const res = await makeRequest({
      path: `/admin/error-reports/${errId}/status`,
      method: 'POST',
      headers: {
        Cookie: superuserCookie,
        Accept: 'application/json'
      }
    }, { status: 'RESOLVED' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.json.success, true);

    const doc = await database.collection(collection.ERROR_REPORTS_COLLECTION).findOne({ _id: errId });
    assert.strictEqual(doc.status, 'RESOLVED');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 8. PERFORMANCE BENCHMARKS ---');
  // ─────────────────────────────────────────────────────────────

  const perfEndpoints = [
    { name: 'Dashboard', path: '/' },
    { name: 'Users Listing', path: '/admin/network/users' },
    { name: 'Businesses', path: '/admin/businesses' },
    { name: 'Verification Review', path: '/admin/verification' },
    { name: 'Error Reports', path: '/admin/error-reports' },
    { name: 'Audit Logs', path: '/admin/audit-logs' }
  ];

  for (const ep of perfEndpoints) {
    await runTest('Performance', `${ep.name} responds within 250ms`, async () => {
      const start = Date.now();
      const res = await makeRequest({
        path: ep.path,
        headers: { Cookie: superuserCookie }
      });
      const duration = Date.now() - start;
      assert.strictEqual(res.statusCode, 200);
      assert.ok(duration < 250, `${ep.name} took ${duration}ms (Threshold: 250ms)`);
    });
  }

  // Cleanup QA Fixtures
  await database.collection(collection.STUDENTS_COLLECTION).deleteOne({ _id: testStudentId });
  await database.collection(collection.ORGANIZATIONS_COLLECTION).deleteOne({ _id: testBusinessId });
  await database.collection(collection.OPPORTUNITIES_COLLECTION).deleteOne({ _id: testJobId });
  await database.collection(collection.VERIFICATION_REQUESTS_COLLECTION).deleteOne({ _id: testVerificationId });
  await database.collection(collection.MODERATION_REPORTS_COLLECTION).deleteOne({ _id: testReportId });
  await database.collection('sessions').deleteMany({
    _id: { $in: [superuserSid, generalAdminSid, verificationAdminSid, businessAdminSid] }
  });

  console.log('\n================================================================');
  console.log(`TOTAL QA CHECKS: ${testResults.total} | PASSED: ${testResults.passed} | FAILED: ${testResults.failed}`);
  console.log('================================================================\n');

  if (testResults.failed > 0) {
    process.exit(1);
  }
  process.exit(0);
};

main().catch((err) => {
  console.error('Fatal QA Engine Error:', err);
  process.exit(1);
});
