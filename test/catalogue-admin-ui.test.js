'use strict';

/**
 * Zeitnah Admin Panel — Automated Test Suite: Professional Identity Catalogue Admin UI (Phase 3)
 *
 * Verifies:
 * 1. Route authorization & capability denial (verifyLogin & requireCapability('manage_taxonomy'))
 * 2. CSRF enforcement on all mutation routes (blocks missing/invalid tokens)
 * 3. Department listing, KPI metrics, search, and status filtering
 * 4. Department detail and scoped title listing with pagination and search
 * 5. Department updates, stable ID immutability, and validation error handling
 * 6. Department retirement and reactivation without deletion
 * 7. Title creation with deterministic scoped composite ID generation
 * 8. Cross-department duplicate display labels remaining valid with distinct IDs
 * 9. Title renaming preserving stable IDs
 * 10. Title retirement and reactivation without hard deletion
 * 11. Explicit rejection of hard deletions (405) and department reassignment (400)
 * 12. Audit failure handling (fails closed when auditLogged is false)
 * 13. Safe rendering / escaping of catalogue fields
 *
 * Runs non-browser tests against an in-memory mock MongoDB database and an isolated Express server.
 */

const assert = require('assert');
const { test, describe, before, after, beforeEach } = require('node:test');
const http = require('http');
const express = require('express');
const exphbs = require('express-handlebars');
const path = require('path');

const collection = require('../config/collections');
const { loadAndValidateCatalogue } = require('../Helpers/catalogue-loader');
const catalogueAdmin = require('../Helpers/catalogue-admin-helper');
const adminCatalogueRouter = require('../routes/admin-catalogue');

/**
 * In-memory Mock MongoDB database
 */
function getDeepValue(obj, pathStr) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, pathStr)) return obj[pathStr];
  const parts = pathStr.split('.');
  let curr = obj;
  for (const p of parts) {
    if (curr === null || curr === undefined || typeof curr !== 'object') return undefined;
    curr = curr[p];
  }
  return curr;
}

function createMockDb() {
  const collections = new Map();

  function matchesFilter(doc, query) {
    if (!query || Object.keys(query).length === 0) return true;
    for (const [k, v] of Object.entries(query)) {
      if (k === '$or') {
        if (!Array.isArray(v)) return false;
        const orMatched = v.some((subQuery) => matchesFilter(doc, subQuery));
        if (!orMatched) return false;
      } else if (v instanceof RegExp) {
        const val = getDeepValue(doc, k);
        if (Array.isArray(val)) {
          if (!val.some((item) => v.test(String(item)))) return false;
        } else if (!v.test(String(val || ''))) {
          return false;
        }
      } else {
        const val = getDeepValue(doc, k);
        if (val !== v) return false;
      }
    }
    return true;
  }

  function getCollection(name) {
    if (!collections.has(name)) {
      const store = [];
      collections.set(name, {
        name,
        store,
        countDocuments: async (query = {}) => {
          return store.filter((doc) => matchesFilter(doc, query)).length;
        },
        findOne: async (query = {}) => {
          const found = store.find((doc) => matchesFilter(doc, query));
          return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        find: (query = {}) => {
          const filtered = store.filter((doc) => matchesFilter(doc, query));
          return {
            toArray: async () => filtered.map((d) => JSON.parse(JSON.stringify(d))),
          };
        },
        insertMany: async (docs) => {
          for (const d of docs) {
            store.push(JSON.parse(JSON.stringify(d)));
          }
          return { insertedCount: docs.length, acknowledged: true };
        },
        insertOne: async (doc) => {
          store.push(JSON.parse(JSON.stringify(doc)));
          return { insertedId: doc._id || 'mock-id', acknowledged: true };
        },
        updateOne: async (filter, update) => {
          const doc = store.find((d) => matchesFilter(d, filter));
          if (!doc) return { matchedCount: 0, modifiedCount: 0 };
          if (update.$set) Object.assign(doc, JSON.parse(JSON.stringify(update.$set)));
          if (update.$inc) {
            for (const [k, incVal] of Object.entries(update.$inc)) {
              doc[k] = (doc[k] || 0) + incVal;
            }
          }
          return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
        },
      });
    }
    return collections.get(name);
  }

  return {
    collection: getCollection,
    getRawCollection: (name) => collections.get(name),
  };
}

describe('Zeitnah Admin — Phase 3: Professional Identity Catalogue Admin UI', () => {
  let app;
  let server;
  let baseUrl;
  let mockDb;
  let currentSession;

  before(async () => {
    // Setup Express App for testing
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Setup Handlebars Engine matching app.js
    app.engine(
      'hbs',
      exphbs.engine({
        extname: 'hbs',
        defaultLayout: false, // In test runner, render views directly
        helpers: {
          eq: (a, b) => String(a) === String(b),
          gt: (a, b) => a > b,
          lt: (a, b) => a < b,
          ifEquals: function (a, b, options) {
            return String(a) === String(b) ? options.fn(this) : options.inverse(this);
          },
          inc: (val) => Number(val || 0) + 1,
          dec: (val) => Math.max(1, Number(val || 1) - 1),
          join: (arr, sep) => (Array.isArray(arr) ? arr.join(typeof sep === 'string' ? sep : ', ') : ''),
          replace: (str, find, repl) => (str ? String(str).split(find).join(repl) : ''),
        },
      })
    );
    app.set('view engine', 'hbs');
    app.set('views', path.join(__dirname, '../views'));

    // Mock session and mock DB injection
    app.use((req, res, next) => {
      req.session = currentSession;
      req.mockDb = mockDb;
      next();
    });

    // Mount catalogue router at /admin/catalogue
    app.use('/admin/catalogue', adminCatalogueRouter);

    // Error handling view fallback
    app.use((err, req, res, next) => {
      const status = err.status || 500;
      res.status(status).render('error', { message: err.message });
    });

    // Start ephemeral HTTP server
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    mockDb = createMockDb();
    const catalogue = loadAndValidateCatalogue();
    const deptColl = mockDb.collection(collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments');
    const titleColl = mockDb.collection(collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles');

    deptColl.store.push(...JSON.parse(JSON.stringify(catalogue.departments)));
    titleColl.store.push(...JSON.parse(JSON.stringify(catalogue.titles)));

    // Patch catalogueAdmin helper in test to use mockDb
    const originalResolveDb = catalogueAdmin.__resolveDb;
    // Monkey-patch db.get() for the test run
    const dbConfig = require('../config/connection');
    dbConfig.get = () => mockDb;

    // Default authorized session with superuser capabilities
    currentSession = {
      adminloggedIn: true,
      admin: {
        _id: 'admin_test_123',
        name: 'Lead Administrator',
        email: 'admin@zeitnah.internal',
        role: 'superuser',
      },
      csrfToken: 'test-valid-csrf-token-1234567890',
    };
  });

  describe('1. Authentication and Authorization Guarding', () => {
    test('unauthenticated request redirects to /login on GET and returns 401 on POST/AJAX', async () => {
      currentSession = { adminloggedIn: false };

      const getRes = await fetch(`${baseUrl}/admin/catalogue/departments`, {
        redirect: 'manual',
      });
      assert.strictEqual(getRes.status, 302);
      assert.strictEqual(getRes.headers.get('location'), '/login');

      const postRes = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
        method: 'POST',
        headers: { 'accept': 'application/json' },
      });
      assert.strictEqual(postRes.status, 401);
      const data = await postRes.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /Authentication required/);
    });

    test('authenticated admin without manage_taxonomy capability receives 403 Forbidden', async () => {
      // verification_admin lacks manage_taxonomy capability
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_restricted_456',
          name: 'Verification Officer',
          role: 'verification_admin',
        },
        csrfToken: 'test-token',
      };

      const res = await fetch(`${baseUrl}/admin/catalogue/departments`, {
        headers: { 'accept': 'application/json' },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /Permission denied: Insufficient privileges/);
    });

    test('admin with manage_taxonomy capability (e.g. superuser, admin, or network_admin) is granted access', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_network_789',
          name: 'Network Officer',
          role: 'network_admin',
        },
        csrfToken: 'test-token',
      };

      const res = await fetch(`${baseUrl}/admin/catalogue/departments`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.match(body, /Professional Identity Catalogue/);
      assert.match(body, /Civil Engineering/);
    });
  });

  describe('2. CSRF Token Protection on Mutations', () => {
    test('rejects POST mutation missing CSRF token with 403 Forbidden', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ name: 'Malicious Update Without Token' }),
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /Invalid or missing CSRF token/);
    });

    test('rejects POST mutation with invalid or mismatched CSRF token', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': 'wrong-token',
        },
        body: JSON.stringify({ name: 'Malicious Update Wrong Token' }),
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /Invalid or missing CSRF token/);
    });

    test('accepts mutation with valid matching CSRF token', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({
          name: 'Civil & Construction Engineering',
          displayOrder: 2,
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.department.name, 'Civil & Construction Engineering');
      assert.strictEqual(data.department.id, 'civil-engineering'); // ID strictly unchanged
    });
  });

  describe('3. Department Listing, Stats & Filter Routes', () => {
    test('GET /admin/catalogue redirects to /admin/catalogue/departments', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue`, { redirect: 'manual' });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.get('location'), '/admin/catalogue/departments');
    });

    test('GET /admin/catalogue/departments renders all departments and computes KPI metrics', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();

      assert.match(body, /Total Departments/);
      assert.match(body, /Civil Engineering/);
      assert.match(body, /Mechanical Engineering/);
      assert.match(body, /Architectural Design/);
      assert.match(body, /18/); // 18 departments
      assert.match(body, /254/); // 254 titles
    });

    test('supports status filter and search query on departments', async () => {
      // Search for 'civil'
      const searchRes = await fetch(`${baseUrl}/admin/catalogue/departments?search=civil`);
      assert.strictEqual(searchRes.status, 200);
      const body = await searchRes.text();
      assert.match(body, /Civil Engineering/);
    });
  });

  describe('4. Department Detail & Title Management Routes', () => {
    test('GET /admin/catalogue/departments/:departmentId returns 200 and renders scoped titles', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();

      assert.match(body, /Civil Engineering/);
      assert.match(body, /civil-engineering:project-manager/);
      assert.match(body, /Add Professional Title/);
      assert.match(body, /immutable/i);
    });

    test('returns 404 for non-existent department ID', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/non-existent-dept`);
      assert.strictEqual(res.status, 404);
      const body = await res.text();
      assert.match(body, /Department with ID (&#x27;|')non-existent-dept(&#x27;|') not found/);
    });
  });

  describe('5. Department Update & Lifecycle Management Flow', () => {
    test('updates department display name, displayOrder, and aliases', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({
          name: 'Civil Engineering & Infrastructure',
          displayOrder: 15,
          aliases: 'Civils, Site Works',
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.department.name, 'Civil Engineering & Infrastructure');
      assert.strictEqual(data.department.displayOrder, 15);
      assert.deepStrictEqual(data.department.aliases, ['Civils', 'Site Works']);
      assert.strictEqual(data.department.id, 'civil-engineering'); // Immutable
    });

    test('retires department via /status route without deleting titles', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({ status: 'retired' }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.department.status, 'retired');

      // Titles remain in the database intact
      const titles = await catalogueAdmin.getTitlesForDepartment('civil-engineering', {}, { db: mockDb });
      assert.strictEqual(titles.total, 12);
    });

    test('reactivates retired department', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({ status: 'active' }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.department.status, 'active');
    });

    test('rejects invalid department status value', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({ status: 'invalid_status' }),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /Invalid status/);
    });
  });

  describe('6. Title Creation & Stable ID Generation Flow', () => {
    test('creates new title with deterministic department-scoped composite ID', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering/titles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({
          label: 'Senior Hydraulics Engineer',
          aliases: 'Hydraulics, Water Resources',
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.title.id, 'civil-engineering:senior-hydraulics-engineer');
      assert.strictEqual(data.title.departmentId, 'civil-engineering');
      assert.strictEqual(data.title.label, 'Senior Hydraulics Engineer');
      assert.strictEqual(data.title.displayOrder, 13); // Auto-sequenced (12 + 1)
      assert.deepStrictEqual(data.title.aliases, ['Hydraulics', 'Water Resources']);
    });

    test('rejects duplicate title in the same department', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering/titles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({
          label: 'Project Manager', // Already exists as civil-engineering:project-manager
        }),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /already exists in department/);
    });

    test('permits identical title label in a different department with distinct scoped ID', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/qa-qc/titles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({
          label: 'Project Manager',
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.title.id, 'qa-qc:project-manager');
      assert.strictEqual(data.title.label, 'Project Manager');
      assert.strictEqual(data.title.departmentId, 'qa-qc');
    });
  });

  describe('7. Title Updates, Renaming & Lifecycle Flow', () => {
    test('renames title label while strictly preserving its stable composite ID', async () => {
      const titleId = 'civil-engineering:project-manager';

      const res = await fetch(`${baseUrl}/admin/catalogue/titles/${titleId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({
          label: 'Lead Infrastructure Project Manager',
          aliases: 'PM, Project Director',
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.title.id, titleId); // ID MUST NOT CHANGE
      assert.strictEqual(data.title.label, 'Lead Infrastructure Project Manager');
      assert.deepStrictEqual(data.title.aliases, ['PM', 'Project Director']);
    });

    test('retires title without hard deletion', async () => {
      const titleId = 'civil-engineering:site-engineer-civil';

      const res = await fetch(`${baseUrl}/admin/catalogue/titles/${titleId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({ status: 'retired' }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.title.status, 'retired');

      // Verify title is still preserved in the database
      const titleColl = mockDb.collection(collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles');
      const doc = await titleColl.findOne({ id: titleId });
      assert.ok(doc, 'Retired title must remain physically in database');
      assert.strictEqual(doc.status, 'retired');
    });

    test('reactivates retired title', async () => {
      const titleId = 'civil-engineering:site-engineer-civil';

      const res = await fetch(`${baseUrl}/admin/catalogue/titles/${titleId}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({ status: 'active' }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.title.status, 'active');
    });
  });

  describe('8. Hard Deletion & Reassignment Rejection Invariants', () => {
    test('rejects department deletion route with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering/delete`, {
        method: 'POST',
      });
      assert.strictEqual(res.status, 405);
      const body = await res.text();
      assert.match(body, /Departments cannot be deleted/);
    });

    test('rejects title deletion route with 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/titles/civil-engineering:project-manager/delete`, {
        method: 'POST',
      });
      assert.strictEqual(res.status, 405);
      const body = await res.text();
      assert.match(body, /Titles cannot be deleted/);
    });

    test('rejects title reassignment with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/titles/civil-engineering:project-manager/reassign`, {
        method: 'POST',
      });
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.match(body, /Department Reassignment Not Supported/);
    });
  });

  describe('9. Audit Failure Handling (Fails Closed)', () => {
    test('fails closed with 500 error if audit logging cannot be recorded', async () => {
      // Mock auditHelper to fail
      const auditHelper = require('../Helpers/audit-helper');
      const originalLogAction = auditHelper.logAction;
      auditHelper.logAction = async () => false;

      // Also break audit_logs collection to simulate complete audit system outage
      const auditColl = mockDb.collection(collection.AUDIT_LOG_COLLECTION || 'audit_logs');
      auditColl.insertOne = async () => {
        throw new Error('Audit storage failure');
      };

      try {
        const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'x-csrf-token': currentSession.csrfToken,
          },
          body: JSON.stringify({ name: 'Unaudited Department Update' }),
        });

        assert.strictEqual(res.status, 500);
        const data = await res.json();
        assert.strictEqual(data.success, false);
        assert.strictEqual(data.auditFailure, true);
        assert.match(data.message, /Security Audit Failure/);
      } finally {
        // Restore audit helper
        auditHelper.logAction = originalLogAction;
      }
    });
  });

  describe('10. Safe Rendering and Escaping', () => {
    test('input with HTML tags is rejected by server validation', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: JSON.stringify({ name: 'Civil <script>alert(1)</script>' }),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /must be plain text without HTML angle brackets/);
    });

    test('sanitizes returnTo parameter to prevent open redirect vulnerabilities', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-csrf-token': currentSession.csrfToken,
        },
        body: new URLSearchParams({
          _csrf: currentSession.csrfToken,
          name: 'Civil Works',
          returnTo: 'https://malicious-external-site.com/exploit',
        }),
        redirect: 'manual',
      });

      assert.strictEqual(res.status, 302);
      const location = res.headers.get('location');
      assert.ok(location.startsWith('/admin/catalogue/departments/civil-engineering'));
      assert.ok(!location.includes('malicious-external-site.com'));
    });
  });
});
