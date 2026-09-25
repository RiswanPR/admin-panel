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
    [collection.ANNOUNCEMENTS_COLLECTION, { status: 1, isPublished: 1, scheduledAt: 1 }],
    [collection.ANNOUNCEMENTS_COLLECTION, { targetType: 1, courseId: 1 }],
    [collection.ANNOUNCEMENTS_COLLECTION, { targetType: 1, learningSpaceId: 1 }],
    [collection.ANNOUNCEMENTS_COLLECTION, { createdBy: 1, createdAt: -1 }],
    [collection.ANNOUNCEMENTS_COLLECTION, { priority: 1, isCritical: 1 }],
    [collection.ANNOUNCEMENTS_COLLECTION, { createdAt: -1 }],
    [collection.LEARNING_SPACES_COLLECTION, { code: 1 }, { unique: true, sparse: true }],
    [collection.LEARNING_SPACES_COLLECTION, { communityId: 1 }, { sparse: true }],
    [collection.LEARNING_SPACES_COLLECTION, { status: 1, createdAt: -1 }],
    [collection.LEARNING_SPACES_COLLECTION, { teachers: 1 }],
    [collection.LEARNING_SPACES_COLLECTION, { ownerId: 1 }],
    // Platform Architecture Indexes
    [collection.PLATFORM_ANNOUNCEMENTS_COLLECTION, { status: 1, priority: 1, startsAt: -1 }],
    [collection.PLATFORM_ANNOUNCEMENTS_COLLECTION, { audience: 1, status: 1 }],
    [collection.PLATFORM_ANNOUNCEMENTS_COLLECTION, { createdAt: -1 }],
    [collection.NETWORK_COMMUNITIES_COLLECTION, { slug: 1 }, { unique: true, sparse: true }],
    [collection.NETWORK_COMMUNITIES_COLLECTION, { type: 1, status: 1 }],
    [collection.NETWORK_COMMUNITIES_COLLECTION, { courseId: 1 }],
    [collection.NETWORK_COMMUNITIES_COLLECTION, { creatorId: 1 }],
    [collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION, { communityId: 1, userId: 1 }, { unique: true }],
    [collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION, { userId: 1, status: 1 }],
    [collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION, { communityId: 1, status: 1 }],
    [collection.NETWORK_COMMUNITY_ANNOUNCEMENTS_COLLECTION, { communityId: 1, pinned: -1, createdAt: -1 }],
    [collection.NETWORK_COMMUNITY_ANNOUNCEMENTS_COLLECTION, { authorId: 1, createdAt: -1 }],
    [collection.NETWORK_CONNECTIONS_COLLECTION, { userLow: 1, userHigh: 1 }, { unique: true }],
    [collection.NETWORK_CONNECTIONS_COLLECTION, { requesterId: 1, status: 1 }],
    [collection.NETWORK_CONNECTIONS_COLLECTION, { recipientId: 1, status: 1 }],
    [collection.NOTIFICATIONS_COLLECTION, { recipientId: 1, createdAt: -1 }],
    [collection.NOTIFICATIONS_COLLECTION, { recipientId: 1, isRead: 1 }],
    [collection.NOTIFICATIONS_COLLECTION, { idempotencyKey: 1 }, { unique: true, sparse: true }],
    // Legacy Indexes (for existing data backward compatibility)
    [collection.LEARNING_SPACE_MEMBERS_COLLECTION, { spaceId: 1, userId: 1 }, { unique: true }],
    [collection.LEARNING_SPACE_MEMBERS_COLLECTION, { userId: 1, status: 1 }],
    [collection.LEARNING_SPACE_MEMBERS_COLLECTION, { spaceId: 1, status: 1 }],
    [collection.COMMUNITY_FOLLOWERS_COLLECTION, { userId: 1, followerId: 1 }, { unique: true }],
    [collection.COMMUNITY_FOLLOWERS_COLLECTION, { followerId: 1 }],
    // Zeitnah Network Ecosystem Indexes
    [collection.ORGANIZATIONS_COLLECTION, { status: 1, createdAt: -1 }],
    [collection.ORGANIZATIONS_COLLECTION, { slug: 1 }, { unique: true, sparse: true }],
    [collection.ORGANIZATIONS_COLLECTION, { createdBy: 1 }],
    [collection.ORGANIZATION_MEMBERSHIPS_COLLECTION, { organizationId: 1, userId: 1 }, { unique: true, sparse: true }],
    [collection.OPPORTUNITIES_COLLECTION, { status: 1, createdAt: -1 }],
    [collection.OPPORTUNITIES_COLLECTION, { organizationId: 1, status: 1 }],
    [collection.OPPORTUNITIES_COLLECTION, { discipline: 1, infrastructureSector: 1 }],
    [collection.JOB_APPLICATIONS_COLLECTION, { jobId: 1, status: 1, createdAt: -1 }],
    [collection.JOB_APPLICATIONS_COLLECTION, { candidateId: 1 }],
    [collection.JOB_TALENT_MATCHES_COLLECTION, { jobId: 1, score: -1 }],
    [collection.JOB_TALENT_MATCHES_COLLECTION, { candidateUserId: 1 }],
    [collection.USER_JOB_RECOMMENDATIONS_COLLECTION, { userId: 1, compatibilityScore: -1 }],
    [collection.USER_JOB_RECOMMENDATIONS_COLLECTION, { jobId: 1 }],
    [collection.SKILLS_COLLECTION, { slug: 1 }, { unique: true, sparse: true }],
    [collection.SKILLS_COLLECTION, { category: 1 }],
    [collection.INFRASTRUCTURE_MARKET_SNAPSHOTS_COLLECTION, { snapshotDate: -1 }],
    [collection.MODERATION_REPORTS_COLLECTION, { status: 1, targetType: 1, createdAt: -1 }],
    [collection.MODERATION_REPORTS_COLLECTION, { reporterId: 1 }],
  ];

  await Promise.allSettled(
    indexDefinitions.map(([col, keys, opts]) => createIndexIfPossible(db, col, keys, opts))
  );
};

module.exports = { ensureIndexes };
