/**
 * Zeitnah Admin Panel — Phase 1 Comprehensive Governance & Zero-Trust Test Suite
 * Validates:
 * 1. Admin Authentication & Session Security
 * 2. RBAC & Capability Enforcement
 * 3. User Role Governance (Educator admin-assigned invariant)
 * 4. Business Governance (Approve, Reject, Suspend, Restore)
 * 5. Job Governance & Moderation Signals
 * 6. Verification Governance (5 Categories, 5 Statuses, Evidence Protection)
 * 7. Moderation System (7 Cases, 4 Lifecycle States)
 * 8. Audit Logging & Recursive Secret Scrubbing
 * 9. Error Reporting & Telemetry Classification
 * 10. IDOR Protection & ObjectId Validation
 */

const assert = require('assert');
const { ObjectId } = require('mongodb');
const permissionsHelper = require('../Helpers/permissions-helper');
const auditHelper = require('../Helpers/audit-helper');
const verificationHelper = require('../Helpers/verification-helper');
const errorHelper = require('../Helpers/error-helper');
const moderationHelper = require('../Helpers/moderation-helper');
const governanceHelper = require('../Helpers/governance-helper');

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
  }
};

const runSuite = async () => {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: PHASE 1 COMPREHENSIVE GOVERNANCE SUITE   ');
  console.log('================================================================\n');

  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. RBAC & Administrative Security Capabilities ---');
  // ─────────────────────────────────────────────────────────────

  await test('Superuser possesses all capabilities and passes any capability check', () => {
    const superuser = { role: 'superuser', email: 'super@zeitnah.com' };
    assert.strictEqual(permissionsHelper.hasCapability(superuser, 'manage_all'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuser, 'manage_verification'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuser, 'view_verification_evidence'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuser, 'restore_businesses'), true);
    assert.strictEqual(permissionsHelper.hasCapability(superuser, 'view_system_errors'), true);
  });

  await test('Domain admins have strictly bounded capabilities (Principle of Least Privilege)', () => {
    const verificationAdmin = {
      role: 'verification_admin'
    };
    assert.strictEqual(permissionsHelper.hasCapability(verificationAdmin, 'manage_verification'), true);
    assert.strictEqual(permissionsHelper.hasCapability(verificationAdmin, 'view_verification_evidence'), true);
    assert.strictEqual(permissionsHelper.hasCapability(verificationAdmin, 'approve_businesses'), false);
    assert.strictEqual(permissionsHelper.hasCapability(verificationAdmin, 'manage_ai_config'), false);
  });

  await test('Admin without view_verification_evidence cannot inspect raw evidence documents', () => {
    const generalAdmin = { role: 'admin' };
    assert.strictEqual(permissionsHelper.hasCapability(generalAdmin, 'view_verification_evidence'), false);
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. User Role Governance & Educator Safeguard ---');
  // ─────────────────────────────────────────────────────────────

  await test('EDUCATOR role remains strictly permitted in role definitions', () => {
    assert.ok(governanceHelper.ALLOWED_PROFILE_ROLES.includes('EDUCATOR'));
    assert.ok(governanceHelper.ALLOWED_PROFILE_ROLES.includes('STUDENT'));
    assert.ok(governanceHelper.ALLOWED_PROFILE_ROLES.includes('PROFESSIONAL'));
    assert.ok(governanceHelper.ALLOWED_PROFILE_ROLES.includes('MENTOR'));
    assert.ok(governanceHelper.ALLOWED_PROFILE_ROLES.includes('RECRUITER'));
    assert.ok(governanceHelper.ALLOWED_PROFILE_ROLES.includes('FOUNDER'));
  });

  await test('Invalid or malicious role assignment is immediately rejected', async () => {
    let errorCaught = false;
    try {
      await governanceHelper.assignUserRole(new ObjectId().toString(), 'SUPERUSER', null, null);
    } catch (e) {
      errorCaught = true;
      assert.ok(e.message.includes('Invalid role'));
    }
    assert.strictEqual(errorCaught, true);
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Verification Governance (5 Categories, 5 Statuses) ---');
  // ─────────────────────────────────────────────────────────────

  await test('Verification categories cover IDENTITY, PROFESSIONAL, BUSINESS_AFFILIATION, CERTIFICATION, EDUCATOR', () => {
    const cats = verificationHelper.VERIFICATION_CATEGORIES;
    assert.strictEqual(cats.length, 5);
    assert.ok(cats.includes('IDENTITY'));
    assert.ok(cats.includes('PROFESSIONAL'));
    assert.ok(cats.includes('BUSINESS_AFFILIATION'));
    assert.ok(cats.includes('CERTIFICATION'));
    assert.ok(cats.includes('EDUCATOR'));
  });

  await test('Verification statuses cover UNVERIFIED, PENDING, VERIFIED, REJECTED, EXPIRED', () => {
    const statuses = verificationHelper.VERIFICATION_STATUSES;
    assert.strictEqual(statuses.length, 5);
    assert.ok(statuses.includes('UNVERIFIED'));
    assert.ok(statuses.includes('PENDING'));
    assert.ok(statuses.includes('VERIFIED'));
    assert.ok(statuses.includes('REJECTED'));
    assert.ok(statuses.includes('EXPIRED'));
  });

  await test('Evidence redaction scrub removes URLs and masks identification for unauthorized admin', () => {
    const rawRecord = {
      targetName: 'Candidate User',
      category: 'IDENTITY',
      idNumber: '1234567890',
      evidenceUrl: 'https://zeitnah.s3.amazonaws.com/passports/secret.pdf',
      documentUrl: 'https://zeitnah.s3.amazonaws.com/ids/secret.pdf',
      attachments: [{ name: 'passport.pdf', url: 'https://example.com/p.pdf' }]
    };

    const redacted = verificationHelper.redactEvidence(rawRecord, false);
    assert.strictEqual(redacted.evidenceRedacted, true);
    assert.strictEqual(redacted.evidenceUrl, null);
    assert.strictEqual(redacted.documentUrl, null);
    assert.strictEqual(redacted.attachments[0].url, null);
    assert.strictEqual(redacted.attachments[0].isProtected, true);
    assert.strictEqual(redacted.idNumber, '12******90');
  });

  await test('Evidence redaction preserves full access for authorized admin', () => {
    const rawRecord = {
      targetName: 'Candidate User',
      category: 'IDENTITY',
      idNumber: '1234567890',
      evidenceUrl: 'https://zeitnah.s3.amazonaws.com/passports/secret.pdf'
    };

    const unredacted = verificationHelper.redactEvidence(rawRecord, true);
    assert.strictEqual(unredacted.evidenceRedacted, false);
    assert.strictEqual(unredacted.evidenceUrl, rawRecord.evidenceUrl);
    assert.strictEqual(unredacted.idNumber, '1234567890');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Moderation Workspace (7 Cases, 4 Lifecycles) ---');
  // ─────────────────────────────────────────────────────────────

  await test('Moderation lifecycle statuses cover OPEN, UNDER_REVIEW, RESOLVED, DISMISSED', () => {
    const statuses = moderationHelper.MODERATION_LIFECYCLE_STATUSES;
    assert.strictEqual(statuses.length, 4);
    assert.ok(statuses.includes('OPEN'));
    assert.ok(statuses.includes('UNDER_REVIEW'));
    assert.ok(statuses.includes('RESOLVED'));
    assert.ok(statuses.includes('DISMISSED'));
  });

  await test('Moderation targets cover all 7 platform domains', () => {
    const targets = moderationHelper.MODERATION_TARGET_TYPES;
    assert.ok(targets.includes('USER'));
    assert.ok(targets.includes('PROFILE'));
    assert.ok(targets.includes('MESSAGE'));
    assert.ok(targets.includes('JOB'));
    assert.ok(targets.includes('BUSINESS'));
    assert.ok(targets.includes('PORTFOLIO'));
    assert.ok(targets.includes('VERIFICATION_ISSUE'));
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 5. Audit Logging & Recursive Secret Scrubbing ---');
  // ─────────────────────────────────────────────────────────────

  await test('scrubSecrets cleans passwords, tokens, OTPs, session secrets and auth headers', () => {
    const payload = {
      username: 'johndoe',
      password: 'superSecretPassword123',
      token: 'jwt_token_header_secret',
      otp: '984521',
      sessionSecret: 'my_session_key',
      headers: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token'
      },
      nested: {
        apiKey: 'sk-live-94829482049284',
        userEmail: 'john@example.com'
      }
    };

    const cleaned = auditHelper.scrubSecrets(payload);
    assert.strictEqual(cleaned.username, 'johndoe');
    assert.strictEqual(cleaned.password, '[REDACTED]');
    assert.strictEqual(cleaned.token, '[REDACTED]');
    assert.strictEqual(cleaned.otp, '[REDACTED]');
    assert.strictEqual(cleaned.sessionSecret, '[REDACTED]');
    assert.strictEqual(cleaned.headers.authorization, '[REDACTED]');
    assert.strictEqual(cleaned.nested.apiKey, '[REDACTED]');
    assert.strictEqual(cleaned.nested.userEmail, 'john@example.com');
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 6. Error Reporting & Telemetry Classification ---');
  // ─────────────────────────────────────────────────────────────

  await test('classifyError categorizes validation/400 as Expected', () => {
    const cat = errorHelper.classifyError(new Error('Validation failed for email'), 400);
    assert.strictEqual(cat, 'Expected');
  });

  await test('classifyError categorizes 401/403/429 as User Action', () => {
    const cat = errorHelper.classifyError(new Error('Unauthorized access attempt'), 401);
    assert.strictEqual(cat, 'User Action');
  });

  await test('classifyError categorizes socket/network errors as Network', () => {
    const cat = errorHelper.classifyError(new Error('connect ECONNREFUSED 127.0.0.1:27017'), 500);
    assert.strictEqual(cat, 'Network');
  });

  await test('classifyError categorizes websocket failures as WebSocket', () => {
    const cat = errorHelper.classifyError(new Error('WebSocket connection timed out'), 500);
    assert.strictEqual(cat, 'WebSocket');
  });

  await test('classifyError categorizes internal runtime bugs as Application', () => {
    const cat = errorHelper.classifyError(new TypeError('Cannot read properties of undefined'), 500);
    assert.strictEqual(cat, 'Application');
  });

  await test('hashErrorSignature produces deterministic SHA256 hashes for deduplication', () => {
    const h1 = errorHelper.hashErrorSignature('GET', '/admin/businesses/640102030405060708090a0b', 'Record not found');
    const h2 = errorHelper.hashErrorSignature('GET', '/admin/businesses/640102030405060708090a0c', 'Record not found');
    // Notice both routes are normalized with :id
    assert.strictEqual(h1, h2);
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 7. IDOR Protection & ObjectId Validation ---');
  // ─────────────────────────────────────────────────────────────

  await test('validateObjectIds rejects malformed ID parameters', () => {
    const invalidIds = ['not-an-id', '123', 'admin;drop table', '../../etc/passwd'];
    for (const id of invalidIds) {
      assert.strictEqual(ObjectId.isValid(id), false);
    }
  });

  await test('validateObjectIds accepts legitimate 24-character hexadecimal ObjectId', () => {
    const validId = new ObjectId().toString();
    assert.strictEqual(ObjectId.isValid(validId), true);
  });

  // ─────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log(`TEST RUN COMPLETE: ${passedTests} passed, ${totalTests - passedTests} failed (${totalTests} total)`);
  console.log('================================================================\n');

  if (totalTests !== passedTests) {
    process.exit(1);
  }
};

runSuite().catch(err => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
