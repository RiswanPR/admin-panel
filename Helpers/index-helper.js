const collection = require('../config/collections');
const logger = require('./logger');

const createIndexIfPossible = async (db, collectionName, keys, options = {}) => {
  try {
    await db.collection(collectionName).createIndex(keys, options);
  } catch (err) {
    if (
      err.codeName === 'IndexOptionsConflict' ||
      err.code === 85 ||
      /existing index/i.test(err.message || '')
    ) {
      logger.warn(`⚠️ Existing index differs on ${collectionName}: ${JSON.stringify(keys)}`);
      return;
    }
    logger.warn(`⚠️ Could not create index on ${collectionName}: ${err.message}`);
  }
};

const ensureIndexes = async (db) => {
  if (!db) return;

  const indexDefinitions = [
    [collection.ADMIN_COLLECTION, { Email: 1 }, { unique: true, sparse: true }],
    [collection.TEACHER_COLLECTION, { email: 1 }, { unique: true, sparse: true }],
    [collection.TEACHER_COLLECTION, { assignedCourses: 1 }],
    [collection.STUDENTS_COLLECTION, { email: 1 }, { unique: true, sparse: true }],
    [collection.STUDENTS_COLLECTION, { username: 1 }, { unique: true, sparse: true }],
    [collection.STUDENTS_COLLECTION, { 'course.courseId': 1 }],
    [collection.STUDENTS_COLLECTION, { End_Date: 1, status: 1 }],
    [collection.STUDENTS_COLLECTION, { 'gamification.totalPoints': -1, 'gamification.level': -1, 'gamification.completedClasses': -1, createdAt: 1 }],
    [collection.POINT_TRANSACTIONS_COLLECTION, { studentId: 1, createdAt: -1 }],
    [collection.POINT_TRANSACTIONS_COLLECTION, { courseId: 1, createdAt: -1 }],
    [collection.POINT_TRANSACTIONS_COLLECTION, { courseId: 1, studentId: 1 }],
    [collection.POINT_TRANSACTIONS_COLLECTION, { scope: 1, createdAt: -1 }],
    [collection.POINT_TRANSACTIONS_COLLECTION, { actorId: 1, createdAt: -1 }],
    [collection.POINT_TRANSACTIONS_COLLECTION, { transactionKey: 1 }, { unique: true, sparse: true }],
    [collection.COURSE_COLLECTION, { 'chapters.uniqueCode': 1 }],
    [collection.COURSE_COLLECTION, { 'chapters.classes._id': 1 }],
    [collection.ASSIGNMENT_COLLECTION, { teacherId: 1, createdAt: -1 }],
    [collection.AUDIT_LOG_COLLECTION, { createdAt: -1 }],
    [collection.COVER_IMAGES_COLLECTION, { status: 1, category: 1, createdAt: -1 }],
    [collection.RESERVED_USERNAMES_COLLECTION, { keyword: 1 }, { unique: true }],
  ];

  await Promise.allSettled(
    indexDefinitions.map(([col, keys, opts]) => createIndexIfPossible(db, col, keys, opts))
  );
};

module.exports = { ensureIndexes };
