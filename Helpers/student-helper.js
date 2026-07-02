const db = require('../config/connection');
var collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const bcrypt = require('bcrypt');
const { deleteFromS3, extractPathFromUrl } = require('../config/s3-storage');
const { decorateProfileImage } = require('./image-url-helper');

const SALT_ROUNDS = 10;

const normalizePackageIds = (value) => {
    const ids = Array.isArray(value) ? value : [value];
    return [...new Set(ids.filter(id => id && ObjectId.isValid(id)).map(String))];
};

const parseDateRange = (startValue, endValue) => {
    const startDate = new Date(startValue);
    const endDate = new Date(endValue);

    if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime()) ||
        endDate < startDate
    ) {
        return null;
    }

    return { startDate, endDate };
};

const buildCourseEnrollment = (course, dates, duration, existingCourse = null) => {
    const totalClasses = (course.chapters || []).reduce(
        (total, chapter) => total + (chapter.classes || []).length,
        0
    );
    const previousProgress = existingCourse?.learningProgress || {};
    const watchedClasses = Math.min(
        Number(previousProgress.watchedClasses) || 0,
        totalClasses
    );
    const completionPercent = totalClasses
        ? Math.round((watchedClasses / totalClasses) * 100)
        : 0;

    return {
        courseId: course._id.toString(),
        courseName: course.name,
        courseFee: course.Total_Fees,
        Start_Date: dates.startDate,
        End_Date: dates.endDate,
        duration,
        learningProgress: {
            totalClasses,
            watchedClasses,
            completionPercent,
            streak: Number(previousProgress.streak) || 0,
            averageWatchTime: previousProgress.averageWatchTime || '0 mins',
            certificateEligible: completionPercent >= 90
        }
    };
};

module.exports = {

    addStudents: async (students, callback) => {
        try {
            const packageIds = normalizePackageIds(students.package);
            const dates = parseDateRange(students.Start_Date, students.End_Date);
            const email = String(students.email || '').trim().toLowerCase();
            const name = String(students.Name || students.name || '').trim();

            if (!packageIds.length || !dates || !email || !name) {
                return callback(false);
            }

            const courses = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .find({ _id: { $in: packageIds.map(id => new ObjectId(id)) } })
                .toArray();

            if (courses.length !== packageIds.length) {
                return callback(false);
            }

            const users = db.get().collection(collection.STUDENTS_COLLECTION);
            const existing = await users.findOne({ email });
            const existingCourses = existing?.course || [];
            const enrollmentMap = new Map(
                existingCourses.map(item => [String(item.courseId), item])
            );

            courses.forEach(course => {
                const courseId = course._id.toString();
                enrollmentMap.set(
                    courseId,
                    buildCourseEnrollment(
                        course,
                        dates,
                        students.Duration,
                        enrollmentMap.get(courseId)
                    )
                );
            });

            const update = {
                Name: name,
                name,
                email,
                Phone_Number: students.Phone_Number || '',
                Paid_Amount: Number(students.Paid_Amount) || 0,
                Start_Date: dates.startDate,
                End_Date: dates.endDate,
                Duration: students.Duration || '',
                package: [...new Set([
                    ...normalizePackageIds(existing?.package || []),
                    ...packageIds
                ])],
                course: [...enrollmentMap.values()],
                status: dates.endDate >= new Date(),
                account_Status: {
                    isVerified: existing?.account_Status?.isVerified ?? true,
                    isActive: true,
                    lastSeen: existing?.account_Status?.lastSeen || new Date(),
                    isBlocked: false,
                    isDeleted: false
                },
                updatedAt: new Date()
            };

            if (students.Password) {
                update.Password = await bcrypt.hash(String(students.Password), SALT_ROUNDS);
            }

            if (existing) {
                await users.updateOne({ _id: existing._id }, { $set: update });
                return callback(existing._id, false); // isNew = false
            }

            const result = await users.insertOne({
                ...update,
                createdAt: new Date()
            });
            callback(result.insertedId, true); // isNew = true
        } catch (err) {
            callback(false, false);
        }
    },

    // ✅ GET STUDENTS (only users who have courses assigned)
    getStudents: () => {
        return new Promise(async (resolve, reject) => {
            let students = await db.get()
                .collection(collection.STUDENTS_COLLECTION)
                .find({
                    course: { $exists: true, $not: { $size: 0 } }
                })
                .toArray();
            await Promise.all(students.map(student => decorateProfileImage(student, 'image')));
            resolve(students);
        });
    },

    // ✅ GET REGISTERED USERS (accounts without courses — from user panel)
    getRegisteredUsers: () => {
        return new Promise(async (resolve, reject) => {
            let users = await db.get()
                .collection(collection.STUDENTS_COLLECTION)
                .find({
                    $or: [
                        { course: { $exists: false } },
                        { course: { $size: 0 } },
                        { course: null }
                    ]
                })
                .sort({ createdAt: -1 })
                .toArray();
            await Promise.all(users.map(user => decorateProfileImage(user, 'image')));
            resolve(users);
        });
    },

    updateExpiredStudents: () => {
        let today = new Date();
        return db.get().collection(collection.STUDENTS_COLLECTION)
            .updateMany(
                { End_Date: { $lt: today }, status: true },
                { $set: { status: false } }
            );
    },

    changeStudentStatus: (studentId, status) => {
        if (!ObjectId.isValid(studentId)) {
            return Promise.reject(new Error('Invalid student'));
        }
        return db.get().collection(collection.STUDENTS_COLLECTION)
            .updateOne(
                { _id: new ObjectId(studentId) },
                {
                    $set: {
                        "account_Status.isBlocked": !status,
                        "account_Status.isActive": status,
                    }
                }
            );
    },

    verifyStudent: (studentId) => {
        if (!ObjectId.isValid(studentId)) {
            return Promise.reject(new Error('Invalid student'));
        }
        return db.get().collection(collection.STUDENTS_COLLECTION)
            .updateOne(
                { _id: new ObjectId(studentId) },
                { $set: { "account_Status.isVerified": true } }
            );
    },

    deleteStudent: async (studentId) => {
        try {
            if (!ObjectId.isValid(studentId)) throw new Error("Invalid student");

            let student = await db.get()
                .collection(collection.STUDENTS_COLLECTION)
                .findOne({ _id: new ObjectId(studentId) });

            if (!student) throw new Error("Student not found");

            // Delete student image from Firebase if stored as a Firebase URL
            if (student.image) {
                try {
                    const storagePath = extractPathFromUrl(student.image);
                    if (storagePath) await deleteFromS3(storagePath);
                } catch (e) {
                    console.warn('Could not delete student image from Firebase:', e.message);
                }
            }

            // DELETE FROM DB
            await db.get()
                .collection(collection.STUDENTS_COLLECTION)
                .deleteOne({ _id: new ObjectId(studentId) });

            return true;

        } catch (err) {
            throw err;
        }
    },

    getStudentById: async (id) => {
        if (!ObjectId.isValid(id)) return null;
        const student = await db.get()
            .collection(collection.STUDENTS_COLLECTION)
            .findOne({ _id: new ObjectId(id) });
        return decorateProfileImage(student, 'image');
    },

    updateStudent: async (id, data) => {
        if (!ObjectId.isValid(id)) return false;

        const packageIds = normalizePackageIds(data.package);
        const dates = parseDateRange(data.Start_Date, data.End_Date);
        if (!packageIds.length || !dates) return false;

        const courses = await db.get()
            .collection(collection.COURSE_COLLECTION)
            .find({ _id: { $in: packageIds.map(pid => new ObjectId(pid)) } })
            .toArray();
        if (courses.length !== packageIds.length) return false;

        const current = await db.get()
            .collection(collection.STUDENTS_COLLECTION)
            .findOne({ _id: new ObjectId(id) });
        if (!current) return false;

        const existingCourses = new Map(
            (current.course || []).map(item => [String(item.courseId), item])
        );
        const courseData = courses.map(course => buildCourseEnrollment(
            course,
            dates,
            data.Duration,
            existingCourses.get(course._id.toString())
        ));
        const name = String(data.Name || data.name || '').trim();

        return db.get()
            .collection(collection.STUDENTS_COLLECTION)
            .updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: {
                        Name: name,
                        name,
                        email: String(data.email || '').trim().toLowerCase(),
                        Phone_Number: data.Phone_Number,
                        Paid_Amount: Number(data.Paid_Amount) || 0,
                        Start_Date: dates.startDate,
                        End_Date: dates.endDate,
                        Duration: data.Duration || '',
                        package: packageIds,
                        course: courseData,
                        status: dates.endDate >= new Date(),
                        "account_Status.lastSeen": new Date(),
                        updatedAt: new Date()
                    }
                }
            );
    },

    // Store Firebase public URL for student profile image
    updateStudentImage: async (id, imageUrl) => {
        if (!ObjectId.isValid(id)) return false;

        await db.get()
            .collection(collection.STUDENTS_COLLECTION)
            .updateOne(
                { _id: new ObjectId(id) },
                { $set: { image: imageUrl } }
            );
    },
};
