'use strict';

/**
 * Zeitnah LMS — Centralized Gamification & Leaderboard Helper
 * Single source of truth for point transactions, rankings, and gamification profiles.
 */

const { ObjectId } = require('mongodb');
const db = require('../config/connection');
const collection = require('../config/collections');
const logger = require('./logger');
const auditHelper = require('./audit-helper');
const { decorateProfileImage } = require('./image-url-helper');
const {
  LEVEL_THRESHOLDS,
  RANK_THRESHOLDS,
  POINT_ACTION_TYPES,
  calculateLevel,
  calculateRank,
  getRankMeta,
  getNextLevelProgress,
  calculateStreak,
  calculatePoints,
} = require('./gamification-constants');

/**
 * Helper to ensure student has all gamification fields
 */
function ensureGamification(user) {
  if (!user.gamification) {
    user.gamification = {};
  }
  user.gamification.totalPoints = Number(user.gamification.totalPoints) || 0;
  user.gamification.level = Number(user.gamification.level) || calculateLevel(user.gamification.totalPoints);
  user.gamification.rank = user.gamification.rank || calculateRank(user.gamification.totalPoints);
  user.gamification.completedCourses = Number(user.gamification.completedCourses) || 0;
  user.gamification.completedClasses = Number(user.gamification.completedClasses) || 0;
  user.gamification.totalWatchMinutes = Number(user.gamification.totalWatchMinutes) || 0;
  user.gamification.profileCompletion = Number(user.gamification.profileCompletion) || 0;
  user.gamification.achievements = Array.isArray(user.gamification.achievements) ? user.gamification.achievements : [];
  user.gamification.rewardedClassIds = Array.isArray(user.gamification.rewardedClassIds) ? user.gamification.rewardedClassIds : [];
  user.gamification.rewardedCourseIds = Array.isArray(user.gamification.rewardedCourseIds) ? user.gamification.rewardedCourseIds : [];
  user.gamification.profileCompletionRewards = Array.isArray(user.gamification.profileCompletionRewards) ? user.gamification.profileCompletionRewards : [];
  user.gamification.activityDates = Array.isArray(user.gamification.activityDates) ? user.gamification.activityDates : [];
  user.gamification.recentActivities = Array.isArray(user.gamification.recentActivities) ? user.gamification.recentActivities : [];
  return user.gamification;
}

/**
 * Record a Point Transaction in the Ledger and atomically update student balance
 */
async function recordPointTransaction({
  studentId,
  points,
  direction = 'credit', // 'credit' | 'debit'
  type = POINT_ACTION_TYPES.MANUAL_AWARD,
  scope = 'global', // 'global' | 'course'
  courseId = null,
  courseName = null,
  reason = '',
  source = 'admin', // 'admin' | 'teacher' | 'system'
  actorId = null,
  actorRole = 'admin',
  actorName = 'Admin',
  metadata = {},
  transactionKey = null,
}) {
  if (!ObjectId.isValid(studentId)) {
    throw new Error('Valid student identifier is required');
  }

  const pointValue = Math.round(Number(points));
  if (!Number.isInteger(pointValue) || pointValue <= 0) {
    throw new Error('Points must be a positive whole integer');
  }

  if (!['credit', 'debit'].includes(direction)) {
    throw new Error('Transaction direction must be "credit" or "debit"');
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    throw new Error('A reason is required for every point modification');
  }

  const sId = new ObjectId(studentId);
  const database = db.get();
  const studentsCol = database.collection(collection.STUDENTS_COLLECTION);
  const ledgerCol = database.collection(collection.POINT_TRANSACTIONS_COLLECTION);

  // Idempotency check: if transactionKey exists, return previous transaction
  if (transactionKey) {
    const existing = await ledgerCol.findOne({ transactionKey: String(transactionKey) });
    if (existing) {
      logger.info(`[Gamification] Duplicate transaction prevented by key: ${transactionKey}`);
      return {
        success: true,
        transaction: existing,
        duplicate: true,
        message: 'Transaction already processed',
      };
    }
  }

  // Fetch current student
  const student = await studentsCol.findOne({ _id: sId });
  if (!student) {
    throw new Error('Student not found');
  }

  ensureGamification(student);

  // Course validation for course scope
  let resolvedCourseName = courseName;
  if (scope === 'course') {
    if (!courseId) {
      throw new Error('Course identifier is required for course-scoped transactions');
    }
    const enrolledCourse = (student.course || []).find(
      (c) => String(c.courseId) === String(courseId)
    );
    if (!enrolledCourse) {
      throw new Error('Student is not enrolled in the specified course');
    }
    if (!resolvedCourseName) {
      resolvedCourseName = enrolledCourse.courseName || 'Course';
    }
  } else {
    courseId = null;
    resolvedCourseName = null;
  }

  const previousBalance = student.gamification.totalPoints || 0;
  let newBalance = previousBalance;

  if (direction === 'credit') {
    newBalance = previousBalance + pointValue;
  } else {
    if (previousBalance < pointValue) {
      throw new Error(
        `Cannot deduct ${pointValue} XP: Student only has ${previousBalance} XP available.`
      );
    }
    newBalance = previousBalance - pointValue;
  }

  const previousLevel = student.gamification.level || 1;
  const newLevel = calculateLevel(newBalance);
  const newRank = calculateRank(newBalance);

  // Create point transaction document
  const transactionDoc = {
    studentId: sId,
    studentName: student.Name || student.name || 'Student',
    studentUsername: student.username || '',
    studentEmail: student.email || student.Email || '',
    points: pointValue,
    direction,
    type,
    scope,
    courseId: courseId ? String(courseId) : null,
    courseName: resolvedCourseName,
    reason: cleanReason,
    source,
    actorId: actorId && ObjectId.isValid(actorId) ? new ObjectId(actorId) : null,
    actorRole: String(actorRole || 'admin').toLowerCase(),
    actorName: String(actorName || 'Admin'),
    previousBalance,
    newBalance,
    status: 'completed',
    transactionKey: transactionKey ? String(transactionKey) : null,
    metadata: metadata || {},
    createdAt: new Date(),
  };

  const insertResult = await ledgerCol.insertOne(transactionDoc);
  transactionDoc._id = insertResult.insertedId;

  // Build activity record for student's recentActivities
  const activityItem = {
    type,
    label: direction === 'credit' ? `+${pointValue} XP: ${cleanReason}` : `-${pointValue} XP: ${cleanReason}`,
    points: direction === 'credit' ? pointValue : -pointValue,
    metadata: {
      scope,
      courseId: courseId ? String(courseId) : null,
      courseName: resolvedCourseName,
      actorName: transactionDoc.actorName,
      transactionId: insertResult.insertedId.toString(),
    },
    createdAt: new Date(),
  };

  const updatedRecent = [activityItem, ...(student.gamification.recentActivities || [])].slice(0, 20);

  // Update student gamification document
  await studentsCol.updateOne(
    { _id: sId },
    {
      $set: {
        'gamification.totalPoints': newBalance,
        'gamification.level': newLevel,
        'gamification.rank': newRank,
        'gamification.recentActivities': updatedRecent,
        updatedAt: new Date(),
      },
    }
  );

  // Audit log entry
  try {
    await auditHelper.logAction({
      action: direction === 'credit' ? 'AWARD_POINTS' : 'DEDUCT_POINTS',
      entityType: 'gamification_points',
      entityId: String(sId),
      entityName: student.Name || student.name || 'Student',
      status: 'success',
      message: `${direction === 'credit' ? 'Awarded' : 'Deducted'} ${pointValue} XP for student (${previousBalance} -> ${newBalance} XP). Reason: ${cleanReason}`,
      metadata: {
        transactionId: String(insertResult.insertedId),
        points: pointValue,
        direction,
        scope,
        courseId,
        courseName: resolvedCourseName,
        previousBalance,
        newBalance,
        levelUp: newLevel > previousLevel,
      },
    });
  } catch (auditErr) {
    logger.warn('[Gamification] Audit log warning:', auditErr.message);
  }

  return {
    success: true,
    transaction: transactionDoc,
    previousBalance,
    newBalance,
    levelUp: newLevel > previousLevel,
    previousLevel,
    newLevel,
    rank: newRank,
  };
}

/**
 * Calculate Course XP for a student
 * Combines course watch/completion progress + course-scoped point transactions
 */
function calculateCourseProgressPoints(courseItem) {
  if (!courseItem) return 0;
  const classProgress = Array.isArray(courseItem.classProgress) ? courseItem.classProgress : [];
  const learningProgress = courseItem.learningProgress || {};

  let totalWatchSeconds = 0;
  let completedCount = 0;

  classProgress.forEach((item) => {
    totalWatchSeconds += Number(item.watchedSeconds) || 0;
    if (item.completed) completedCount += 1;
  });

  const watchMinutes = Math.floor(totalWatchSeconds / 60);
  const watchPoints = calculatePoints(watchMinutes); // 1 pt / min
  const classPoints = completedCount * 25; // 25 pts per completed class
  const courseCompletePoints =
    learningProgress.totalClasses > 0 &&
    learningProgress.completedClasses >= learningProgress.totalClasses
      ? 100
      : 0;

  return watchPoints + classPoints + courseCompletePoints;
}

/**
 * Retrieve Global Leaderboard with server-side pagination, filters, podium, and KPIs
 */
async function getGlobalLeaderboard({
  page = 1,
  limit = 25,
  search = '',
  level = '',
  rank = '',
  courseId = '',
  status = '',
  sort = 'points',
} = {}) {
  const database = db.get();
  const studentsCol = database.collection(collection.STUDENTS_COLLECTION);

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 25));
  const skip = (safePage - 1) * safeLimit;

  // Match only student accounts (have course array or role is student)
  const matchStage = {
    $or: [
      { course: { $exists: true, $not: { $size: 0 } } },
      { role: 'student' },
    ],
  };

  // Search filter
  if (search && String(search).trim()) {
    const term = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(term, 'i');
    matchStage.$and = matchStage.$and || [];
    matchStage.$and.push({
      $or: [
        { Name: regex },
        { name: regex },
        { username: regex },
        { email: regex },
        { Email: regex },
      ],
    });
  }

  // Level filter
  if (level !== '' && !isNaN(parseInt(level, 10))) {
    matchStage['gamification.level'] = parseInt(level, 10);
  }

  // Rank filter
  if (rank && String(rank).trim()) {
    matchStage['gamification.rank'] = String(rank).trim();
  }

  // Course filter
  if (courseId && String(courseId).trim()) {
    matchStage['course.courseId'] = String(courseId).trim();
  }

  // Status filter
  if (status === 'active') {
    matchStage['account_Status.isActive'] = true;
    matchStage['account_Status.isBlocked'] = false;
  } else if (status === 'inactive') {
    matchStage.$and = matchStage.$and || [];
    matchStage.$and.push({
      $or: [
        { 'account_Status.isActive': false },
        { 'account_Status.isBlocked': true },
      ],
    });
  }

  // Sorting: Deterministic
  let sortStage = {
    'gamification.totalPoints': -1,
    'gamification.level': -1,
    'gamification.completedClasses': -1,
    createdAt: 1,
    _id: 1,
  };

  if (sort === 'level') {
    sortStage = { 'gamification.level': -1, 'gamification.totalPoints': -1, createdAt: 1, _id: 1 };
  } else if (sort === 'classes') {
    sortStage = { 'gamification.completedClasses': -1, 'gamification.totalPoints': -1, createdAt: 1, _id: 1 };
  } else if (sort === 'streak') {
    sortStage = { 'gamification.totalPoints': -1, createdAt: 1, _id: 1 }; // streak sorted post-query or secondary
  } else if (sort === 'recent') {
    sortStage = { 'gamification.recentActivities.0.createdAt': -1, 'gamification.totalPoints': -1, _id: 1 };
  }

  // Projection: Never leak sensitive auth/security fields
  const projectStage = {
    _id: 1,
    Name: 1,
    name: 1,
    username: 1,
    usernameClaimed: 1,
    email: 1,
    Email: 1,
    image: 1,
    avatar: 1,
    course: 1,
    gamification: 1,
    account_Status: 1,
    createdAt: 1,
  };

  // Pipeline with facets for data + count + top3 podium + KPIs
  const pipeline = [
    { $match: matchStage },
    { $project: projectStage },
    {
      $facet: {
        paginatedResults: [{ $sort: sortStage }, { $skip: skip }, { $limit: safeLimit }],
        totalCount: [{ $count: 'count' }],
        podium: [{ $sort: sortStage }, { $limit: 3 }],
        kpis: [
          {
            $group: {
              _id: null,
              totalStudents: { $sum: 1 },
              totalPoints: { $sum: { $ifNull: ['$gamification.totalPoints', 0] } },
              activeStudents: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$account_Status.isActive', true] },
                        { $ne: ['$account_Status.isBlocked', true] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ];

  const [aggregationResult] = await studentsCol.aggregate(pipeline).toArray();

  const total = aggregationResult?.totalCount?.[0]?.count || 0;
  const rawStudents = aggregationResult?.paginatedResults || [];
  const rawPodium = aggregationResult?.podium || [];
  const kpiData = aggregationResult?.kpis?.[0] || {
    totalStudents: total,
    totalPoints: 0,
    activeStudents: 0,
  };

  const totalPages = Math.ceil(total / safeLimit) || 1;
  const averagePoints = kpiData.totalStudents ? Math.round(kpiData.totalPoints / kpiData.totalStudents) : 0;

  // Decorate students with rank, images, and level progress
  const decorateStudentRow = async (s, indexOffset) => {
    ensureGamification(s);
    await decorateProfileImage(s, 'image');

    const displayName = s.Name || s.name || 'Student';
    const streak = calculateStreak(s.gamification.activityDates);
    const rankMeta = getRankMeta(s.gamification.rank);
    const levelProgress = getNextLevelProgress(s.gamification.totalPoints);

    return {
      _id: s._id.toString(),
      rank: indexOffset + 1,
      displayName,
      username: s.username ? `@${s.username}` : '',
      email: s.email || s.Email || '',
      imageUrl: s.imageUrl || s.image || s.avatar || '/img/placeholders/profile.svg',
      initials: displayName.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'ST',
      points: s.gamification.totalPoints,
      level: s.gamification.level,
      rankTitle: s.gamification.rank,
      rankMeta,
      completedClasses: s.gamification.completedClasses,
      completedCourses: s.gamification.completedCourses,
      totalWatchMinutes: s.gamification.totalWatchMinutes,
      streak,
      levelProgress,
      isActive: s.account_Status?.isActive !== false && !s.account_Status?.isBlocked,
      enrolledCoursesCount: (s.course || []).length,
    };
  };

  const students = await Promise.all(
    rawStudents.map((s, idx) => decorateStudentRow(s, skip + idx))
  );

  const podium = await Promise.all(
    rawPodium.map((s, idx) => decorateStudentRow(s, idx))
  );

  return {
    students,
    podium,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      prevPage: safePage - 1,
      nextPage: safePage + 1,
    },
    kpis: {
      totalStudents: kpiData.totalStudents || total,
      activeStudents: kpiData.activeStudents || 0,
      totalPoints: kpiData.totalPoints || 0,
      averagePoints,
    },
  };
}

/**
 * Retrieve Course Leaderboard with course-specific points, podium, and metrics
 */
async function getCourseLeaderboard(courseId, { page = 1, limit = 25, search = '', sort = 'points' } = {}) {
  if (!courseId) {
    throw new Error('Course identifier is required');
  }

  const database = db.get();
  const courseCol = database.collection(collection.COURSE_COLLECTION);
  const studentsCol = database.collection(collection.STUDENTS_COLLECTION);
  const ledgerCol = database.collection(collection.POINT_TRANSACTIONS_COLLECTION);

  // Fetch course details
  const courseDoc = await courseCol.findOne(
    ObjectId.isValid(courseId) ? { _id: new ObjectId(courseId) } : { _id: String(courseId) }
  );

  if (!courseDoc) {
    throw new Error('Course not found');
  }

  const courseIdStr = courseDoc._id.toString();
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 25));

  // Match only students enrolled in this course
  const matchQuery = {
    'course.courseId': courseIdStr,
  };

  if (search && String(search).trim()) {
    const term = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(term, 'i');
    matchQuery.$or = [
      { Name: regex },
      { name: regex },
      { username: regex },
      { email: regex },
    ];
  }

  // Fetch all enrolled students matching search to accurately compute course points & rank
  const enrolledStudents = await studentsCol
    .find(matchQuery, {
      projection: {
        _id: 1,
        Name: 1,
        name: 1,
        username: 1,
        image: 1,
        avatar: 1,
        course: 1,
        gamification: 1,
        account_Status: 1,
        createdAt: 1,
      },
    })
    .toArray();

  // Fetch course-scoped point transactions for these students
  const studentIds = enrolledStudents.map((s) => s._id);
  const courseTransactions = await ledgerCol
    .find({
      studentId: { $in: studentIds },
      courseId: courseIdStr,
      scope: 'course',
    })
    .toArray();

  const transactionPointsMap = new Map();
  courseTransactions.forEach((tx) => {
    const sKey = tx.studentId.toString();
    const current = transactionPointsMap.get(sKey) || 0;
    const delta = tx.direction === 'credit' ? Number(tx.points) : -Number(tx.points);
    transactionPointsMap.set(sKey, current + delta);
  });

  // Calculate course-specific XP and stats for each student
  const studentList = enrolledStudents.map((student) => {
    ensureGamification(student);
    const enrollment = (student.course || []).find((c) => String(c.courseId) === courseIdStr) || {};
    const progressPoints = calculateCourseProgressPoints(enrollment);
    const txPoints = transactionPointsMap.get(student._id.toString()) || 0;
    const courseXP = Math.max(0, progressPoints + txPoints);

    const learningProgress = enrollment.learningProgress || {};
    const completionPercent = Number(learningProgress.completionPercent) || 0;
    const completedClasses = Number(learningProgress.completedClasses) || 0;
    const totalClasses = Number(learningProgress.totalClasses) || 0;
    const streak = calculateStreak(enrollment.activityDates || student.gamification.activityDates);

    return {
      _id: student._id.toString(),
      displayName: student.Name || student.name || 'Student',
      username: student.username ? `@${student.username}` : '',
      image: student.image,
      avatar: student.avatar,
      courseXP,
      globalXP: student.gamification.totalPoints || 0,
      level: student.gamification.level || 1,
      rankTitle: student.gamification.rank || 'Beginner',
      rankMeta: getRankMeta(student.gamification.rank),
      completionPercent,
      completedClasses,
      totalClasses,
      streak,
      lastActive: student.account_Status?.lastSeen || student.createdAt,
      createdAt: student.createdAt,
    };
  });

  // Deterministic sorting on courseXP
  studentList.sort((a, b) => {
    if (b.courseXP !== a.courseXP) return b.courseXP - a.courseXP;
    if (b.completionPercent !== a.completionPercent) return b.completionPercent - a.completionPercent;
    if (b.completedClasses !== a.completedClasses) return b.completedClasses - a.completedClasses;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const total = studentList.length;
  const totalPages = Math.ceil(total / safeLimit) || 1;
  const skip = (safePage - 1) * safeLimit;

  // Calculate KPIs
  const totalCourseXP = studentList.reduce((sum, s) => sum + s.courseXP, 0);
  const highestXP = studentList.length ? studentList[0].courseXP : 0;
  const averageXP = studentList.length ? Math.round(totalCourseXP / studentList.length) : 0;
  const topCompletion = studentList.reduce((max, s) => Math.max(max, s.completionPercent), 0);

  // Top 3 Podium
  const podium = await Promise.all(
    studentList.slice(0, 3).map(async (s, idx) => {
      await decorateProfileImage(s, 'image');
      return {
        ...s,
        rank: idx + 1,
        imageUrl: s.imageUrl || s.image || s.avatar || '/img/placeholders/profile.svg',
        initials: s.displayName.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'ST',
      };
    })
  );

  // Paginated students with rank
  const pageSlice = studentList.slice(skip, skip + safeLimit);
  const paginatedStudents = await Promise.all(
    pageSlice.map(async (s, idx) => {
      await decorateProfileImage(s, 'image');
      return {
        ...s,
        rank: skip + idx + 1,
        imageUrl: s.imageUrl || s.image || s.avatar || '/img/placeholders/profile.svg',
        initials: s.displayName.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'ST',
      };
    })
  );

  return {
    course: {
      _id: courseDoc._id.toString(),
      name: courseDoc.name || 'Course',
      type: courseDoc.type || '',
      Total_Fees: courseDoc.Total_Fees || '',
    },
    students: paginatedStudents,
    podium,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      prevPage: safePage - 1,
      nextPage: safePage + 1,
    },
    kpis: {
      totalStudents: total,
      highestXP,
      averageXP,
      topCompletion,
    },
  };
}

/**
 * Retrieve Complete Student Gamification Profile
 */
async function getStudentGamificationProfile(studentId) {
  if (!ObjectId.isValid(studentId)) {
    throw new Error('Valid student identifier is required');
  }

  const sId = new ObjectId(studentId);
  const database = db.get();
  const studentsCol = database.collection(collection.STUDENTS_COLLECTION);
  const ledgerCol = database.collection(collection.POINT_TRANSACTIONS_COLLECTION);

  const student = await studentsCol.findOne({ _id: sId });
  if (!student) {
    throw new Error('Student not found');
  }

  ensureGamification(student);
  await decorateProfileImage(student, 'image');

  const displayName = student.Name || student.name || 'Student';
  const totalPoints = student.gamification.totalPoints || 0;
  const levelProgress = getNextLevelProgress(totalPoints);
  const rankMeta = getRankMeta(student.gamification.rank);
  const streak = calculateStreak(student.gamification.activityDates);

  // Calculate Global Rank deterministically
  const higherCount = await studentsCol.countDocuments({
    $or: [
      { 'gamification.totalPoints': { $gt: totalPoints } },
      {
        'gamification.totalPoints': totalPoints,
        'gamification.level': { $gt: student.gamification.level || 1 },
      },
      {
        'gamification.totalPoints': totalPoints,
        'gamification.level': student.gamification.level || 1,
        'gamification.completedClasses': { $gt: student.gamification.completedClasses || 0 },
      },
      {
        'gamification.totalPoints': totalPoints,
        'gamification.level': student.gamification.level || 1,
        'gamification.completedClasses': student.gamification.completedClasses || 0,
        createdAt: { $lt: student.createdAt },
      },
    ],
  });
  const globalRank = higherCount + 1;

  // Retrieve enrolled courses breakdown with course rank & XP
  const enrolledCourses = [];
  const courses = Array.isArray(student.course) ? student.course : [];

  for (const courseItem of courses) {
    const courseIdStr = String(courseItem.courseId);
    const progressPoints = calculateCourseProgressPoints(courseItem);

    // Sum transactions for this course
    const txSummary = await ledgerCol
      .aggregate([
        {
          $match: {
            studentId: sId,
            courseId: courseIdStr,
            scope: 'course',
          },
        },
        {
          $group: {
            _id: null,
            totalCredits: {
              $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$points', 0] },
            },
            totalDebits: {
              $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$points', 0] },
            },
          },
        },
      ])
      .toArray();

    const txPoints = (txSummary[0]?.totalCredits || 0) - (txSummary[0]?.totalDebits || 0);
    const courseXP = Math.max(0, progressPoints + txPoints);

    // Calculate rank within this course
    const otherStudentsInCourse = await studentsCol
      .find({ 'course.courseId': courseIdStr }, { projection: { course: 1, gamification: 1, createdAt: 1 } })
      .toArray();

    let courseRank = 1;
    otherStudentsInCourse.forEach((other) => {
      if (other._id.toString() === sId.toString()) return;
      const otherEnrollment = (other.course || []).find((c) => String(c.courseId) === courseIdStr);
      const otherXP = calculateCourseProgressPoints(otherEnrollment);
      if (otherXP > courseXP) {
        courseRank += 1;
      }
    });

    const lp = courseItem.learningProgress || {};
    enrolledCourses.push({
      courseId: courseIdStr,
      courseName: courseItem.courseName || 'Course',
      courseXP,
      completionPercent: Number(lp.completionPercent) || 0,
      completedClasses: Number(lp.completedClasses) || 0,
      totalClasses: Number(lp.totalClasses) || 0,
      streak: Number(lp.streak) || 0,
      courseRank,
      duration: courseItem.duration || '—',
    });
  }

  // Fetch Point Transactions Timeline (recent 50)
  const transactions = await ledgerCol
    .find({ studentId: sId })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  // If no transactions exist yet, use recentActivities as display timeline
  const timeline = transactions.length
    ? transactions.map((tx) => ({
        id: tx._id.toString(),
        points: tx.points,
        direction: tx.direction,
        isCredit: tx.direction === 'credit',
        type: tx.type,
        scope: tx.scope,
        courseName: tx.courseName,
        reason: tx.reason,
        actorName: tx.actorName,
        actorRole: tx.actorRole,
        previousBalance: tx.previousBalance,
        newBalance: tx.newBalance,
        createdAt: tx.createdAt,
      }))
    : (student.gamification.recentActivities || []).map((act, idx) => ({
        id: `legacy-${idx}`,
        points: Math.abs(act.points || 0),
        direction: (act.points || 0) >= 0 ? 'credit' : 'debit',
        isCredit: (act.points || 0) >= 0,
        type: act.type || 'activity',
        scope: act.metadata?.courseId ? 'course' : 'global',
        courseName: act.metadata?.courseName || null,
        reason: act.label || 'Activity reward',
        actorName: act.metadata?.actorName || 'System',
        actorRole: 'system',
        previousBalance: totalPoints,
        newBalance: totalPoints,
        createdAt: act.createdAt || new Date(),
      }));

  return {
    student: {
      _id: student._id.toString(),
      displayName,
      username: student.username ? `@${student.username}` : '',
      email: student.email || student.Email || '',
      imageUrl: student.imageUrl || student.image || student.avatar || '/img/placeholders/profile.svg',
      initials: displayName.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase() || 'ST',
      isActive: student.account_Status?.isActive !== false && !student.account_Status?.isBlocked,
      createdAt: student.createdAt,
    },
    gamification: {
      totalPoints,
      level: student.gamification.level || 1,
      rankTitle: student.gamification.rank || 'Beginner',
      rankMeta,
      globalRank,
      completedClasses: student.gamification.completedClasses || 0,
      completedCourses: student.gamification.completedCourses || 0,
      totalWatchMinutes: student.gamification.totalWatchMinutes || 0,
      profileCompletion: student.gamification.profileCompletion || 0,
      streak,
      levelProgress,
      achievements: student.gamification.achievements || [],
    },
    enrolledCourses,
    timeline,
  };
}

/**
 * Retrieve Point History (Audit Trail) across all students with filters and pagination
 */
async function getPointHistory({
  page = 1,
  limit = 25,
  studentId = '',
  actorId = '',
  courseId = '',
  scope = '',
  direction = '',
  type = '',
  search = '',
  startDate = '',
  endDate = '',
} = {}) {
  const database = db.get();
  const ledgerCol = database.collection(collection.POINT_TRANSACTIONS_COLLECTION);

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 25));
  const skip = (safePage - 1) * safeLimit;

  const query = {};

  if (studentId && ObjectId.isValid(studentId)) {
    query.studentId = new ObjectId(studentId);
  }

  if (actorId && ObjectId.isValid(actorId)) {
    query.actorId = new ObjectId(actorId);
  }

  if (courseId) {
    query.courseId = String(courseId);
  }

  if (scope && ['global', 'course'].includes(scope)) {
    query.scope = scope;
  }

  if (direction && ['credit', 'debit'].includes(direction)) {
    query.direction = direction;
  }

  if (type) {
    query.type = type;
  }

  if (search && String(search).trim()) {
    const term = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(term, 'i');
    query.$or = [
      { studentName: regex },
      { studentUsername: regex },
      { studentEmail: regex },
      { reason: regex },
      { actorName: regex },
      { courseName: regex },
    ];
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) query.createdAt.$gte = d;
    }
    if (endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        query.createdAt.$lte = d;
      }
    }
  }

  const [transactions, total] = await Promise.all([
    ledgerCol
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .toArray(),
    ledgerCol.countDocuments(query),
  ]);

  const totalPages = Math.ceil(total / safeLimit) || 1;

  return {
    transactions: transactions.map((tx) => ({
      _id: tx._id.toString(),
      studentId: tx.studentId ? tx.studentId.toString() : '',
      studentName: tx.studentName || 'Student',
      studentUsername: tx.studentUsername ? `@${tx.studentUsername}` : '',
      studentEmail: tx.studentEmail || '',
      points: tx.points,
      direction: tx.direction,
      isCredit: tx.direction === 'credit',
      type: tx.type,
      scope: tx.scope,
      courseId: tx.courseId,
      courseName: tx.courseName || '—',
      reason: tx.reason,
      source: tx.source,
      actorName: tx.actorName || 'Admin',
      actorRole: tx.actorRole || 'admin',
      previousBalance: tx.previousBalance,
      newBalance: tx.newBalance,
      createdAt: tx.createdAt,
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      prevPage: safePage - 1,
      nextPage: safePage + 1,
    },
  };
}

/**
 * Reconcile a single student's ledger transactions against their current balance
 */
async function reconcileStudent(studentId, applyFix = false) {
  if (!ObjectId.isValid(studentId)) {
    throw new Error('Valid student identifier is required');
  }

  const sId = new ObjectId(studentId);
  const database = db.get();
  const studentsCol = database.collection(collection.STUDENTS_COLLECTION);
  const ledgerCol = database.collection(collection.POINT_TRANSACTIONS_COLLECTION);

  const student = await studentsCol.findOne({ _id: sId });
  if (!student) {
    throw new Error('Student not found');
  }

  ensureGamification(student);

  // Aggregate ledger
  const result = await ledgerCol
    .aggregate([
      { $match: { studentId: sId } },
      {
        $group: {
          _id: null,
          totalCredits: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$points', 0] } },
          totalDebits: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$points', 0] } },
          transactionCount: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const ledgerCredits = result[0]?.totalCredits || 0;
  const ledgerDebits = result[0]?.totalDebits || 0;
  const expectedBalance = Math.max(0, ledgerCredits - ledgerDebits);
  const actualBalance = student.gamification.totalPoints || 0;
  const discrepancy = actualBalance - expectedBalance;

  let fixed = false;
  if (applyFix && discrepancy !== 0) {
    const newLevel = calculateLevel(expectedBalance);
    const newRank = calculateRank(expectedBalance);

    await studentsCol.updateOne(
      { _id: sId },
      {
        $set: {
          'gamification.totalPoints': expectedBalance,
          'gamification.level': newLevel,
          'gamification.rank': newRank,
          updatedAt: new Date(),
        },
      }
    );
    fixed = true;

    await auditHelper.logAction({
      action: 'RECONCILE_STUDENT_POINTS',
      entityType: 'gamification_reconciliation',
      entityId: String(sId),
      entityName: student.Name || student.name || 'Student',
      status: 'success',
      message: `Reconciled student points from ${actualBalance} to ledger expected ${expectedBalance} XP`,
      metadata: { expectedBalance, actualBalance, discrepancy },
    });
  }

  return {
    studentId: sId.toString(),
    studentName: student.Name || student.name || 'Student',
    username: student.username || '',
    actualBalance,
    expectedBalance,
    discrepancy,
    hasDiscrepancy: discrepancy !== 0,
    transactionCount: result[0]?.transactionCount || 0,
    fixed,
  };
}

/**
 * Reconcile all students
 */
async function reconcileAllStudents({ applyFix = false } = {}) {
  const database = db.get();
  const studentsCol = database.collection(collection.STUDENTS_COLLECTION);

  const students = await studentsCol
    .find(
      {
        $or: [
          { 'gamification.totalPoints': { $gt: 0 } },
          { course: { $exists: true, $not: { $size: 0 } } },
        ],
      },
      { projection: { _id: 1 } }
    )
    .toArray();

  const reports = [];
  let totalMismatches = 0;

  for (const s of students) {
    const report = await reconcileStudent(s._id, applyFix);
    if (report.hasDiscrepancy) {
      totalMismatches += 1;
      reports.push(report);
    }
  }

  return {
    totalChecked: students.length,
    totalMismatches,
    totalMatches: students.length - totalMismatches,
    discrepancies: reports,
    fixed: applyFix,
  };
}

/**
 * Idempotent Migration: Initialize baseline ledger records for legacy students with existing points
 */
async function migrateLegacyPoints() {
  const database = db.get();
  const studentsCol = database.collection(collection.STUDENTS_COLLECTION);
  const ledgerCol = database.collection(collection.POINT_TRANSACTIONS_COLLECTION);

  logger.info('[Gamification Migration] Starting idempotent legacy points migration...');

  const studentsWithPoints = await studentsCol
    .find({
      'gamification.totalPoints': { $gt: 0 },
    })
    .toArray();

  let migratedCount = 0;
  let skippedCount = 0;

  for (const student of studentsWithPoints) {
    const sId = student._id;
    // Check if student already has any transaction in ledger
    const existingTx = await ledgerCol.findOne({ studentId: sId });

    if (existingTx) {
      skippedCount += 1;
      continue;
    }

    const baselinePoints = student.gamification.totalPoints;
    const baselineDoc = {
      studentId: sId,
      studentName: student.Name || student.name || 'Student',
      studentUsername: student.username || '',
      studentEmail: student.email || student.Email || '',
      points: baselinePoints,
      direction: 'credit',
      type: POINT_ACTION_TYPES.MIGRATION_BASELINE,
      scope: 'global',
      courseId: null,
      courseName: null,
      reason: 'Idempotent legacy points baseline migration',
      source: 'system',
      actorId: null,
      actorRole: 'system',
      actorName: 'System Migration',
      previousBalance: 0,
      newBalance: baselinePoints,
      status: 'completed',
      transactionKey: `migration-baseline-${sId.toString()}`,
      metadata: {
        legacyCompletedClasses: student.gamification.completedClasses || 0,
        legacyCompletedCourses: student.gamification.completedCourses || 0,
        migratedAt: new Date(),
      },
      createdAt: student.createdAt || new Date(),
    };

    await ledgerCol.insertOne(baselineDoc);
    migratedCount += 1;
  }

  logger.info(
    `[Gamification Migration] Complete: ${migratedCount} students migrated, ${skippedCount} already had transactions.`
  );

  return {
    totalChecked: studentsWithPoints.length,
    migratedCount,
    skippedCount,
  };
}

module.exports = {
  recordPointTransaction,
  getGlobalLeaderboard,
  getCourseLeaderboard,
  getStudentGamificationProfile,
  getPointHistory,
  reconcileStudent,
  reconcileAllStudents,
  migrateLegacyPoints,
  ensureGamification,
  calculateCourseProgressPoints,
};
