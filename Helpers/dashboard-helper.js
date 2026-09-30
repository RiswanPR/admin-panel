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
        return { icon: 'fa-solid fa-user', colorClass: 'activity-student' };
    }
    if (text.includes('business') || text.includes('organization')) {
        return { icon: 'fa-solid fa-building-shield', colorClass: 'activity-business' };
    }
    if (text.includes('job') || text.includes('opportunity')) {
        return { icon: 'fa-solid fa-briefcase', colorClass: 'activity-job' };
    }
    if (text.includes('verification')) {
        return { icon: 'fa-solid fa-shield-check', colorClass: 'activity-verification' };
    }
    if (text.includes('moderation') || text.includes('report')) {
        return { icon: 'fa-solid fa-shield-halved', colorClass: 'activity-moderation' };
    }
    if (text.includes('error')) {
        return { icon: 'fa-solid fa-triangle-exclamation', colorClass: 'activity-error' };
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
            if (!dbConn) {
                return {
                    totalStudents: 0,
                    activeStudents: 0,
                    totalRevenue: 0,
                    totalCourses: 0,
                    totalChapters: 0,
                    governance: {
                        totalUsers: 0,
                        activeUsers: 0,
                        newUsers7d: 0,
                        pendingVerification: 0,
                        pendingBusinesses: 0,
                        publishedJobs: 0,
                        openOpportunities: 0,
                        openModeration: 0,
                        systemErrors: 0
                    },
                    alerts: [],
                    systemHealth: { database: 'OFFLINE', sessionStore: 'UNKNOWN', errorRate: 'UNKNOWN' },
                    recentActivity: []
                };
            }

            // Build last 6 months keys & labels
            const now = new Date();
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
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
                totalUsers,
                totalStudents,
                totalLearners,
                activeUsers,
                activeStudents,
                activeLearners,
                expiredStudents,
                newUsers7d,
                pendingUsersVerification,
                pendingRequestsVerification,
                totalCourses,
                courses,
                revenueResult,
                recentStudents,
                totalTeachers,
                totalLearningSpaces,
                rawAuditLogs,
                pendingBusinessesCount,
                approvedBusinessesCount,
                publishedJobsCount,
                openModerationCount,
                underReviewModerationCount,
                unresolvedErrorsCount,
                totalMatchesCount
            ] = await Promise.all([
                // 1. Total platform registered users
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments().catch(() => 0),
                // 2. Canonical Student platform identity users (primaryRole: 'STUDENT')
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({
                    $or: [
                        { primaryRole: 'STUDENT' },
                        { primaryRole: { $exists: false }, role: 'student' }
                    ]
                }).catch(() => 0),
                // 3. Enrolled learners (users with at least one course enrollment)
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ 'course.0': { $exists: true } }).catch(() => 0),
                // 4. Active users
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ status: true }).catch(() => 0),
                // 5. Active canonical students
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({
                    $or: [
                        { primaryRole: 'STUDENT' },
                        { primaryRole: { $exists: false }, role: 'student' }
                    ],
                    status: true
                }).catch(() => 0),
                // 6. Active enrolled learners
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ 'course.0': { $exists: true }, status: true }).catch(() => 0),
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ status: false }).catch(() => 0),
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ createdAt: { $gte: sevenDaysAgo } }).catch(() => 0),
                dbConn.collection(collection.STUDENTS_COLLECTION).countDocuments({ verificationStatus: { $in: ['PENDING', 'UNDER_REVIEW'] } }).catch(() => 0),
                dbConn.collection(collection.VERIFICATION_REQUESTS_COLLECTION).countDocuments({ status: 'PENDING' }).catch(() => 0),
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
                    .limit(10)
                    .toArray().catch(() => []),
                dbConn.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['PENDING', 'pending'] } }).catch(() => 0),
                dbConn.collection(collection.ORGANIZATIONS_COLLECTION).countDocuments({ status: { $in: ['APPROVED', 'approved', 'ACTIVE', 'active'] } }).catch(() => 0),
                dbConn.collection(collection.OPPORTUNITIES_COLLECTION).countDocuments({ status: { $in: ['PUBLISHED', 'published'] } }).catch(() => 0),
                dbConn.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['PENDING', 'pending', 'open', 'OPEN'] } }).catch(() => 0),
                dbConn.collection(collection.MODERATION_REPORTS_COLLECTION).countDocuments({ status: { $in: ['REVIEWED', 'reviewed', 'under_review', 'UNDER_REVIEW'] } }).catch(() => 0),
                dbConn.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ status: 'UNRESOLVED' }).catch(() => 0),
                dbConn.collection(collection.JOB_TALENT_MATCHES_COLLECTION).countDocuments({}).catch(() => 0)
            ]);

            const totalRevenue = revenueResult[0]?.total || 0;
            const totalChapters = courses.reduce((sum, c) => sum + (c.chapters ? c.chapters.length : 0), 0);

            // Total pending verifications combines requests and direct user states
            const pendingVerificationCount = Math.max(pendingUsersVerification, pendingRequestsVerification);

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
            const popularCourse = courseDistRaw[0]?._id || 'General';

            // Monthly enrollments trend
            const enrollmentCountsByMonth = {};
            monthKeys.forEach(k => { enrollmentCountsByMonth[k] = 0; });

            try {
                const enrollAggr = await dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                    { $match: { createdAt: { $gte: sixMonthsAgo } } },
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
            } catch (e) {}

            const enrollmentChart = {
                labels: monthLabels,
                data: monthKeys.map(k => enrollmentCountsByMonth[k] || 0)
            };

            // Monthly revenue trend
            const revenueByMonth = {};
            monthKeys.forEach(k => { revenueByMonth[k] = 0; });

            try {
                const revAggr = await dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                    { $match: { createdAt: { $gte: sixMonthsAgo } } },
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
                        revenueByMonth[key] = item.total;
                    }
                });
            } catch (e) {}

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

            // Actionable Alerts / Pending Queue
            const alerts = [];
            if (pendingBusinessesCount > 0) {
                alerts.push({
                    type: 'warning',
                    badge: 'Review Required',
                    title: 'Pending Businesses Queue',
                    message: `${pendingBusinessesCount} business organization(s) awaiting administrative review and approval.`,
                    url: '/admin/businesses?tab=pending',
                    icon: 'fa-solid fa-building-shield'
                });
            }
            if (openModerationCount > 0) {
                alerts.push({
                    type: 'danger',
                    badge: 'Action Required',
                    title: 'Community Moderation Backlog',
                    message: `${openModerationCount} open community report(s) requiring adjudication and resolution.`,
                    url: '/admin/moderation?tab=open',
                    icon: 'fa-solid fa-shield-halved'
                });
            }
            if (pendingVerificationCount > 0) {
                alerts.push({
                    type: 'warning',
                    badge: 'Credentials',
                    title: 'Pending Verification Requests',
                    message: `${pendingVerificationCount} candidate identity or credential verification request(s) awaiting review.`,
                    url: '/admin/verification?status=PENDING',
                    icon: 'fa-solid fa-id-card'
                });
            }
            if (unresolvedErrorsCount > 0) {
                alerts.push({
                    type: 'danger',
                    badge: 'System Alert',
                    title: 'Unresolved Application Errors',
                    message: `${unresolvedErrorsCount} unresolved application error signature(s) detected in system logs.`,
                    url: '/admin/error-reports?status=UNRESOLVED',
                    icon: 'fa-solid fa-triangle-exclamation'
                });
            }

            const activeLearnerPercentage = totalLearners > 0 
                ? Math.round((activeLearners / totalLearners) * 100) 
                : 0;

            const activeStudentPercentage = totalStudents > 0 
                ? Math.round((activeStudents / totalStudents) * 100) 
                : 0;

            const activePercentage = activeLearnerPercentage;

            const systemHealth = {
                database: 'OPERATIONAL',
                sessionStore: 'HEALTHY',
                errorRate: unresolvedErrorsCount > 10 ? 'ELEVATED' : 'NORMAL'
            };

            return {
                totalUsers,
                totalStudents,
                totalLearners,
                totalEnrolledLearners: totalLearners,
                activeUsers,
                activeStudents,
                activeLearners,
                expiredStudents,
                totalRevenue,
                totalCourses,
                totalChapters,
                recentStudents,
                popularCourse,
                totalTeachers,
                totalLearningSpaces,
                activePercentage,
                activeLearnerPercentage,
                activeStudentPercentage,
                courseDistribution: {
                    labels: courseDistLabels,
                    data: courseDistData
                },
                enrollmentChart,
                revenueChart,
                recentActivity,
                alerts,
                systemHealth,
                governance: {
                    totalUsers,
                    totalStudents,
                    totalEnrolledLearners: totalLearners,
                    activeUsers,
                    activeStudents,
                    activeLearners,
                    newUsers7d,
                    pendingVerification: pendingVerificationCount,
                    pendingBusinesses: pendingBusinessesCount,
                    approvedBusinesses: approvedBusinessesCount,
                    publishedJobs: publishedJobsCount,
                    openOpportunities: publishedJobsCount,
                    openModeration: openModerationCount,
                    underReviewModeration: underReviewModerationCount,
                    systemErrors: unresolvedErrorsCount,
                    totalMatches: totalMatchesCount
                }
            };

        } catch (err) {
            throw err;
        }
    }
};