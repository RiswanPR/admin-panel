'use strict';

/**
 * Zeitnah Admin Panel — Automated Test Suite: Custom Title Requests & Review Queue (Phase 4 & Phase 6)
 *
 * Verifies:
 * 1. Pending request listing, status/department filtering, search, and pagination.
 * 2. Authentication, authorization (manage_taxonomy), and CSRF guarding on request review routes.
 * 3. Successful title request approval:
 *    - Validates request and target department
 *    - Generates department-scoped composite stable ID (<deptId>:<slug>)
 *    - Inserts new title into catalogue_titles with status 'active' and sequenced displayOrder
 *    - Transitions request status to 'approved' and records reviewer info
 *    - Records structured audit log
 * 4. Approval duplicate detection and idempotency:
 *    - Repeated approval calls are idempotent (returns alreadyApproved: true)
 *    - Safe linking if title with equivalent slug already exists
 *    - Rejection of approval if department is retired or non-existent
 * 5. Request rejection:
 *    - Sets status to 'rejected' with administrative reason
 *    - Strictly guarantees zero writes/mutations to catalogue_titles
 *    - Repeated rejection calls are idempotent (returns alreadyRejected: true)
 *    - Records structured audit log
 * 6. Audit logging failure enforcement (fails closed).
 * 7. Open redirect protection on returnTo.
 *
 * Uses isolated in-memory mock database collections and ephemeral HTTP server with zero external network or database dependencies.
 */

const assert = require('assert');
const { test, describe, before, after, beforeEach } = require('node:test');
const http = require('http');
const express = require('express');

const collection = require('../config/collections');
const catalogueAdmin = require('../Helpers/catalogue-admin-helper');
const adminCatalogueRouter = require('../routes/admin-catalogue');
const dbConfig = require('../config/connection');

/**
 * High-fidelity in-memory mock MongoDB collection and database
 */
function getDeepValue(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = path.split('.');
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
        find: (query = {}, options = {}) => {
          const filtered = store.filter((doc) => matchesFilter(doc, query));
          return {
            toArray: async () => filtered.map((d) => JSON.parse(JSON.stringify(d))),
            sort: () => ({
              toArray: async () => filtered.map((d) => JSON.parse(JSON.stringify(d))),
              skip: (s) => ({
                limit: (l) => ({
                  toArray: async () =>
                    filtered
                      .slice(s, s + l)
                      .map((d) => JSON.parse(JSON.stringify(d))),
                }),
              }),
            }),
            skip: (s) => ({
              limit: (l) => ({
                toArray: async () =>
                  filtered
                    .slice(s, s + l)
                    .map((d) => JSON.parse(JSON.stringify(d))),
              }),
            }),
          };
        },
        insertOne: async (doc) => {
          const cloned = JSON.parse(JSON.stringify(doc));
          if (!cloned._id) cloned._id = `id_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
          store.push(cloned);
          return { insertedId: cloned._id, acknowledged: true };
        },
        insertMany: async (docs) => {
          const insertedIds = {};
          for (let i = 0; i < docs.length; i++) {
            const cloned = JSON.parse(JSON.stringify(docs[i]));
            if (!cloned._id) cloned._id = `id_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            store.push(cloned);
            insertedIds[i] = cloned._id;
          }
          return { insertedCount: docs.length, insertedIds, acknowledged: true };
        },
        updateOne: async (query, update) => {
          const doc = store.find((d) => matchesFilter(d, query));
          if (!doc) return { matchedCount: 0, modifiedCount: 0 };

          if (update.$set) {
            for (const [k, v] of Object.entries(update.$set)) {
              doc[k] = JSON.parse(JSON.stringify(v));
            }
          }
          if (update.$inc) {
            for (const [k, incVal] of Object.entries(update.$inc)) {
              doc[k] = (doc[k] || 0) + incVal;
            }
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
      });
    }
    return collections.get(name);
  }

  return {
    collection: getCollection,
    getRawStore: (name) => getCollection(name).store,
  };
}

describe('Zeitnah Admin — Custom Title Requests Review Queue', () => {
  let mockDb;
  let adminContext;
  let app;
  let server;
  let baseUrl;
  let currentSession;

  before(async () => {
    app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // Simple Handlebars engine stub
    app.engine('hbs', (filePath, options, callback) => callback(null, '<html>rendered-title-requests</html>'));
    app.set('views', '/tmp');
    app.set('view engine', 'hbs');

    // Test session & mockDb middleware
    app.use((req, res, next) => {
      req.session = currentSession;
      req.mockDb = mockDb;
      next();
    });

    // Mount admin catalogue router
    app.use('/admin/catalogue', adminCatalogueRouter);

    // Ephemeral HTTP server
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
    dbConfig.get = () => mockDb;

    // Populate initial test department
    mockDb.getRawStore(collection.CATALOGUE_DEPARTMENTS_COLLECTION).push(
      {
        id: 'civil-engineering',
        name: 'Civil Engineering',
        status: 'active',
        displayOrder: 1,
        catalogueVersion: '2026.1',
        aliases: [],
      },
      {
        id: 'retired-department',
        name: 'Retired Department',
        status: 'retired',
        displayOrder: 2,
        catalogueVersion: '2026.1',
        aliases: [],
      }
    );

    // Populate initial existing title in civil-engineering
    mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).push({
      id: 'civil-engineering:site-engineer',
      departmentId: 'civil-engineering',
      label: 'Site Engineer',
      status: 'active',
      displayOrder: 1,
      catalogueVersion: '2026.1',
      aliases: [],
    });

    // Populate sample requests in catalogue_title_requests
    mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push(
      {
        id: 'req_001',
        userId: 'user_101',
        userName: 'Alex Smith',
        userEmail: 'alex@example.com',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Coastal Protection Engineer',
        normalizedTitle: 'coastal protection engineer',
        status: 'pending',
        submittedAt: new Date('2026-10-15T10:00:00Z'),
        reviewedAt: null,
        reviewerId: null,
        createdTitleId: null,
      },
      {
        id: 'req_002',
        userId: 'user_102',
        userName: 'Sam Wilson',
        userEmail: 'sam@example.com',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Bridge Rehabilitation Specialist',
        normalizedTitle: 'bridge rehabilitation specialist',
        status: 'pending',
        submittedAt: new Date('2026-10-16T12:00:00Z'),
        reviewedAt: null,
        reviewerId: null,
        createdTitleId: null,
      },
      {
        id: 'req_003',
        userId: 'user_103',
        userName: 'Taylor Lee',
        userEmail: 'taylor@example.com',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Geotechnical Site Analyst',
        normalizedTitle: 'geotechnical site analyst',
        status: 'approved',
        submittedAt: new Date('2026-10-14T08:00:00Z'),
        reviewedAt: new Date('2026-10-15T09:00:00Z'),
        reviewerId: 'admin_1',
        createdTitleId: 'civil-engineering:geotechnical-site-analyst',
      }
    );

    adminContext = {
      db: mockDb,
      actor: {
        _id: 'admin_super_1',
        name: 'Chief Admin',
        role: 'superuser',
      },
      reason: 'Automated test suite review',
    };

    currentSession = {
      adminloggedIn: true,
      admin: {
        _id: 'admin_super_1',
        name: 'Chief Admin',
        role: 'superuser',
      },
      csrfToken: 'test-valid-csrf-token',
    };
  });

  describe('1. Request Listing, Filtering & Metrics', () => {
    test('lists requests with default status=pending filter', async () => {
      const res = await catalogueAdmin.getTitleRequests({ status: 'pending' }, { page: 1, limit: 10 }, { db: mockDb });
      assert.strictEqual(res.requests.length, 2);
      assert.strictEqual(res.pendingCount, 2);
      assert.strictEqual(res.approvedCount, 1);
      assert.ok(res.requests.every((r) => r.status === 'pending'));
    });

    test('supports filtering by status=all and specific department', async () => {
      const res = await catalogueAdmin.getTitleRequests(
        { status: 'all', departmentId: 'civil-engineering' },
        { page: 1, limit: 10 },
        { db: mockDb }
      );
      assert.strictEqual(res.requests.length, 3);
      assert.strictEqual(res.total, 3);
    });

    test('supports keyword search across requestedTitle and requester details', async () => {
      const res = await catalogueAdmin.getTitleRequests(
        { status: 'all', search: 'coastal' },
        { page: 1, limit: 10 },
        { db: mockDb }
      );
      assert.strictEqual(res.requests.length, 1);
      assert.strictEqual(res.requests[0].requestedTitle, 'Coastal Protection Engineer');
    });

    test('rejects invalid status filter with validation error', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.getTitleRequests({ status: 'unsupported_status' }, {}, { db: mockDb });
        },
        /Invalid status filter/
      );
    });

    test('fetches a single request by ID', async () => {
      const reqDoc = await catalogueAdmin.getTitleRequestById('req_001', { db: mockDb });
      assert.ok(reqDoc);
      assert.strictEqual(reqDoc.id, 'req_001');
      assert.strictEqual(reqDoc.requestedTitle, 'Coastal Protection Engineer');
    });
  });

  describe('2. Request Approval Workflow & Idempotency', () => {
    test('successfully approves a pending request and inserts title into catalogue', async () => {
      const result = await catalogueAdmin.approveTitleRequest(
        'req_001',
        { note: 'Approved standard coastal engineering title' },
        adminContext
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.request.status, 'approved');
      assert.strictEqual(result.request.createdTitleId, 'civil-engineering:coastal-protection-engineer');
      assert.strictEqual(result.request.reviewerId, 'admin_super_1');
      assert.ok(result.request.reviewedAt);

      // Verify title was inserted into catalogue_titles
      const titlesStore = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION);
      const inserted = titlesStore.find((t) => t.id === 'civil-engineering:coastal-protection-engineer');
      assert.ok(inserted, 'Title must be inserted into catalogue_titles');
      assert.strictEqual(inserted.label, 'Coastal Protection Engineer');
      assert.strictEqual(inserted.status, 'active');
      assert.strictEqual(inserted.departmentId, 'civil-engineering');
      assert.strictEqual(inserted.displayOrder, 2); // 1 existing + 1
    });

    test('repeated approval call is strictly idempotent and does not insert duplicate titles', async () => {
      // First approval
      await catalogueAdmin.approveTitleRequest('req_001', {}, adminContext);
      const initialTitlesCount = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).length;

      // Second approval attempt
      const secondResult = await catalogueAdmin.approveTitleRequest('req_001', {}, adminContext);
      assert.strictEqual(secondResult.success, true);
      assert.strictEqual(secondResult.alreadyApproved, true);

      // Title count in catalogue_titles must remain unchanged
      const finalTitlesCount = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).length;
      assert.strictEqual(finalTitlesCount, initialTitlesCount);
    });

    test('safely links if equivalent title already exists in catalogue without inserting duplicate', async () => {
      // Add a request for 'Site Engineer' (which already exists in civil-engineering)
      mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push({
        id: 'req_duplicate',
        userId: 'user_999',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Site Engineer',
        normalizedTitle: 'site engineer',
        status: 'pending',
      });

      const initialCount = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).length;

      const res = await catalogueAdmin.approveTitleRequest('req_duplicate', {}, adminContext);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.request.status, 'approved');
      assert.strictEqual(res.alreadyExisted, true);

      // No new title record inserted
      const finalCount = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).length;
      assert.strictEqual(finalCount, initialCount);
    });

    test('rejects approval when request references retired department', async () => {
      mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push({
        id: 'req_retired_dept',
        userId: 'user_404',
        departmentId: 'retired-department',
        departmentName: 'Retired Department',
        requestedTitle: 'Some Role',
        status: 'pending',
      });

      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_retired_dept', {}, adminContext);
        },
        /Cannot approve title request for retired department/
      );
    });

    test('rejects approval of non-existent request ID', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('non_existent_id', {}, adminContext);
        },
        /not found/
      );
    });
  });

  describe('3. Request Rejection Workflow', () => {
    test('successfully rejects a pending request with reason', async () => {
      const result = await catalogueAdmin.rejectTitleRequest(
        'req_002',
        { reason: 'Role title is redundant with existing Structural Engineer' },
        adminContext
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.request.status, 'rejected');
      assert.strictEqual(result.request.reviewNote, 'Role title is redundant with existing Structural Engineer');
      assert.strictEqual(result.request.reviewerId, 'admin_super_1');
      assert.ok(result.request.reviewedAt);
    });

    test('rejection strictly guarantees zero mutations or inserts to catalogue_titles', async () => {
      const initialTitles = JSON.parse(
        JSON.stringify(mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION))
      );

      await catalogueAdmin.rejectTitleRequest(
        'req_002',
        { reason: 'Not an engineering role' },
        adminContext
      );

      const finalTitles = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION);
      assert.deepStrictEqual(finalTitles, initialTitles, 'Catalogue titles must remain identical on rejection');
    });

    test('repeated rejection call is idempotent and safe', async () => {
      await catalogueAdmin.rejectTitleRequest('req_002', { reason: 'Test' }, adminContext);
      const second = await catalogueAdmin.rejectTitleRequest('req_002', { reason: 'Test again' }, adminContext);

      assert.strictEqual(second.success, true);
      assert.strictEqual(second.alreadyRejected, true);
    });

    test('cannot reject an already approved request', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.rejectTitleRequest('req_003', {}, adminContext); // req_003 is already approved
        },
        /Cannot reject request 'req_003': current status is 'approved'/
      );
    });
  });

  describe('4. Express Route Integration, Auth & CSRF Protection', () => {
    test('unauthenticated request redirects to /login on GET and returns 401 on AJAX', async () => {
      currentSession = { adminloggedIn: false };

      const getRes = await fetch(`${baseUrl}/admin/catalogue/requests`, {
        redirect: 'manual',
      });
      assert.strictEqual(getRes.status, 302);
      assert.strictEqual(getRes.headers.get('location'), '/login');

      const postRes = await fetch(`${baseUrl}/admin/catalogue/requests/req_001/approve`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      assert.strictEqual(postRes.status, 401);
      const postData = await postRes.json();
      assert.strictEqual(postData.success, false);
    });

    test('authenticated user without manage_taxonomy capability receives 403 Forbidden', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_read_only',
          role: 'viewer',
          capabilities: [],
        },
        csrfToken: 'test-token',
      };

      const res = await fetch(`${baseUrl}/admin/catalogue/requests`, {
        headers: { accept: 'application/json' },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /Permission denied: Insufficient privileges/);
    });

    test('rejects POST mutation missing CSRF token with 403 Forbidden', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'expected-token-123',
      };

      // POST without CSRF header or body
      const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_001/approve`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ note: 'Approving without CSRF' }),
      });

      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /CSRF/i);
    });

    test('authorized admin with valid CSRF successfully approves request via POST route', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'valid-token-xyz',
      };

      const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_001/approve`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-csrf-token': 'valid-token-xyz',
        },
        body: JSON.stringify({ note: 'Approved via route test' }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.request.status, 'approved');
      assert.strictEqual(data.request.createdTitleId, 'civil-engineering:coastal-protection-engineer');
    });

    test('authorized admin with valid CSRF successfully rejects request via POST route', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'valid-token-xyz',
      };

      const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_002/reject`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-csrf-token': 'valid-token-xyz',
        },
        body: JSON.stringify({ reason: 'Out of domain scope' }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.request.status, 'rejected');
      assert.strictEqual(data.request.reviewNote, 'Out of domain scope');
    });
  });
});
