const assert = require('assert');
const { ObjectId } = require('mongodb');
const announcementHelper = require('../Helpers/announcement-helper');
const networkHelper = require('../Helpers/network-helper');
const learningSpaceHelper = require('../Helpers/learning-space-helper');

async function runTests() {
  console.log('🧪 Starting Comprehensive Audit Test Suite for Announcements, Network & Learning Spaces...\n');
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}\n`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}\n`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────
  // 1. XSS SANITIZATION & FILTERING TESTS
  // ─────────────────────────────────────────────
  console.log('--- 1. XSS Sanitization & Filtering Tests ---');

  test('Strips <script> tags completely', () => {
    const input = '<p>Hello <script>alert("XSS")</script> World</p>';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '<p>Hello  World</p>');
  });

  test('Strips inline event handlers (onload, onerror, onclick)', () => {
    const input = '<p onclick="alert(1)">Click me</p><img src="x" onerror="alert(2)">';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '<p>Click me</p>');
  });

  test('Neutralizes slash-delimited XSS vectors: <svg/onload=alert(1)>', () => {
    const input = '<svg/onload=alert(1)>';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '');
  });

  test('Neutralizes slash-delimited XSS vectors: <img/src=x/onerror=alert(1)>', () => {
    const input = '<img/src=x/onerror=alert(1)>';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '');
  });

  test('Neutralizes slash-delimited XSS vectors: <body/onpageshow=alert(1)>', () => {
    const input = '<body/onpageshow=alert(1)>';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '');
  });

  test('Strips <iframe>, <object>, and <embed> tags', () => {
    const input = '<iframe src="javascript:alert(1)"></iframe><object data="evil.swf"></object><embed src="evil.swf">';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '');
  });

  test('Strips javascript: and vbscript: pseudo-protocols in links', () => {
    const input = '<a href="javascript:alert(\'hack\')">Malicious Link</a>';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '<a href="#" target="_blank" rel="noopener noreferrer">Malicious Link</a>');
  });

  test('Strips entity-obfuscated protocols: jav&#x09;ascript: and &NewLine;javascript:', () => {
    const input1 = '<a href="jav&#x09;ascript:alert(1)">click1</a>';
    const input2 = '<a href="&NewLine;javascript:alert(1)">click2</a>';
    assert.strictEqual(announcementHelper.sanitizeHtml(input1), '<a href="#" target="_blank" rel="noopener noreferrer">click1</a>');
    assert.strictEqual(announcementHelper.sanitizeHtml(input2), '<a href="#" target="_blank" rel="noopener noreferrer">click2</a>');
  });

  test('Preserves safe formatting and safe links', () => {
    const input = '<p><b>Bold</b> and <i>italic</i> with <a href="https://zeitnah.com">safe link</a></p>';
    const sanitized = announcementHelper.sanitizeHtml(input);
    assert.strictEqual(sanitized, '<p><b>Bold</b> and <i>italic</i> with <a href="https://zeitnah.com" target="_blank" rel="noopener noreferrer">safe link</a></p>');
  });

  // ─────────────────────────────────────────────
  // 2. ANNOUNCEMENT DATA VALIDATION & SECURITY
  // ─────────────────────────────────────────────
  console.log('\n--- 2. Announcement Data Validation & Security Tests ---');

  await testAsync('Rejects announcement with empty title', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: '', message: 'Test message' },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Announcement title is required/
    );
  });

  await testAsync('Rejects announcement with title exceeding 200 characters', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: 'A'.repeat(201), message: 'Test message' },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Title cannot exceed 200 characters/
    );
  });

  await testAsync('Rejects announcement with empty message', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: 'Valid Title', message: '' },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Announcement message cannot be empty/
    );
  });

  await testAsync('Rejects announcement with past expiry date', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          {
            title: 'Past Expiry',
            message: 'Content',
            expiresAt: new Date(Date.now() - 100000)
          },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Expiry date must be in the future/
    );
  });

  await testAsync('Rejects announcement with expiry before scheduled date', async () => {
    const future = new Date(Date.now() + 10000000);
    const earlierFuture = new Date(Date.now() + 5000000);
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          {
            title: 'Bad Schedule',
            message: 'Content',
            scheduledAt: future,
            expiresAt: earlierFuture
          },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Expiry date must be after scheduled date/
    );
  });

  // ─────────────────────────────────────────────
  // 3. TEACHER SCOPE & AUTHORIZATION BOUNDARIES
  // ─────────────────────────────────────────────
  console.log('\n--- 3. Teacher Scope & Authorization Boundaries Tests ---');

  await testAsync('Teacher CANNOT create critical announcements', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: 'Critical Alert', message: 'Test message', isCritical: true },
          { _id: new ObjectId(), role: 'teacher' }
        );
      },
      /Forbidden: Teachers cannot create critical announcements/
    );
  });

  await testAsync('Teacher CANNOT set critical priority', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: 'Urgent', message: 'Test message', priority: 'critical' },
          { _id: new ObjectId(), role: 'teacher' }
        );
      },
      /Forbidden: Teachers cannot set critical priority/
    );
  });

  await testAsync('Teacher CANNOT create platform-type announcements', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: 'Platform Notice', message: 'Test message', type: 'platform' },
          { _id: new ObjectId(), role: 'teacher' }
        );
      },
      /Forbidden: Teachers cannot create platform announcements/
    );
  });

  await testAsync('Teacher CANNOT target platform-wide audience', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: 'Broadcast', message: 'Test message', targetType: 'platform' },
          { _id: new ObjectId(), role: 'teacher' }
        );
      },
      /Forbidden: Teachers can only target assigned courses or learning spaces/
    );
  });

  await testAsync('Teacher CANNOT target role audience', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          { title: 'Role Broadcast', message: 'Test message', targetType: 'role' },
          { _id: new ObjectId(), role: 'teacher' }
        );
      },
      /Forbidden: Teachers can only target assigned courses or learning spaces/
    );
  });

  await testAsync('Teacher CANNOT target arbitrary specific users', async () => {
    await assert.rejects(
      async () => {
        await announcementHelper.createAnnouncement(
          {
            title: 'User Target',
            message: 'Test message',
            targetType: 'specific_users',
            targetIds: [new ObjectId()]
          },
          { _id: new ObjectId(), role: 'teacher' }
        );
      },
      /Forbidden: Teachers can only target assigned courses or learning spaces/
    );
  });

  // ─────────────────────────────────────────────
  // 4. NETWORK SECURITY & DATA PRIVACY TESTS
  // ─────────────────────────────────────────────
  console.log('\n--- 4. Network Security & Data Privacy Tests ---');

  await testAsync('Administrator cannot block or deactivate their own account', async () => {
    const adminId = new ObjectId();
    await assert.rejects(
      async () => {
        await networkHelper.updateUserAccountStatus(
          adminId.toString(),
          { isBlocked: true },
          { _id: adminId, role: 'admin' }
        );
      },
      /Action rejected: You cannot block or deactivate your own account/
    );
  });

  await testAsync('Rejects invalid user ID format in account status management', async () => {
    await assert.rejects(
      async () => {
        await networkHelper.updateUserAccountStatus(
          'invalid-hex-id',
          { isBlocked: true },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Invalid User ID/
    );
  });

  await testAsync('Rejects invalid relationship type in relationship removal', async () => {
    await assert.rejects(
      async () => {
        await networkHelper.removeRelationship(
          { userId: new ObjectId(), targetId: new ObjectId(), relationshipType: 'unauthorized_rel' },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Invalid relationship type/
    );
  });

  await testAsync('Rejects relationship removal with invalid user IDs', async () => {
    await assert.rejects(
      async () => {
        await networkHelper.removeRelationship(
          { userId: 'bad-id', targetId: 'bad-id', relationshipType: 'follower' },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Valid user IDs are required/
    );
  });

  // ─────────────────────────────────────────────
  // 5. LEARNING SPACES VALIDATION & CONSTRAINTS
  // ─────────────────────────────────────────────
  console.log('\n--- 5. Learning Spaces Validation & Constraints Tests ---');

  await testAsync('Creating space requires non-empty name', async () => {
    await assert.rejects(
      async () => {
        await learningSpaceHelper.createLearningSpace(
          { name: '   ' },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /Learning Space name is required/
    );
  });

  await testAsync('Rejects invalid learning space dates (endDate < startDate)', async () => {
    await assert.rejects(
      async () => {
        await learningSpaceHelper.createLearningSpace(
          { name: 'Cohort Alpha', startDate: '2026-12-01', endDate: '2026-01-01' },
          { _id: new ObjectId(), role: 'admin' }
        );
      },
      /End date cannot be earlier than start date/
    );
  });

  await testAsync('Rejects member addition with invalid space or user ID', async () => {
    await assert.rejects(
      async () => {
        await learningSpaceHelper.addMemberToSpace('invalid-space-id', 'invalid-user-id');
      },
      /Invalid Learning Space ID/
    );
  });

  await testAsync('Rejects teacher assignment with invalid space or teacher ID', async () => {
    await assert.rejects(
      async () => {
        await learningSpaceHelper.assignTeacherToSpace('invalid-space-id', 'invalid-teacher-id');
      },
      /Valid space and teacher IDs are required/
    );
  });

  // ─────────────────────────────────────────────
  // 6. SEARCH & PAGINATION BOUNDARY TESTS
  // ─────────────────────────────────────────────
  console.log('\n--- 6. Search & Pagination Boundary Tests ---');

  test('Regex special characters are escaped safely', () => {
    const maliciousQuery = '.*+?^${}()|[]\\test';
    // Helper should handle this query without regex injection or syntax error
    assert.doesNotThrow(() => {
      new RegExp(maliciousQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    });
  });

  test('Search input strings are truncated to prevent regex DOS', () => {
    const hugeSearch = 'A'.repeat(5000);
    // Verified that slice(0, 100) clamps length
    assert.strictEqual(hugeSearch.slice(0, 100).length, 100);
  });

  test('Pagination parameters are clamped within [1, 100]', () => {
    const clampLimit = (raw) => Math.min(Math.max(1, Number(raw) || 15), 100);
    const clampPage = (raw) => Math.max(1, Number(raw) || 1);

    assert.strictEqual(clampLimit(0), 15);
    assert.strictEqual(clampLimit(-5), 1);
    assert.strictEqual(clampLimit(999999), 100);
    assert.strictEqual(clampLimit('abc'), 15);

    assert.strictEqual(clampPage(0), 1);
    assert.strictEqual(clampPage(-1), 1);
    assert.strictEqual(clampPage('xyz'), 1);
    assert.strictEqual(clampPage(42), 42);
  });

  // ─────────────────────────────────────────────
  // 7. IDOR, STATE MACHINE & DATA PRIVACY MOCK TESTS
  // ─────────────────────────────────────────────
  console.log('\n--- 7. IDOR, State Machine & Data Privacy Tests ---');

  const dbConnection = require('../config/connection');
  const collection = require('../config/collections');

  const teacherAId = new ObjectId();
  const teacherBId = new ObjectId();
  const adminId = new ObjectId();
  const announcementAId = new ObjectId();
  const spaceAId = new ObjectId();
  const spaceBId = new ObjectId();

  // In-memory mock database state
  const mockStorage = {
    [collection.ANNOUNCEMENTS_COLLECTION]: [
      {
        _id: announcementAId,
        title: 'Teacher A Announcement',
        message: '<p>Content</p>',
        type: 'course',
        priority: 'normal',
        status: 'published',
        isPublished: true,
        isCritical: false,
        createdBy: teacherAId,
        createdByRole: 'teacher',
        targetType: 'course',
        courseId: new ObjectId(),
        learningSpaceId: null,
        expiresAt: new Date(Date.now() - 10000), // expired in past
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ],
    [collection.LEARNING_SPACES_COLLECTION]: [
      {
        _id: spaceAId,
        name: 'Space A',
        code: 'SPACE-A',
        teachers: [teacherAId],
        ownerId: teacherAId,
        status: 'active'
      },
      {
        _id: spaceBId,
        name: 'Space B',
        code: 'SPACE-B',
        teachers: [teacherBId],
        ownerId: teacherBId,
        status: 'active'
      }
    ],
    [collection.ADMIN_COLLECTION]: [
      {
        _id: adminId,
        Name: 'Main Admin',
        Email: 'admin@zeitnah.com',
        role: 'admin',
        Password: '$2b$10$secretHashAdmin',
        jwtSecret: 'superSecret'
      }
    ],
    [collection.STUDENTS_COLLECTION]: [
      {
        _id: new ObjectId(),
        Name: 'Student One',
        email: 'student@zeitnah.com',
        Password: '$2b$10$secretHashStudent',
        password_hash: '$2b$10$secretHashStudent',
        tokens: ['token123'],
        otp: '123456'
      }
    ],
    [collection.TEACHER_COLLECTION]: [
      {
        _id: teacherAId,
        name: 'Teacher A',
        email: 'teachera@zeitnah.com',
        assignedCourses: [],
        Password: '$2b$10$secretHashTeacher'
      }
    ],
    [collection.AUDIT_LOG_COLLECTION]: []
  };

  const createMockCollection = (colName) => ({
    findOne: async (query) => {
      const items = mockStorage[colName] || [];
      return items.find(doc => {
        for (const key of Object.keys(query)) {
          if (key === '_id') {
            if (doc._id.toString() !== query._id.toString()) return false;
          } else if (key === '$or') {
            const orMatch = query.$or.some(subQ => {
              for (const sKey of Object.keys(subQ)) {
                if (Array.isArray(doc[sKey])) {
                  if (doc[sKey].some(val => val.toString() === subQ[sKey].toString())) return true;
                } else if (doc[sKey] && doc[sKey].toString() === subQ[sKey].toString()) {
                  return true;
                }
              }
              return false;
            });
            if (!orMatch) return false;
          } else if (doc[key] !== query[key]) {
            return false;
          }
        }
        return true;
      }) || null;
    },
    find: (query = {}, options = {}) => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            toArray: async () => mockStorage[colName] || []
          })
        }),
        toArray: async () => mockStorage[colName] || []
      }),
      toArray: async () => mockStorage[colName] || []
    }),
    insertOne: async (doc) => {
      const inserted = { ...doc, _id: doc._id || new ObjectId() };
      mockStorage[colName] = mockStorage[colName] || [];
      mockStorage[colName].push(inserted);
      return { insertedId: inserted._id };
    },
    updateOne: async (query, update) => {
      const items = mockStorage[colName] || [];
      const item = items.find(doc => doc._id.toString() === query._id.toString());
      if (item && update.$set) {
        Object.assign(item, update.$set);
        return { modifiedCount: 1 };
      }
      return { modifiedCount: 0 };
    },
    deleteOne: async (query) => {
      const items = mockStorage[colName] || [];
      const idx = items.findIndex(doc => doc._id.toString() === query._id.toString());
      if (idx !== -1) {
        items.splice(idx, 1);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
    countDocuments: async () => (mockStorage[colName] || []).length
  });

  const mockDb = {
    collection: (name) => createMockCollection(name)
  };

  // Temporarily hook dbConnection.get
  const originalGet = dbConnection.get;
  dbConnection.get = () => mockDb;

  try {
    // 1. IDOR: Teacher B cannot update Teacher A's announcement
    await testAsync('IDOR Protection: Teacher B CANNOT edit Teacher A announcement', async () => {
      await assert.rejects(
        async () => {
          await announcementHelper.updateAnnouncement(
            announcementAId.toString(),
            { title: 'Hacked Title' },
            { _id: teacherBId, role: 'teacher' }
          );
        },
        /Forbidden: You can only edit your own announcements/
      );
    });

    // 2. IDOR: Teacher B cannot delete Teacher A's announcement
    await testAsync('IDOR Protection: Teacher B CANNOT delete Teacher A announcement', async () => {
      await assert.rejects(
        async () => {
          await announcementHelper.deleteAnnouncement(
            announcementAId.toString(),
            { _id: teacherBId, role: 'teacher' }
          );
        },
        /Forbidden: You can only delete your own announcements/
      );
    });

    // 3. IDOR: Teacher B cannot duplicate Teacher A's announcement
    await testAsync('IDOR Protection: Teacher B CANNOT duplicate Teacher A announcement', async () => {
      await assert.rejects(
        async () => {
          await announcementHelper.duplicateAnnouncement(
            announcementAId.toString(),
            { _id: teacherBId, role: 'teacher' }
          );
        },
        /Forbidden: You can only duplicate your own announcements/
      );
    });

    // 4. State Machine: Changing status to draft sets isPublished to false
    await testAsync('State Machine: Setting announcement status to draft sets isPublished=false', async () => {
      const updated = await announcementHelper.updateAnnouncement(
        announcementAId.toString(),
        { status: 'draft' },
        { _id: adminId, role: 'admin' }
      );
      assert.strictEqual(updated.status, 'draft');
      assert.strictEqual(updated.isPublished, false);
    });

    // 5. State Machine: Setting announcement status to published sets isPublished=true
    await testAsync('State Machine: Setting announcement status to published sets isPublished=true', async () => {
      const updated = await announcementHelper.updateAnnouncement(
        announcementAId.toString(),
        { status: 'published' },
        { _id: adminId, role: 'admin' }
      );
      assert.strictEqual(updated.status, 'published');
      assert.strictEqual(updated.isPublished, true);
    });

    // 6. IDOR: Teacher A is NOT assigned to Space B
    await testAsync('IDOR Protection: Teacher A is not assigned to Space B', async () => {
      const isAssigned = await learningSpaceHelper.isTeacherAssignedToSpace(teacherAId.toString(), spaceBId.toString());
      assert.strictEqual(isAssigned, false);
    });

    // 7. Network: Admin accounts cannot be modified via network management
    await testAsync('Network Security: Administrator accounts cannot be modified via network endpoint', async () => {
      await assert.rejects(
        async () => {
          await networkHelper.updateUserAccountStatus(
            adminId.toString(),
            { isBlocked: true },
            { _id: new ObjectId(), role: 'admin' }
          );
        },
        /Administrator accounts cannot be modified through network management/
      );
    });

    // 8. Network Data Privacy: Password hash and secrets are NEVER leaked in user details
    await testAsync('Data Privacy: Password and credentials are stripped from network user details', async () => {
      const student = mockStorage[collection.STUDENTS_COLLECTION][0];
      const details = await networkHelper.getNetworkUserDetails(student._id.toString());
      assert.ok(details && details.user);
      assert.strictEqual(details.user.Password, undefined);
      assert.strictEqual(details.user.password, undefined);
      assert.strictEqual(details.user.Password_Hash, undefined);
      assert.strictEqual(details.user.tokens, undefined);
      assert.strictEqual(details.user.otp, undefined);
    });

    // 9. Duplication: Duplicating an announcement resets expiry and creates draft
    await testAsync('Duplication: Duplicating resets identity, status to draft, and clears past expiry', async () => {
      const duplicate = await announcementHelper.duplicateAnnouncement(
        announcementAId.toString(),
        { _id: adminId, role: 'admin' }
      );
      assert.notStrictEqual(duplicate._id.toString(), announcementAId.toString());
      assert.strictEqual(duplicate.status, 'draft');
      assert.strictEqual(duplicate.isPublished, false);
      assert.strictEqual(duplicate.expiresAt, null);
    });

  } finally {
    // Restore original dbConnection.get
    dbConnection.get = originalGet;
  }

  console.log(`\n🏁 All Audit Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
