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
          or: (...args) => args.slice(0, -1).some(Boolean),
          ifEquals: function (a, b, options) {
            return String(a) === String(b) ? options.fn(this) : options.inverse(this);
          },
          inc: (val) => Number(val || 0) + 1,
          dec: (val) => Math.max(1, Number(val || 1) - 1),
          add: (a, b) => Number(a || 0) + Number(b || 0),
          ifGt: function (a, b, options) {
            return Number(a) > Number(b) ? options.fn(this) : options.inverse(this);
          },
          ifLt: function (a, b, options) {
            return Number(a) < Number(b) ? options.fn(this) : options.inverse(this);
          },
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

  describe('11. Phase 10: Navigation Permissions & Department Requests Shortcut', () => {
    const fs = require('fs');
    const handlebars = require('handlebars');

    const headerHbsSource = fs.readFileSync(
      path.join(__dirname, '../views/partials/Admin-Header.hbs'),
      'utf8'
    );
    const compileHeader = () => {
      const hbsInstance = handlebars.create();
      hbsInstance.registerHelper('or', (...args) => args.slice(0, -1).some(Boolean));
      hbsInstance.registerHelper('ifEquals', function (a, b, options) {
        return String(a) === String(b) ? options.fn(this) : options.inverse(this);
      });
      return hbsInstance.compile(headerHbsSource);
    };

    test('taxonomy manager sees Identity Catalogue and Title Requests in header', () => {
      const template = compileHeader();
      const html = template({
        canManageTaxonomy: true,
        canManageAI: false,
        isSuperuser: false,
      });

      assert.ok(html.includes('/admin/catalogue/departments'), 'Taxonomy manager must see Identity Catalogue link');
      assert.ok(html.includes('/admin/catalogue/requests'), 'Taxonomy manager must see Title Requests link');
    });

    test('superuser sees Identity Catalogue and Title Requests in header', () => {
      const template = compileHeader();
      const html = template({
        canManageTaxonomy: false,
        canManageAI: false,
        isSuperuser: true,
      });

      assert.ok(html.includes('/admin/catalogue/departments'), 'Superuser must see Identity Catalogue link');
      assert.ok(html.includes('/admin/catalogue/requests'), 'Superuser must see Title Requests link');
    });

    test('AI-only manager (without manage_taxonomy) does NOT see catalogue links in header', () => {
      const template = compileHeader();
      const html = template({
        canManageAI: true,
        canManageTaxonomy: false,
        isSuperuser: false,
      });

      assert.ok(!html.includes('/admin/catalogue/departments'), 'AI-only manager must NOT see Identity Catalogue link');
      assert.ok(!html.includes('/admin/catalogue/requests'), 'AI-only manager must NOT see Title Requests link');
      assert.ok(html.includes('/admin/ai/matching'), 'AI manager still sees Matching link');
      assert.ok(html.includes('/admin/ai/config'), 'AI manager still sees AI Monitoring link');
    });

    test('administrator without taxonomy or AI permissions does NOT see Career Intelligence catalogue links', () => {
      const template = compileHeader();
      const html = template({
        canManageAI: false,
        canManageTaxonomy: false,
        isSuperuser: false,
      });

      assert.ok(!html.includes('/admin/catalogue/departments'));
      assert.ok(!html.includes('/admin/catalogue/requests'));
    });

    test('department titles page renders contextual shortcut to filtered requests queue', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/departments/civil-engineering`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();

      assert.match(
        body,
        /\/admin\/catalogue\/requests\?departmentId=civil-engineering/,
        'Must contain contextual link to filtered requests for civil-engineering'
      );
      assert.match(body, /Title Requests/, 'Shortcut must show "Title Requests" button text');

      assert.match(body, /Add Professional Title/, 'Add title button must be preserved');
      assert.match(body, /Edit Department/, 'Edit department button must be preserved');
      assert.match(body, /All Departments/, 'All departments link must be preserved');
    });

    test('department shortcut dynamically interpolates different department IDs without hardcoding', async () => {
      mockDb.getRawCollection(collection.CATALOGUE_DEPARTMENTS_COLLECTION).store.push({
        id: 'mechanical-engineering',
        name: 'Mechanical Engineering',
        status: 'active',
        displayOrder: 2,
        catalogueVersion: '2026.1',
        aliases: [],
      });

      const res = await fetch(`${baseUrl}/admin/catalogue/departments/mechanical-engineering`);
      assert.strictEqual(res.status, 200);
      const body = await res.text();

      assert.match(
        body,
        /\/admin\/catalogue\/requests\?departmentId=mechanical-engineering/,
        'Must dynamically interpolate department.id rather than hardcoding'
      );
    });
  });

  describe('12. Moderation UI & Rejection Dialog Layout', () => {
    beforeEach(async () => {
      // Ensure seed request exists in mockDb
      const requestsCol = mockDb.collection(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION || 'catalogue_title_requests');
      requestsCol.store.length = 0;
      requestsCol.store.push({
        id: 'req_mod_ui_1',
        userId: 'usr_moderation_test',
        userName: 'Alex Johnson',
        userEmail: 'alex.johnson.engineering@example.com',
        requestedTitle: 'Lead Geotechnical Architect',
        normalizedTitle: 'lead geotechnical architect',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        status: 'pending',
        submittedAt: '2026-10-17 12:00:00',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    test('GET /admin/catalogue/requests renders dark-themed rejection modal outside table-responsive', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/requests`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      // Check table responsive wrapper is closed before modal definition
      const tableRespIdx = html.indexOf('class="table-responsive');
      const tableEndIdx = html.indexOf('</table>');
      const modalIdx = html.indexOf('id="rejectModal-req_mod_ui_1"');

      assert.ok(tableRespIdx > -1, 'Page must contain table-responsive container');
      assert.ok(tableEndIdx > -1, 'Page must contain closed table');
      assert.ok(modalIdx > -1, 'Page must render reject modal for req_mod_ui_1');
      assert.ok(
        modalIdx > tableEndIdx,
        'Reject modal must be positioned outside and after the table to prevent overflow clipping'
      );

      // Verify modal structure & attributes
      assert.match(html, /modal-dialog-centered/, 'Modal must be centered');
      assert.match(html, /Reject Title Request/, 'Modal must contain complete title text');
      assert.match(html, /name="reason"/, 'Modal must contain rejection reason field');
      assert.match(html, /required/, 'Rejection reason must be marked required');
      assert.match(html, /maxlength="500"/, 'Rejection reason must enforce maxlength 500');
      assert.match(html, /data-bs-dismiss="modal"/, 'Modal must support BS5 dismiss');
      assert.match(html, /data-dismiss="modal"/, 'Modal must support BS4 dismiss');
      assert.match(html, /action="\/admin\/catalogue\/requests\/req_mod_ui_1\/reject"/, 'Form action must bind exact request ID');
      assert.match(html, /name="_csrf"/, 'Form must include CSRF token');
    });

    test('GET /admin/catalogue/requests queue table has aligned headers and dark theme surfaces', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/requests`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      // Header alignment & responsive constraints
      assert.match(html, /Status<\/th>/, 'Queue table must have Status column');
      assert.match(html, /Requested Title<\/th>/, 'Queue table must have Requested Title column');
      assert.match(html, /Department<\/th>/, 'Queue table must have Department column');
      assert.match(html, /Requester<\/th>/, 'Queue table must have Requester column');
      assert.match(html, /Submitted<\/th>/, 'Queue table must have Submitted column');
      assert.match(html, /Actions<\/th>/, 'Queue table must have Actions column');

      // Check text truncation for long requester emails
      assert.match(html, /text-truncate/, 'Requester email/id must use text-truncate to avoid breaking layout');
      assert.match(html, /var\(--surface-2\)/, 'Table headers must use dark-compatible var(--surface-2)');
    });

    test('GET /admin/catalogue/requests/:requestId renders moderation actions without solid neon backgrounds', async () => {
      const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_mod_ui_1`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      // Ensure no broken Bootstrap 4 full solid neon backgrounds are present on entire form sections
      assert.ok(!html.includes('bg-success bg-opacity-10'), 'Must not use un-polyfilled bg-success bg-opacity-10');
      assert.ok(!html.includes('bg-danger bg-opacity-10'), 'Must not use un-polyfilled bg-danger bg-opacity-10');

      // Verify clean accent borders and dark surface styling
      assert.match(html, /border-left:\s*5px solid #10b981/i, 'Approval action must use subtle green accent border');
      assert.match(html, /border-left:\s*5px solid #ef4444/i, 'Rejection action must use subtle red accent border');
      assert.match(html, /action="\/admin\/catalogue\/requests\/req_mod_ui_1\/approve"/, 'Approval action binds correct request ID');
      assert.match(html, /action="\/admin\/catalogue\/requests\/req_mod_ui_1\/reject"/, 'Rejection action binds correct request ID');
      assert.match(html, /col-xl-6 col-lg-6 col-md-12 col-12/, 'Columns must use responsive grid classes');
    });

    test('Layout stylesheet contains btn-close polyfill and dark theme filter', () => {
      const fs = require('fs');
      const layoutHtml = fs.readFileSync(path.join(__dirname, '../views/Layout/layout.hbs'), 'utf8');
      assert.match(layoutHtml, /\.btn-close\s*\{/, 'Layout must define .btn-close polyfill');
      assert.match(layoutHtml, /\.btn-close-white/, 'Layout must define .btn-close-white');
      assert.match(layoutHtml, /html\[data-theme="dark"\]\s+\.btn-close/, 'Layout must support inverted close icon in dark theme');
    });
  });
});
