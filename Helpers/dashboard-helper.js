const db = require('../config/connection');
const collection = require('../config/collections');

module.exports = {

    getDashboardData: () => {
        return new Promise(async (resolve, reject) => {
            try {

                // students
                const students = await db.get()
                    .collection(collection.STUDENTS_COLLECTION)
                    .find()
                    .toArray();

                // courses
                const courses = await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .find()
                    .toArray();

                const totalStudents = students.length;

                const activeStudents =
                    students.filter(s => s.status === true).length;

                const expiredStudents =
                    students.filter(s => s.status === false).length;

                const totalRevenue =
                    students.reduce((sum, s) =>
                        sum + Number(s.Paid_Amount || 0), 0);

                const totalCourses = courses.length;

                const totalChapters =
                    courses.reduce((sum, c) =>
                        sum + (c.chapters ? c.chapters.length : 0), 0);

                // recent 5 students
                const recentStudents =
                    students.slice(-5).reverse();

                // popular course
                let courseMap = {};

                students.forEach(s => {
                    if (s.course && Array.isArray(s.course)) {
                        s.course.forEach(c => {
                            if (c.courseName) {
                                courseMap[c.courseName] =
                                    (courseMap[c.courseName] || 0) + 1;
                            }
                        });
                    } else if (s.courseName) {
                        courseMap[s.courseName] =
                            (courseMap[s.courseName] || 0) + 1;
                    }
                });

                let popularCourse = "No Data";
                let max = 0;

                for (let course in courseMap) {
                    if (courseMap[course] > max) {
                        max = courseMap[course];
                        popularCourse = course;
                    }
                }

                resolve({
                    totalStudents,
                    activeStudents,
                    expiredStudents,
                    totalRevenue,
                    totalCourses,
                    totalChapters,
                    recentStudents,
                    popularCourse
                });

            } catch (err) {
                reject(err);
            }
        });
    },
    

};