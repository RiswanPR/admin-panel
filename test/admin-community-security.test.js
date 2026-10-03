'use strict';

/**
 * Zeitnah Admin Panel — Community Administration Security Test Suite
 * Validates:
 * 1. Authentication: Rejection of unauthenticated access (401 JSON / 302 Redirect)
 * 2. RBAC: Server-side capability check (moderate_content), rejection of unauthorized roles (403), zero mutations
 * 3. IDOR: Cross-entity and invalid ID mutation prevention, type boundary enforcement
 * 4. MongoDB Operator Injection: Rejection/neutralization of $gt, $ne, $where, $regex, $in
 * 5. Regex Injection & ReDoS: Metacharacters escaping, catastrophic pattern resilience, safe search behavior
 * 6. Pagination & Query Object Injection: Neutralization of object injection (?page[$gt]=1, ?limit[$gt]=1)
 * 7. URL Sanitization: Rejection of unsafe protocols (javascript:, data:, file:) and preservation of safe URLs
 * 8. XSS & Template Escaping: HTML escaping of user input (<script>alert(1)</script>) without weakening Handlebars
 * 9. CSRF & Cross-Origin Guard: Rejection of mismatched Origin / Referer (403 Forbidden)
 */

const assert = require('assert');
const hbs = require('express-handlebars').create();
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

const createMockReqRes = ({ adminUser = null, method = 'POST', body = {}, params = {}, query = {}, headers = {} } = {}) => {
  const req = {
    method,
    session: {
      adminloggedIn: Boolean(adminUser),
      admin: adminUser || null
    },
    params,
    query,
    body,
    headers: {
      'x-forwarded-for': '127.0.0.1',
      'user-agent': 'ZeitnahSecurityTestRunner/1.0',
      host: 'admin.zeitnah.com',
      accept: 'application/json',
      ...headers
    },
    ip: '127.0.0.1',
    get(headerName) {
      const lower = headerName.toLowerCase();
      return this.headers[lower] || undefined;
    },
    is(type) {
      return type === 'json' && (this.headers['content-type']?.includes('json'));
    }
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

// Mirror the app.js cross-origin mutation guard
const crossOriginGuard = (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const source = req.get('origin') || req.get('referer');
  const isAjaxOrJson = req.xhr ||
                       req.get('x-requested-with') === 'XMLHttpRequest' ||
                       req.is('json') ||
                       req.get('accept')?.indexOf('json') > -1;

  if (!source || source === 'null') {
    if (process.env.NODE_ENV === 'production' && !isAjaxOrJson) {
      return res.status(403).json({
        success: false,
        message: 'Cross-origin request rejected: Missing request origin.'
      });
    }
    return next();
  }

  try {
    const sourceUrl = new URL(source);
    const expectedHost = req.get('x-forwarded-host') || req.get('host');

    if (sourceUrl.host !== expectedHost) {
      if (sourceUrl.hostname !== expectedHost?.split(':')[0]) {
        return res.status(403).json({
          success: false,
          message: 'Cross-origin request rejected.'
        });
      }
    }
  } catch (err) {
    return res.status(403).json({
      success: false,
      message: 'Invalid request origin.'
    });
  }

  next();
};

const runSuite = async () => {
  console.log('\n================================================================');
  console.log('   ZEITNAH ADMIN PANEL: COMMUNITY SECURITY & INTEGRITY SUITE    ');
  console.log('================================================================\n');

  // DB connection
  await new Promise((resolve, reject) => {
    db.connect((err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const database = db.get();

  const authorizedMod = {
    _id: new ObjectId(),
    Name: 'Security Moderator',
    Email: 'secmod@zeitnah.com',
    role: 'moderation_admin'
  };

  const unauthorizedUser = {
    _id: new ObjectId(),
    Name: 'Network Admin',
    Email: 'netadmin@zeitnah.com',
    role: 'network_admin'
  };

  const createdPostIds = [];
  const createdCommentIds = [];

  try {
    // ─────────────────────────────────────────────────────────────
    console.log('--- 1. Authentication Verification ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('1.1: Unauthenticated JSON mutation is rejected with 401 Unauthorized', async () => {
      const { req, res } = createMockReqRes({ adminUser: null, method: 'POST' });
      const guard = permissionsHelper.requireCapability('moderate_content');
      let passed = false;
      guard(req, res, () => { passed = true; });

      assert.strictEqual(passed, false);
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body?.success, false);
      assert.strictEqual(res.body?.message, 'Authentication required.');
    });

    await testAsync('1.2: Unauthenticated HTML navigation redirects to /login (302)', async () => {
      const { req, res } = createMockReqRes({
        adminUser: null,
        method: 'GET',
        headers: { accept: 'text/html' }
      });
      const guard = permissionsHelper.requireCapability('moderate_content');
      let passed = false;
      guard(req, res, () => { passed = true; });

      assert.strictEqual(passed, false);
      assert.strictEqual(res.redirectedTo, '/login');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 2. RBAC & Server-Side Capability Enforcement ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('2.1: Authorized moderator with moderate_content passes capability check', async () => {
      const { req, res } = createMockReqRes({ adminUser: authorizedMod });
      const guard = permissionsHelper.requireCapability('moderate_content');
      let passed = false;
      guard(req, res, () => { passed = true; });

      assert.strictEqual(passed, true, 'moderation_admin must pass moderate_content');
    });

    await testAsync('2.2: User without moderate_content (network_admin) is rejected with 403 Forbidden', async () => {
      const { req, res } = createMockReqRes({ adminUser: unauthorizedUser });
      const guard = permissionsHelper.requireCapability('moderate_content');
      let passed = false;
      guard(req, res, () => { passed = true; });

      assert.strictEqual(passed, false);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.success, false);
      assert.ok(res.body?.message?.includes('Insufficient privileges'));
    });

    await testAsync('2.3: Superuser role bypasses capability checks and possesses all capabilities', async () => {
      const superuser = { _id: new ObjectId(), role: 'superuser' };
      assert.strictEqual(permissionsHelper.hasCapability(superuser, 'moderate_content'), true);
      assert.strictEqual(permissionsHelper.hasCapability(superuser, 'manage_all'), true);
      assert.strictEqual(permissionsHelper.hasCapability(superuser, 'any_unregistered_capability'), true);
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 3. IDOR & Entity Type Boundary Enforcement ---');
    // ─────────────────────────────────────────────────────────────

    const secPostId = 'sec-post-idor-01';
    await database.collection(collection.COMMUNITY_POSTS_COLLECTION).insertOne({
      _id: secPostId,
      authorId: 'user-a',
      content: 'IDOR target post content',
      isDeleted: false,
      createdAt: new Date()
    });
    createdPostIds.push(secPostId);

    const secCommentId = 'sec-comment-idor-01';
    await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).insertOne({
      _id: secCommentId,
      postId: secPostId,
      authorId: 'user-b',
      text: 'IDOR target comment text',
      isDeleted: false,
      createdAt: new Date()
    });
    createdCommentIds.push(secCommentId);

    await testAsync('3.1: Attempting to operate on a comment using post endpoint fails safely', async () => {
      // Trying to hide comment ID using post hide
      let failed = false;
      try {
        await communityHelper.hidePost(secCommentId, {}, authorizedMod, { ip: '127.0.0.1', headers: {} });
      } catch (err) {
        failed = true;
        assert.ok(err.message.includes('not found') || err.message.includes('Invalid'));
      }
      assert.strictEqual(failed, true, 'Cannot mutate comment via post method');

      // Verify comment remains untouched
      const commentDoc = await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).findOne({ _id: secCommentId });
      assert.strictEqual(commentDoc.isDeleted, false, 'Comment must not be mutated by post method');
    });

    await testAsync('3.2: Unsupported entity type in bulk operation is safely caught and rejected without mutation', async () => {
      const res = await communityHelper.executeBulkAction({
        entityType: 'unsupported_entity',
        action: 'hide',
        ids: [secPostId],
        actor: authorizedMod,
        req: { ip: '127.0.0.1', headers: {} }
      });
      assert.strictEqual(res.failed, 1);
      assert.ok(res.details[0].reason.includes('Unsupported entity type'));

      // Verify zero mutation
      const postDoc = await database.collection(collection.COMMUNITY_POSTS_COLLECTION).findOne({ _id: secPostId });
      assert.strictEqual(postDoc.isDeleted, false);
    });

    await testAsync('3.3: Invalid entity ID format is rejected before reaching database queries', async () => {
      const invalidIds = ['id with spaces', 'id$special', '<script>', '../../path/traversal', ''];
      for (const id of invalidIds) {
        assert.strictEqual(communityHelper.isValidCommunityId(id), false, `Should reject invalid ID: ${id}`);
      }
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 4. MongoDB Operator Injection Resistance ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('4.1: MongoDB query operators ($gt, $ne, $where, $regex, $in) in ID are rejected by validator', async () => {
      const operators = [
        '{"$gt": ""}',
        '{"$ne": null}',
        '{"$where": "sleep(5000)"}',
        '{"$regex": ".*"}',
        '{"$in": ["a", "b"]}',
        '$gt',
        '$ne',
        '$where',
        '$regex',
        '$in'
      ];

      for (const op of operators) {
        assert.strictEqual(communityHelper.isValidCommunityId(op), false, `Operator ${op} must be rejected as ID`);
      }
    });

    await testAsync('4.2: Object passed as search filter is safely converted to string without becoming query operators', async () => {
      // If client sends ?search[$gt]=, express query parser produces { search: { '$gt': '' } }
      const maliciousFilter = {
        search: { '$gt': '' },
        page: 1,
        limit: 10
      };

      const result = await communityHelper.getPosts(maliciousFilter);
      assert.ok(result, 'Query must execute safely without MongoDB operator injection');
      assert.ok(Array.isArray(result.records), 'Records must be returned as an array');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 5. Regex Injection & ReDoS Protection ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('5.1: Special regex metacharacters (. * + ? [ ] ( ) { } ^ $ \\ |) do not cause syntax errors', async () => {
      const evilSearchStrings = [
        '.*+?[](){}^$\\',
        '[a-z]+',
        '(',
        '(((',
        '\\',
        '[',
        '{1,100}',
        '^$',
        '|'
      ];

      for (const pattern of evilSearchStrings) {
        assert.doesNotThrow(() => {
          new RegExp(communityHelper.escapeRegex(pattern), 'i');
        }, `Pattern ${pattern} must not throw regex SyntaxError`);
      }
    });

    await testAsync('5.2: Potential catastrophic ReDoS pattern runs in under 5ms', async () => {
      // Classic ReDoS pattern: (a+)+$
      const redosInput = 'a'.repeat(50) + '!';
      const start = process.hrtime.bigint();
      const escaped = communityHelper.escapeRegex(redosInput);
      const regex = new RegExp(escaped, 'i');
      regex.test('a'.repeat(60));
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1e6;

      assert.ok(durationMs < 5, `ReDoS check took ${durationMs}ms, should be < 5ms`);
    });

    await testAsync('5.3: Escaped regex search only matches literal strings (dot does not match arbitrary chars)', async () => {
      const searchWithDot = 'test.target';
      const escaped = communityHelper.escapeRegex(searchWithDot);
      const regex = new RegExp(escaped, 'i');

      assert.strictEqual(regex.test('test.target'), true, 'Should match exact dot');
      assert.strictEqual(regex.test('test1target'), false, 'Should NOT match non-dot character');
      assert.strictEqual(regex.test('test-target'), false, 'Should NOT match dash');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 6. Pagination & Query Object Injection Resistance ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('6.1: Object injection in page (?page[$gt]=1) is neutralized to default integer', async () => {
      const injectedQuery = {
        page: { '$gt': '1' },
        limit: { '$gt': '1' }
      };

      const result = await communityHelper.getPosts(injectedQuery);
      assert.strictEqual(result.page, 1, 'Injected page object must evaluate to 1');
      assert.strictEqual(result.limit, 15, 'Injected limit object must evaluate to default 15');
    });

    await testAsync('6.2: Unbounded limit (?limit=99999999) is strictly clamped to maximum allowable limit', async () => {
      const result = await communityHelper.getPosts({ limit: 99999999 });
      assert.strictEqual(result.limit, 100, 'Limit must be bounded to maximum 100');

      const searchResult = await communityHelper.globalCommunitySearch('test', { limit: 99999999 });
      assert.strictEqual(searchResult.limit, 50, 'Search limit must be bounded to maximum 50');
    });

    await testAsync('6.3: Negative and zero pagination parameters are clamped to 1', async () => {
      const result = await communityHelper.getPosts({ page: -5, limit: 0 });
      assert.strictEqual(result.page, 1, 'Negative page must clamp to 1');
      assert.strictEqual(result.limit, 15, 'Zero limit must fallback to default 15');
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 7. URL Protocol Sanitization ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('7.1: Dangerous URI protocols (javascript:, data:, file:, vbscript:) are stripped to empty string', async () => {
      const dangerousUrls = [
        'javascript:alert(document.cookie)',
        'JAVASCRIPT:alert(1)',
        'javascript:/*--></title></style></textarea>*/<script>alert(1)</script>',
        'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
        'data:image/svg+xml,<svg onload=alert(1)>',
        'file:///etc/passwd',
        'file://C:\\Windows\\System32\\cmd.exe',
        'vbscript:msgbox(1)'
      ];

      for (const dangerous of dangerousUrls) {
        const sanitized = communityHelper.sanitizeUrl(dangerous);
        assert.strictEqual(sanitized, '', `Dangerous URL '${dangerous}' must be stripped to ''`);
      }
    });

    await testAsync('7.2: Safe URLs (https://, http://, relative /) are preserved intact', async () => {
      const safeUrls = [
        'https://cdn.zeitnah.com/avatars/user.webp',
        'http://localhost:3000/media/demo.png',
        '/uploads/community/stories/story-01.jpg',
        '/static/img/placeholder.png'
      ];

      for (const safe of safeUrls) {
        const sanitized = communityHelper.sanitizeUrl(safe);
        assert.strictEqual(sanitized, safe, `Safe URL '${safe}' must be preserved`);
      }
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 8. XSS & Template Escaping ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('8.1: Handlebars double-brace expressions escape malicious HTML and JavaScript payload', async () => {
      const template = hbs.handlebars.compile('<div class="content">{{userContent}}</div>');
      const maliciousPayload = '<script>alert("XSS")</script><img src=x onerror=alert(1)>';
      const rendered = template({ userContent: maliciousPayload });

      assert.ok(rendered.includes('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'));
      assert.ok(!rendered.includes('<script>'));
      assert.ok(!rendered.includes('onerror=alert(1)'));
    });

    await testAsync('8.2: User-controlled fields in Community models do not bypass auto-escaping', async () => {
      const template = hbs.handlebars.compile('<span>{{author.name}}</span><p>{{post.content}}</p>');
      const data = {
        author: { name: '<b>Hacker</b>' },
        post: { content: '<svg onload=alert(1)>' }
      };
      const rendered = template(data);

      assert.ok(!rendered.includes('<b>Hacker</b>'));
      assert.ok(rendered.includes('&lt;b&gt;Hacker&lt;/b&gt;'));
      assert.ok(!rendered.includes('<svg onload'));
      assert.ok(rendered.includes('&lt;svg onload'));
    });

    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 9. CSRF & Cross-Origin Mutation Guard ---');
    // ─────────────────────────────────────────────────────────────

    await testAsync('9.1: Cross-origin mutation request with mismatched Origin is rejected with 403 Forbidden', async () => {
      const { req, res } = createMockReqRes({
        adminUser: authorizedMod,
        method: 'POST',
        headers: {
          origin: 'https://evil-attacker.com',
          host: 'admin.zeitnah.com'
        }
      });

      let passed = false;
      crossOriginGuard(req, res, () => { passed = true; });

      assert.strictEqual(passed, false);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.success, false);
      assert.ok(res.body?.message?.includes('Cross-origin request rejected'));
    });

    await testAsync('9.2: Cross-origin mutation request with mismatched Referer is rejected with 403 Forbidden', async () => {
      const { req, res } = createMockReqRes({
        adminUser: authorizedMod,
        method: 'POST',
        headers: {
          referer: 'https://evil-attacker.com/csrf-page',
          host: 'admin.zeitnah.com'
        }
      });

      let passed = false;
      crossOriginGuard(req, res, () => { passed = true; });

      assert.strictEqual(passed, false);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body?.success, false);
      assert.ok(res.body?.message?.includes('Cross-origin request rejected'));
    });

    await testAsync('9.3: Same-origin mutation request with matching Origin passes cross-origin guard', async () => {
      const { req, res } = createMockReqRes({
        adminUser: authorizedMod,
        method: 'POST',
        headers: {
          origin: 'https://admin.zeitnah.com',
          host: 'admin.zeitnah.com'
        }
      });

      let passed = false;
      crossOriginGuard(req, res, () => { passed = true; });

      assert.strictEqual(passed, true, 'Same-origin request must pass guard');
    });

    await testAsync('9.4: Safe GET requests bypass the cross-origin mutation guard', async () => {
      const { req, res } = createMockReqRes({
        adminUser: authorizedMod,
        method: 'GET',
        headers: {
          origin: 'https://any-site.com',
          host: 'admin.zeitnah.com'
        }
      });

      let passed = false;
      crossOriginGuard(req, res, () => { passed = true; });

      assert.strictEqual(passed, true, 'GET request must bypass cross-origin mutation guard');
    });

  } finally {
    // Teardown
    if (createdPostIds.length) {
      await database.collection(collection.COMMUNITY_POSTS_COLLECTION).deleteMany({ _id: { $in: createdPostIds } }).catch(() => {});
    }
    if (createdCommentIds.length) {
      await database.collection(collection.COMMUNITY_COMMENTS_COLLECTION).deleteMany({ _id: { $in: createdCommentIds } }).catch(() => {});
    }
  }

  console.log('\n================================================================');
  console.log(`SECURITY SUITE SUMMARY: ${passedTests} passed, ${failedTests} failed (${totalTests} total)`);
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
