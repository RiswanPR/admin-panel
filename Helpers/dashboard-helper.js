const db = require('../config/connection');
const collection = require('../config/collections');

module.exports = {

    getDashboardData: async () => {
        try {
            const dbConn = db.get();

            // Use countDocuments instead of fetching all documents into memory
            const [
                totalStudents,
                activeStudents,
                expiredStudents,
                totalCourses,
                courses,
                revenueResult,
                recentStudents
            ] = await Promise.all([
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments(),
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ status: true }),
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ status: false }),
                dbConn.collection(collection.COURSE_COLLECTION).countDocuments(),
                dbConn.collection(collection.COURSE_COLLECTION).find({}, { projection: { chapters: 1 } }).toArray(),
                dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                    { $group: { _id: null, total: { $sum: { $toDouble: { $ifNull: ['$Paid_Amount', 0] } } } } }
                ]).toArray(),
                dbConn.collection(collection.STUDENTS_COLLECTION)
                    .find()
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray()
            ]);

            const totalRevenue = revenueResult[0]?.total || 0;

            const totalChapters = courses.reduce((sum, c) =>
                sum + (c.chapters ? c.chapters.length : 0), 0);

            // Find popular course from recent students' enrolled courses
            const courseMap = {};
            recentStudents.forEach(s => {
                if (s.course && Array.isArray(s.course)) {
                    s.course.forEach(c => {
                        if (c.courseName) {
                            courseMap[c.courseName] = (courseMap[c.courseName] || 0) + 1;
                        }
                    });
                }
            });

            // For a more accurate popular course, query all students' courses
            const allStudentCourses = await dbConn.collection(collection.STUDENTS_COLLECTION)
                .aggregate([
                    { $unwind: { path: '$course', preserveNullAndEmptyArrays: false } },
                    { $group: { _id: '$course.courseName', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 1 }
                ]).toArray();

            const popularCourse = allStudentCourses[0]?._id || 'No Data';

            return {
                totalStudents,
                activeStudents,
                expiredStudents,
                totalRevenue,
                totalCourses,
                totalChapters,
                recentStudents,
                popularCourse
            };

        } catch (err) {
            throw err;
        }
    },

};