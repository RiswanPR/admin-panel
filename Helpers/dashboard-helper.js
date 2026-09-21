const db = require('../config/connection');
const collection = require('../config/collections');

const getRelativeTime = (date) => {
    if (!date) return 'Recently';
    const now = new Date();
    const diffMs = now - new Date(date);
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return new Date(date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
};

const getActionIconAndColor = (action = '', entityType = '') => {
    const text = `${action} ${entityType}`.toLowerCase();
    if (text.includes('student') || text.includes('user')) {
        return { icon: 'fa-solid fa-user-graduate', colorClass: 'activity-student' };
    }
    if (text.includes('course')) {
        return { icon: 'fa-solid fa-book-open', colorClass: 'activity-course' };
    }
    if (text.includes('chapter')) {
        return { icon: 'fa-solid fa-layer-group', colorClass: 'activity-chapter' };
    }
    if (text.includes('video') || text.includes('class')) {
        return { icon: 'fa-solid fa-video', colorClass: 'activity-video' };
    }
    if (text.includes('teacher')) {
        return { icon: 'fa-solid fa-chalkboard-user', colorClass: 'activity-teacher' };
    }
    if (text.includes('space')) {
        return { icon: 'fa-solid fa-people-roof', colorClass: 'activity-space' };
    }
    if (text.includes('auth') || text.includes('login') || text.includes('password')) {
        return { icon: 'fa-solid fa-shield-halved', colorClass: 'activity-security' };
    }
    return { icon: 'fa-solid fa-bolt', colorClass: 'activity-general' };
};

module.exports = {

    getDashboardData: async () => {
        try {
            const dbConn = db.get();

            // Build last 6 months keys & labels
            const now = new Date();
            const monthLabels = [];
            const monthKeys = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                monthLabels.push(d.toLocaleString('en-US', { month: 'short' }));
                monthKeys.push(`${d.getFullYear()}-${d.getMonth() + 1}`);
            }
            const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

            // Execute primary queries in parallel
            const [
                totalStudents,
                activeStudents,
                expiredStudents,
                totalCourses,
                courses,
                revenueResult,
                recentStudents,
                totalTeachers,
                totalLearningSpaces,
                rawAuditLogs
            ] = await Promise.all([
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments().catch(() => 0),
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ status: true }).catch(() => 0),
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ status: false }).catch(() => 0),
                dbConn.collection(collection.COURSE_COLLECTION).countDocuments().catch(() => 0),
                dbConn.collection(collection.COURSE_COLLECTION).find({}, { projection: { chapters: 1 } }).toArray().catch(() => []),
                dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                    { $group: { _id: null, total: { $sum: { $toDouble: { $ifNull: ['$Paid_Amount', 0] } } } } }
                ]).toArray().catch(() => []),
                dbConn.collection(collection.STUDENTS_COLLECTION)
                    .find()
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray().catch(() => []),
                dbConn.collection(collection.TEACHER_COLLECTION).countDocuments().catch(() => 0),
                dbConn.collection(collection.LEARNING_SPACES_COLLECTION).countDocuments().catch(() => 0),
                dbConn.collection(collection.AUDIT_LOG_COLLECTION)
                    .find({})
                    .sort({ createdAt: -1 })
                    .limit(8)
                    .toArray().catch(() => [])
            ]);

            const totalRevenue = revenueResult[0]?.total || 0;

            const totalChapters = courses.reduce((sum, c) =>
                sum + (c.chapters ? c.chapters.length : 0), 0);

            // Course distribution aggregation
            let courseDistRaw = [];
            try {
                courseDistRaw = await dbConn.collection(collection.STUDENTS_COLLECTION)
                    .aggregate([
                        { $unwind: { path: '$course', preserveNullAndEmptyArrays: false } },
                        { $group: { _id: '$course.courseName', count: { $sum: 1 } } },
                        { $sort: { count: -1 } },
                        { $limit: 5 }
                    ]).toArray();
            } catch (e) {
                courseDistRaw = [];
            }

            const courseDistLabels = courseDistRaw.length ? courseDistRaw.map(c => c._id || 'General') : ['General'];
            const courseDistData = courseDistRaw.length ? courseDistRaw.map(c => c.count) : [totalStudents || 0];

            // For popular course
            const popularCourse = courseDistRaw[0]?._id || 'No Data';

            // Monthly enrollments trend
            const enrollmentCountsByMonth = {};
            monthKeys.forEach(k => { enrollmentCountsByMonth[k] = 0; });

            try {
                const enrollAggr = await dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                    {
                        $match: {
                            createdAt: { $gte: sixMonthsAgo }
                        }
                    },
                    {
                        $group: {
                            _id: {
                                year: { $year: { $toDate: '$createdAt' } },
                                month: { $month: { $toDate: '$createdAt' } }
                            },
                            count: { $sum: 1 }
                        }
                    }
                ]).toArray();

                enrollAggr.forEach(item => {
                    const key = `${item._id.year}-${item._id.month}`;
                    if (enrollmentCountsByMonth[key] !== undefined) {
                        enrollmentCountsByMonth[key] = item.count;
                    }
                });
            } catch (e) {
                // Keep default 0s
            }

            const enrollmentChart = {
                labels: monthLabels,
                data: monthKeys.map(k => enrollmentCountsByMonth[k] || 0)
            };

            // Monthly revenue trend
            const revenueByMonth = {};
            monthKeys.forEach(k => { revenueByMonth[k] = 0; });

            try {
                const revAggr = await dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                    {
                        $match: {
                            createdAt: { $gte: sixMonthsAgo }
                        }
                    },
                    {
                        $group: {
                            _id: {
                                year: { $year: { $toDate: '$createdAt' } },
                                month: { $month: { $toDate: '$createdAt' } }
                            },
                            total: { $sum: { $toDouble: { $ifNull: ['$Paid_Amount', 0] } } }
                        }
                    }
                ]).toArray();

                revAggr.forEach(item => {
                    const key = `${item._id.year}-${item._id.month}`;
                    if (revenueByMonth[key] !== undefined) {
                        revenueByMonth[key] = Math.round(item.total || 0);
                    }
                });
            } catch (e) {
                // Keep default 0s
            }

            const revenueChart = {
                labels: monthLabels,
                data: monthKeys.map(k => revenueByMonth[k] || 0)
            };

            // Format recent activity from audit logs
            const recentActivity = (rawAuditLogs || []).map(log => {
                const meta = getActionIconAndColor(log.action, log.entityType);
                return {
                    id: log._id ? String(log._id) : '',
                    action: log.action || 'Action Performed',
                    message: log.message || `${log.action || 'Updated'} ${log.entityName || log.entityType || ''}`.trim(),
                    actorName: log.admin?.name || 'Admin',
                    status: log.status || 'success',
                    relativeTime: getRelativeTime(log.createdAt),
                    createdAt: log.createdAt,
                    icon: meta.icon,
                    colorClass: meta.colorClass
                };
            });

            // Calculate active ratio percentage
            const activePercentage = totalStudents > 0 
                ? Math.round((activeStudents / totalStudents) * 100) 
                : 0;

            return {
                totalStudents,
                activeStudents,
                expiredStudents,
                totalRevenue,
                totalCourses,
                totalChapters,
                recentStudents,
                popularCourse,
                totalTeachers,
                totalLearningSpaces,
                activePercentage,
                courseDistribution: {
                    labels: courseDistLabels,
                    data: courseDistData
                },
                enrollmentChart,
                revenueChart,
                recentActivity
            };

        } catch (err) {
            throw err;
        }
    },

};