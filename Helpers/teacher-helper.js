const db = require('../config/connection');
const collection = require('../config/collections');
const bcrypt = require('bcrypt');
const { ObjectId } = require('mongodb');
const { deleteFromS3, extractPathFromUrl } = require('../config/s3-storage');

const SALT_ROUNDS = 10;

// Delete a teacher image from Firebase Storage (silently ignores non-Firebase URLs)
const deleteTeacherImageFromFirebase = async (imageUrl) => {
  if (!imageUrl) return;
  try {
    const storagePath = extractPathFromUrl(imageUrl);
    if (storagePath) await deleteFromS3(storagePath);
  } catch (e) {
    console.warn('Could not delete teacher image from Firebase:', e.message);
  }
};

// ─────────────────────────────────────────────
// CREATE TEACHER
// ─────────────────────────────────────────────
const createTeacher = async (data) => {
  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');

  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid name and email are required');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const teacherDoc = {
    name,
    email,
    mobile: data.mobile || '',
    password: hashedPassword,
    profileImage: data.profileImage || 'default-teacher.png',
    designation: data.designation || '',
    bio: data.bio || '',
    role: 'teacher',
    assignedCourses: [],
    status: 'active',
    createdAt: new Date()
  };

  const result = await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .insertOne(teacherDoc);

  return { ...teacherDoc, _id: result.insertedId };
};

// ─────────────────────────────────────────────
// GET TEACHER BY EMAIL
// ─────────────────────────────────────────────
const getTeacherByEmail = async (email) => {
  try {
    if (!email) return null;
    return await db.get()
      .collection(collection.TEACHER_COLLECTION)
      .findOne({ email: email.trim().toLowerCase() });
  } catch (err) {
    console.error('getTeacherByEmail Error:', err.message);
    return null;
  }
};

// ─────────────────────────────────────────────
// GET TEACHER BY ID
// ─────────────────────────────────────────────
const getTeacherById = async (id) => {
  try {
    if (!ObjectId.isValid(id)) return null;

    return await db.get()
      .collection(collection.TEACHER_COLLECTION)
      .findOne({ _id: new ObjectId(id) });
  } catch (err) {
    console.error('getTeacherById Error:', err.message);
    return null;
  }
};

// ─────────────────────────────────────────────
// VERIFY PASSWORD
// ─────────────────────────────────────────────
const verifyTeacherPassword = async (teacher, plainPassword) => {
  if (!teacher || !plainPassword) return false;
  try {
    return await bcrypt.compare(plainPassword, teacher.password);
  } catch (err) {
    console.error('verifyTeacherPassword Error:', err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// GET ALL TEACHERS (with course names resolved)
// ─────────────────────────────────────────────
const getAllTeachers = async () => {
  try {
    const teachers = await db.get()
      .collection(collection.TEACHER_COLLECTION)
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    // Resolve assigned course names for each teacher
    const allCourses = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .find({}, { projection: { _id: 1, name: 1 } })
      .toArray();

    const courseMap = {};
    allCourses.forEach(c => { courseMap[c._id.toString()] = c.name; });

    teachers.forEach(teacher => {
      teacher.assignedCourseNames = (teacher.assignedCourses || [])
        .map(id => courseMap[id.toString()] || 'Unknown')
        .join(', ');
      teacher.courseCount = (teacher.assignedCourses || []).length;
    });

    return teachers;
  } catch (err) {
    console.error('getAllTeachers Error:', err.message);
    return [];
  }
};

// ─────────────────────────────────────────────
// UPDATE TEACHER (admin editing)
// ─────────────────────────────────────────────
const updateTeacher = async (id, data) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid teacher');
  const email = String(data.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid email is required');
  }

  const existing = await getTeacherByEmail(email);
  if (existing && String(existing._id) !== String(id)) {
    throw new Error('A teacher with this email already exists');
  }

  const update = {
    name: (data.name || '').trim(),
    email,
    mobile: data.mobile || '',
    designation: data.designation || '',
    bio: data.bio || ''
  };

  // Only update password if a new one is provided
  if (data.password && data.password.trim()) {
    if (data.password.trim().length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    update.password = await bcrypt.hash(data.password.trim(), SALT_ROUNDS);
  }

  await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: update });
};

// ─────────────────────────────────────────────
// DELETE TEACHER
// ─────────────────────────────────────────────
const deleteTeacher = async (id) => {
  try {
    if (!ObjectId.isValid(id)) return { status: false, message: 'Invalid teacher' };

    const teacher = await getTeacherById(id);
    if (!teacher) return { status: false, message: 'Teacher not found' };

    // Remove teacher from course assignedTeachers arrays
    if (teacher.assignedCourses && teacher.assignedCourses.length) {
      await db.get()
        .collection(collection.COURSE_COLLECTION)
        .updateMany(
          { _id: { $in: teacher.assignedCourses.map(cid => new ObjectId(cid)) } },
          { $pull: { assignedTeachers: id.toString() } }
        );
    }

    await db.get()
      .collection(collection.TEACHER_COLLECTION)
      .deleteOne({ _id: new ObjectId(id) });
    await db.get()
      .collection(collection.ASSIGNMENT_COLLECTION)
      .deleteMany({ teacherId: id.toString() });

    // Delete teacher image from Firebase
    await deleteTeacherImageFromFirebase(teacher.profileImage);

    return { status: true };
  } catch (err) {
    console.error('deleteTeacher Error:', err.message);
    return { status: false, message: err.message };
  }
};

// ─────────────────────────────────────────────
// DISABLE / ENABLE TEACHER
// ─────────────────────────────────────────────
const setTeacherStatus = async (id, status) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid teacher');

  await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: { status } });
};

// ─────────────────────────────────────────────
// ASSIGN COURSES TO TEACHER (bidirectional)
// ─────────────────────────────────────────────
const assignCourses = async (teacherId, courseIds) => {
  if (!ObjectId.isValid(teacherId)) throw new Error('Invalid teacher');
  courseIds = [...new Set(courseIds.filter(ObjectId.isValid).map(String))];

  // Get old assigned courses to clean bidirectional refs
  const teacher = await getTeacherById(teacherId);
  if (!teacher) throw new Error('Teacher not found');
  const oldIds = (teacher.assignedCourses || []).map(id => id.toString());

  // Compute removed and added
  const removed = oldIds.filter(id => !courseIds.includes(id));
  const added = courseIds.filter(id => !oldIds.includes(id));

  // Remove teacher from courses no longer assigned
  if (removed.length) {
    await db.get()
      .collection(collection.COURSE_COLLECTION)
      .updateMany(
        { _id: { $in: removed.map(id => new ObjectId(id)) } },
        { $pull: { assignedTeachers: teacherId.toString() } }
      );
  }

  // Add teacher to newly assigned courses
  if (added.length) {
    await db.get()
      .collection(collection.COURSE_COLLECTION)
      .updateMany(
        { _id: { $in: added.map(id => new ObjectId(id)) } },
        { $addToSet: { assignedTeachers: teacherId.toString() } }
      );
  }

  // Update teacher's assignedCourses
  await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .updateOne(
      { _id: new ObjectId(teacherId) },
      { $set: { assignedCourses: courseIds } }
    );
};

// ─────────────────────────────────────────────
// GET TEACHER'S ASSIGNED COURSES (full docs)
// ─────────────────────────────────────────────
const getTeacherCourses = async (teacherId) => {
  try {
    const teacher = await getTeacherById(teacherId);
    if (!teacher || !teacher.assignedCourses || !teacher.assignedCourses.length) {
      return [];
    }

    const courseIds = teacher.assignedCourses
      .filter(id => ObjectId.isValid(id))
      .map(id => new ObjectId(id));

    const courses = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .find({ _id: { $in: courseIds } })
      .sort({ order: 1, createdAt: -1 })
      .toArray();

    // Add student count per course
    await Promise.all(courses.map(async (course) => {
      const count = await db.get()
        .collection(collection.STUDENTS_COLLECTION)
        .countDocuments({ 'course.courseId': course._id.toString() });
      course.studentCount = count;
      course.chapterCount = (course.chapters || []).length;
      const lastUpdate = course.updatedAt || course.createdAt;
      course.lastUpdatedDisplay = lastUpdate
        ? new Date(lastUpdate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';
    }));

    return courses;
  } catch (err) {
    console.error('getTeacherCourses Error:', err.message);
    return [];
  }
};

// ─────────────────────────────────────────────
// GET TEACHER'S STUDENTS (enrolled in assigned courses)
// ─────────────────────────────────────────────
const getTeacherStudents = async (teacherId) => {
  try {
    const teacher = await getTeacherById(teacherId);
    if (!teacher || !teacher.assignedCourses || !teacher.assignedCourses.length) {
      return [];
    }

    const courseIdStrings = teacher.assignedCourses.map(id => id.toString());

    const students = await db.get()
      .collection(collection.STUDENTS_COLLECTION)
      .find({ 'course.courseId': { $in: courseIdStrings } })
      .toArray();

    // Attach the relevant course name for display
    students.forEach(student => {
      const enrolledCourse = (student.course || []).find(
        c => courseIdStrings.includes(c.courseId)
      );
      student.displayCourse = enrolledCourse ? enrolledCourse.courseName : '—';
      student.displayProgress = enrolledCourse
        ? (enrolledCourse.learningProgress?.completionPercent || 0)
        : 0;
      student.lastSeenDisplay = student.account_Status?.lastSeen
        ? new Date(student.account_Status.lastSeen).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';
      student.isBlocked = student.account_Status?.isBlocked || false;
      student.isActive = student.account_Status?.isActive !== false;
    });

    return students;
  } catch (err) {
    console.error('getTeacherStudents Error:', err.message);
    return [];
  }
};

// ─────────────────────────────────────────────
// CHECK IF STUDENT BELONGS TO TEACHER
// ─────────────────────────────────────────────
const teacherOwnsStudent = async (teacherId, studentId) => {
  try {
    if (!ObjectId.isValid(studentId)) return false;

    const teacher = await getTeacherById(teacherId);
    if (!teacher || !teacher.assignedCourses || !teacher.assignedCourses.length) return false;

    const courseIdStrings = teacher.assignedCourses.map(id => id.toString());

    const student = await db.get()
      .collection(collection.STUDENTS_COLLECTION)
      .findOne({
        _id: new ObjectId(studentId),
        'course.courseId': { $in: courseIdStrings }
      });

    return !!student;
  } catch (err) {
    return false;
  }
};

// ─────────────────────────────────────────────
// CHECK IF COURSE BELONGS TO TEACHER
// ─────────────────────────────────────────────
const teacherOwnsCourse = async (teacherId, courseId) => {
  try {
    const teacher = await getTeacherById(teacherId);
    if (!teacher) return false;
    return (teacher.assignedCourses || []).map(id => id.toString()).includes(courseId.toString());
  } catch (err) {
    return false;
  }
};

// ─────────────────────────────────────────────
// DASHBOARD DATA
// ─────────────────────────────────────────────
const getTeacherDashboardData = async (teacherId) => {
  try {
    const teacher = await getTeacherById(teacherId);
    const assignedCourses = teacher ? (teacher.assignedCourses || []) : [];
    const courseIdStrings = assignedCourses.map(id => id.toString());

    const [totalStudents, activeStudents, pendingAssignments, recentStudents] = await Promise.all([
      // Total students in teacher's courses
      courseIdStrings.length
        ? db.get().collection(collection.STUDENTS_COLLECTION)
            .countDocuments({ 'course.courseId': { $in: courseIdStrings } })
        : Promise.resolve(0),

      // Active students
      courseIdStrings.length
        ? db.get().collection(collection.STUDENTS_COLLECTION)
            .countDocuments({
              'course.courseId': { $in: courseIdStrings },
              'account_Status.isActive': true,
              'account_Status.isBlocked': false
            })
        : Promise.resolve(0),

      // Pending assignments (ungraded submissions)
      db.get().collection(collection.ASSIGNMENT_COLLECTION)
        .countDocuments({
          teacherId: teacherId.toString(),
          'submissions': { $elemMatch: { marks: null } }
        }).catch(() => 0),

      // Recent 5 students
      courseIdStrings.length
        ? db.get().collection(collection.STUDENTS_COLLECTION)
            .find({ 'course.courseId': { $in: courseIdStrings } })
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray()
        : Promise.resolve([])
    ]);

    return {
      assignedCourseCount: assignedCourses.length,
      totalStudents,
      activeStudents,
      pendingAssignments,
      recentStudents: recentStudents.map(s => {
        const c = (s.course || []).find(cr => courseIdStrings.includes(cr.courseId));
        return {
          name: s.Name || s.name || '—',
          courseName: c ? c.courseName : '—',
          isActive: s.account_Status?.isActive !== false,
          isBlocked: s.account_Status?.isBlocked || false
        };
      })
    };
  } catch (err) {
    console.error('getTeacherDashboardData Error:', err.message);
    return {
      assignedCourseCount: 0,
      totalStudents: 0,
      activeStudents: 0,
      pendingAssignments: 0,
      recentStudents: []
    };
  }
};

// ─────────────────────────────────────────────
// UPDATE TEACHER PROFILE (teacher self-edit)
// ─────────────────────────────────────────────
const updateTeacherProfile = async (id, data, profileImage) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid teacher');

  const teacher = await getTeacherById(id);
  if (!teacher) throw new Error('Teacher not found');

  const update = {
    name: (data.name || '').trim(),
    bio: data.bio || '',
    designation: data.designation || ''
  };

  if (profileImage) {
    update.profileImage = profileImage;
  }

  if (data.newPassword && data.newPassword.trim()) {
    if (data.newPassword !== data.confirmNewPassword) {
      throw new Error('Password confirmation does not match');
    }
    if (data.newPassword.trim().length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    update.password = await bcrypt.hash(data.newPassword.trim(), SALT_ROUNDS);
  }

  await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: update });

  // Delete old profile image from Firebase if a new one was provided
  if (profileImage && profileImage !== teacher.profileImage) {
    await deleteTeacherImageFromFirebase(teacher.profileImage);
  }
};

// ─────────────────────────────────────────────
// UPDATE TEACHER PROFILE IMAGE
// ─────────────────────────────────────────────
const updateTeacherImage = async (id, imageUrl) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid teacher');

  const teacher = await getTeacherById(id);
  if (!teacher) throw new Error('Teacher not found');

  await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: { profileImage: imageUrl } });

  // Delete old image from Firebase if it was a Firebase URL
  if (imageUrl !== teacher.profileImage) {
    await deleteTeacherImageFromFirebase(teacher.profileImage);
  }
};

module.exports = {
  createTeacher,
  getTeacherByEmail,
  getTeacherById,
  verifyTeacherPassword,
  getAllTeachers,
  updateTeacher,
  deleteTeacher,
  setTeacherStatus,
  assignCourses,
  getTeacherCourses,
  getTeacherStudents,
  teacherOwnsStudent,
  teacherOwnsCourse,
  getTeacherDashboardData,
  updateTeacherProfile,
  updateTeacherImage
};
