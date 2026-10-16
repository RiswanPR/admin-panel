'use strict';

/**
 * Zeitnah Admin Panel — Automated Test Suite: Professional Identity Catalogue Admin Service (Phase 2)
 *
 * Comprehensive tests for catalogue-admin-helper:
 * 1. Department listing, filtering, and ordering
 * 2. Department not-found behavior
 * 3. Valid and invalid department updates
 * 4. Title listing with department scoping, search, and pagination
 * 5. New title validation, sequencing, and stable ID generation
 * 6. Duplicate IDs and invalid department references
 * 7. Title rename preserving stable IDs
 * 8. Retirement and reactivation without hard deletion
 * 9. Cross-department duplicate labels remaining valid
 * 10. Rejection of unsupported department reassignment
 * 11. Audit logging for successful mutations
 * 12. No mutation when validation fails
 * 13. Unexpected input fields rejected
 * 14. Usage statistics resolution and safe null fallback
 *
 * Uses in-memory mock MongoDB collections with zero dependency on external/production databases.
 */

const assert = require('assert');
const { test, describe, beforeEach } = require('node:test');

const collection = require('../config/collections');
const { loadAndValidateCatalogue } = require('../Helpers/catalogue-loader');
const catalogueAdmin = require('../Helpers/catalogue-admin-helper');

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
          };
        },
        insertMany: async (docs, opts = {}) => {
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
          if (update.$set) {
            Object.assign(doc, JSON.parse(JSON.stringify(update.$set)));
          }
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

describe('Zeitnah Admin — Phase 2: Professional Identity Catalogue Admin Service', () => {
  let mockDb;
  let actorContext;

  beforeEach(() => {
    mockDb = createMockDb();

    // Populate mock DB with authoritative catalogue (18 depts, 254 titles)
    const catalogue = loadAndValidateCatalogue();
    const deptColl = mockDb.collection(collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments');
    const titleColl = mockDb.collection(collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles');

    deptColl.store.push(...JSON.parse(JSON.stringify(catalogue.departments)));
    titleColl.store.push(...JSON.parse(JSON.stringify(catalogue.titles)));

    actorContext = {
      db: mockDb,
      actor: {
        _id: 'admin_test_123',
        name: 'Test Administrator',
        email: 'admin@zeitnah.internal',
        role: 'superadmin',
      },
      req: {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'ZeitnahTestAgent/1.0' },
      },
      reason: 'Automated Service Unit Test',
    };
  });

  describe('1. Department Listing, Stats & Ordering', () => {
    test('retrieves all 18 departments enriched with title counts and display ordering', async () => {
      const depts = await catalogueAdmin.getDepartmentsWithStats({}, { db: mockDb });
      assert.strictEqual(depts.length, 18);

      // Verify display ordering is strictly ascending
      for (let i = 0; i < depts.length - 1; i++) {
        assert.ok(
          depts[i].displayOrder <= depts[i + 1].displayOrder,
          `Departments must be sorted by displayOrder (${depts[i].id} > ${depts[i + 1].id})`
        );
      }

      // Check civil-engineering department stats
      const civil = depts.find((d) => d.id === 'civil-engineering');
      assert.ok(civil, 'Civil engineering department must exist');
      assert.strictEqual(civil.titlesCount, 12);
      assert.strictEqual(civil.activeTitlesCount, 12);
      assert.strictEqual(civil.retiredTitlesCount, 0);
      assert.strictEqual(civil.usageCount, 0); // user collection exists and has 0 matching profiles
    });

    test('filters departments by status', async () => {
      // Retire one department first
      await catalogueAdmin.updateDepartment('civil-engineering', { status: 'retired' }, actorContext);

      const activeDepts = await catalogueAdmin.getDepartmentsWithStats({ status: 'active' }, { db: mockDb });
      const retiredDepts = await catalogueAdmin.getDepartmentsWithStats({ status: 'retired' }, { db: mockDb });

      assert.strictEqual(activeDepts.length, 17);
      assert.strictEqual(retiredDepts.length, 1);
      assert.strictEqual(retiredDepts[0].id, 'civil-engineering');
      assert.strictEqual(retiredDepts[0].status, 'retired');
    });

    test('filters departments by search term matching name or id', async () => {
      const searchResults = await catalogueAdmin.getDepartmentsWithStats({ search: 'civil' }, { db: mockDb });
      assert.strictEqual(searchResults.length, 1);
      assert.strictEqual(searchResults[0].id, 'civil-engineering');
    });

    test('rejects invalid status filter', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.getDepartmentsWithStats({ status: 'archived' }, { db: mockDb });
        },
        /Invalid status filter/
      );
    });
  });

  describe('2. Department Details & Not-Found Handling', () => {
    test('returns full department details by valid ID', async () => {
      const dept = await catalogueAdmin.getDepartmentById('mechanical-engineering', { db: mockDb });
      assert.ok(dept);
      assert.strictEqual(dept.id, 'mechanical-engineering');
      assert.strictEqual(dept.name, 'Mechanical Engineering');
      assert.strictEqual(dept.titlesCount, 26);
      assert.strictEqual(dept.status, 'active');
    });

    test('returns null for non-existent department ID', async () => {
      const dept = await catalogueAdmin.getDepartmentById('non-existent-dept', { db: mockDb });
      assert.strictEqual(dept, null);
    });

    test('rejects missing or invalid department ID parameter', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.getDepartmentById('', { db: mockDb });
        },
        /Valid department ID is required/
      );

      await assert.rejects(
        async () => {
          await catalogueAdmin.getDepartmentById(null, { db: mockDb });
        },
        /Valid department ID is required/
      );
    });
  });

  describe('3. Department Updates (Valid & Invalid)', () => {
    test('successfully updates department name, displayOrder, and aliases', async () => {
      const result = await catalogueAdmin.updateDepartment(
        'civil-engineering',
        {
          name: 'Civil & Infrastructure Engineering',
          displayOrder: 99,
          aliases: ['Civils', 'Infrastructure'],
        },
        actorContext
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.updated, true);
      assert.deepStrictEqual(result.changedFields.sort(), ['aliases', 'displayOrder', 'name']);
      assert.strictEqual(result.department.name, 'Civil & Infrastructure Engineering');
      assert.strictEqual(result.department.displayOrder, 99);
      assert.deepStrictEqual(result.department.aliases, ['Civils', 'Infrastructure']);
      assert.strictEqual(result.department.id, 'civil-engineering'); // ID strictly unchanged
    });

    test('retires a department without deleting it or altering titles', async () => {
      const result = await catalogueAdmin.updateDepartment(
        'architectural-design',
        { status: 'retired' },
        actorContext
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.department.status, 'retired');

      // Verify department still exists in DB
      const deptInDb = await catalogueAdmin.getDepartmentById('architectural-design', { db: mockDb });
      assert.ok(deptInDb);
      assert.strictEqual(deptInDb.status, 'retired');
      assert.strictEqual(deptInDb.titlesCount, 11); // Titles remain intact
    });

    test('reactivates a previously retired department', async () => {
      await catalogueAdmin.updateDepartment('civil-engineering', { status: 'retired' }, actorContext);
      const reactivated = await catalogueAdmin.updateDepartment('civil-engineering', { status: 'active' }, actorContext);

      assert.strictEqual(reactivated.success, true);
      assert.strictEqual(reactivated.department.status, 'active');
    });

    test('rejects attempt to alter department ID (immutable ID protection)', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { id: 'civil-new-id' }, actorContext);
        },
        /Unexpected field\(s\) in Department changes: id|Department ID is immutable/
      );
    });

    test('rejects unexpected fields in department updates', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { maliciousField: 123 }, actorContext);
        },
        /Unexpected field\(s\) in Department changes: maliciousField/
      );
    });

    test('rejects invalid status value for department', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { status: 'deleted' }, actorContext);
        },
        /Invalid department status/
      );
    });

    test('rejects invalid display order (out of range or non-integer)', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { displayOrder: 0 }, actorContext);
        },
        /Display order must be an integer between 1 and 1000/
      );

      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { displayOrder: 1001 }, actorContext);
        },
        /Display order must be an integer between 1 and 1000/
      );

      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { displayOrder: 3.14 }, actorContext);
        },
        /Display order must be an integer between 1 and 1000/
      );
    });

    test('rejects HTML tags and newlines in department name', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { name: '<script>alert(1)</script>' }, actorContext);
        },
        /must be plain text without HTML angle brackets/
      );

      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('civil-engineering', { name: 'Line 1\nLine 2' }, actorContext);
        },
        /must be single-line text without newlines/
      );
    });

    test('fails with not-found error for non-existent department', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateDepartment('non-existent-dept', { name: 'New Name' }, actorContext);
        },
        /Department with ID 'non-existent-dept' not found/
      );
    });
  });

  describe('4. Title Listing Scoped to Department & Pagination', () => {
    test('lists titles strictly scoped to specified department', async () => {
      const result = await catalogueAdmin.getTitlesForDepartment('civil-engineering', {}, { db: mockDb });
      assert.strictEqual(result.department.id, 'civil-engineering');
      assert.strictEqual(result.total, 12);
      assert.strictEqual(result.titles.length, 12);

      // Verify every title belongs to civil-engineering
      result.titles.forEach((t) => {
        assert.strictEqual(t.departmentId, 'civil-engineering');
        assert.ok(t.id.startsWith('civil-engineering:'), `Title ID '${t.id}' must start with 'civil-engineering:'`);
      });
    });

    test('supports pagination for title listings', async () => {
      const page1 = await catalogueAdmin.getTitlesForDepartment(
        'civil-engineering',
        {},
        { db: mockDb, page: 1, limit: 5 }
      );
      assert.strictEqual(page1.page, 1);
      assert.strictEqual(page1.limit, 5);
      assert.strictEqual(page1.titles.length, 5);
      assert.strictEqual(page1.total, 12);
      assert.strictEqual(page1.totalPages, 3);

      const page2 = await catalogueAdmin.getTitlesForDepartment(
        'civil-engineering',
        {},
        { db: mockDb, page: 2, limit: 5 }
      );
      assert.strictEqual(page2.titles.length, 5);
      assert.notStrictEqual(page1.titles[0].id, page2.titles[0].id);

      const page3 = await catalogueAdmin.getTitlesForDepartment(
        'civil-engineering',
        {},
        { db: mockDb, page: 3, limit: 5 }
      );
      assert.strictEqual(page3.titles.length, 2);
    });

    test('supports search query on title labels', async () => {
      const result = await catalogueAdmin.getTitlesForDepartment(
        'civil-engineering',
        { search: 'Bridge' },
        { db: mockDb }
      );
      assert.ok(result.titles.length >= 1);
      assert.ok(result.titles.some((t) => t.label.includes('Bridge')));
    });

    test('rejects title listing for non-existent department', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.getTitlesForDepartment('fake-dept', {}, { db: mockDb });
        },
        /Department with ID 'fake-dept' not found/
      );
    });
  });

  describe('5. New Title Creation & Stable Composite ID Generation', () => {
    test('creates a new title with deterministic department-scoped composite ID', async () => {
      const result = await catalogueAdmin.addTitle(
        'civil-engineering',
        {
          label: 'Senior Geotechnical Modeler',
          aliases: ['Geo Modeler'],
        },
        actorContext
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.title.id, 'civil-engineering:senior-geotechnical-modeler');
      assert.strictEqual(result.title.departmentId, 'civil-engineering');
      assert.strictEqual(result.title.label, 'Senior Geotechnical Modeler');
      assert.strictEqual(result.title.status, 'active');
      assert.strictEqual(result.title.displayOrder, 13); // Auto-assigned next sequential order (12 + 1)
      assert.deepStrictEqual(result.title.aliases, ['Geo Modeler']);
      assert.ok(result.title.createdAt instanceof Date);
      assert.ok(result.title.updatedAt instanceof Date);

      // Verify title is persisted in DB
      const list = await catalogueAdmin.getTitlesForDepartment('civil-engineering', {}, { db: mockDb });
      assert.strictEqual(list.total, 13);
    });

    test('supports custom explicit displayOrder on title creation', async () => {
      const result = await catalogueAdmin.addTitle(
        'civil-engineering',
        {
          label: 'Specialist Engineer',
          displayOrder: 50,
        },
        actorContext
      );

      assert.strictEqual(result.title.displayOrder, 50);
    });

    test('rejects duplicate title ID within the same department', async () => {
      // 'civil-engineering:project-manager' already exists in seed catalogue
      await assert.rejects(
        async () => {
          await catalogueAdmin.addTitle(
            'civil-engineering',
            { label: 'Project Manager' },
            actorContext
          );
        },
        /Conflict: Title with ID 'civil-engineering:project-manager' already exists/
      );
    });

    test('rejects adding title to non-existent department', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.addTitle(
            'alien-department',
            { label: 'Alien Commander' },
            actorContext
          );
        },
        /Department with ID 'alien-department' not found/
      );
    });

    test('rejects unexpected fields on title creation', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.addTitle(
            'civil-engineering',
            {
              label: 'Field Inspector',
              invalidField: 'forbidden',
            },
            actorContext
          );
        },
        /Unexpected field\(s\) in Title input: invalidField/
      );
    });

    test('rejects empty or malformed title label', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.addTitle('civil-engineering', { label: ' ' }, actorContext);
        },
        /Title label must be at least 2 character\(s\) long/
      );

      await assert.rejects(
        async () => {
          await catalogueAdmin.addTitle('civil-engineering', { label: '<b>Bold Title</b>' }, actorContext);
        },
        /must be plain text without HTML angle brackets/
      );
    });
  });

  describe('6. Cross-Department Duplicate Labels Preservation', () => {
    test('permits identical display labels across distinct departments with scoped composite IDs', async () => {
      // In seed catalogue:
      // civil-engineering has 'civil-engineering:project-manager' (label: "Project manager")
      // mechanical-engineering has 'mechanical-engineering:project-manager' (label: "Project manager")
      const civilList = await catalogueAdmin.getTitlesForDepartment('civil-engineering', { search: 'Project manager' }, { db: mockDb });
      const mechList = await catalogueAdmin.getTitlesForDepartment('mechanical-engineering', { search: 'Project manager' }, { db: mockDb });

      const civilPM = civilList.titles.find((t) => t.id === 'civil-engineering:project-manager');
      const mechPM = mechList.titles.find((t) => t.id === 'mechanical-engineering:project-manager');

      assert.ok(civilPM);
      assert.ok(mechPM);
      assert.strictEqual(civilPM.label.toLowerCase(), mechPM.label.toLowerCase());
      assert.notStrictEqual(civilPM.id, mechPM.id);

      // Add a third "Project manager" in qa-qc
      const qaResult = await catalogueAdmin.addTitle(
        'qa-qc',
        { label: 'Project manager' },
        actorContext
      );

      assert.strictEqual(qaResult.success, true);
      assert.strictEqual(qaResult.title.id, 'qa-qc:project-manager');
      assert.strictEqual(qaResult.title.label, 'Project manager');
      assert.strictEqual(qaResult.title.departmentId, 'qa-qc');
    });
  });

  describe('7. Title Updates & Stable ID Immutability', () => {
    test('renames title label while preserving its immutable stable ID', async () => {
      const originalTitleId = 'civil-engineering:project-manager';

      const updateResult = await catalogueAdmin.updateTitle(
        originalTitleId,
        { label: 'Senior Infrastructure Project Manager' },
        actorContext
      );

      assert.strictEqual(updateResult.success, true);
      assert.strictEqual(updateResult.updated, true);
      assert.strictEqual(updateResult.title.id, originalTitleId); // ID must NEVER change
      assert.strictEqual(updateResult.title.label, 'Senior Infrastructure Project Manager');
      assert.strictEqual(updateResult.title.departmentId, 'civil-engineering');

      // Verify in DB that ID remains exact same
      const titleColl = mockDb.collection(collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles');
      const doc = await titleColl.findOne({ id: originalTitleId });
      assert.ok(doc);
      assert.strictEqual(doc.label, 'Senior Infrastructure Project Manager');
    });

    test('rejects attempt to alter title ID or departmentId', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateTitle(
            'civil-engineering:project-manager',
            { id: 'civil-engineering:new-id' },
            actorContext
          );
        },
        /Unexpected field\(s\) in Title changes: id|Title ID and Department ID are immutable/
      );

      await assert.rejects(
        async () => {
          await catalogueAdmin.updateTitle(
            'civil-engineering:project-manager',
            { departmentId: 'mechanical-engineering' },
            actorContext
          );
        },
        /Unexpected field\(s\) in Title changes: departmentId|Title ID and Department ID are immutable/
      );
    });

    test('rejects unexpected fields in title updates', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateTitle(
            'civil-engineering:project-manager',
            { unknownField: 'test' },
            actorContext
          );
        },
        /Unexpected field\(s\) in Title changes: unknownField/
      );
    });

    test('throws not-found when updating non-existent title', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.updateTitle(
            'civil-engineering:non-existent-title',
            { label: 'Valid Label' },
            actorContext
          );
        },
        /Title with ID 'civil-engineering:non-existent-title' not found/
      );
    });
  });

  describe('8. Title Retirement & Reactivation (Never Hard-Deleted)', () => {
    test('retires title without deleting document from database', async () => {
      const titleId = 'civil-engineering:site-engineer-civil';

      const retireResult = await catalogueAdmin.setTitleStatus(titleId, 'retired', actorContext);
      assert.strictEqual(retireResult.success, true);
      assert.strictEqual(retireResult.title.status, 'retired');

      // Verify title is still in the database collection and resolvable
      const titleColl = mockDb.collection(collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles');
      const inDb = await titleColl.findOne({ id: titleId });
      assert.ok(inDb, 'Retired title must remain physically stored in the database');
      assert.strictEqual(inDb.status, 'retired');

      // Scoped listing includes it with status retired
      const list = await catalogueAdmin.getTitlesForDepartment('civil-engineering', { status: 'retired' }, { db: mockDb });
      assert.ok(list.titles.some((t) => t.id === titleId));
    });

    test('reactivates retired title', async () => {
      const titleId = 'civil-engineering:site-engineer-civil';
      await catalogueAdmin.setTitleStatus(titleId, 'retired', actorContext);

      const activeResult = await catalogueAdmin.setTitleStatus(titleId, 'active', actorContext);
      assert.strictEqual(activeResult.success, true);
      assert.strictEqual(activeResult.title.status, 'active');
    });

    test('rejects invalid title status', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.setTitleStatus('civil-engineering:site-engineer-civil', 'purged', actorContext);
        },
        /Invalid status 'purged'/
      );
    });
  });

  describe('9. Safe Department Reassignment Rejection', () => {
    test('explicitly rejects title department reassignment to protect historical profile validity', async () => {
      await assert.rejects(
        async () => {
          await catalogueAdmin.reassignTitleDepartment(
            'civil-engineering:project-manager',
            'mechanical-engineering',
            actorContext
          );
        },
        /UnsupportedOperation: Title department reassignment is not permitted/
      );
    });
  });

  describe('10. Audit Logging on Successful Mutations', () => {
    test('records audit log on department update', async () => {
      const auditColl = mockDb.collection(collection.AUDIT_LOG_COLLECTION || 'audit_logs');
      assert.strictEqual(auditColl.store.length, 0);

      await catalogueAdmin.updateDepartment(
        'civil-engineering',
        { name: 'Civil Works & Construction' },
        actorContext
      );

      assert.strictEqual(auditColl.store.length, 1);
      const log = auditColl.store[0];
      assert.strictEqual(log.action, 'CATALOGUE_DEPARTMENT_UPDATED');
      assert.strictEqual(log.entityType, 'CATALOGUE_DEPARTMENT');
      assert.strictEqual(log.entityId, 'civil-engineering');
      assert.strictEqual(log.status, 'success');
      assert.strictEqual(log.actor.id, 'admin_test_123');
      assert.strictEqual(log.metadata.previousState.name, 'Civil Engineering');
      assert.strictEqual(log.metadata.newState.name, 'Civil Works & Construction');
    });

    test('records audit log on title creation', async () => {
      const auditColl = mockDb.collection(collection.AUDIT_LOG_COLLECTION || 'audit_logs');
      auditColl.store.length = 0;

      await catalogueAdmin.addTitle(
        'civil-engineering',
        { label: 'Quality Assurance Inspector' },
        actorContext
      );

      assert.strictEqual(auditColl.store.length, 1);
      const log = auditColl.store[0];
      assert.strictEqual(log.action, 'CATALOGUE_TITLE_CREATED');
      assert.strictEqual(log.entityType, 'CATALOGUE_TITLE');
      assert.strictEqual(log.entityId, 'civil-engineering:quality-assurance-inspector');
      assert.strictEqual(log.metadata.departmentId, 'civil-engineering');
    });

    test('records audit log on title status change (retirement)', async () => {
      const auditColl = mockDb.collection(collection.AUDIT_LOG_COLLECTION || 'audit_logs');
      auditColl.store.length = 0;

      await catalogueAdmin.setTitleStatus(
        'civil-engineering:site-engineer-civil',
        'retired',
        actorContext
      );

      assert.strictEqual(auditColl.store.length, 1);
      const log = auditColl.store[0];
      assert.strictEqual(log.action, 'CATALOGUE_TITLE_RETIRED');
      assert.strictEqual(log.metadata.previousState.status, 'active');
      assert.strictEqual(log.metadata.newState.status, 'retired');
    });
  });

  describe('11. Validation Failure Prevents State Mutation', () => {
    test('department state is unmutated if validation rejects an update', async () => {
      const deptColl = mockDb.collection(collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments');
      const originalDoc = await deptColl.findOne({ id: 'civil-engineering' });

      try {
        await catalogueAdmin.updateDepartment(
          'civil-engineering',
          { name: 'Bad Name <script>', status: 'invalid-status' },
          actorContext
        );
      } catch (_) {
        // Expected validation failure
      }

      const currentDoc = await deptColl.findOne({ id: 'civil-engineering' });
      assert.strictEqual(currentDoc.name, originalDoc.name);
      assert.strictEqual(currentDoc.status, originalDoc.status);
    });

    test('no title document is inserted if validation fails during addTitle', async () => {
      const titleColl = mockDb.collection(collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles');
      const initialCount = titleColl.store.length;

      try {
        await catalogueAdmin.addTitle(
          'civil-engineering',
          { label: 'Too short x', invalidField: true },
          actorContext
        );
      } catch (_) {
        // Expected validation failure
      }

      assert.strictEqual(titleColl.store.length, initialCount);
    });
  });

  describe('12. Profile Usage Statistics Resolution', () => {
    test('safely resolves usageCount when users collection is present', async () => {
      const userColl = mockDb.collection(collection.STUDENTS_COLLECTION || 'users');

      // Add mock user profiles referencing civil-engineering
      userColl.store.push(
        { _id: 'u1', professionalIdentity: { departmentId: 'civil-engineering', titleId: 'civil-engineering:project-manager' } },
        { _id: 'u2', professionalIdentity: { departmentId: 'civil-engineering', titleId: 'civil-engineering:project-manager' } },
        { _id: 'u3', professionalIdentity: { departmentId: 'civil-engineering', titleId: 'civil-engineering:site-engineer-civil' } },
        { _id: 'u4', professionalIdentity: { departmentId: 'mechanical-engineering', titleId: 'mechanical-engineering:design-engineer' } }
      );

      const dept = await catalogueAdmin.getDepartmentById('civil-engineering', { db: mockDb });
      assert.strictEqual(dept.usageCount, 3);

      const titles = await catalogueAdmin.getTitlesForDepartment('civil-engineering', {}, { db: mockDb });
      const pm = titles.titles.find((t) => t.id === 'civil-engineering:project-manager');
      const struct = titles.titles.find((t) => t.id === 'civil-engineering:site-engineer-civil');
      const bridge = titles.titles.find((t) => t.id === 'civil-engineering:bridge-engineer');

      assert.strictEqual(pm.usageCount, 2);
      assert.strictEqual(struct.usageCount, 1);
      assert.strictEqual(bridge.usageCount, 0);
    });

    test('returns null when usage statistics cannot be safely queried or are disabled', async () => {
      // Mock db without users collection methods returning null safely
      const bareDb = {
        collection: (name) => {
          if (name === (collection.STUDENTS_COLLECTION || 'users')) {
            return null; // Simulate missing or inaccessible user collection
          }
          return mockDb.collection(name);
        },
      };

      const dept = await catalogueAdmin.getDepartmentById('civil-engineering', { db: bareDb });
      assert.strictEqual(dept.usageCount, null);

      const titles = await catalogueAdmin.getTitlesForDepartment('civil-engineering', {}, { db: bareDb });
      assert.strictEqual(titles.titles[0].usageCount, null);
    });
  });
});
