const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const { deleteFromS3, extractPathFromUrl } = require('../config/s3-storage');

// ─────────────────────────────────────────────
// CREATE ASSIGNMENT
// ─────────────────────────────────────────────
const createAssignment = async (data) => {
  const title = String(data.title || '').trim();
  const marks = Number(data.marks);
  const dueDate = data.dueDate ? new Date(data.dueDate) : null;

  if (!title) throw new Error('Assignment title is required');
  if (!data.courseId || !ObjectId.isValid(data.courseId)) {
    throw new Error('A valid course is required');
  }
  if (!Number.isFinite(marks) || marks <= 0) {
    throw new Error('Marks must be greater than zero');
  }
  if (dueDate && Number.isNaN(dueDate.getTime())) {
    throw new Error('Invalid due date');
  }

  const doc = {
    title,
    description: data.description || '',
    dueDate,
    marks,
    courseId: data.courseId || '',
    teacherId: data.teacherId || '',
    attachments: [],
    submissions: [],
    createdAt: new Date()
  };

  const result = await db.get()
    .collection(collection.ASSIGNMENT_COLLECTION)
    .insertOne(doc);

  return { ...doc, _id: result.insertedId };
};

// ─────────────────────────────────────────────
// GET ASSIGNMENTS BY TEACHER
// ─────────────────────────────────────────────
const getAssignmentsByTeacher = async (teacherId) => {
  try {
    const assignments = await db.get()
      .collection(collection.ASSIGNMENT_COLLECTION)
      .find({ teacherId: teacherId.toString() })
      .sort({ createdAt: -1 })
      .toArray();

    assignments.forEach(a => {
      a.submissionCount = (a.submissions || []).length;
      a.ungradedCount = (a.submissions || []).filter(s => s.marks === null || s.marks === undefined).length;
      a.dueDateDisplay = a.dueDate
        ? new Date(a.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';
    });

    return assignments;
  } catch (err) {
    console.error('getAssignmentsByTeacher Error:', err.message);
    return [];
  }
};

// ─────────────────────────────────────────────
// GET ASSIGNMENT BY ID
// ─────────────────────────────────────────────
const getAssignmentById = async (id) => {
  try {
    if (!ObjectId.isValid(id)) return null;

    const assignment = await db.get()
      .collection(collection.ASSIGNMENT_COLLECTION)
      .findOne({ _id: new ObjectId(id) });

    if (assignment) {
      assignment.submissionCount = (assignment.submissions || []).length;
      assignment.ungradedCount = (assignment.submissions || [])
        .filter(s => s.marks === null || s.marks === undefined).length;
      assignment.dueDateDisplay = assignment.dueDate
        ? new Date(assignment.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';
      assignment.submissions = (assignment.submissions || []).map(sub => ({
        ...sub,
        isGraded: sub.marks !== null && sub.marks !== undefined,
        submittedAtDisplay: sub.submittedAt
          ? new Date(sub.submittedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
          : '—'
      }));
    }

    return assignment;
  } catch (err) {
    console.error('getAssignmentById Error:', err.message);
    return null;
  }
};

// ─────────────────────────────────────────────
// UPDATE ASSIGNMENT
// ─────────────────────────────────────────────
const updateAssignment = async (id, data) => {
  if (!ObjectId.isValid(id)) {
    throw new Error('Invalid assignment');
  }

  await db.get()
    .collection(collection.ASSIGNMENT_COLLECTION)
    .updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          title: (data.title || '').trim(),
          description: data.description || '',
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          marks: Number(data.marks) || 0,
          updatedAt: new Date()
        }
      }
    );
};

// ─────────────────────────────────────────────
// DELETE ASSIGNMENT
// ─────────────────────────────────────────────
const deleteAssignment = async (id) => {
  if (!ObjectId.isValid(id)) {
    throw new Error('Invalid assignment');
  }

  try {
    const assignment = await getAssignmentById(id);
    if (assignment) {
      // 1. Delete attachments if any
      if (assignment.attachments && Array.isArray(assignment.attachments)) {
        for (const attachment of assignment.attachments) {
          const fileUrl = typeof attachment === 'string' ? attachment : attachment.file;
          if (fileUrl) {
            const storagePath = extractPathFromUrl(fileUrl);
            if (storagePath) await deleteFromS3(storagePath);
          }
        }
      }

      // 2. Delete student submissions from S3
      if (assignment.submissions && Array.isArray(assignment.submissions)) {
        for (const submission of assignment.submissions) {
          if (submission.file) {
            const storagePath = extractPathFromUrl(submission.file);
            if (storagePath) await deleteFromS3(storagePath);
          }
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not complete S3 cleanup for deleted assignment:', err.message);
  }

  await db.get()
    .collection(collection.ASSIGNMENT_COLLECTION)
    .deleteOne({ _id: new ObjectId(id) });
};

// ─────────────────────────────────────────────
// ADD SUBMISSION (student submitting — for future student portal)
// ─────────────────────────────────────────────
const addSubmission = async (assignmentId, studentId, studentName, file) => {
  if (!ObjectId.isValid(assignmentId)) {
    throw new Error('Invalid assignment');
  }

  const submission = {
    _id: new ObjectId(),
    studentId: studentId.toString(),
    studentName,
    file: file || null,
    submittedAt: new Date(),
    marks: null,
    feedback: null
  };

  await db.get()
    .collection(collection.ASSIGNMENT_COLLECTION)
    .updateOne(
      { _id: new ObjectId(assignmentId) },
      { $push: { submissions: submission } }
    );

  return submission;
};

// ─────────────────────────────────────────────
// GRADE SUBMISSION
// ─────────────────────────────────────────────
const gradeSubmission = async (assignmentId, submissionId, marks, feedback) => {
  const numericMarks = Number(marks);
  if (
    !ObjectId.isValid(assignmentId) ||
    !ObjectId.isValid(submissionId) ||
    !Number.isFinite(numericMarks) ||
    numericMarks < 0
  ) {
    throw new Error('Invalid grade');
  }

  const assignment = await getAssignmentById(assignmentId);
  if (!assignment || numericMarks > Number(assignment.marks)) {
    throw new Error('Marks exceed the assignment maximum');
  }

  const result = await db.get()
    .collection(collection.ASSIGNMENT_COLLECTION)
    .updateOne(
      {
        _id: new ObjectId(assignmentId),
        'submissions._id': new ObjectId(submissionId)
      },
      {
        $set: {
          'submissions.$.marks': numericMarks,
          'submissions.$.feedback': feedback || '',
          'submissions.$.gradedAt': new Date()
        }
      }
    );

  if (!result.modifiedCount) {
    throw new Error('Submission not found');
  }
};

// ─────────────────────────────────────────────
// PENDING ASSIGNMENT COUNT FOR TEACHER
// ─────────────────────────────────────────────
const getPendingCount = async (teacherId) => {
  try {
    const result = await db.get()
      .collection(collection.ASSIGNMENT_COLLECTION)
      .find({ teacherId: teacherId.toString() })
      .toArray();

    return result.reduce((total, a) => {
      const ungraded = (a.submissions || []).filter(s => s.marks === null || s.marks === undefined).length;
      return total + ungraded;
    }, 0);
  } catch (err) {
    return 0;
  }
};

module.exports = {
  createAssignment,
  getAssignmentsByTeacher,
  getAssignmentById,
  updateAssignment,
  deleteAssignment,
  addSubmission,
  gradeSubmission,
  getPendingCount
};
