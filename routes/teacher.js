const logger = require('../Helpers/logger');
var express = require('express');
var router = express.Router();
const teacherHelper = require('../Helpers/teacher-helper');
const assignmentHelper = require('../Helpers/assignment-helper');
const courseHelper = require('../Helpers/course-helper');
const classHelper = require('../Helpers/class-helper');
const studentHelper = require('../Helpers/student-helper');
const { ObjectId } = require('mongodb');
const db = require('../config/connection');
const collection = require('../config/collections');
const { uploadTeacher, uploadStudent, uploadClass, uploadExercise } = require('../config/multer');
const multer = require('multer');
const path = require('path');
const parseForm = multer().none();
const { uploadToS3 } = require('../config/s3-storage');
const mediaHelper = require('../Helpers/media-helper');
const ffprobeStatic = require('ffprobe-static');
const { getVideoDurationInSeconds } = require('get-video-duration');
const { decorateClass, decorateCourse, decorateProfileImage } = require('../Helpers/image-url-helper');

// ═══════════════════════════════════════════════════
// GUARDS
// ═══════════════════════════════════════════════════

const verifyTeacherLogin = (req, res, next) => {
  if (req.session.teacherloggedIn && req.session.teacher) {
    return next();
  }
  if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  res.redirect('/login');
};

const checkTeacherCourseOwnership = async (req, res, next) => {
  const courseId = req.params.courseId || req.params.id;
  const teacherId = req.session.teacher._id;
  const owns = await teacherHelper.teacherOwnsCourse(teacherId, courseId);
  if (!owns) {
    return res.status(403).render('error', { message: 'Access Denied — This course is not assigned to you.' });
  }
  next();
};

const checkTeacherStudentAccess = async (req, res, next) => {
  const studentId = req.params.id || req.params.studentId;
  const teacherId = req.session.teacher._id;
  const owns = await teacherHelper.teacherOwnsStudent(teacherId, studentId);
  if (!owns) {
    return res.status(403).render('error', { message: 'Access Denied — This student is not in your courses.' });
  }
  next();
};

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

// ═══════════════════════════════════════════════════
// INJECT TEACHER INTO ALL TEMPLATES
// ═══════════════════════════════════════════════════
router.use(async (req, res, next) => {
  try {
    if (req.session.teacher) {
      await decorateProfileImage(req.session.teacher, 'profileImage');
    }
  } catch (err) {
    logger.warn('Teacher session image signing warning:', err.message);
  }
  res.locals.sessionTeacher = req.session.teacher || null;
  res.locals.teacherPanel = true;
  next();
});

// ═══════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════
router.get('/dashboard', verifyTeacherLogin, async (req, res) => {
  try {
    const teacher = req.session.teacher;
    const data = await teacherHelper.getTeacherDashboardData(teacher._id);
    const courses = await teacherHelper.getTeacherCourses(teacher._id);

    res.render('teacher/dashboard', {
      teacherPanel: true,
      currentPage: 'dashboard',
      teacher,
      dashboard: data,
      courses: courses.slice(0, 4)
    });
  } catch (err) {
    logger.error('Teacher Dashboard Error:', err.message);
    res.redirect('/login');
  }
});



// ═══════════════════════════════════════════════════
// MY COURSES
// ═══════════════════════════════════════════════════
router.get('/courses', verifyTeacherLogin, async (req, res) => {
  try {
    const teacher = req.session.teacher;
    const courses = await teacherHelper.getTeacherCourses(teacher._id);

    res.render('teacher/my-courses', {
      teacherPanel: true,
      currentPage: 'courses',
      teacher,
      courses
    });
  } catch (err) {
    logger.error('Teacher Courses Error:', err.message);
    res.redirect('/teacher/dashboard');
  }
});

// ═══════════════════════════════════════════════════
// COURSE DETAIL / CHAPTERS
// ═══════════════════════════════════════════════════
router.get('/courses/:id', verifyTeacherLogin, validateObjectIds(['id']), checkTeacherCourseOwnership, async (req, res) => {
  try {
    const teacher = req.session.teacher;
    const course = await courseHelper.getCourseById(req.params.id);
    if (!course) return res.redirect('/teacher/courses');

    const chapters = (course.chapters || []).sort((a, b) => a.order - b.order);

    res.render('teacher/course-detail', {
      teacherPanel: true,
      currentPage: 'courses',
      teacher,
      course,
      chapters
    });
  } catch (err) {
    logger.error('Teacher Course Detail Error:', err.message);
    res.redirect('/teacher/courses');
  }
});

router.get('/chapters/classes/:uniqueCode', verifyTeacherLogin, async (req, res) => {
  try {
    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ 'chapters.uniqueCode': req.params.uniqueCode });

    if (!course) {
      return res.redirect('/teacher/courses');
    }

    const owns = await teacherHelper.teacherOwnsCourse(
      req.session.teacher._id,
      course._id
    );
    if (!owns) {
      return res.status(403).render('error', {
        message: 'Access Denied - This course is not assigned to you.'
      });
    }

    const chapter = await classHelper.getChapterClasses(req.params.uniqueCode);
    const courseType = course?.type || 'recording';

    res.render('teacher/classes', {
      teacherPanel: true,
      currentPage: 'courses',
      teacher: req.session.teacher,
      course,
      chapter,
      courseType
    });
  } catch (err) {
    logger.error('Teacher Classes Error:', err.message);
    res.redirect('/teacher/courses');
  }
});

// ═══════════════════════════════════════════════════
// EDIT CLASS (teacher)
// ═══════════════════════════════════════════════════
router.get('/chapters/edit-class/:chapterCode/:classId', verifyTeacherLogin, async (req, res) => {
  try {
    const { chapterCode, classId } = req.params;
    
    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ 'chapters.uniqueCode': chapterCode });

    if (!course) {
      return res.redirect('/teacher/courses');
    }

    const owns = await teacherHelper.teacherOwnsCourse(req.session.teacher._id, course._id);
    if (!owns) {
      return res.status(403).render('error', { message: 'Access Denied - This course is not assigned to you.' });
    }

    const classData = await classHelper.getClass(chapterCode, classId);
    if (!classData) {
      return res.redirect(`/teacher/chapters/classes/${chapterCode}`);
    }

    const courseType = course?.type || 'recording';

    res.render('teacher/edit-class', {
      teachers: true,
      teacher: req.session.teacher,
      chapterCode,
      classData,
      courseType
    });
  } catch (err) {
    logger.error('Teacher Edit Class Page Error:', err.message);
    res.redirect('/teacher/courses');
  }
});

router.post('/chapters/edit-class/:chapterCode/:classId', verifyTeacherLogin, uploadClass.fields([{ name: 'video', maxCount: 1 }]), async (req, res) => {
  try {
    const { chapterCode, classId } = req.params;
    
    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ 'chapters.uniqueCode': chapterCode });

    if (!course) {
      return res.redirect('/teacher/courses');
    }

    const owns = await teacherHelper.teacherOwnsCourse(req.session.teacher._id, course._id);
    if (!owns) {
      return res.status(403).send('Access Denied');
    }

    const data = req.body;
    const files = req.files;

    let newThumbnailUrl = req.body.coverImageUrl || null;
    if (newThumbnailUrl) {
        data.thumbnailUrl = newThumbnailUrl;
    }

    await classHelper.updateClass(chapterCode, classId, data, files);

    logAudit(req, {
      action: 'teacher.class.update',
      entityType: 'class',
      entityId: classId,
      entityName: data.title,
      message: 'Class updated by teacher'
    });

    res.redirect(`/teacher/chapters/classes/${chapterCode}`);
  } catch (err) {
    logger.error('Teacher Edit Class Error:', err.message);
    res.redirect(`/teacher/chapters/classes/${req.params.chapterCode}`);
  }
});

// ═══════════════════════════════════════════════════
// ADD CLASS (teacher)
// ═══════════════════════════════════════════════════
router.get('/chapters/add-class/:chapterCode', verifyTeacherLogin, async (req, res) => {
  try {
    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ 'chapters.uniqueCode': req.params.chapterCode });

    if (!course) {
      return res.redirect('/teacher/courses');
    }

    const owns = await teacherHelper.teacherOwnsCourse(req.session.teacher._id, course._id);
    if (!owns) {
      return res.status(403).render('error', { message: 'Access Denied - This course is not assigned to you.' });
    }

    const courseType = course?.type || 'recording';

    res.render('teacher/add-class', {
      teacherPanel: true,
      teacher: req.session.teacher,
      chapterCode: req.params.chapterCode,
      courseName: course.name,
      courseType
    });
  } catch (err) {
    logger.error('Teacher Add Class View Error:', err.message);
    res.redirect('/teacher/courses');
  }
});

router.post(
  '/add-class',
  verifyTeacherLogin,
  uploadClass.fields([
    { name: 'video', maxCount: 1 }
  ]),
  async (req, res) => {
    const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';

    try {
      const course = await db.get()
        .collection(collection.COURSE_COLLECTION)
        .findOne({ 'chapters.uniqueCode': req.body.chapterId });

      if (course) {
        const owns = await teacherHelper.teacherOwnsCourse(req.session.teacher._id, course._id);
        if (!owns) {
          return isAjax
            ? res.status(403).json({ success: false, error: 'Access Denied' })
            : res.status(403).send('Access Denied');
        }
      }

      if (!req.body.coverImageUrl) {
        const msg = 'Class cover image is required. Please select one from the Media Library.';
        return isAjax
          ? res.status(400).json({ success: false, error: msg })
          : res.status(400).send(msg);
      }

      let thumbnailUrl = req.body.coverImageUrl;

      let detectedDuration = 0;
      try {
        if (req.files && req.files.video && req.files.video[0]) {
          const videoFile = req.files.video[0];
          logger.info(`Teacher Upload: Extracting duration for ${videoFile.originalname}`);

          const rawSeconds = await getVideoDurationInSeconds(videoFile.path, ffprobeStatic.path);
          detectedDuration = Math.floor(rawSeconds);

          logger.info(`Successfully extracted duration: ${detectedDuration} seconds`);
        }
      } catch (durationErr) {
        logger.error('Video duration extraction failed:', durationErr.message);
      }

      const courseType = course?.type || 'recording';

      const bodyWithThumb = { ...req.body, thumbnailUrl, duration: detectedDuration, courseType };
      const result = await classHelper.addClass(bodyWithThumb, req.files);

      if (!result.success) {
        return isAjax
          ? res.status(400).json({ success: false, error: result.error })
          : res.status(400).send(result.error);
      }

      const redirectUrl = '/teacher/chapters/classes/' + req.body.chapterId;

      return isAjax
        ? res.json({ success: true, redirect: redirectUrl })
        : res.redirect(redirectUrl);

    } catch (err) {
      logger.error('Teacher Add Class Route Error:', err.message);
      return isAjax
        ? res.status(500).json({ success: false, error: 'Failed to add class' })
        : res.status(500).send('Failed to add class');
    }
  }
);

// ═══════════════════════════════════════════════════
// ADD CHAPTER (teacher)
// ═══════════════════════════════════════════════════
router.post('/courses/:id/add-chapter', verifyTeacherLogin, validateObjectIds(['id']), checkTeacherCourseOwnership, parseForm, async (req, res) => {
  try {
    const courseId = req.params.id;
    const uniqueCode = Date.now() + courseId;

    await courseHelper.addChapter(
      { ...req.body, package: courseId },
      req.body.coverImageUrl || 'default-chapter.jpg',
      uniqueCode
    );

    res.redirect('/teacher/courses/' + courseId);
  } catch (err) {
    logger.error('Teacher Add Chapter Error:', err.message);
    res.redirect('/teacher/courses/' + req.params.id);
  }
});

// ═══════════════════════════════════════════════════
// EDIT CHAPTER (teacher)
// ═══════════════════════════════════════════════════
router.post('/courses/:courseId/chapters/:uniqueCode/edit', verifyTeacherLogin, validateObjectIds(['courseId']), checkTeacherCourseOwnership, parseForm, async (req, res) => {
  try {
    await courseHelper.updateChapterUltraSafe(
      req.params.courseId,
      req.params.uniqueCode,
      { ...req.body, package: req.params.courseId },
      req.body.coverImageUrl || null
    );
    res.redirect('/teacher/courses/' + req.params.courseId);
  } catch (err) {
    logger.error('Teacher Edit Chapter Error:', err.message);
    res.redirect('/teacher/courses/' + req.params.courseId);
  }
});

// ═══════════════════════════════════════════════════
// STUDENTS — LIST
// ═══════════════════════════════════════════════════
router.get('/tstudents', verifyTeacherLogin, async (req, res) => {
  try {
    const teacher = req.session.teacher;
    let students = await teacherHelper.getTeacherStudents(teacher._id);

    // Filters
    const { search, filter, course: filterCourse } = req.query;

    if (search) {
      const s = search.toLowerCase();
      students = students.filter(st =>
        (st.Name || st.name || '').toLowerCase().includes(s) ||
        (st.email || '').toLowerCase().includes(s) ||
        (st.Phone_Number || '').toString().includes(s)
      );
    }

    if (filter === 'active') {
      students = students.filter(st => st.isActive && !st.isBlocked);
    } else if (filter === 'blocked') {
      students = students.filter(st => st.isBlocked);
    } else if (filter === 'expired') {
      students = students.filter(st => !st.isActive && !st.isBlocked);
    }

    if (filterCourse) {
      students = students.filter(st =>
        (st.course || []).some(c => c.courseId === filterCourse)
      );
    }

    const courses = await teacherHelper.getTeacherCourses(teacher._id);

    res.render('teacher/students', {
      teacherPanel: true,
      currentPage: 'students',
      teacher,
      students,
      courses,
      query: req.query
    });
  } catch (err) {
    logger.error('Teacher Students Error:', err.stack);
    res.status(500).render('error', { message: 'An unexpected error occurred while loading students.' });
  }
});

// ═══════════════════════════════════════════════════
// ADD STUDENT — FORM (DISABLED)
// ═══════════════════════════════════════════════════
router.get('/tstudents/add', verifyTeacherLogin, (req, res) => {
  res.redirect('/teacher/tstudents');
});

// ═══════════════════════════════════════════════════
// ADD STUDENT — POST (DISABLED)
// ═══════════════════════════════════════════════════
router.post('/tstudents/add', verifyTeacherLogin, (req, res) => {
  res.status(403).json({ success: false, message: 'Access Denied: Teachers cannot add students.' });
});

// ═══════════════════════════════════════════════════
// BLOCK STUDENT
// ═══════════════════════════════════════════════════
router.post('/tstudents/:id/block', verifyTeacherLogin, validateObjectIds(['id']), checkTeacherStudentAccess, async (req, res) => {
  try {
    await studentHelper.changeStudentStatus(req.params.id, false); // false = block
    res.json({ success: true });
  } catch (err) {
    logger.error('Block Student Error:', err.message);
    res.json({ success: false });
  }
});

// ═══════════════════════════════════════════════════
// UNBLOCK STUDENT
// ═══════════════════════════════════════════════════
router.post('/tstudents/:id/unblock', verifyTeacherLogin, validateObjectIds(['id']), checkTeacherStudentAccess, async (req, res) => {
  try {
    await studentHelper.changeStudentStatus(req.params.id, true); // true = unblock
    res.json({ success: true });
  } catch (err) {
    logger.error('Unblock Student Error:', err.message);
    res.json({ success: false });
  }
});

// ═══════════════════════════════════════════════════
// EXTEND STUDENT ACCESS
// ═══════════════════════════════════════════════════
router.post('/tstudents/:id/extend', verifyTeacherLogin, validateObjectIds(['id']), checkTeacherStudentAccess, async (req, res) => {
  try {
    const { endDate } = req.body;
    if (!endDate) return res.json({ success: false, message: 'End date required' });
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid student' });
    }

    const parsedEndDate = new Date(endDate);
    if (Number.isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid end date' });
    }

    await db.get()
      .collection(collection.STUDENTS_COLLECTION)
      .updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            End_Date: parsedEndDate,
            'account_Status.isActive': true,
            status: true
          }
        }
      );

    res.json({ success: true });
  } catch (err) {
    logger.error('Extend Access Error:', err.message);
    res.json({ success: false });
  }
});

// ═══════════════════════════════════════════════════
// ASSIGNMENTS — LIST & ACTIONS (DISABLED)
// ═══════════════════════════════════════════════════
router.get('/assignments*', verifyTeacherLogin, (req, res) => {
  res.redirect('/teacher/dashboard');
});

router.post('/assignments*', verifyTeacherLogin, (req, res) => {
  res.status(403).json({ success: false, message: 'Access Denied: Assignments functionality is disabled.' });
});

// ═══════════════════════════════════════════════════
// PROFILE — VIEW
// ═══════════════════════════════════════════════════
router.get('/profile', verifyTeacherLogin, async (req, res) => {
  try {
    const teacher = await teacherHelper.getTeacherById(req.session.teacher._id);

    res.render('teacher/profile', {
      teacherPanel: true,
      currentPage: 'profile',
      teacher
    });
  } catch (err) {
    logger.error('Teacher Profile Error:', err.message);
    res.redirect('/teacher/dashboard');
  }
});

// ═══════════════════════════════════════════════════
// PROFILE — UPDATE
// ═══════════════════════════════════════════════════
router.post('/profile/update', verifyTeacherLogin, uploadTeacher.single('profileImage'), async (req, res) => {
  try {
    const teacher = req.session.teacher;
    let profileImage = null;

    if (req.file) {
      // Upload to Firebase
      const ext = path.extname(req.file.originalname) || '.jpg';
      const destPath = `profiles/teachers/${teacher._id}_${Date.now()}${ext}`;
      profileImage = await uploadToS3(
        req.file.buffer,
        destPath,
        req.file.mimetype
      );
    }

    await teacherHelper.updateTeacherProfile(teacher._id, req.body, profileImage);

    // Refresh session
    const updated = await teacherHelper.getTeacherById(teacher._id);
    req.session.teacher = updated;

    res.json({ success: true });
  } catch (err) {
    logger.error('Update Profile Error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════
// WATCH CLASS (PREVIEW WITH HIGH SECURITY)
// ═══════════════════════════════════════════════════
router.get('/watch-class/:chapterCode/:classId', verifyTeacherLogin, validateObjectIds(['classId']), async (req, res) => {
  try {
    const teacherId = req.session.teacher._id;
    const { chapterCode, classId } = req.params;

    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ 'chapters.uniqueCode': chapterCode });

    if (!course) {
      return res.status(404).render('error', { message: 'Chapter not found.' });
    }

    const owns = await teacherHelper.teacherOwnsCourse(teacherId, course._id);
    if (!owns) {
      return res.status(403).render('error', { message: 'Access Denied — This course is not assigned to you.' });
    }

    const chapter = course.chapters.find(ch => ch.uniqueCode === chapterCode);
    if (!chapter) {
      return res.status(404).render('error', { message: 'Chapter not found.' });
    }

    const classData = chapter.classes?.find(c => String(c._id) === String(classId));
    if (!classData) {
      return res.status(404).render('error', { message: 'Class not found.' });
    }

    await decorateCourse(course);
    await decorateClass(classData);

    res.render('teacher/watch-class', {
      teacherPanel: true,
      currentPage: 'courses',
      teacher: req.session.teacher,
      classData,
      course,
      chapter,
      chapterCode
    });
  } catch (err) {
    logger.error('Watch Class Error:', err.message);
    res.status(500).render('error', { message: 'Failed to load class.' });
  }
});

// ═══════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) logger.error('Teacher session destroy error:', err.message);
    res.clearCookie('zeitnah.sid');
    res.redirect('/login');
  });
});

// ═══════════════════════════════════════════════════
// MEDIA LIBRARY (COVER IMAGES)
// ═══════════════════════════════════════════════════
router.get('/cover-images', verifyTeacherLogin, async (req, res) => {
  try {
    // Only return active cover images for the teacher
    const query = { ...req.query, status: 'true' };
    const images = await mediaHelper.getCoverImages(query);
    res.json({ success: true, images });
  } catch (err) {
    logger.error('Teacher Cover Images Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =================================
// UPDATE CHAPTERS ORDER (teacher)
// =================================
router.post('/courses/:courseId/chapters/update-order', verifyTeacherLogin, validateObjectIds(['courseId']), checkTeacherCourseOwnership, async (req, res) => {
  try {
    const { uniqueCodes } = req.body;
    if (Array.isArray(uniqueCodes)) {
      await courseHelper.updateChaptersOrder(req.params.courseId, uniqueCodes);
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, message: 'Invalid data' });
  } catch (err) {
    logger.error('Teacher Update chapters order error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =================================
// UPDATE CLASSES ORDER (teacher)
// =================================
router.post('/chapters/:chapterId/classes/update-order', verifyTeacherLogin, async (req, res) => {
  try {
    const { classIds } = req.body;
    if (!Array.isArray(classIds)) {
      return res.status(400).json({ success: false, message: 'Invalid data' });
    }
    
    // Security: check if teacher owns the course for this chapter
    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ 'chapters.uniqueCode': req.params.chapterId });
    if (!course) return res.status(404).json({ success: false, message: 'Chapter not found' });

    const owns = await teacherHelper.teacherOwnsCourse(req.session.teacher._id, course._id);
    if (!owns) {
      return res.status(403).json({ success: false, message: 'Access Denied' });
    }

    await classHelper.updateClassesOrder(req.params.chapterId, classIds);
    res.json({ success: true });
  } catch (err) {
    logger.error('Teacher Update classes order error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// =================================
// TEACHER EXERCISE ROUTES
// =================================

// Middleware to check if teacher owns the course that contains the chapter
const checkTeacherChapterAccess = async (req, res, next) => {
  const chapterId = req.params.chapterId || req.body.chapterId;
  if (!chapterId) return res.status(400).send('Chapter ID required');
  try {
    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ 'chapters.uniqueCode': chapterId });
    if (!course) return res.status(404).send('Chapter not found');

    const owns = await teacherHelper.teacherOwnsCourse(req.session.teacher._id, course._id);
    if (!owns) {
      return res.status(403).send('Access Denied — This chapter is not in your courses.');
    }
    next();
  } catch (err) {
    logger.error('Teacher Chapter Access Check Error:', err.message);
    res.status(500).send('Server Error');
  }
};

// 1. View exercises list
router.get(
  '/chapters/exercises/:chapterId/:classId',
  verifyTeacherLogin,
  validateObjectIds(['classId']),
  checkTeacherChapterAccess,
  async (req, res) => {
    try {
      const data = await courseHelper.getClassExercises(
        req.params.chapterId,
        req.params.classId
      );

      if (!data) {
        return res.redirect('/teacher/courses');
      }

      res.render(
        'teacher/view-exercises',
        {
          teacherPanel: true,
          currentPage: 'courses',
          teacher: req.session.teacher,
          chapterId: req.params.chapterId,
          classId: req.params.classId,
          classData: data.classData,
          chapter: data.chapter
        }
      );
    } catch (err) {
      logger.error('Teacher View Exercise Route Error:', err.message);
      res.redirect('/teacher/courses');
    }
  }
);

// 2. Add exercise page
router.get(
  '/add-exercise/:chapterId/:classId',
  verifyTeacherLogin,
  validateObjectIds(['classId']),
  checkTeacherChapterAccess,
  (req, res) => {
    res.render(
      'teacher/add-exercise',
      {
        teacherPanel: true,
        currentPage: 'courses',
        teacher: req.session.teacher,
        chapterId: req.params.chapterId,
        classId: req.params.classId
      }
    );
  }
);

// 3. Add exercise POST
router.post(
  '/add-exercise',
  verifyTeacherLogin,
  validateObjectIds(['classId']),
  checkTeacherChapterAccess,
  uploadExercise.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).send('File required');
      }

      const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();

      let type = '';
      if (ext === 'pdf') type = 'pdf';
      else if (ext === 'xls' || ext === 'xlsx') type = 'excel';
      else if (ext === 'dwg') type = 'autocad';

      if (!type) {
        return res.status(400).send('Unsupported exercise file type');
      }

      const destPath = `exercises/${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
      const fileUrl = await uploadToS3(
        req.file.buffer,
        destPath,
        req.file.mimetype
      );

      const result = await courseHelper.addExercise(
        {
          chapterId: req.body.chapterId,
          classId: req.body.classId,
          title: req.body.title,
          type
        },
        fileUrl
      );

      if (!result) {
        return res.status(500).send('Failed to add exercise');
      }

      res.redirect(
        '/teacher/chapters/exercises/' +
        req.body.chapterId + '/' + req.body.classId
      );
    } catch (err) {
      logger.error('Teacher Add Exercise Error:', err.message);
      res.status(500).send('Failed to add exercise');
    }
  }
);

// 4. Edit exercise page
router.get(
  '/edit-exercise/:exerciseId/:chapterId/:classId',
  verifyTeacherLogin,
  validateObjectIds(['exerciseId', 'classId']),
  checkTeacherChapterAccess,
  async (req, res) => {
    try {
      const data = await courseHelper.getExercise(
        req.params.exerciseId,
        req.params.chapterId,
        req.params.classId
      );

      if (!data || !data.exercise) {
        return res.redirect(
          '/teacher/chapters/exercises/' +
          req.params.chapterId +
          '/' +
          req.params.classId
        );
      }

      res.render(
        'teacher/edit-exercise',
        {
          teacherPanel: true,
          currentPage: 'courses',
          teacher: req.session.teacher,
          exercise: data.exercise,
          chapterId: req.params.chapterId,
          classId: req.params.classId
        }
      );
    } catch (err) {
      logger.error('Teacher Edit Exercise Page Error:', err.message);
      res.redirect('/teacher/courses');
    }
  }
);

// 5. Edit exercise POST
router.post(
  '/edit-exercise',
  verifyTeacherLogin,
  validateObjectIds(['exerciseId', 'classId']),
  checkTeacherChapterAccess,
  uploadExercise.single('file'),
  async (req, res) => {
    try {
      let filePayload = null;
      if (req.file) {
        const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
        const destPath = `exercises/${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
        const newUrl = await uploadToS3(
          req.file.buffer,
          destPath,
          req.file.mimetype
        );
        filePayload = { newUrl, ext };
      }

      const updated = await courseHelper.updateExercise(
        req.body,
        filePayload
      );

      res.redirect(
        '/teacher/chapters/exercises/' +
        req.body.chapterId + '/' + req.body.classId
      );
    } catch (err) {
      logger.error('Teacher Edit Exercise Error:', err.message);
      res.redirect(
        '/teacher/chapters/exercises/' +
        req.body.chapterId + '/' + req.body.classId
      );
    }
  }
);

// 6. Delete exercise
router.post(
  '/delete-exercise/:exerciseId/:chapterId/:classId',
  verifyTeacherLogin,
  validateObjectIds(['exerciseId', 'classId']),
  checkTeacherChapterAccess,
  async (req, res) => {
    try {
      await courseHelper.deleteExercise(
        req.params.exerciseId,
        req.params.chapterId,
        req.params.classId
      );

      res.redirect(
        '/teacher/chapters/exercises/' +
        req.params.chapterId +
        '/' +
        req.params.classId
      );
    } catch (err) {
      logger.error('Teacher Delete Exercise Error:', err.message);
      res.redirect(
        '/teacher/chapters/exercises/' +
        req.params.chapterId +
        '/' +
        req.params.classId
      );
    }
  }
);

module.exports = router;
