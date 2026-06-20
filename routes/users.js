const logger = require('../Helpers/logger');
var express = require('express');
var router = express.Router();
const rateLimit = require('express-rate-limit');
var courseHelpers = require('../Helpers/course-helper');
var studentHelpers = require('../Helpers/student-helper');
var mailHelpers = require('../Helpers/mail-helper');
var auditHelper = require('../Helpers/audit-helper');
const dashboardHelper = require('../Helpers/dashboard-helper');
const settingsHelper = require('../Helpers/settings-helper');
const classHelper = require('../Helpers/class-helper');
const adminHelpers = require('../Helpers/admin-helper');
const teacherHelpers = require('../Helpers/teacher-helper');
const { getVideoDurationInSeconds } = require('get-video-duration');
const ffprobeStatic = require('ffprobe-static');
const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({
  dest: path.join(__dirname, '../backups/uploads'),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isJson = path.extname(file.originalname).toLowerCase() === '.json';
    cb(isJson ? null : new Error('Only .json backup files are accepted.'), isJson);
  }
});
const {
  uploadCourse,
  uploadChapter,
  uploadStudent,
  uploadTeacher,
  uploadClass,
  uploadExercise,
  uploadCover
} = require('../config/multer');
const { uploadToS3, extractPathFromUrl, deleteFromS3 } = require('../config/s3-storage');
const mediaHelper = require('../Helpers/media-helper');

const logAudit = (req, data) => {
  auditHelper.logAction({ req, ...data });
};

// ─── LOGIN RATE LIMITERS ───────────────────────────────────────────────────
// Strict limit on login/OTP routes to prevent brute-force & OTP spam
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,                    // max 15 login attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again in 15 minutes.',
  skipSuccessfulRequests: true,
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10,                    // max 10 OTP submissions per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many OTP attempts. Please try again later.',
});

const resendOtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,                     // max 3 resend requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many OTP resend requests. Please try again later.',
});

// Note: Handlebars helpers are registered centrally in app.js

const verifyLogin = (req, res, next) => {
  if (req.session.adminloggedIn) {
    next();
  } else {
    // If it's an AJAX request or fetch POST, return JSON instead of HTML redirect
    if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
      return res.status(401).json({ success: false, message: 'Unauthorized. Please log in again.' });
    }
    res.redirect('/login');
  }
};

// Only the superuser can access these routes
const verifySuperuser = (req, res, next) => {
  if (req.session.adminloggedIn && req.session.admin && req.session.admin.role === 'superuser') {
    next();
  } else {
    res.status(403).render('error', { message: 'Access Denied — Superuser only.' });
  }
};

// Reusable middleware to validate parameters that must be valid MongoDB ObjectIds
const validateObjectIds = (paramNames) => {
  return (req, res, next) => {
    for (const name of paramNames) {
      const value = req.params[name] || req.body[name] || req.query[name];
      if (value && !ObjectId.isValid(value)) {
        if (req.xhr || req.headers.accept?.indexOf('json') > -1 || req.method === 'POST') {
          return res.status(400).json({ success: false, error: `Invalid parameter: ${name}` });
        }
        return res.status(400).render('error', { message: `Invalid identifier: ${name}` });
      }
    }
    next();
  };
};

// Inject session admin info into all templates automatically
router.use((req, res, next) => {
  const admin = req.session.admin || null;
  res.locals.isSuperuser = admin && admin.role === 'superuser';
  res.locals.sessionAdmin = admin;
  next();
});

const OTP_EXPIRY_MS = 5 * 60 * 1000;

const buildLoginViewModel = (req, extra = {}) => {
  const otpSession = req.session.adminOtpLogin || null;

  return {
    admins: false,
    loginErr: req.session.loginErr,
    otpErr: req.session.otpErr,
    otpInfo: req.session.otpInfo,
    otpPending: Boolean(otpSession),
    pendingEmail: otpSession ? otpSession.email : '',
    ...extra
  };
};

const clearLoginMessages = (req) => {
  req.session.loginErr = null;
  req.session.otpErr = null;
  req.session.otpInfo = null;
};

const clearPendingAdminOtp = (req) => {
  delete req.session.adminOtpLogin;
};

const generateOtp = () => {
  return String(crypto.randomInt(100000, 1000000));
};

const hashOtp = (otp) => {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(String(otp))
    .digest('hex');
};

const isMatchingOtp = (otp, expectedHash) => {
  if (!/^\d{6}$/.test(otp) || !expectedHash) return false;
  const actual = Buffer.from(hashOtp(otp), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const reviveBackupValue = (value, key = '') => {
  if (Array.isArray(value)) return value.map(item => reviveBackupValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        reviveBackupValue(childValue, childKey)
      ])
    );
  }
  if (key === '_id' && typeof value === 'string' && ObjectId.isValid(value)) {
    return new ObjectId(value);
  }
  if (
    typeof value === 'string' &&
    /^(createdAt|updatedAt|submittedAt|gradedAt|dueDate|Start_Date|End_Date|lastSeen|otpExpiry)$/i.test(key)
  ) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return value;
};

/* GET users listing. */

router.get('/', async function (req, res, next) {
  try {
    // Redirect teacher to their dashboard
    if (req.session.teacherloggedIn) {
      return res.redirect('/teacher/dashboard');
    }

    if (!req.session.adminloggedIn) {
      return res.redirect('/login');
    }

    const admin = req.session.admin;
    const isSuperuser = admin && admin.role === 'superuser';

    const dashboard =
      await dashboardHelper.getDashboardData();

    res.render('admin/home', {
      admin: admin ? (admin.Name || admin.Email) : 'Admin',
      adminData: admin,
      isSuperuser,
      admins: true,
      currentPage: 'dashboard',
      dashboard
    });

  } catch (err) {
    logger.info(err);
    res.redirect('/login');
  }
});
router.get('/students', verifyLogin, function (req, res, next) {
  studentHelpers.getStudents().then((students) => {
    res.render('admin/students', { admins: true, currentPage: 'students', students });
  }).catch((err) => {
    logger.info('Get Students Error:', err.message);
    res.redirect('/');
  });
});

// ✅ REGISTERED USERS (from user panel, no courses)
router.get('/registered-users', verifyLogin, async function (req, res) {
  try {
    let users = await studentHelpers.getRegisteredUsers();
    let courses = await courseHelpers.getCourses();

    res.render('admin/registered-users', {
      admins: true,
      currentPage: 'registered-users',
      users,
      courses
    });
  } catch (err) {
    logger.info('Registered Users Error:', err);
    res.redirect('/');
  }
});

// ✅ ASSIGN COURSE TO USER
router.post('/assign-course', verifyLogin, async function (req, res) {
  try {
    let userId = req.body.userId;
    let packageIds = Array.isArray(req.body.package) ? req.body.package : [req.body.package].filter(Boolean);
    packageIds = [...new Set(packageIds.filter(id => ObjectId.isValid(id)).map(String))];

    if (!ObjectId.isValid(userId) || !packageIds.length) {
      return res.status(400).json({ status: false, error: 'Invalid user or course selection.' });
    }

    let courses = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .find({ _id: { $in: packageIds.map(id => new ObjectId(id)) } })
      .toArray();

    if (courses.length !== packageIds.length) {
      return res.status(400).json({ status: false, error: 'One or more courses were not found.' });
    }

    const existingUser = await db.get()
      .collection(collection.STUDENTS_COLLECTION)
      .findOne({ _id: new ObjectId(userId) });

    if (!existingUser) {
      return res.status(404).json({ status: false, error: 'User not found.' });
    }

    let courseData = courses.map(course => {
      let totalClasses = 0;
      if (course.chapters) {
        course.chapters.forEach(chapter => {
          totalClasses += chapter.classes ? chapter.classes.length : 0;
        });
      }
      if (totalClasses <= 0) {
        totalClasses = Math.floor(Math.random() * 40) + 20;
      }
      const chance = Math.random();
      let minPercent = 0, maxPercent = 25;
      if (chance <= 0.35) { minPercent = 0; maxPercent = 25; }
      else if (chance <= 0.75) { minPercent = 25; maxPercent = 70; }
      else if (chance <= 0.95) { minPercent = 70; maxPercent = 95; }
      else { minPercent = 100; maxPercent = 100; }
      let completionPercent = Math.floor(Math.random() * (maxPercent - minPercent + 1)) + minPercent;
      let watchedClasses = Math.round((completionPercent / 100) * totalClasses);

      return {
        courseId: course._id.toString(),
        courseName: course.name,
        courseFee: course.Total_Fees,
        Start_Date: new Date(),
        End_Date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days default
        duration: '90 days',
        learningProgress: {
          totalClasses,
          watchedClasses,
          completionPercent,
          streak: Math.floor(Math.random() * 45) + 1,
          averageWatchTime: (Math.floor(Math.random() * 75) + 15) + " mins",
          certificateEligible: completionPercent >= 90
        }
      };
    });

    const existingCourseMap = new Map(
      (existingUser.course || []).map(course => [String(course.courseId), course])
    );
    courseData.forEach(course => existingCourseMap.set(String(course.courseId), course));

    await db.get()
      .collection(collection.STUDENTS_COLLECTION)
      .updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: {
            course: [...existingCourseMap.values()],
            package: [...new Set([
              ...(Array.isArray(existingUser.package) ? existingUser.package.map(String) : []),
              ...packageIds
            ])],
            "account_Status.isVerified": true,
            status: true
          }
        }
      );

    logAudit(req, {
      action: 'user.assign_course',
      entityType: 'user',
      entityId: userId,
      message: 'Courses assigned to registered user'
    });

    res.json({ status: true });
  } catch (err) {
    logger.info('Assign Course Error:', err);
    res.json({ status: false, error: err.message });
  }
});

// Normal Add Student page
router.get('/add-students', verifyLogin, async function (req, res) {

  let courses = await courseHelpers.getCourses();

  res.render('admin/add-students', {
    admins: true,
    courses
  });

});


// Add Student from Course Students page (auto-select course)
router.get('/add-students/:courseId', verifyLogin, validateObjectIds(['courseId']), async function (req, res) {

  let courses = await courseHelpers.getCourses();

  res.render('admin/add-students', {
    admins: true,
    courses,
    selectedCourseId: req.params.courseId
  });

});
router.post(
  '/add-students',
  verifyLogin,
  uploadStudent.single('image'),
  async (req, res) => {
    try {

      studentHelpers.addStudents(
        req.body,
        async (id) => {
          try {
            if (!id) {
              return res.status(400).send('Invalid student or course data');
            }

            // Upload student image to Firebase if provided
            if (req.file) {
              const ext = path.extname(req.file.originalname) || '.jpg';
              const destPath = `student-images/${id}${ext}`;
              const imageUrl = await uploadToS3(
                req.file.buffer,
                destPath,
                req.file.mimetype
              );
              await studentHelpers.updateStudentImage(id, imageUrl);
            }

            logAudit(req, {
              action: 'student.create',
              entityType: 'student',
              entityId: id,
              entityName: req.body.Name,
              message: 'Student added'
            });

            if (req.body.redirectCourseId) {
              return res.redirect('/' + req.body.redirectCourseId + '/students');
            }

            res.redirect('/students');

          } catch (err) {
            logger.info('Upload Error:', err);
            res.redirect('/students');
          }
        }
      );

    } catch (err) {
      logger.info('Add Student Error:', err);
      res.redirect('/students');
    }
  }
);

router.post('/delete-student/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {

  try {

    await studentHelpers.deleteStudent(req.params.id);

    logAudit(req, {
      action: 'student.delete',
      entityType: 'student',
      entityId: req.params.id,
      message: 'Student deleted'
    });

    res.json({ success: true });

  } catch (err) {
    logger.info(err);

    res.json({
      success: false,
      message: "Delete failed"
    });
  }

});

router.get('/edit-student/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    let student = await studentHelpers.getStudentById(req.params.id);
    if (!student) {
      return res.redirect('/students');
    }

    let courses = await courseHelpers.getCourses();

    res.render('admin/edit-student', {
      admins: true,
      student,
      courses
    });
  } catch (err) {
    logger.info('GET Edit Student Error:', err.message);
    res.redirect('/students');
  }
});

router.post(
  '/edit-student/:id',
  verifyLogin,
  validateObjectIds(['id']),
  uploadStudent.single('image'),
  async (req, res) => {
    try {

      const updated = await studentHelpers.updateStudent(
        req.params.id,
        req.body
      );
      if (!updated) {
        return res.status(400).send('Invalid student or course data');
      }

      // Upload new student image to Firebase if provided
      if (req.file) {
        const ext = path.extname(req.file.originalname) || '.jpg';
        const destPath = `student-images/${req.params.id}${ext}`;
        const imageUrl = await uploadToS3(
          req.file.buffer,
          destPath,
          req.file.mimetype
        );
        await studentHelpers.updateStudentImage(req.params.id, imageUrl);
      }

      logAudit(req, {
        action: 'student.update',
        entityType: 'student',
        entityId: req.params.id,
        entityName: req.body.Name,
        message: 'Student updated'
      });

      res.redirect('/students');

    } catch (err) {
      logger.info('Edit Student Error:', err);
      res.redirect('/students');
    }
  }
);
// ✅ Protected with verifyLogin
router.post('/change-status/:id/:status', verifyLogin, validateObjectIds(['id']), (req, res) => {
  const studentId = req.params.id;
  const status = req.params.status === 'true';

  studentHelpers.changeStudentStatus(studentId, status)
    .then(() => {
      logAudit(req, {
        action: status ? 'student.access.approve' : 'student.access.block',
        entityType: 'student',
        entityId: studentId,
        message: status ? 'Student access approved' : 'Student access blocked'
      });
      res.json({ status: true });
    })
    .catch((err) => {
      logger.info('Change Status Error:', err.message);
      res.json({ status: false });
    });
});

// ✅ Protected with verifyLogin
router.post('/verify-account/:id', verifyLogin, validateObjectIds(['id']), (req, res) => {
  const studentId = req.params.id;

  studentHelpers.verifyStudent(studentId)
    .then(() => {
      logAudit(req, {
        action: 'student.verify',
        entityType: 'student',
        entityId: studentId,
        message: 'Student account verified'
      });
      res.json({ status: true });
    })
    .catch((err) => {
      logger.info('Verify Student Error:', err.message);
      res.json({ status: false });
    });
});

// ===========================
// VIEW CHAPTERS
// ===========================
router.get(
  '/chapters',
  verifyLogin,
  async (req, res) => {
    try {

      const chapters =
        await courseHelpers.getAllChapters();

      res.render(
        'admin/chapters',
        {
          admins: true,
          chapters,
          currentPage: 'chapters'
        }
      );

    } catch (err) {
      logger.info(
        'Get Chapters Error:',
        err.message
      );

      res.redirect('/');
    }
  }
);


// ===========================
// ADD CHAPTER PAGE
// ===========================
router.get(
  '/add-chapters',
  verifyLogin,
  async (req, res) => {
    try {

      const courses =
        await courseHelpers.getCourses();

      res.render(
        'admin/add-chapters',
        {
          admins: true,
          courses
        }
      );

    } catch (err) {
      logger.info(
        'Get Add Chapter Error:',
        err.message
      );

      res.redirect('/');
    }
  }
);


// ===========================
// ADD CHAPTER
// ===========================
router.post(
  '/add-chapters',
  verifyLogin,
  uploadChapter.none(),
  async (req, res) => {
    try {

      if (!req.body.coverImageUrl) {
        return res.status(400).send('Chapter cover image is required. Please select one from the Media Library.');
      }

      const uniqueCode = Date.now() + req.body.package;
      const imageUrl = req.body.coverImageUrl;

      await courseHelpers.addChapter(
        req.body,
        imageUrl,
        uniqueCode
      );

      logAudit(req, {
        action: 'chapter.create',
        entityType: 'chapter',
        entityId: uniqueCode,
        entityName: req.body.title,
        message: 'Chapter added',
        metadata: { courseId: req.body.package }
      });

      logger.info('✅ Chapter added');
      res.redirect('/chapters');

    } catch (err) {
      logger.info('Add Chapter Error:', err.message);
      res.status(500).send('Failed to add chapter');
    }
  }
);


// ===========================
// DELETE CHAPTER
// ===========================
router.post(
  '/delete-chapter/:courseId/:uniqueCode',
  verifyLogin,
  validateObjectIds(['courseId']),
  async (req, res) => {
    try {

      const response =
        await courseHelpers.deleteChapter(
          req.params.courseId,
          req.params.uniqueCode
        );

      if (response.status) {
        logAudit(req, {
          action: 'chapter.delete',
          entityType: 'chapter',
          entityId: req.params.uniqueCode,
          message: 'Chapter deleted',
          metadata: {
            courseId: req.params.courseId
          }
        });
      }

      if (!response.status) {
        logger.info(
          response.message
        );
      }

      res.redirect('/chapters');

    } catch (err) {
      logger.info(
        'Delete Chapter Error:',
        err.message
      );

      res.redirect('/chapters');
    }
  }
);


// ===========================
// EDIT CHAPTER PAGE
// ===========================
router.get(
  '/edit-chapter/:courseId/:uniqueCode',
  verifyLogin,
  validateObjectIds(['courseId']),
  async (req, res) => {
    try {

      const chapter =
        await courseHelpers.getChapter(
          req.params.courseId,
          req.params.uniqueCode
        );

      const courses =
        await courseHelpers.getCourses();

      res.render(
        'admin/edit-chapters',
        {
          admins: true,
          chapter,
          courses
        }
      );

    } catch (err) {
      logger.info(
        'Get Edit Chapter Error:',
        err.message
      );

      res.redirect('/chapters');
    }
  }
);


// ===========================
// EDIT CHAPTER
// ===========================
router.post(
  '/edit-chapter/:courseId/:uniqueCode',
  verifyLogin,
  validateObjectIds(['courseId']),
  uploadChapter.none(),
  async (req, res) => {
    try {

      let newImageUrl = req.body.coverImageUrl || null;

      const response = await courseHelpers.updateChapterUltraSafe(
        req.params.courseId,
        req.params.uniqueCode,
        req.body,
        newImageUrl   // null = keep existing; string = new Firebase URL
      );

      if (!response.status) {
        logger.info(response.message);
      } else {
        logAudit(req, {
          action: 'chapter.update',
          entityType: 'chapter',
          entityId: req.params.uniqueCode,
          entityName: req.body.title || req.body.name,
          message: 'Chapter updated',
          metadata: {
            courseId: req.params.courseId,
            newCourseId: req.body.package
          }
        });
      }

      res.redirect('/chapters');

    } catch (err) {
      logger.info('Edit Chapter Error:', err.message);
      res.redirect('/chapters');
    }
  }
);
router.get(
  '/chapters/classes/:id',
  verifyLogin,
  async (req, res) => {
    try {

      const chapter =
        await classHelper.getChapterClasses(
          req.params.id
        );

      if (!chapter) {
        return res.redirect('/courses');
      }

      // Fetch course to get type (online/recording)
      const course = await db.get()
        .collection(collection.COURSE_COLLECTION)
        .findOne({ 'chapters.uniqueCode': req.params.id });

      const courseType = course?.type || 'recording';

      res.render(
        'admin/view-classes',
        {
          admins: true,
          chapter,
          courseType
        }
      );

    } catch (err) {
      logger.info(
        'Get Classes Route Error:',
        err.message
      );

    }
  }
);

router.get(
  '/classes',
  verifyLogin,
  async (req, res) => {
    try {
      const classes = await db.get().collection(collection.COURSE_COLLECTION).aggregate([
        { $unwind: '$chapters' },
        { $unwind: '$chapters.classes' },
        {
          $project: {
            _id: '$chapters.classes._id',
            title: '$chapters.classes.title',
            description: '$chapters.classes.description',
            thumbnail: '$chapters.classes.thumbnail',
            duration: '$chapters.classes.duration',
            order: '$chapters.classes.order',
            videoSource: '$chapters.classes.videoSource',
            videoId: '$chapters.classes.videoId',
            videoUrl: '$chapters.classes.videoUrl',
            exercisesCount: { $size: { $ifNull: ['$chapters.classes.exercises', []] } },
            chapterTitle: '$chapters.title',
            chapterCode: '$chapters.uniqueCode',
            courseName: '$name',
            courseId: '$_id'
          }
        }
      ]).toArray();

      res.render('admin/all-classes', {
        admins: true,
        currentPage: 'classes',
        classes
      });
    } catch (err) {
      logger.info('Get All Classes Route Error:', err.message);
      res.redirect('/courses');
    }
  }
);

router.get(
  '/add-class/:chapterCode',
  verifyLogin,
  async (req, res) => {
    try {
      // Fetch course to get type (online/recording)
      const course = await db.get()
        .collection(collection.COURSE_COLLECTION)
        .findOne({ 'chapters.uniqueCode': req.params.chapterCode });

      const courseType = course?.type || 'recording';

      res.render('admin/add-class', {
        admins: true,
        chapterCode: req.params.chapterCode,
        courseType
      });
    } catch (err) {
      logger.info('Add Class Page Error:', err.message);
      res.redirect('/chapters');
    }
  }
);

router.post(
  '/add-class',
  verifyLogin,
  uploadClass.fields([
    { name: 'video', maxCount: 1 }
  ]),
  async (req, res) => {
    const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';

    try {

      if (!req.body.coverImageUrl) {
        const msg = 'Class cover image is required. Please select one from the Media Library.';
        return isAjax
          ? res.status(400).json({ success: false, error: msg })
          : res.status(400).send(msg);
      }

      // Use coverImageUrl from body
      let thumbnailUrl = req.body.coverImageUrl;

      let detectedDuration = 0;
      try {
        if (req.files && req.files.video && req.files.video[0]) {
          const videoFile = req.files.video[0];
          logger.info(`Extracting duration for ${videoFile.originalname} (${videoFile.mimetype}, ${(videoFile.size / 1024 / 1024).toFixed(2)} MB)`);

          const rawSeconds = await getVideoDurationInSeconds(videoFile.path, ffprobeStatic.path);
          detectedDuration = Math.floor(rawSeconds);

          logger.info(`Successfully extracted duration: ${detectedDuration} seconds`);
        }
      } catch (durationErr) {
        logger.error('Video duration extraction failed:', durationErr.message);
      }

      // Fetch course type for this chapter
      const course = await db.get()
        .collection(collection.COURSE_COLLECTION)
        .findOne({ 'chapters.uniqueCode': req.body.chapterId });
      const courseType = course?.type || 'recording';

      // Attach Firebase URL + courseType so class-helper can use it
      const bodyWithThumb = { ...req.body, thumbnailUrl, duration: detectedDuration, courseType };

      const result = await classHelper.addClass(bodyWithThumb, req.files);

      if (!result.success) {
        return isAjax
          ? res.status(400).json({ success: false, error: result.error })
          : res.status(400).send(result.error);
      }

      logAudit(req, {
        action: 'class.create',
        entityType: 'class',
        entityName: req.body.title,
        message: 'Class added',
        metadata: { chapterId: req.body.chapterId }
      });

      const redirectUrl = '/chapters/classes/' + req.body.chapterId;

      return isAjax
        ? res.json({ success: true, redirect: redirectUrl })
        : res.redirect(redirectUrl);

    } catch (err) {
      logger.info('Add Class Route Error:', err.message);
      return isAjax
        ? res.status(500).json({ success: false, error: 'Failed to add class' })
        : res.status(500).send('Failed to add class');
    }
  }
);
router.get(
  '/class-video/:videoId',
  verifyLogin,
  async (req, res) => {
    try {

      const videoId = req.params.videoId;

      const response = await axios.post(
        `https://dev.vdocipher.com/api/videos/${videoId}/otp`,
        {
          ttl: 300
        },
        {
          headers: {
            Authorization:
              `Apisecret ${process.env.VDOCIPHER_API_SECRET}`
          }
        }
      );

      res.json({
        otp: response.data.otp,
        playbackInfo:
          response.data.playbackInfo
      });

    } catch (err) {
      logger.info(
        'OTP Error:',
        err.response?.data || err.message
      );

      res.status(500).json({
        error: 'Failed'
      });
    }
  }
);
router.post(
  '/delete-class/:chapterCode/:classId',
  verifyLogin,
  validateObjectIds(['classId']),
  async (req, res) => {
    try {

      await classHelper.deleteClass(
        req.params.chapterCode,
        req.params.classId
      );

      logAudit(req, {
        action: 'class.delete',
        entityType: 'class',
        entityId: req.params.classId,
        message: 'Class deleted',
        metadata: {
          chapterId: req.params.chapterCode
        }
      });

      res.redirect(
        '/chapters/classes/' +
        req.params.chapterCode
      );

    } catch (err) {
      logger.info(
        'Delete Class Route Error:',
        err.message
      );

      res.redirect(
        '/chapters/classes/' +
        req.params.chapterCode
      );
    }
  }
);

// ═══════════════════════════════════════════════════
// WATCH CLASS (ADMIN - PREVIEW WITH HIGH SECURITY)
// ═══════════════════════════════════════════════════
router.get(
  '/watch-class/:chapterCode/:classId',
  verifyLogin,
  validateObjectIds(['classId']),
  async (req, res) => {
    try {
      const { chapterCode, classId } = req.params;

      const course = await db.get()
        .collection(collection.COURSE_COLLECTION)
        .findOne({ 'chapters.uniqueCode': chapterCode });

      if (!course) {
        return res.status(404).render('error', { message: 'Chapter not found.' });
      }

      const chapter = course.chapters.find(ch => ch.uniqueCode === chapterCode);
      if (!chapter) {
        return res.status(404).render('error', { message: 'Chapter not found.' });
      }

      const classData = chapter.classes?.find(c => String(c._id) === String(classId));
      if (!classData) {
        return res.status(404).render('error', { message: 'Class not found.' });
      }

      res.render('admin/watch-class', {
        admins: true,
        currentPage: 'classes',
        classData,
        course,
        chapter,
        chapterCode
      });
    } catch (err) {
      logger.error('Admin Watch Class Error:', err.message);
      res.status(500).render('error', { message: 'Failed to load class.' });
    }
  }
);

// ===========================
// VIEW EXERCISES
// ===========================
router.get(
  '/chapters/exercises/:chapterId/:classId',
  verifyLogin,
  validateObjectIds(['classId']),
  async (req, res) => {
    try {

      const data =
        await courseHelpers.getClassExercises(
          req.params.chapterId,
          req.params.classId
        );

      if (!data) {
        return res.redirect('/chapters');
      }

      res.render(
        'admin/view-exercises',
        {
          admins: true,
          chapterId:
            req.params.chapterId,
          classId:
            req.params.classId,
          classData:
            data.classData,
          chapter:
            data.chapter
        }
      );

    } catch (err) {

      logger.info(
        'View Exercise Route Error:',
        err.message
      );

      res.redirect('/chapters');
    }
  }
);


// ===========================
// ADD EXERCISE PAGE
// ===========================
router.get(
  '/add-exercise/:chapterId/:classId',
  verifyLogin,
  validateObjectIds(['classId']),
  (req, res) => {

    res.render(
      'admin/add-exercise',
      {
        admins: true,
        chapterId:
          req.params.chapterId,
        classId:
          req.params.classId
      }
    );
  }
);


// ===========================
// ADD EXERCISE
// ===========================
router.post(
  '/add-exercise',
  verifyLogin,
  validateObjectIds(['classId']),
  uploadExercise.single('file'),
  async (req, res) => {
    try {

      if (!req.file) {
        return res.send('File required');
      }

      const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();

      let type = '';
      if (ext === 'pdf') type = 'pdf';
      else if (ext === 'xls' || ext === 'xlsx') type = 'excel';
      else if (ext === 'dwg') type = 'autocad';

      if (!type) {
        return res.status(400).send('Unsupported exercise file type');
      }

      // Upload exercise file to Firebase
      const destPath = `exercise-files/${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
      const fileUrl = await uploadToS3(
        req.file.buffer,
        destPath,
        req.file.mimetype
      );

      const result = await courseHelpers.addExercise(
        {
          chapterId: req.body.chapterId,
          classId: req.body.classId,
          title: req.body.title,
          type
        },
        fileUrl
      );

      if (!result) {
        return res.send('Failed to add exercise');
      }

      logAudit(req, {
        action: 'exercise.create',
        entityType: 'exercise',
        entityName: req.body.title,
        message: 'Exercise added',
        metadata: {
          chapterId: req.body.chapterId,
          classId: req.body.classId,
          type
        }
      });

      res.redirect(
        '/chapters/exercises/' +
        req.body.chapterId + '/' + req.body.classId
      );

    } catch (err) {
      logger.info('Add Exercise Error:', err.message);
      res.send('Failed to add exercise');
    }
  }
);
// ===========================
// DELETE EXERCISE
// ===========================
router.post(
  '/delete-exercise/:exerciseId/:chapterId/:classId',
  verifyLogin,
  validateObjectIds(['exerciseId', 'classId']),
  async (req, res) => {
    try {

      await courseHelpers.deleteExercise(
        req.params.exerciseId,
        req.params.chapterId,
        req.params.classId
      );

      logAudit(req, {
        action: 'exercise.delete',
        entityType: 'exercise',
        entityId: req.params.exerciseId,
        message: 'Exercise deleted',
        metadata: {
          chapterId: req.params.chapterId,
          classId: req.params.classId
        }
      });

      res.redirect(
        '/chapters/exercises/' +
        req.params.chapterId +
        '/' +
        req.params.classId
      );

    } catch (err) {

      logger.info(
        'Delete Exercise Error:',
        err.message
      );

      res.redirect(
        '/chapters/exercises/' +
        req.params.chapterId +
        '/' +
        req.params.classId
      );
    }
  }
);
// ===========================
// EDIT EXERCISE PAGE
// ===========================
router.get(
  '/edit-exercise/:exerciseId/:chapterId/:classId',
  verifyLogin,
  validateObjectIds(['exerciseId', 'classId']),
  async (req, res) => {
    try {

      const data =
        await courseHelpers.getExercise(
          req.params.exerciseId,
          req.params.chapterId,
          req.params.classId
        );

      if (!data || !data.exercise) {
        return res.redirect(
          '/chapters/exercises/' +
          req.params.chapterId +
          '/' +
          req.params.classId
        );
      }

      res.render(
        'admin/edit-exercise',
        {
          admins: true,
          exercise:
            data.exercise,

          chapterId:
            req.params.chapterId,

          classId:
            req.params.classId
        }
      );

    } catch (err) {

      logger.info(
        'Edit Exercise Page Error:',
        err.message
      );

      res.redirect('/chapters');
    }
  }
);
// ===========================
// EDIT EXERCISE
// ===========================
router.post(
  '/edit-exercise',
  verifyLogin,
  validateObjectIds(['exerciseId', 'classId']),
  uploadExercise.single('file'),
  async (req, res) => {
    try {

      // If a new file was uploaded, push it to Firebase
      let filePayload = null;
      if (req.file) {
        const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
        const destPath = `exercise-files/${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
        const newUrl = await uploadToS3(
          req.file.buffer,
          destPath,
          req.file.mimetype
        );
        filePayload = { newUrl, ext };
      }

      const updated = await courseHelpers.updateExercise(
        req.body,
        filePayload   // null = keep existing; { newUrl, ext } = replace
      );

      if (!updated) {
        return res.redirect(
          '/chapters/exercises/' +
          req.body.chapterId + '/' + req.body.classId
        );
      }

      logAudit(req, {
        action: 'exercise.update',
        entityType: 'exercise',
        entityId: req.body.exerciseId,
        entityName: req.body.title,
        message: 'Exercise updated',
        metadata: {
          chapterId: req.body.chapterId,
          classId: req.body.classId
        }
      });

      res.redirect(
        '/chapters/exercises/' +
        req.body.chapterId + '/' + req.body.classId
      );

    } catch (err) {
      logger.info('Edit Exercise Error:', err.message);
      res.redirect(
        '/chapters/exercises/' +
        req.body.chapterId + '/' + req.body.classId
      );
    }
  }
);

// ===========================
// GET COURSES
// ===========================
router.get(
  '/courses',
  verifyLogin,
  async (req, res) => {
    try {

      const courses =
        await courseHelpers.getCourses();

      res.render(
        'admin/courses',
        {
          admins: true,
          courses,
          currentPage: 'courses'
        }
      );

    } catch (err) {
      logger.info(
        err.message
      );

      res.redirect('/');
    }
  }
);


// ===========================
// GET ADD COURSE
// ===========================
router.get(
  '/add-courses',
  verifyLogin,
  (req, res) => {
    res.render(
      'admin/add-courses',
      { admins: true }
    );
  }
);


// ===========================
// POST ADD COURSE
// ===========================
router.post(
  '/add-courses',
  verifyLogin,
  uploadCourse.single('image'),
  async (req, res) => {
    try {

      const id = await courseHelpers.addCourse(req.body);

      // Upload course cover image to Firebase if provided
      if (req.file) {
        const ext = path.extname(req.file.originalname) || '.jpg';
        const destPath = `course-images/${id}${ext}`;
        const imageUrl = await uploadToS3(
          req.file.buffer,
          destPath,
          req.file.mimetype
        );
        await courseHelpers.updateCourseImage(id, imageUrl);
      }

      logAudit(req, {
        action: 'course.create',
        entityType: 'course',
        entityId: id,
        entityName: req.body.name,
        message: 'Course added'
      });

      res.json({ success: true });

    } catch (err) {
      logger.info(err.message);
      res.json({ success: false, message: 'Something went wrong' });
    }
  }
);




// ===========================
// GET EDIT COURSE
// ===========================
router.get(
  '/edit-course/:id',
  verifyLogin,
  validateObjectIds(['id']),
  async (req, res) => {
    try {

      const course =
        await courseHelpers.getCourseDetails(
          req.params.id
        );

      res.render(
        'admin/edit-course',
        {
          admins: true,
          course
        }
      );

    } catch (err) {
      logger.info(
        err.message
      );

      res.redirect('/courses');
    }
  }
);


// ===========================
// POST EDIT COURSE
// ===========================
router.post(
  '/edit-course/:id',
  verifyLogin,
  validateObjectIds(['id']),
  uploadCourse.single('image'),
  async (req, res) => {
    try {

      await courseHelpers.updateCourse(req.params.id, req.body);

      // Upload new course image to Firebase if provided
      if (req.file) {
        const ext = path.extname(req.file.originalname) || '.jpg';
        const destPath = `course-images/${req.params.id}_${Date.now()}${ext}`;
        const imageUrl = await uploadToS3(
          req.file.buffer,
          destPath,
          req.file.mimetype
        );
        await courseHelpers.updateCourseImage(req.params.id, imageUrl);
      }

      logAudit(req, {
        action: 'course.update',
        entityType: 'course',
        entityId: req.params.id,
        entityName: req.body.name,
        message: 'Course updated'
      });

      res.redirect('/courses');

    } catch (err) {
      logger.info(err.message);
      res.json({ success: false, message: err.message });
    }
  }
);
// ===========================
// DELETE COURSE
// ===========================
router.post(
  '/delete-course/:id',
  verifyLogin,
  validateObjectIds(['id']),
  async (req, res) => {
    try {

      await courseHelpers.deleteCourse(
        req.params.id
      );

      logAudit(req, {
        action: 'course.delete',
        entityType: 'course',
        entityId: req.params.id,
        message: 'Course deleted'
      });

      res.json({
        success: true
      });

    } catch (err) {
      logger.info(
        err.message
      );

      res.json({
        success: false,
        message:
          'Failed to delete course'
      });
    }
  }
);

router.get('/audit-logs', verifyLogin, verifySuperuser, async (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      action: req.query.action || '',
      entityType: req.query.entityType || '',
      status: req.query.status || '',
      limit: req.query.limit || 200
    };

    const logs = await auditHelper.getLogs(filters);

    res.render('admin/audit-logs', {
      admins: true,
      currentPage: 'audit-logs',
      logs,
      filters
    });
  } catch (err) {
    logger.info('Audit Logs Route Error:', err.message);
    res.redirect('/');
  }
});

router.post('/audit-logs/clear', verifyLogin, verifySuperuser, async (req, res) => {
  try {
    await auditHelper.clearLogs();

    logAudit(req, {
      action: 'audit.clear',
      entityType: 'audit',
      message: 'Audit logs cleared'
    });

    res.json({ status: true });
  } catch (err) {
    logger.info('Clear Audit Logs Error:', err.message);
    res.json({ status: false });
  }
});

router.get('/:id/students', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    let courseId = req.params.id;
    let data = await courseHelpers.getCourseStudents(courseId);

    res.render('admin/course-students', {
      admins: true,
      students: data.students,
      courseName: data.courseName,
      courseId
    });

  } catch (err) {
    logger.info(err);
    res.redirect('/courses');
  }
});
router.get('/:id/chapters', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {

    let data = await courseHelpers.getCourseChapters(req.params.id);

    res.render('admin/course-chapters', {
      admins: true,
      courseName: data.courseName,
      chapters: data.chapters,
      courseId: req.params.id
    });

  } catch (err) {
    logger.info(err);
    res.redirect('/courses');
  }
});
// SETTINGS PAGE
router.get('/settings', verifyLogin, verifySuperuser, async (req, res) => {
  try {

    let settings = await settingsHelper.getSettings();

    res.render('admin/settings', {
      admins: true,
      currentPage: 'settings',
      settings
    });

  } catch (err) {
    logger.info(err);
    res.redirect('/');
  }
});


// UPDATE ACADEMY PROFILE
router.post('/update-settings', verifyLogin, verifySuperuser, async (req, res) => {
  try {

    await settingsHelper.updateAcademyProfile(req.body);

    logAudit(req, {
      action: 'settings.profile.update',
      entityType: 'settings',
      entityName: req.body.academyName,
      message: 'Academy profile updated'
    });

    res.json({
      status: true
    });

  } catch (err) {
    logger.info(err);

    res.json({
      status: false
    });
  }
});


// UPDATE THEME
router.post('/update-theme', verifyLogin, verifySuperuser, async (req, res) => {
  try {

    await settingsHelper.updateTheme(req.body.theme);

    logAudit(req, {
      action: 'settings.theme.update',
      entityType: 'settings',
      entityName: req.body.theme,
      message: 'Theme updated'
    });

    res.json({
      status: true
    });

  } catch (err) {
    logger.info(err);

    res.json({
      status: false
    });
  }
});
// EXPORT STUDENTS CSV
router.get('/export-students', verifyLogin, verifySuperuser, async (req, res) => {
  const file = await settingsHelper.exportStudentsCSV();
  logAudit(req, {
    action: 'backup.students.export',
    entityType: 'backup',
    message: 'Students CSV exported'
  });
  res.download(file, (err) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
});


// EXPORT COURSES JSON
router.get('/export-courses', verifyLogin, verifySuperuser, async (req, res) => {
  const file = await settingsHelper.exportCoursesJSON();
  logAudit(req, {
    action: 'backup.courses.export',
    entityType: 'backup',
    message: 'Courses JSON exported'
  });
  res.download(file, (err) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
});


// FULL BACKUP
router.get('/full-backup', verifyLogin, verifySuperuser, async (req, res) => {
  const file = await settingsHelper.fullBackup();
  logAudit(req, {
    action: 'backup.full.export',
    entityType: 'backup',
    message: 'Full backup exported'
  });
  res.download(file, (err) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
});


// RESTORE — with validation
router.post(
  '/restore-backup',
  verifyLogin,
  verifySuperuser,
  upload.single('backup'),
  async (req, res) => {
    const cleanupBackupUpload = () => {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    };

    try {
      if (!req.file) {
        return res.json({ status: false, message: 'No file uploaded.' });
      }

      // ── Security: only allow .json files ──
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext !== '.json') {
        cleanupBackupUpload();
        return res.json({ status: false, message: 'Only .json backup files are accepted.' });
      }

      // ── Security: cap file size at 50 MB ──
      if (req.file.size > 50 * 1024 * 1024) {
        cleanupBackupUpload();
        return res.json({ status: false, message: 'Backup file too large (max 50 MB).' });
      }

      const raw = fs.readFileSync(req.file.path, 'utf8');
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        cleanupBackupUpload();
        return res.json({ status: false, message: 'Invalid JSON backup file.' });
      }

      // ── Validate expected shape ──
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        cleanupBackupUpload();
        return res.json({ status: false, message: 'Invalid backup structure.' });
      }

      const validKeys = new Set(['students', 'courses', 'settings', 'auditLogs']);
      const hasValidKey = Object.keys(data).some(k => validKeys.has(k));
      if (!hasValidKey) {
        cleanupBackupUpload();
        return res.json({ status: false, message: 'Unrecognised backup format.' });
      }

      // ── Restore collections ──
      const restoreTargets = [
        ['students', collection.STUDENTS_COLLECTION],
        ['courses', collection.COURSE_COLLECTION],
        ['settings', collection.SETTINGS_COLLECTION],
        ['auditLogs', collection.AUDIT_LOG_COLLECTION]
      ].filter(([key]) => Object.hasOwn(data, key));

      if (restoreTargets.some(([key]) => !Array.isArray(data[key]))) {
        cleanupBackupUpload();
        return res.json({ status: false, message: 'Backup collections must be arrays.' });
      }

      const snapshots = new Map();
      try {
        for (const [key, collectionName] of restoreTargets) {
          const target = db.get().collection(collectionName);
          snapshots.set(collectionName, await target.find({}).toArray());
          const documents = reviveBackupValue(data[key]);
          await target.deleteMany({});
          if (documents.length) await target.insertMany(documents);
        }
      } catch (restoreError) {
        for (const [, collectionName] of restoreTargets) {
          const target = db.get().collection(collectionName);
          await target.deleteMany({});
          const snapshot = snapshots.get(collectionName) || [];
          if (snapshot.length) await target.insertMany(snapshot);
        }
        throw restoreError;
      }

      cleanupBackupUpload();

      logAudit(req, {
        action: 'backup.restore',
        entityType: 'backup',
        message: 'Backup restored',
        metadata: {
          students: Array.isArray(data.students) ? data.students.length : 0,
          courses: Array.isArray(data.courses) ? data.courses.length : 0,
          settings: Array.isArray(data.settings) ? data.settings.length : 0,
          auditLogs: Array.isArray(data.auditLogs) ? data.auditLogs.length : 0
        }
      });

      res.json({ status: true });

    } catch (err) {
      logger.info('Restore Backup Error:', err.message);
      cleanupBackupUpload();
      res.json({ status: false, message: 'Restore failed.' });
    }
  }
);
// ===========================
// ADMINS LIST  (superuser only)
// ===========================
router.get('/admins', verifyLogin, verifySuperuser, async (req, res) => {
  try {
    const admins = await adminHelpers.getAllAdmins();
    const admin = req.session.admin;
    res.render('admin/admins', {
      admins: true,
      isSuperuser: true,
      adminData: admin,
      adminList: admins,
      currentPage: 'admins'
    });
  } catch (err) {
    logger.info('Admins List Error:', err.message);
    res.redirect('/');
  }
});

// ===========================
// DELETE ADMIN  (superuser only)
// ===========================
router.post('/admin/delete/:id', verifyLogin, verifySuperuser, validateObjectIds(['id']), async (req, res) => {
  try {
    const result = await adminHelpers.deleteAdmin(req.params.id);
    logAudit(req, {
      action: 'admin.delete',
      entityType: 'admin',
      entityId: req.params.id,
      message: 'Admin deleted by superuser'
    });
    res.json(result);
  } catch (err) {
    logger.info('Delete Admin Error:', err.message);
    res.json({ status: false, message: err.message });
  }
});

// ===========================
// ADD ADMIN PAGE  (superuser only — hidden URL)
// ===========================
router.get('/superuser/add-admin', verifySuperuser, (req, res) => {
  res.render('admin/add-admin', {
    admins: true,
    isSuperuser: true,
    adminData: req.session.admin,
    addErr: req.session.addAdminErr || null,
    addSuccess: req.session.addAdminSuccess || null
  });
  req.session.addAdminErr = null;
  req.session.addAdminSuccess = null;
});

// ===========================
// ADD ADMIN POST  (superuser only)
// ===========================
router.post('/superuser/add-admin', verifySuperuser, async (req, res) => {
  try {
    const existing = await adminHelpers.getAdminByEmail(req.body.Email);
    if (existing) {
      req.session.addAdminErr = 'An admin with this email already exists.';
      return res.redirect('/superuser/add-admin');
    }
    const newAdmin = await adminHelpers.doSignupAdmin(req.body);
    logAudit(req, {
      action: 'admin.create',
      entityType: 'admin',
      entityId: newAdmin._id,
      entityName: newAdmin.Email,
      message: 'New admin created by superuser'
    });
    req.session.addAdminSuccess = `Admin "${newAdmin.Name}" created successfully.`;
    res.redirect('/superuser/add-admin');
  } catch (err) {
    logger.info('Add Admin Error:', err.message);
    req.session.addAdminErr = 'Failed to create admin: ' + err.message;
    res.redirect('/superuser/add-admin');
  }
});

router.get('/login', (req, res, next) => {
  if (req.session.adminloggedIn) {
    return res.redirect('/');
  }
  res.render('admin/login', buildLoginViewModel(req));
  clearLoginMessages(req);
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body.Email || '').trim().toLowerCase();
    const password = String(req.body.Password || '');

    if (!email || !password) {
      req.session.loginErr = 'Email and password are required.';
      return res.redirect('/login');
    }

    // ── Try Admin login first ──
    const admin = await adminHelpers.getAdminByEmail(email);
    const validPassword = await adminHelpers.verifyAdminPassword(admin, password);

    if (admin && validPassword) {
      // ── Existing admin OTP flow ──
      const otp = generateOtp();

      await mailHelpers.sendAdminOtpEmail(admin.Email, otp);

      req.session.adminOtpLogin = {
        adminId: String(admin._id),
        email: admin.Email,
        otpHash: hashOtp(otp),
        expiresAt: Date.now() + OTP_EXPIRY_MS
      };

      clearLoginMessages(req);
      req.session.otpInfo = 'We sent a 6-digit OTP to your email address.';
      logAudit(req, {
        action: 'admin.login.otp_sent',
        entityType: 'admin',
        entityId: admin._id,
        entityName: admin.Email,
        message: 'Admin login OTP sent'
      });
      return res.redirect('/login');
    }

    // ── Try Teacher login (email + password, no OTP) ──
    const teacher = await teacherHelpers.getTeacherByEmail(email);
    const validTeacherPassword = await teacherHelpers.verifyTeacherPassword(teacher, password);

    if (teacher && validTeacherPassword) {
      if (teacher.status === 'disabled') {
        req.session.loginErr = 'Your account has been disabled. Please contact the administrator.';
        return res.redirect('/login');
      }

      req.session.teacherloggedIn = true;
      req.session.teacher = teacher;
      clearLoginMessages(req);
      logAudit(req, {
        action: 'teacher.login.success',
        entityType: 'teacher',
        entityId: teacher._id,
        entityName: teacher.email,
        message: 'Teacher logged in'
      });
      return res.redirect('/teacher/dashboard');
    }

    // ── Both failed ──
    clearPendingAdminOtp(req);
    req.session.loginErr = 'Invalid email or password.';
    logAudit(req, {
      action: 'login.failed',
      entityType: 'auth',
      entityName: email,
      status: 'failed',
      message: 'Invalid login attempt'
    });
    return res.redirect('/login');

  } catch (error) {
    logger.error('Login error:', error);
    clearPendingAdminOtp(req);
    req.session.loginErr = error.message || 'Login failed.';
    res.redirect('/login');
  }
});

router.post('/login/verify-otp', otpLimiter, async (req, res) => {
  try {
    const otpSession = req.session.adminOtpLogin;
    const otp = String(req.body.otp || '').trim();

    if (!otpSession) {
      req.session.otpErr = 'Your OTP session has expired. Please sign in again.';
      return res.redirect('/login');
    }

    if (Date.now() > otpSession.expiresAt) {
      clearPendingAdminOtp(req);
      req.session.otpErr = 'OTP expired. Please sign in again.';
      return res.redirect('/login');
    }

    // ── OTP brute-force protection: max 5 wrong attempts ──
    if (!otpSession.attempts) otpSession.attempts = 0;
    if (!isMatchingOtp(otp, otpSession.otpHash)) {
      otpSession.attempts += 1;
      if (otpSession.attempts >= 5) {
        clearPendingAdminOtp(req);
        req.session.loginErr = 'Too many incorrect OTP attempts. Please sign in again.';
        logAudit(req, {
          action: 'admin.login.otp_lockout',
          entityType: 'admin',
          entityName: otpSession.email,
          status: 'failed',
          message: 'OTP locked out after 5 failed attempts'
        });
        return res.redirect('/login');
      }
      req.session.otpErr = `Invalid OTP. ${5 - otpSession.attempts} attempt(s) remaining.`;
      return res.redirect('/login');
    }

    const admin = await adminHelpers.getAdminById(otpSession.adminId);

    if (!admin) {
      clearPendingAdminOtp(req);
      req.session.loginErr = 'Admin account not found.';
      return res.redirect('/login');
    }

    req.session.adminloggedIn = true;
    req.session.admin = admin;
    clearPendingAdminOtp(req);
    clearLoginMessages(req);
    logAudit(req, {
      action: 'admin.login.success',
      entityType: 'admin',
      entityId: admin._id,
      entityName: admin.Email,
      message: 'Admin logged in'
    });
    res.redirect('/');
  } catch (error) {
    logger.error('OTP verification error:', error);
    req.session.otpErr = 'Unable to verify OTP.';
    res.redirect('/login');
  }
});

router.post('/login/resend-otp', resendOtpLimiter, async (req, res) => {
  try {
    const otpSession = req.session.adminOtpLogin;

    if (!otpSession) {
      req.session.loginErr = 'Your OTP session has expired. Please sign in again.';
      return res.redirect('/login');
    }

    const admin = await adminHelpers.getAdminById(otpSession.adminId);

    if (!admin) {
      clearPendingAdminOtp(req);
      req.session.loginErr = 'Admin account not found.';
      return res.redirect('/login');
    }

    const otp = generateOtp();
    await mailHelpers.sendAdminOtpEmail(admin.Email, otp);

    req.session.adminOtpLogin = {
      adminId: String(admin._id),
      email: admin.Email,
      otpHash: hashOtp(otp),
      expiresAt: Date.now() + OTP_EXPIRY_MS
    };

    clearLoginMessages(req);
    req.session.otpInfo = 'A new OTP has been sent to your email address.';
    res.redirect('/login');
  } catch (error) {
    logger.error('OTP resend error:', error);
    req.session.otpErr = error.message || 'Unable to resend OTP.';
    res.redirect('/login');
  }
});
router.get('/logout', (req, res) => {
  logAudit(req, {
    action: 'admin.logout',
    entityType: 'admin',
    message: 'Admin logged out'
  });
  // Fully destroy the session to clear all flags (including adminloggedIn)
  req.session.destroy((err) => {
    if (err) {
      logger.info('Session destroy error:', err.message);
    }
    res.clearCookie('zeitnah.sid');
    res.redirect('/login');
  });
});

// ═══════════════════════════════════════════════════════
// ADMIN: TEACHERS MODULE
// ═══════════════════════════════════════════════════════

// LIST TEACHERS
router.get('/teachers', verifyLogin, async (req, res) => {
  try {
    const teachers = await teacherHelpers.getAllTeachers();
    res.render('admin/teachers', {
      admins: true,
      currentPage: 'teachers',
      teachers
    });
  } catch (err) {
    logger.info('Teachers List Error:', err.message);
    res.redirect('/');
  }
});

// ADD TEACHER — FORM
router.get('/teachers/add', verifyLogin, async (req, res) => {
  const courses = await courseHelpers.getCourses();
  res.render('admin/add-teacher', {
    admins: true,
    currentPage: 'teachers',
    courses
  });
});

// ADD TEACHER — POST
router.post('/teachers/add', verifyLogin, uploadTeacher.single('profileImage'), async (req, res) => {
  try {
    const existing = await teacherHelpers.getTeacherByEmail(req.body.email);
    if (existing) {
      return res.json({ success: false, message: 'A teacher with this email already exists.' });
    }

    const data = { ...req.body };

    const teacher = await teacherHelpers.createTeacher(data);

    // Upload teacher profile image to Firebase if provided
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      const destPath = `teacher-images/${teacher._id}${ext}`;
      const imageUrl = await uploadToS3(
        req.file.buffer,
        destPath,
        req.file.mimetype
      );
      await teacherHelpers.updateTeacherImage(teacher._id, imageUrl);
    }

    logAudit(req, {
      action: 'teacher.create',
      entityType: 'teacher',
      entityId: teacher._id,
      entityName: teacher.email,
      message: 'Teacher created'
    });

    res.json({ success: true });
  } catch (err) {
    logger.info('Add Teacher Error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

// EDIT TEACHER — FORM
router.get('/teachers/:id/edit', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const [teacher, courses] = await Promise.all([
      teacherHelpers.getTeacherById(req.params.id),
      courseHelpers.getCourses()
    ]);
    if (!teacher) return res.redirect('/teachers');

    res.render('admin/edit-teacher', {
      admins: true,
      currentPage: 'teachers',
      teacher,
      courses
    });
  } catch (err) {
    logger.info('Edit Teacher Form Error:', err.message);
    res.redirect('/teachers');
  }
});

// EDIT TEACHER — POST
router.post('/teachers/:id/edit', verifyLogin, validateObjectIds(['id']), uploadTeacher.single('profileImage'), async (req, res) => {
  try {
    await teacherHelpers.updateTeacher(req.params.id, req.body);

    // Upload new teacher image to Firebase if provided
    if (req.file) {
      const ext = path.extname(req.file.originalname) || '.jpg';
      const destPath = `teacher-images/${req.params.id}_${Date.now()}${ext}`;
      const imageUrl = await uploadToS3(
        req.file.buffer,
        destPath,
        req.file.mimetype
      );
      await teacherHelpers.updateTeacherImage(req.params.id, imageUrl);
    }

    logAudit(req, {
      action: 'teacher.update',
      entityType: 'teacher',
      entityId: req.params.id,
      entityName: req.body.email,
      message: 'Teacher updated'
    });

    res.json({ success: true });
  } catch (err) {
    logger.info('Update Teacher Error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

// DELETE TEACHER
router.post('/teachers/:id/delete', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const result = await teacherHelpers.deleteTeacher(req.params.id);

    logAudit(req, {
      action: 'teacher.delete',
      entityType: 'teacher',
      entityId: req.params.id,
      message: 'Teacher deleted'
    });

    res.json(result);
  } catch (err) {
    logger.info('Delete Teacher Error:', err.message);
    res.json({ status: false, message: err.message });
  }
});

// DISABLE TEACHER
router.post('/teachers/:id/disable', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    await teacherHelpers.setTeacherStatus(req.params.id, 'disabled');
    logAudit(req, { action: 'teacher.disable', entityType: 'teacher', entityId: req.params.id, message: 'Teacher disabled' });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ENABLE TEACHER
router.post('/teachers/:id/enable', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    await teacherHelpers.setTeacherStatus(req.params.id, 'active');
    logAudit(req, { action: 'teacher.enable', entityType: 'teacher', entityId: req.params.id, message: 'Teacher enabled' });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ASSIGN COURSES — FORM
router.get('/teachers/:id/assign-courses', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const [teacher, courses] = await Promise.all([
      teacherHelpers.getTeacherById(req.params.id),
      courseHelpers.getCourses()
    ]);
    if (!teacher) return res.redirect('/teachers');

    res.render('admin/assign-courses', {
      admins: true,
      currentPage: 'teachers',
      teacher,
      courses
    });
  } catch (err) {
    logger.info('Assign Courses Form Error:', err.message);
    res.redirect('/teachers');
  }
});

// ASSIGN COURSES — POST
router.post('/teachers/:id/assign-courses', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    let courseIds = req.body.courseIds;
    if (!courseIds) courseIds = [];
    if (!Array.isArray(courseIds)) courseIds = [courseIds];

    await teacherHelpers.assignCourses(req.params.id, courseIds);

    logAudit(req, {
      action: 'teacher.assign_courses',
      entityType: 'teacher',
      entityId: req.params.id,
      message: `Assigned ${courseIds.length} course(s) to teacher`
    });

    res.json({ success: true });
  } catch (err) {
    logger.info('Assign Courses Error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

// VIEW TEACHER'S STUDENTS
router.get('/teachers/:id/students', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    const teacher = await teacherHelpers.getTeacherById(req.params.id);
    if (!teacher) return res.redirect('/teachers');

    const students = await teacherHelpers.getTeacherStudents(req.params.id);

    res.render('admin/teacher-students', {
      admins: true,
      currentPage: 'teachers',
      teacher,
      students
    });
  } catch (err) {
    logger.info('Teacher Students Error:', err.message);
    res.redirect('/teachers');
  }
});

// ==========================================
// MEDIA LIBRARY (COVER IMAGES)
// ==========================================

router.get('/cover-images', verifyLogin, async (req, res) => {
  try {
    const images = await mediaHelper.getCoverImages(req.query);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, images });
    }

    res.render('admin/cover-images', {
      admins: true,
      currentPage: 'cover-images', // Used for active sidebar link
      images,
      query: req.query
    });
  } catch (err) {
    logger.error('Cover Images Error:', err.message);
    res.redirect('/admin');
  }
});

router.post('/cover-images', verifyLogin, uploadCover.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Image is required' });

    // Upload to Firebase
    const ext = require('path').extname(req.file.originalname) || '.jpg';
    const destPath = `cover-images/cover_${Date.now()}${ext}`;
    const imageUrl = await uploadToS3(req.file.buffer, destPath, req.file.mimetype);

    // Save to DB
    await mediaHelper.addCoverImage(req.body, imageUrl, req.session.admin._id);

    res.json({ success: true });
  } catch (err) {
    logger.error('Upload Cover Image Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/cover-images/:id/edit', verifyLogin, validateObjectIds(['id']), uploadCover.none(), async (req, res) => {
  try {
    await mediaHelper.updateCoverImage(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    logger.error('Update Cover Image Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/cover-images/:id', verifyLogin, validateObjectIds(['id']), async (req, res) => {
  try {
    await mediaHelper.deleteCoverImage(req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Delete Cover Image Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/courses/update-order', verifyLogin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (Array.isArray(ids)) {
      for (let i = 0; i < ids.length; i++) {
        if (ObjectId.isValid(ids[i])) {
          await db.get().collection(collection.COURSE_COLLECTION).updateOne(
            { _id: new ObjectId(ids[i]) },
            { $set: { order: i + 1 } }
          );
        }
      }
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, message: 'Invalid data' });
  } catch (err) {
    logger.error('Update courses order error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/courses/:courseId/chapters/update-order', verifyLogin, validateObjectIds(['courseId']), async (req, res) => {
  try {
    const { uniqueCodes } = req.body;
    if (Array.isArray(uniqueCodes)) {
      await courseHelpers.updateChaptersOrder(req.params.courseId, uniqueCodes);
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, message: 'Invalid data' });
  } catch (err) {
    logger.error('Update chapters order error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/chapters/:chapterId/classes/update-order', verifyLogin, async (req, res) => {
  try {
    const { classIds } = req.body;
    if (Array.isArray(classIds)) {
      await classHelper.updateClassesOrder(req.params.chapterId, classIds);
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, message: 'Invalid data' });
  } catch (err) {
    logger.error('Update classes order error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
