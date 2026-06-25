const collection = require('../config/collections');

const createIndexIfPossible = async (db, collectionName, keys, options = {}) => {
  try {
    await db.collection(collectionName).createIndex(keys, options);
  } catch (err) {
    if (
      err.codeName === 'IndexOptionsConflict' ||
      err.code === 85 ||
      /existing index/i.test(err.message || '')
    ) {
      console.warn(`⚠️ Existing index differs on ${collectionName}: ${JSON.stringify(keys)}`);
      return;
    }
    throw err;
  }
};

const ensureIndexes = async (db) => {
  if (!db) return;

  await Promise.all([
    createIndexIfPossible(db, collection.ADMIN_COLLECTION, { Email: 1 }, { unique: true, sparse: true }),
    createIndexIfPossible(db, collection.TEACHER_COLLECTION, { email: 1 }, { unique: true, sparse: true }),
    createIndexIfPossible(db, collection.TEACHER_COLLECTION, { assignedCourses: 1 }),
    createIndexIfPossible(db, collection.STUDENTS_COLLECTION, { email: 1 }, { unique: true, sparse: true }),
    createIndexIfPossible(db, collection.STUDENTS_COLLECTION, { 'course.courseId': 1 }),
    createIndexIfPossible(db, collection.STUDENTS_COLLECTION, { End_Date: 1, status: 1 }),
    createIndexIfPossible(db, collection.COURSE_COLLECTION, { 'chapters.uniqueCode': 1 }),
    createIndexIfPossible(db, collection.COURSE_COLLECTION, { 'chapters.classes._id': 1 }),
    createIndexIfPossible(db, collection.ASSIGNMENT_COLLECTION, { teacherId: 1, createdAt: -1 }),
    createIndexIfPossible(db, collection.AUDIT_LOG_COLLECTION, { createdAt: -1 }),
    createIndexIfPossible(db, collection.COVER_IMAGES_COLLECTION, { status: 1, category: 1, createdAt: -1 }),
  ]);
};

module.exports = { ensureIndexes };
