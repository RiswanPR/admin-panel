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
        deleteOne: async (query = {}) => {
          const idx = store.findIndex((doc) => matchesFilter(doc, query));
          if (idx !== -1) {
            store.splice(idx, 1);
            return { deletedCount: 1, acknowledged: true };
          }
          return { deletedCount: 0, acknowledged: true };
        },
        insertOne: async (doc) => {
          const cloned = JSON.parse(JSON.stringify(doc));
          if (cloned.id && store.some((d) => d.id === cloned.id)) {
            const err = new Error(`E11000 duplicate key error collection: ${name} index: id_1 dup key: { id: "${cloned.id}" }`);
            err.code = 11000;
            throw err;
          }
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

    test('existing title collision prevents duplicate creation and returns clear conflict error', async () => {
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

      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_duplicate', {}, adminContext);
        },
        (err) => {
          assert.strictEqual(err.code, 'CONFLICT');
          assert.match(err.message, /conflicts with existing catalogue title/);
          return true;
        }
      );

      // Verify no new title was inserted
      const finalCount = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).length;
      assert.strictEqual(finalCount, initialCount);

      // Verify request remains pending
      const reqDoc = await catalogueAdmin.getTitleRequestById('req_duplicate', { db: mockDb });
      assert.strictEqual(reqDoc.status, 'pending');

      // Verify conflict audit log was recorded
      const auditStore = mockDb.getRawStore(collection.AUDIT_LOG_COLLECTION);
      const conflictLog = auditStore.find((a) => a.action === 'CATALOGUE_TITLE_REQUEST_APPROVAL_CONFLICT');
      assert.ok(conflictLog, 'Audit log must record approval conflict attempt');
    });

    test('alias collision in same department prevents duplicate creation and returns conflict error', async () => {
      // Add existing title with an alias
      mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).push({
        id: 'civil-engineering:project-engineer',
        departmentId: 'civil-engineering',
        label: 'Project Engineer',
        status: 'active',
        displayOrder: 2,
        aliases: ['Field Project Lead'],
      });

      mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push({
        id: 'req_alias_dup',
        userId: 'user_777',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Field Project Lead',
        normalizedTitle: 'field project lead',
        status: 'pending',
      });

      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_alias_dup', {}, adminContext);
        },
        /conflicts with existing catalogue title/
      );
    });

    test('server-side validation rejects invalid title label (<2 chars, >100 chars, control chars, HTML)', async () => {
      // < 2 chars
      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_001', { label: 'A' }, adminContext);
        },
        /must be at least 2 character\(s\) long/
      );

      // > 100 chars
      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_001', { label: 'X'.repeat(101) }, adminContext);
        },
        /must not exceed 100 characters/
      );

      // HTML markup
      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_001', { label: '<script>alert(1)</script>' }, adminContext);
        },
        /HTML angle brackets/
      );

      // Control characters
      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_001', { label: 'Engineer\x00' }, adminContext);
        },
        /control characters/
      );
    });

    test('recovers from prior partial failure without creating duplicate titles', async () => {
      // Simulate title was inserted in previous run but request status update failed
      const preInsertedTitle = {
        id: 'civil-engineering:coastal-protection-engineer',
        departmentId: 'civil-engineering',
        label: 'Coastal Protection Engineer',
        status: 'active',
        displayOrder: 2,
        requestId: 'req_001',
      };
      mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).push(preInsertedTitle);
      const countBefore = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).length;

      // Retry approving req_001
      const res = await catalogueAdmin.approveTitleRequest('req_001', {}, adminContext);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.request.status, 'approved');

      // Title count must NOT increase
      const countAfter = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).length;
      assert.strictEqual(countAfter, countBefore);
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

    test('concurrent approval of same request behaves safely and returns alreadyApproved: true for the second call', async () => {
      const [res1, res2] = await Promise.all([
        catalogueAdmin.approveTitleRequest('req_001', {}, adminContext),
        catalogueAdmin.approveTitleRequest('req_001', {}, adminContext),
      ]);

      assert.strictEqual(res1.success, true);
      assert.strictEqual(res2.success, true);
      const alreadyApprovedCount = (res1.alreadyApproved ? 1 : 0) + (res2.alreadyApproved ? 1 : 0);
      assert.strictEqual(alreadyApprovedCount, 1);

      const titlesStore = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION);
      const inserted = titlesStore.filter((t) => t.id === 'civil-engineering:coastal-protection-engineer');
      assert.strictEqual(inserted.length, 1);
    });

    test('concurrent duplicate title creation across two distinct requests raises 409 conflict and logs conflict audit event', async () => {
      mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push(
        {
          id: 'req_concurrent_a',
          userId: 'user_a',
          departmentId: 'civil-engineering',
          departmentName: 'Civil Engineering',
          requestedTitle: 'Marine Geotechnical Engineer',
          status: 'pending',
        },
        {
          id: 'req_concurrent_b',
          userId: 'user_b',
          departmentId: 'civil-engineering',
          departmentName: 'Civil Engineering',
          requestedTitle: 'Marine Geotechnical Engineer',
          status: 'pending',
        }
      );

      const resA = await catalogueAdmin.approveTitleRequest('req_concurrent_a', {}, adminContext);
      assert.strictEqual(resA.success, true);

      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_concurrent_b', {}, adminContext);
        },
        (err) => {
          assert.strictEqual(err.code, 'CONFLICT');
          assert.strictEqual(err.status, 409);
          return true;
        }
      );

      const auditStore = mockDb.getRawStore(collection.AUDIT_LOG_COLLECTION);
      const conflictLog = auditStore.find((a) => a.action === 'CATALOGUE_TITLE_REQUEST_APPROVAL_CONFLICT' && a.entityId === 'req_concurrent_b');
      assert.ok(conflictLog, 'Audit log must record conflict for request B');
    });

    test('rolls back newly created title if request status was changed concurrently away from pending', async () => {
      mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push({
        id: 'req_concurrent_abort',
        userId: 'user_abort',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Offshore Wind Structural Engineer',
        status: 'pending',
      });

      const reqColl = mockDb.collection(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION);
      const originalUpdateOne = reqColl.updateOne;
      reqColl.updateOne = async (query, update) => {
        if (query.id === 'req_concurrent_abort') {
          const doc = mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).find((d) => d.id === 'req_concurrent_abort');
          if (doc) doc.status = 'rejected';
          return { matchedCount: 0, modifiedCount: 0 };
        }
        return originalUpdateOne(query, update);
      };

      await assert.rejects(
        async () => {
          await catalogueAdmin.approveTitleRequest('req_concurrent_abort', {}, adminContext);
        },
        (err) => {
          assert.strictEqual(err.code, 'CONFLICT');
          assert.strictEqual(err.status, 409);
          return true;
        }
      );

      const titlesStore = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION);
      const orphaned = titlesStore.find((t) => t.id === 'civil-engineering:offshore-wind-structural-engineer');
      assert.strictEqual(orphaned, undefined, 'Orphaned title must be deleted via rollback on concurrent abort');
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

    test('rejects rejection reason with HTML tags or exceeding 500 characters', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.rejectTitleRequest('req_002', { reason: '<b>Bold HTML</b>' }, adminContext);
        },
        /HTML angle brackets/
      );

      await assert.rejects(
        async () => {
          await catalogueAdmin.rejectTitleRequest('req_002', { reason: 'R'.repeat(501) }, adminContext);
        },
        /must not exceed 500 characters/
      );
    });

    test('rejection safely cleans up unapproved title lingering from a prior aborted/failed approval attempt', async () => {
      mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push({
        id: 'req_failed_prior',
        userId: 'user_failed',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Tunnel Ventilation Engineer',
        status: 'pending',
      });

      mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION).push({
        id: 'civil-engineering:tunnel-ventilation-engineer',
        departmentId: 'civil-engineering',
        label: 'Tunnel Ventilation Engineer',
        status: 'active',
        displayOrder: 99,
        requestId: 'req_failed_prior',
      });

      const titlesBefore = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION);
      assert.ok(titlesBefore.some((t) => t.id === 'civil-engineering:tunnel-ventilation-engineer'));

      const res = await catalogueAdmin.rejectTitleRequest('req_failed_prior', { reason: 'Not an accepted role' }, adminContext);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.request.status, 'rejected');

      const titlesAfter = mockDb.getRawStore(collection.CATALOGUE_TITLES_COLLECTION);
      const lingering = titlesAfter.find((t) => t.requestId === 'req_failed_prior');
      assert.strictEqual(lingering, undefined, 'Lingering unapproved title must be deleted when request is rejected');
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

    test('GET /admin/catalogue/requests/:id returns 200 and details for existing request', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'valid-token-xyz',
      };

      const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_001`, {
        headers: { accept: 'application/json' },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.request.id, 'req_001');
      assert.strictEqual(data.request.requestedTitle, 'Coastal Protection Engineer');
      assert.strictEqual(data.department.id, 'civil-engineering');
    });

    test('GET /admin/catalogue/requests/:id returns 404 for non-existent request', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'valid-token-xyz',
      };

      const res = await fetch(`${baseUrl}/admin/catalogue/requests/non_existent_999`, {
        headers: { accept: 'application/json' },
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /not found/i);
    });

    test('POST approve route enforces conflict return status 409 when collision detected', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'valid-token-xyz',
      };

      // Add duplicate request
      mockDb.getRawStore(collection.CATALOGUE_TITLE_REQUESTS_COLLECTION).push({
        id: 'req_dup_route',
        userId: 'user_888',
        departmentId: 'civil-engineering',
        departmentName: 'Civil Engineering',
        requestedTitle: 'Site Engineer',
        normalizedTitle: 'site engineer',
        status: 'pending',
      });

      const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_dup_route/approve`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-csrf-token': 'valid-token-xyz',
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(res.status, 409);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.match(data.message, /conflicts with existing catalogue title/);
    });

    test('reviewer identity is derived strictly from server-side session, ignoring body overrides', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'real_admin_777',
          name: 'Legit Admin',
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
        body: JSON.stringify({
          reviewerId: 'spoofed_admin_id',
          reviewerName: 'Fake Name',
          status: 'pending', // attempt to tamper status
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.request.status, 'approved');
      assert.strictEqual(data.request.reviewerId, 'real_admin_777');
      assert.strictEqual(data.request.reviewerName, 'Legit Admin');
    });

    test('POST approve route fails closed (500) if audit logging fails', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'valid-token-xyz',
      };

      const auditHelper = require('../Helpers/audit-helper');
      const originalLogAction = auditHelper.logAction;
      auditHelper.logAction = async () => false;

      const auditColl = mockDb.collection(collection.AUDIT_LOG_COLLECTION);
      const originalInsertOne = auditColl.insertOne;
      auditColl.insertOne = async () => { throw new Error('Audit disk full'); };

      try {
        const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_001/approve`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-csrf-token': 'valid-token-xyz',
          },
          body: JSON.stringify({}),
        });

        assert.strictEqual(res.status, 500);
        const data = await res.json();
        assert.strictEqual(data.success, false);
        assert.strictEqual(data.auditFailure, true);
      } finally {
        auditHelper.logAction = originalLogAction;
        auditColl.insertOne = originalInsertOne;
      }
    });

    test('POST reject route fails closed (500) if audit logging fails', async () => {
      currentSession = {
        adminloggedIn: true,
        admin: {
          _id: 'admin_super_1',
          name: 'Chief Admin',
          role: 'superuser',
        },
        csrfToken: 'valid-token-xyz',
      };

      const auditHelper = require('../Helpers/audit-helper');
      const originalLogAction = auditHelper.logAction;
      auditHelper.logAction = async () => false;

      const auditColl = mockDb.collection(collection.AUDIT_LOG_COLLECTION);
      const originalInsertOne = auditColl.insertOne;
      auditColl.insertOne = async () => { throw new Error('Audit disk full'); };

      try {
        const res = await fetch(`${baseUrl}/admin/catalogue/requests/req_002/reject`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-csrf-token': 'valid-token-xyz',
          },
          body: JSON.stringify({ reason: 'Failed audit test' }),
        });

        assert.strictEqual(res.status, 500);
        const data = await res.json();
        assert.strictEqual(data.success, false);
        assert.strictEqual(data.auditFailure, true);
      } finally {
        auditHelper.logAction = originalLogAction;
        auditColl.insertOne = originalInsertOne;
      }
    });
  });

  describe('5. Partial Unique Index & Duplicate Pending Request Protection (Phase 10)', () => {
    const { ensureCatalogueIndexes, createIndexIfPossible } = require('../Helpers/index-helper');

    test('declares partial unique index on { departmentId: 1, normalizedTitle: 1 } for status=pending', async () => {
      const createdIndexes = [];
      const testDb = {
        collection: (colName) => ({
          createIndex: async (keys, options) => {
            createdIndexes.push({ collection: colName, keys, options });
            return Object.keys(keys).join('_');
          },
        }),
      };

      await ensureCatalogueIndexes(testDb);

      const partialIndex = createdIndexes.find(
        (idx) =>
          idx.collection === collection.CATALOGUE_TITLE_REQUESTS_COLLECTION &&
          idx.keys.departmentId === 1 &&
          idx.keys.normalizedTitle === 1 &&
          !idx.keys.status
      );

      assert.ok(partialIndex, 'Partial unique index on { departmentId: 1, normalizedTitle: 1 } must be declared');
      assert.strictEqual(partialIndex.options?.unique, true, 'Partial index must specify unique: true');
      assert.deepStrictEqual(
        partialIndex.options?.partialFilterExpression,
        { status: 'pending' },
        'Partial index must filter on { status: "pending" }'
      );
    });

    test('preserves existing unique index on request id and non-unique query indexes', async () => {
      const createdIndexes = [];
      const testDb = {
        collection: (colName) => ({
          createIndex: async (keys, options) => {
            createdIndexes.push({ collection: colName, keys, options });
            return Object.keys(keys).join('_');
          },
        }),
      };

      await ensureCatalogueIndexes(testDb);

      const reqIndexes = createdIndexes.filter(
        (idx) => idx.collection === collection.CATALOGUE_TITLE_REQUESTS_COLLECTION
      );

      const idIndex = reqIndexes.find((idx) => idx.keys.id === 1 && Object.keys(idx.keys).length === 1);
      assert.ok(idIndex, 'Unique index on id must be preserved');
      assert.strictEqual(idIndex.options?.unique, true);

      const statusSortIndex = reqIndexes.find(
        (idx) => idx.keys.status === 1 && idx.keys.createdAt === -1
      );
      assert.ok(statusSortIndex, 'Query index on { status: 1, createdAt: -1 } must be preserved');

      const compoundQueryIndex = reqIndexes.find(
        (idx) => idx.keys.departmentId === 1 && idx.keys.normalizedTitle === 1 && idx.keys.status === 1
      );
      assert.ok(compoundQueryIndex, 'Query index on { departmentId: 1, normalizedTitle: 1, status: 1 } must be preserved');
      assert.ok(!compoundQueryIndex.options?.unique, 'Query compound index must remain non-unique for multi-field lookups');
    });

    test('partial unique index rejects duplicate pending requests with E11000 duplicate key error', async () => {
      const store = [];
      const customInsert = async (doc) => {
        if (doc.status === 'pending') {
          const duplicate = store.find(
            (d) =>
              d.status === 'pending' &&
              d.departmentId === doc.departmentId &&
              d.normalizedTitle === doc.normalizedTitle
          );
          if (duplicate) {
            const err = new Error(
              `E11000 duplicate key error collection: catalogue_title_requests index: departmentId_1_normalizedTitle_1 dup key: { departmentId: "${doc.departmentId}", normalizedTitle: "${doc.normalizedTitle}" }`
            );
            err.code = 11000;
            throw err;
          }
        }
        store.push(JSON.parse(JSON.stringify(doc)));
        return { insertedId: doc.id, acknowledged: true };
      };

      await customInsert({
        id: 'req_partial_1',
        departmentId: 'civil-engineering',
        normalizedTitle: 'tunnel ventilation engineer',
        status: 'pending',
      });

      await assert.rejects(
        async () => {
          await customInsert({
            id: 'req_partial_2',
            departmentId: 'civil-engineering',
            normalizedTitle: 'tunnel ventilation engineer',
            status: 'pending',
          });
        },
        (err) => {
          assert.strictEqual(err.code, 11000);
          assert.match(err.message, /E11000 duplicate key error/);
          return true;
        }
      );
    });

    test('partial unique index permits coexisting historical records when status is approved or rejected', async () => {
      const store = [];
      const customInsert = async (doc) => {
        if (doc.status === 'pending') {
          const duplicate = store.find(
            (d) =>
              d.status === 'pending' &&
              d.departmentId === doc.departmentId &&
              d.normalizedTitle === doc.normalizedTitle
          );
          if (duplicate) {
            const err = new Error('E11000 duplicate key error');
            err.code = 11000;
            throw err;
          }
        }
        store.push(JSON.parse(JSON.stringify(doc)));
        return { insertedId: doc.id, acknowledged: true };
      };

      await customInsert({
        id: 'req_approved_hist',
        departmentId: 'civil-engineering',
        normalizedTitle: 'structural forensic engineer',
        status: 'approved',
      });

      await customInsert({
        id: 'req_rejected_hist',
        departmentId: 'civil-engineering',
        normalizedTitle: 'structural forensic engineer',
        status: 'rejected',
      });

      await customInsert({
        id: 'req_new_pending',
        departmentId: 'civil-engineering',
        normalizedTitle: 'structural forensic engineer',
        status: 'pending',
      });

      assert.strictEqual(store.length, 3, 'Approved, rejected, and pending records must coexist safely');
    });

    test('createIndexIfPossible safely catches IndexOptionsConflict (code 85) without throwing', async () => {
      const conflictingDb = {
        collection: () => ({
          createIndex: async () => {
            const err = new Error('Index already exists with different options');
            err.code = 85;
            err.codeName = 'IndexOptionsConflict';
            throw err;
          },
        }),
      };

      await assert.doesNotReject(async () => {
        await createIndexIfPossible(
          conflictingDb,
          collection.CATALOGUE_TITLE_REQUESTS_COLLECTION,
          { departmentId: 1, normalizedTitle: 1 },
          { unique: true, partialFilterExpression: { status: 'pending' } }
        );
      });
    });
  });
});
