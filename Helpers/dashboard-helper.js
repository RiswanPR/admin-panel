const db = require('../config/connection');
const collection = require('../config/collections');
const permissionsHelper = require('./permissions-helper');

const formatUptime = (seconds) => {
    seconds = Math.floor(Number(seconds) || 0);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
};

// Deterministic Severity Thresholds for Operational Attention
const ATTENTION_SEVERITY_THRESHOLDS = {
    SYSTEM_ERRORS: { CRITICAL: 10, HIGH: 1 },
    COMMUNITY_REPORTS: { CRITICAL: 15, HIGH: 5, MEDIUM: 1 },
    MODERATION_BACKLOG: { HIGH: 15, MEDIUM: 1 },
    PENDING_BUSINESSES: { HIGH: 10, MEDIUM: 1 },
    VERIFICATION_REQUESTS: { HIGH: 10, MEDIUM: 1 }
};

/**
 * Pure deterministic trend calculation helper.
 * Never produces NaN or Infinity. Safely handles missing/zero baselines.
 */
const calculateTrend = (current = 0, previous = 0, label = 'vs prev 7d') => {
    const curr = Number(current) || 0;
    const prev = Number(previous) || 0;
    const delta = curr - prev;
    let deltaPercent = 0;
    let direction = 'flat';

    if (prev === 0) {
        deltaPercent = curr > 0 ? 100 : 0;
    } else {
        deltaPercent = Math.round((delta / prev) * 100);
    }

    if (delta > 0) {
        direction = 'up';
    } else if (delta < 0) {
        direction = 'down';
    } else {
        direction = 'flat';
    }

    const isPositive = delta > 0;
    const sign = delta > 0 ? '+' : '';
    const text = delta === 0 ? `0% ${label}` : `${sign}${deltaPercent}% ${label}`;

    return {
        current: curr,
        previous: prev,
        delta,
        deltaPercent,
        direction,
        isPositive,
        text
    };
};

const getSeverityBadgeClass = (sev) => {
    switch (sev) {
        case 'critical': return 'bg-danger text-white';
        case 'high': return 'bg-warning-subtle text-warning border-warning';
        case 'medium': return 'bg-info-subtle text-info border-info';
        default: return 'bg-secondary-subtle text-muted';
    }
};

/**
 * Builds unified capability-filtered attention model and operational health.
 * Prevents side-channel leakage by evaluating ONLY queues visible to the requesting admin.
 */
const buildAttentionModel = ({
    canViewErrors = false,
    canModerate = false,
    canReviewBusinesses = false,
    canVerify = false,
    unresolvedErrorsCount = 0,
    communityPendingReports = 0,
    openModerationCount = 0,
    pendingBusinessesCount = 0,
    pendingVerificationCount = 0
}) => {
    const items = [];

    if (canViewErrors && unresolvedErrorsCount > 0) {
        const severity = unresolvedErrorsCount >= ATTENTION_SEVERITY_THRESHOLDS.SYSTEM_ERRORS.CRITICAL
            ? 'critical'
            : (unresolvedErrorsCount >= ATTENTION_SEVERITY_THRESHOLDS.SYSTEM_ERRORS.HIGH ? 'high' : 'medium');
        items.push({
            key: 'system_errors',
            title: 'Unresolved System Errors',
            count: unresolvedErrorsCount,
            severity,
            badgeClass: getSeverityBadgeClass(severity),
            description: `${unresolvedErrorsCount} unresolved error signature(s) detected in system error logs.`,
            href: '/admin/error-reports?status=UNRESOLVED',
            actionText: 'Inspect Logs',
            icon: 'fa-solid fa-triangle-exclamation',
            capability: 'view_system_errors'
        });
    }

    if (canModerate && communityPendingReports > 0) {
        const severity = communityPendingReports >= ATTENTION_SEVERITY_THRESHOLDS.COMMUNITY_REPORTS.CRITICAL
            ? 'critical'
            : (communityPendingReports >= ATTENTION_SEVERITY_THRESHOLDS.COMMUNITY_REPORTS.HIGH ? 'high' : 'medium');
        items.push({
            key: 'community_reports',
            title: 'Pending Community Reports',
            count: communityPendingReports,
            severity,
            badgeClass: getSeverityBadgeClass(severity),
            description: `${communityPendingReports} community report(s) awaiting triage in Reports Center.`,
            href: '/admin/community/reports?status=pending',
            actionText: 'Triage Reports',
            icon: 'fa-solid fa-flag',
            capability: 'moderate_content'
        });
    }

    if (canModerate && openModerationCount > 0) {
        const severity = openModerationCount >= ATTENTION_SEVERITY_THRESHOLDS.MODERATION_BACKLOG.HIGH ? 'high' : 'medium';
        items.push({
            key: 'moderation_backlog',
            title: 'Community Moderation Backlog',
            count: openModerationCount,
            severity,
            badgeClass: getSeverityBadgeClass(severity),
            description: `${openModerationCount} open community report(s) requiring adjudication and resolution.`,
            href: '/admin/moderation?tab=open',
            actionText: 'Adjudicate',
            icon: 'fa-solid fa-shield-halved',
            capability: 'moderate_content'
        });
    }

    if (canReviewBusinesses && pendingBusinessesCount > 0) {
        const severity = pendingBusinessesCount >= ATTENTION_SEVERITY_THRESHOLDS.PENDING_BUSINESSES.HIGH ? 'high' : 'medium';
        items.push({
            key: 'pending_businesses',
            title: 'Pending Business Approvals',
            count: pendingBusinessesCount,
            severity,
            badgeClass: getSeverityBadgeClass(severity),
            description: `${pendingBusinessesCount} business organization(s) awaiting administrative review and approval.`,
            href: '/admin/businesses?tab=pending',
            actionText: 'Review Applications',
            icon: 'fa-solid fa-building-shield',
            capability: 'review_businesses'
        });
    }

    if (canVerify && pendingVerificationCount > 0) {
        const severity = pendingVerificationCount >= ATTENTION_SEVERITY_THRESHOLDS.VERIFICATION_REQUESTS.HIGH ? 'high' : 'medium';
        items.push({
            key: 'verification_requests',
            title: 'Pending Identity Verifications',
            count: pendingVerificationCount,
            severity,
            badgeClass: getSeverityBadgeClass(severity),
            description: `${pendingVerificationCount} candidate identity or credential verification request(s) awaiting review.`,
            href: '/admin/verification?status=PENDING',
            actionText: 'Verify Credentials',
            icon: 'fa-solid fa-id-card',
            capability: 'manage_verification'
        });
    }

    // Sort items deterministically: critical first, then high, then medium, then count descending
    const severityWeight = { critical: 4, high: 3, medium: 2, low: 1 };
    items.sort((a, b) => {
        const diff = (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
        if (diff !== 0) return diff;
        return b.count - a.count;
    });

    const total = items.reduce((sum, item) => sum + item.count, 0);
    const hasCritical = items.some(item => item.severity === 'critical');
    const hasHigh = items.some(item => item.severity === 'high');

    // Build operational health state strictly from visible queues to prevent side-channel leakage
    const evaluatedSignals = [];
    if (canViewErrors) evaluatedSignals.push('system_errors');
    if (canModerate) evaluatedSignals.push('community_reports', 'moderation_backlog');
    if (canReviewBusinesses) evaluatedSignals.push('pending_businesses');
    if (canVerify) evaluatedSignals.push('verification_requests');

    let healthStatus = 'HEALTHY';
    let healthLabel = 'Healthy';
    let healthBadgeClass = 'bg-success-subtle text-success border-success';
    let healthIcon = 'fa-solid fa-circle-check text-success';
    let healthSummary = 'All visible operational queues are clear and systems operating within normal parameters.';

    if (hasCritical) {
        healthStatus = 'CRITICAL';
        healthLabel = 'Critical Attention';
        healthBadgeClass = 'bg-danger text-white border-danger';
        healthIcon = 'fa-solid fa-circle-exclamation text-white';
        healthSummary = 'Critical operational issues require immediate administrative attention.';
    } else if (hasHigh || items.length > 0) {
        healthStatus = 'ATTENTION_REQUIRED';
        healthLabel = 'Attention Required';
        healthBadgeClass = 'bg-warning-subtle text-warning border-warning';
        healthIcon = 'fa-solid fa-triangle-exclamation text-warning';
        healthSummary = `${items.length} operational queue(s) require review and processing (${total} total actionable items).`;
    }

    const operationalHealth = {
        status: healthStatus,
        label: healthLabel,
        badgeClass: healthBadgeClass,
        icon: healthIcon,
        summary: healthSummary,
        hasCritical,
        actionableQueueCount: items.length,
        evaluatedSignals
    };

    return {
        attention: {
            visible: canViewErrors || canModerate || canReviewBusinesses || canVerify,
            total,
            queueCount: items.length,
            hasCritical,
            items
        },
        operationalHealth
    };
};

const getSafeFallbackData = (admin = null) => {
    const isSuperuser = admin && admin.role === 'superuser';
    const canViewRevenue = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'manage_settings');
    const canViewErrors = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'view_system_errors');
    const canModerate = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'moderate_content');

    return {
        totalUsers: 0,
        totalStudents: 0,
        totalLearners: 0,
        totalEnrolledLearners: 0,
        activeUsers: 0,
        activeStudents: 0,
        activeLearners: 0,
        expiredStudents: 0,
        totalRevenue: canViewRevenue ? 0 : null,
        totalCourses: 0,
        totalChapters: 0,
        recentStudents: [],
        popularCourse: 'General',
        totalTeachers: 0,
        totalLearningSpaces: 0,
        activePercentage: 0,
        activeLearnerPercentage: 0,
        activeStudentPercentage: 0,
        courseDistribution: {
            labels: ['General'],
            data: [0]
        },
        enrollmentChart: {
            labels: [],
            data: []
        },
        revenueChart: {
            labels: [],
            data: []
        },
        recentActivity: [],
        alerts: [],
        systemHealth: {
            database: 'OFFLINE',
            sessionStore: 'HEALTHY',
            errorRate: canViewErrors ? 'UNKNOWN' : 'RESTRICTED',
            uptimeFormatted: formatUptime(process.uptime())
        },
        operationalHealth: {
            status: 'CRITICAL',
            label: 'Offline / Critical',
            badgeClass: 'bg-danger-subtle text-danger border-danger',
            icon: 'fa-solid fa-circle-exclamation text-danger',
            summary: 'Database is Offline. Live telemetry unavailable; system running in resilient fallback mode.',
            hasCritical: true,
            actionableQueueCount: 0,
            evaluatedSignals: []
        },
        attention: {
            visible: true,
            total: 0,
            queueCount: 0,
            hasCritical: false,
            items: []
        },
        trends: {
            users7d: calculateTrend(0, 0, 'vs prev 7d'),
            posts7d: calculateTrend(0, 0, 'vs prev 7d'),
            comments7d: calculateTrend(0, 0, 'vs prev 7d'),
            stories7d: calculateTrend(0, 0, 'vs prev 7d'),
            communityActivity7d: calculateTrend(0, 0, 'vs prev 7d'),
            monthlyEnrollment: calculateTrend(0, 0, 'vs prev month'),
            monthlyRevenue: canViewRevenue ? calculateTrend(0, 0, 'vs prev month') : null,
            communityReports7d: canModerate ? calculateTrend(0, 0, 'vs prev 7d') : null
        },
        community: {
            overview: {
                totalPosts: 0,
                activePosts: 0,
                newPosts7d: 0,
                totalComments: 0,
                activeComments: 0,
                newComments7d: 0,
                totalStories: 0,
                activeStories: 0,
                newStories7d: 0
            },
            trends: {
                posts: calculateTrend(0, 0, 'vs prev 7d'),
                comments: calculateTrend(0, 0, 'vs prev 7d'),
                stories: calculateTrend(0, 0, 'vs prev 7d'),
                activity: calculateTrend(0, 0, 'vs prev 7d'),
                reports: canModerate ? calculateTrend(0, 0, 'vs prev 7d') : null
            },
            moderation: {
                visible: canModerate,
                totalReports: canModerate ? 0 : null,
                pendingReports: canModerate ? 0 : null,
                underReviewReports: canModerate ? 0 : null,
                totalActionable: canModerate ? 0 : null,
                reportsByType: canModerate ? { post: 0, comment: 0, story: 0, user: 0 } : {}
            },
            recentActivityCount: 0
        },
        governance: {
            totalUsers: 0,
            totalStudents: 0,
            totalEnrolledLearners: 0,
            activeUsers: 0,
            activeStudents: 0,
            activeLearners: 0,
            newUsers7d: 0,
            prevUsers7d: 0,
            pendingVerification: 0,
            pendingBusinesses: 0,
            approvedBusinesses: 0,
            publishedJobs: 0,
            activeJobs: 0,
            openOpportunities: 0,
            openModeration: 0,
            underReviewModeration: 0,
            systemErrors: canViewErrors ? 0 : 0,
            totalMatches: 0,
            communityPosts: 0,
            communityComments: 0,
            communityStories: 0,
            communityPendingReports: canModerate ? 0 : null
        }
    };
};

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

    ATTENTION_SEVERITY_THRESHOLDS,
    calculateTrend,
    buildAttentionModel,
    getSafeFallbackData,

    getDashboardData: async (admin = null) => {
        try {
            const isSuperuser = admin && admin.role === 'superuser';
            const canViewRevenue = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'manage_settings');
            const canViewErrors = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'view_system_errors');
            const canReviewBusinesses = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'review_businesses') || permissionsHelper.hasCapability(admin, 'manage_businesses');
            const canModerate = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'moderate_content');
            const canVerify = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'manage_verification');
            const canViewAudit = isSuperuser || !admin || permissionsHelper.hasCapability(admin, 'view_audit_logs');

            const dbConn = db.get();
            if (!dbConn) {
                return getSafeFallbackData(admin);
            }

            // Build last 6 months keys & labels
            const now = new Date();
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
            const monthLabels = [];
            const monthKeys = [];
            for (let i = 5; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                monthLabels.push(d.toLocaleString('en-US', { month: 'short' }));
                monthKeys.push(`${d.getFullYear()}-${d.getMonth() + 1}`);
            }
            const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

            // 1. Consolidated Platform User Metrics (single aggregation pass over STUDENTS_COLLECTION)
            const userStatsPromise = dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                {
                    $group: {
                        _id: null,
                        totalUsers: { $sum: 1 },
                        totalStudents: {
                            $sum: {
                                $cond: [
                                    {
                                        $or: [
                                            { $eq: ['$primaryRole', 'STUDENT'] },
                                            {
                                                $and: [
                                                    { $or: [{ $eq: ['$primaryRole', null] }, { $eq: [{ $type: '$primaryRole' }, 'missing'] }] },
                                                    { $eq: ['$role', 'student'] }
                                                ]
                                            }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        totalLearners: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $isArray: '$course' },
                                            { $gt: [{ $size: '$course' }, 0] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        activeUsers: {
                            $sum: { $cond: [{ $eq: ['$status', true] }, 1, 0] }
                        },
                        activeStudents: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$status', true] },
                                            {
                                                $or: [
                                                    { $eq: ['$primaryRole', 'STUDENT'] },
                                                    {
                                                        $and: [
                                                            { $or: [{ $eq: ['$primaryRole', null] }, { $eq: [{ $type: '$primaryRole' }, 'missing'] }] },
                                                            { $eq: ['$role', 'student'] }
                                                        ]
                                                    }
                                                ]
                                            }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        activeLearners: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$status', true] },
                                            { $isArray: '$course' },
                                            { $gt: [{ $size: '$course' }, 0] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        expiredStudents: {
                            $sum: { $cond: [{ $eq: ['$status', false] }, 1, 0] }
                        },
                        newUsers7d: {
                            $sum: {
                                $cond: [
                                    { $gte: [{ $toDate: '$createdAt' }, sevenDaysAgo] },
                                    1,
                                    0
                                ]
                            }
                        },
                        prevUsers7d: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $gte: [{ $toDate: '$createdAt' }, fourteenDaysAgo] },
                                            { $lt: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        pendingUsersVerification: {
                            $sum: {
                                $cond: [
                                    { $in: ['$verificationStatus', ['PENDING', 'UNDER_REVIEW']] },
                                    1,
                                    0
                                ]
                            }
                        },
                        totalRevenue: {
                            $sum: {
                                $convert: {
                                    input: '$Paid_Amount',
                                    to: 'double',
                                    onError: 0,
                                    onNull: 0
                                }
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 2. Consolidated Course Metrics (server-side chapter count via $size without loading documents into Node.js)
            const courseStatsPromise = dbConn.collection(collection.COURSE_COLLECTION).aggregate([
                {
                    $group: {
                        _id: null,
                        totalCourses: { $sum: 1 },
                        totalChapters: {
                            $sum: {
                                $cond: [
                                    { $isArray: '$chapters' },
                                    { $size: '$chapters' },
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 3. Consolidated Organization Metrics (pending and approved counts in one aggregation)
            const orgStatsPromise = dbConn.collection(collection.ORGANIZATIONS_COLLECTION).aggregate([
                {
                    $group: {
                        _id: null,
                        pending: {
                            $sum: {
                                $cond: [
                                    { $in: ['$status', ['PENDING', 'pending']] },
                                    1,
                                    0
                                ]
                            }
                        },
                        approved: {
                            $sum: {
                                $cond: [
                                    { $in: ['$status', ['APPROVED', 'approved', 'ACTIVE', 'active']] },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 4. Consolidated Moderation Reports Metrics (open and underReview counts in one aggregation)
            const modStatsPromise = dbConn.collection(collection.MODERATION_REPORTS_COLLECTION).aggregate([
                {
                    $group: {
                        _id: null,
                        open: {
                            $sum: {
                                $cond: [
                                    { $in: ['$status', ['PENDING', 'pending', 'open', 'OPEN']] },
                                    1,
                                    0
                                ]
                            }
                        },
                        underReview: {
                            $sum: {
                                $cond: [
                                    { $in: ['$status', ['REVIEWED', 'reviewed', 'under_review', 'UNDER_REVIEW']] },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 5. Recent registered students with lean projection (excluding credentials, password, and heavy objects)
            const recentStudentsPromise = dbConn.collection(collection.STUDENTS_COLLECTION)
                .find({}, {
                    projection: {
                        Name: 1,
                        Email: 1,
                        'course.courseName': 1,
                        'account_Status.isActive': 1,
                        createdAt: 1
                    }
                })
                .sort({ createdAt: -1 })
                .limit(5)
                .toArray().catch(() => []);

            // 6. Verification requests count
            const pendingRequestsVerificationPromise = dbConn.collection(collection.VERIFICATION_REQUESTS_COLLECTION)
                .countDocuments({ status: 'PENDING' }).catch(() => 0);

            // 7. Teachers count
            const totalTeachersPromise = dbConn.collection(collection.TEACHER_COLLECTION)
                .countDocuments().catch(() => 0);

            // 8. Learning spaces count
            const totalLearningSpacesPromise = dbConn.collection(collection.LEARNING_SPACES_COLLECTION)
                .countDocuments().catch(() => 0);

            // 9. Published jobs / opportunities count
            const publishedJobsPromise = dbConn.collection(collection.OPPORTUNITIES_COLLECTION)
                .countDocuments({ status: { $in: ['PUBLISHED', 'published'] } }).catch(() => 0);

            // 10. Job talent matches count
            const totalMatchesPromise = dbConn.collection(collection.JOB_TALENT_MATCHES_COLLECTION)
                .countDocuments({}).catch(() => 0);

            // 11. Error reports (conditionally queried only if admin has view_system_errors capability)
            const unresolvedErrorsPromise = canViewErrors
                ? dbConn.collection(collection.ERROR_REPORTS_COLLECTION).countDocuments({ status: 'UNRESOLVED' }).catch(() => 0)
                : Promise.resolve(0);

            // 12. Audit logs (conditionally queried only if admin has view_audit_logs capability, with lean projection)
            const rawAuditLogsPromise = canViewAudit
                ? dbConn.collection(collection.AUDIT_LOG_COLLECTION)
                    .find({}, {
                        projection: {
                            action: 1,
                            entityType: 1,
                            entityName: 1,
                            message: 1,
                            'admin.name': 1,
                            status: 1,
                            createdAt: 1
                        }
                    })
                    .sort({ createdAt: -1 })
                    .limit(10)
                    .toArray().catch(() => [])
                : Promise.resolve([]);

            // 13. Course distribution (pre-filtered with match { 'course.0': { $exists: true } } before $unwind)
            const courseDistPromise = dbConn.collection(collection.STUDENTS_COLLECTION)
                .aggregate([
                    { $match: { 'course.0': { $exists: true } } },
                    { $unwind: { path: '$course', preserveNullAndEmptyArrays: false } },
                    { $group: { _id: '$course.courseName', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 5 }
                ]).toArray().catch(() => []);

            // 14. Monthly trends (single pass over 6-month window for BOTH enrollment and revenue)
            const monthlyTrendPromise = dbConn.collection(collection.STUDENTS_COLLECTION).aggregate([
                { $match: { createdAt: { $gte: sixMonthsAgo } } },
                {
                    $group: {
                        _id: {
                            year: { $year: { $toDate: '$createdAt' } },
                            month: { $month: { $toDate: '$createdAt' } }
                        },
                        enrollmentCount: { $sum: 1 },
                        revenueTotal: {
                            $sum: {
                                $convert: {
                                    input: '$Paid_Amount',
                                    to: 'double',
                                    onError: 0,
                                    onNull: 0
                                }
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 15. Community Posts aggregation (total, active, new in 7 days, previous 7-14 days)
            const communityPostsPromise = dbConn.collection(collection.COMMUNITY_POSTS_COLLECTION).aggregate([
                {
                    $group: {
                        _id: null,
                        totalPosts: { $sum: 1 },
                        activePosts: { $sum: { $cond: [{ $ne: ['$isDeleted', true] }, 1, 0] } },
                        newPosts7d: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$isDeleted', true] },
                                            { $gte: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        prevPosts7d: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$isDeleted', true] },
                                            { $gte: [{ $toDate: '$createdAt' }, fourteenDaysAgo] },
                                            { $lt: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 16. Community Comments aggregation (total, active, new in 7 days, previous 7-14 days)
            const communityCommentsPromise = dbConn.collection(collection.COMMUNITY_COMMENTS_COLLECTION).aggregate([
                {
                    $group: {
                        _id: null,
                        totalComments: { $sum: 1 },
                        activeComments: { $sum: { $cond: [{ $ne: ['$isDeleted', true] }, 1, 0] } },
                        newComments7d: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$isDeleted', true] },
                                            { $gte: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        prevComments7d: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$isDeleted', true] },
                                            { $gte: [{ $toDate: '$createdAt' }, fourteenDaysAgo] },
                                            { $lt: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 17. Community Stories aggregation (total, active [not expired & not deleted], new in 7 days, previous 7-14 days)
            const communityStoriesPromise = dbConn.collection(collection.COMMUNITY_STORIES_COLLECTION).aggregate([
                {
                    $group: {
                        _id: null,
                        totalStories: { $sum: 1 },
                        activeStories: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$isDeleted', true] },
                                            { $gt: [{ $toDate: '$expiresAt' }, now] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        newStories7d: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$isDeleted', true] },
                                            { $gte: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        prevStories7d: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $ne: ['$isDeleted', true] },
                                            { $gte: [{ $toDate: '$createdAt' }, fourteenDaysAgo] },
                                            { $lt: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).toArray().catch(() => []);

            // 18. Community Reports aggregation (capability-gated: only if canModerate, otherwise Promise.resolve([]))
            const communityReportsPromise = canModerate
                ? dbConn.collection(collection.COMMUNITY_REPORTS_COLLECTION).aggregate([
                    {
                        $group: {
                            _id: null,
                            totalReports: { $sum: 1 },
                            pendingReports: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$status', ['pending', 'PENDING', 'open', 'OPEN']] },
                                        1,
                                        0
                                    ]
                                }
                            },
                            underReviewReports: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$status', ['investigating', 'INVESTIGATING', 'reviewed', 'REVIEWED', 'under_review', 'UNDER_REVIEW']] },
                                        1,
                                        0
                                    ]
                                }
                            },
                            newReports7d: {
                                $sum: {
                                    $cond: [
                                        { $gte: [{ $toDate: '$createdAt' }, sevenDaysAgo] },
                                        1,
                                        0
                                    ]
                                }
                            },
                            prevReports7d: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $gte: [{ $toDate: '$createdAt' }, fourteenDaysAgo] },
                                                { $lt: [{ $toDate: '$createdAt' }, sevenDaysAgo] }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            },
                            postReports: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $in: ['$status', ['pending', 'PENDING', 'open', 'OPEN', 'investigating', 'INVESTIGATING', 'reviewed', 'REVIEWED', 'under_review', 'UNDER_REVIEW']] },
                                                { $eq: [{ $toLower: '$entityType' }, 'post'] }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            },
                            commentReports: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $in: ['$status', ['pending', 'PENDING', 'open', 'OPEN', 'investigating', 'INVESTIGATING', 'reviewed', 'REVIEWED', 'under_review', 'UNDER_REVIEW']] },
                                                { $eq: [{ $toLower: '$entityType' }, 'comment'] }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            },
                            storyReports: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $in: ['$status', ['pending', 'PENDING', 'open', 'OPEN', 'investigating', 'INVESTIGATING', 'reviewed', 'REVIEWED', 'under_review', 'UNDER_REVIEW']] },
                                                { $eq: [{ $toLower: '$entityType' }, 'story'] }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            },
                            userReports: {
                                $sum: {
                                    $cond: [
                                        {
                                            $and: [
                                                { $in: ['$status', ['pending', 'PENDING', 'open', 'OPEN', 'investigating', 'INVESTIGATING', 'reviewed', 'REVIEWED', 'under_review', 'UNDER_REVIEW']] },
                                                { $eq: [{ $toLower: '$entityType' }, 'user'] }
                                            ]
                                        },
                                        1,
                                        0
                                    ]
                                }
                            }
                        }
                    }
                ]).toArray().catch(() => [])
                : Promise.resolve([]);

            // Execute primary queries in parallel
            const [
                userStatsResult,
                courseStatsResult,
                orgStatsResult,
                modStatsResult,
                recentStudents,
                pendingRequestsVerification,
                totalTeachers,
                totalLearningSpaces,
                publishedJobsCount,
                totalMatchesCount,
                unresolvedErrorsCount,
                rawAuditLogs,
                courseDistRaw,
                monthlyTrendResult,
                communityPostsResult,
                communityCommentsResult,
                communityStoriesResult,
                communityReportsResult
            ] = await Promise.all([
                userStatsPromise,
                courseStatsPromise,
                orgStatsPromise,
                modStatsPromise,
                recentStudentsPromise,
                pendingRequestsVerificationPromise,
                totalTeachersPromise,
                totalLearningSpacesPromise,
                publishedJobsPromise,
                totalMatchesPromise,
                unresolvedErrorsPromise,
                rawAuditLogsPromise,
                courseDistPromise,
                monthlyTrendPromise,
                communityPostsPromise,
                communityCommentsPromise,
                communityStoriesPromise,
                communityReportsPromise
            ]);

            const userStats = (userStatsResult && userStatsResult[0]) || {};
            const totalUsers = userStats.totalUsers || 0;
            const totalStudents = userStats.totalStudents || 0;
            const totalLearners = userStats.totalLearners || 0;
            const activeUsers = userStats.activeUsers || 0;
            const activeStudents = userStats.activeStudents || 0;
            const activeLearners = userStats.activeLearners || 0;
            const expiredStudents = userStats.expiredStudents || 0;
            const newUsers7d = userStats.newUsers7d || 0;
            const pendingUsersVerification = userStats.pendingUsersVerification || 0;
            const totalRevenue = userStats.totalRevenue || 0;

            const courseStats = (courseStatsResult && courseStatsResult[0]) || {};
            const totalCourses = courseStats.totalCourses || 0;
            const totalChapters = courseStats.totalChapters || 0;

            const orgStats = (orgStatsResult && orgStatsResult[0]) || {};
            const pendingBusinessesCount = orgStats.pending || 0;
            const approvedBusinessesCount = orgStats.approved || 0;

            const modStats = (modStatsResult && modStatsResult[0]) || {};
            const openModerationCount = modStats.open || 0;
            const underReviewModerationCount = modStats.underReview || 0;

            // Total pending verifications combines requests and direct user states
            const pendingVerificationCount = Math.max(pendingUsersVerification, pendingRequestsVerification);

            const courseDistLabels = (courseDistRaw && courseDistRaw.length) ? courseDistRaw.map(c => c._id || 'General') : ['General'];
            const courseDistData = (courseDistRaw && courseDistRaw.length) ? courseDistRaw.map(c => c.count) : [totalStudents || 0];
            const popularCourse = (courseDistRaw && courseDistRaw[0])?._id || 'General';

            // Populate monthly trends from unified single-pass aggregation
            const enrollmentCountsByMonth = {};
            const revenueByMonth = {};
            monthKeys.forEach(k => {
                enrollmentCountsByMonth[k] = 0;
                revenueByMonth[k] = 0;
            });

            (monthlyTrendResult || []).forEach(item => {
                if (item && item._id && item._id.year && item._id.month) {
                    const key = `${item._id.year}-${item._id.month}`;
                    if (enrollmentCountsByMonth[key] !== undefined) {
                        enrollmentCountsByMonth[key] = item.enrollmentCount || 0;
                    }
                    if (revenueByMonth[key] !== undefined) {
                        revenueByMonth[key] = item.revenueTotal || 0;
                    }
                }
            });

            const enrollmentChart = {
                labels: monthLabels,
                data: monthKeys.map(k => enrollmentCountsByMonth[k] || 0)
            };

            const revenueChart = {
                labels: monthLabels,
                data: monthKeys.map(k => revenueByMonth[k] || 0)
            };

            // Format recent activity from audit logs
            const recentActivity = canViewAudit ? (rawAuditLogs || []).map(log => {
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
            }) : [];

            // Actionable Alerts / Pending Queue
            const alerts = [];
            if (pendingBusinessesCount > 0 && canReviewBusinesses) {
                alerts.push({
                    type: 'warning',
                    badge: 'Review Required',
                    title: 'Pending Businesses Queue',
                    message: `${pendingBusinessesCount} business organization(s) awaiting administrative review and approval.`,
                    url: '/admin/businesses?tab=pending',
                    icon: 'fa-solid fa-building-shield'
                });
            }
            if (openModerationCount > 0 && canModerate) {
                alerts.push({
                    type: 'danger',
                    badge: 'Action Required',
                    title: 'Community Moderation Backlog',
                    message: `${openModerationCount} open community report(s) requiring adjudication and resolution.`,
                    url: '/admin/moderation?tab=open',
                    icon: 'fa-solid fa-shield-halved'
                });
            }
            if (pendingVerificationCount > 0 && canVerify) {
                alerts.push({
                    type: 'warning',
                    badge: 'Credentials',
                    title: 'Pending Verification Requests',
                    message: `${pendingVerificationCount} candidate identity or credential verification request(s) awaiting review.`,
                    url: '/admin/verification?status=PENDING',
                    icon: 'fa-solid fa-id-card'
                });
            }
            if (unresolvedErrorsCount > 0 && canViewErrors) {
                alerts.push({
                    type: 'danger',
                    badge: 'System Alert',
                    title: 'Unresolved Application Errors',
                    message: `${unresolvedErrorsCount} unresolved application error signature(s) detected in system logs.`,
                    url: '/admin/error-reports?status=UNRESOLVED',
                    icon: 'fa-solid fa-triangle-exclamation'
                });
            }

            // Unpack Community Metrics
            const postsStats = (communityPostsResult && communityPostsResult[0]) || {};
            const commentsStats = (communityCommentsResult && communityCommentsResult[0]) || {};
            const storiesStats = (communityStoriesResult && communityStoriesResult[0]) || {};
            const reportsStats = (communityReportsResult && communityReportsResult[0]) || {};

            const communityTotalPosts = postsStats.totalPosts || 0;
            const communityActivePosts = postsStats.activePosts || 0;
            const communityNewPosts7d = postsStats.newPosts7d || 0;
            const communityPrevPosts7d = postsStats.prevPosts7d || 0;

            const communityTotalComments = commentsStats.totalComments || 0;
            const communityActiveComments = commentsStats.activeComments || 0;
            const communityNewComments7d = commentsStats.newComments7d || 0;
            const communityPrevComments7d = commentsStats.prevComments7d || 0;

            const communityTotalStories = storiesStats.totalStories || 0;
            const communityActiveStories = storiesStats.activeStories || 0;
            const communityNewStories7d = storiesStats.newStories7d || 0;
            const communityPrevStories7d = storiesStats.prevStories7d || 0;

            const communityTotalReports = canModerate ? (reportsStats.totalReports || 0) : null;
            const communityPendingReports = canModerate ? (reportsStats.pendingReports || 0) : null;
            const communityUnderReviewReports = canModerate ? (reportsStats.underReviewReports || 0) : null;
            const communityTotalActionable = canModerate ? ((communityPendingReports || 0) + (communityUnderReviewReports || 0)) : null;
            const communityNewReports7d = canModerate ? (reportsStats.newReports7d || 0) : null;
            const communityPrevReports7d = canModerate ? (reportsStats.prevReports7d || 0) : null;

            const communityReportsByType = canModerate ? {
                post: reportsStats.postReports || 0,
                comment: reportsStats.commentReports || 0,
                story: reportsStats.storyReports || 0,
                user: reportsStats.userReports || 0
            } : {};

            const communityRecentActivityCount = communityNewPosts7d + communityNewComments7d + communityNewStories7d;
            const communityPrevRecentActivityCount = communityPrevPosts7d + communityPrevComments7d + communityPrevStories7d;

            if (canModerate && (communityPendingReports || 0) > 0) {
                alerts.push({
                    type: 'danger',
                    badge: 'Action Required',
                    title: 'Community Reports Pending',
                    message: `${communityPendingReports} pending community report(s) awaiting triage in Reports Center.`,
                    url: '/admin/community/reports?status=pending',
                    icon: 'fa-solid fa-flag'
                });
            }

            // Month-over-month trends (last month in window vs previous month)
            const currentMonthKey = monthKeys[monthKeys.length - 1];
            const prevMonthKey = monthKeys[monthKeys.length - 2];
            const currentMonthEnrollment = enrollmentCountsByMonth[currentMonthKey] || 0;
            const prevMonthEnrollment = enrollmentCountsByMonth[prevMonthKey] || 0;
            const currentMonthRevenue = revenueByMonth[currentMonthKey] || 0;
            const prevMonthRevenue = revenueByMonth[prevMonthKey] || 0;

            const prevUsers7d = userStats.prevUsers7d || 0;

            const trends = {
                users7d: calculateTrend(newUsers7d, prevUsers7d, 'vs prev 7d'),
                posts7d: calculateTrend(communityNewPosts7d, communityPrevPosts7d, 'vs prev 7d'),
                comments7d: calculateTrend(communityNewComments7d, communityPrevComments7d, 'vs prev 7d'),
                stories7d: calculateTrend(communityNewStories7d, communityPrevStories7d, 'vs prev 7d'),
                communityActivity7d: calculateTrend(communityRecentActivityCount, communityPrevRecentActivityCount, 'vs prev 7d'),
                monthlyEnrollment: calculateTrend(currentMonthEnrollment, prevMonthEnrollment, 'vs prev month'),
                monthlyRevenue: canViewRevenue ? calculateTrend(currentMonthRevenue, prevMonthRevenue, 'vs prev month') : null,
                communityReports7d: canModerate ? calculateTrend(communityNewReports7d, communityPrevReports7d, 'vs prev 7d') : null
            };

            const { attention, operationalHealth } = buildAttentionModel({
                canViewErrors,
                canModerate,
                canReviewBusinesses,
                canVerify,
                unresolvedErrorsCount,
                communityPendingReports: communityPendingReports || 0,
                openModerationCount,
                pendingBusinessesCount,
                pendingVerificationCount
            });

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
                errorRate: canViewErrors ? (unresolvedErrorsCount > 10 ? 'ELEVATED' : 'NORMAL') : 'RESTRICTED',
                uptimeFormatted: formatUptime(process.uptime())
            };

            const community = {
                overview: {
                    totalPosts: communityTotalPosts,
                    activePosts: communityActivePosts,
                    newPosts7d: communityNewPosts7d,
                    totalComments: communityTotalComments,
                    activeComments: communityActiveComments,
                    newComments7d: communityNewComments7d,
                    totalStories: communityTotalStories,
                    activeStories: communityActiveStories,
                    newStories7d: communityNewStories7d
                },
                trends: {
                    posts: trends.posts7d,
                    comments: trends.comments7d,
                    stories: trends.stories7d,
                    activity: trends.communityActivity7d,
                    reports: trends.communityReports7d
                },
                moderation: {
                    visible: canModerate,
                    totalReports: communityTotalReports,
                    pendingReports: communityPendingReports,
                    underReviewReports: communityUnderReviewReports,
                    totalActionable: communityTotalActionable,
                    reportsByType: communityReportsByType,
                    reportsTrend: trends.communityReports7d
                },
                recentActivityCount: communityRecentActivityCount
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
                totalRevenue: canViewRevenue ? totalRevenue : null,
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
                revenueChart: canViewRevenue ? revenueChart : { labels: [], data: [] },
                recentActivity,
                alerts,
                systemHealth,
                operationalHealth,
                attention,
                trends,
                community,
                governance: {
                    totalUsers,
                    totalStudents,
                    totalEnrolledLearners: totalLearners,
                    activeUsers,
                    activeStudents,
                    activeLearners,
                    newUsers7d,
                    prevUsers7d,
                    pendingVerification: pendingVerificationCount,
                    pendingBusinesses: pendingBusinessesCount,
                    approvedBusinesses: approvedBusinessesCount,
                    publishedJobs: publishedJobsCount,
                    activeJobs: publishedJobsCount,
                    openOpportunities: publishedJobsCount,
                    openModeration: openModerationCount,
                    underReviewModeration: underReviewModerationCount,
                    systemErrors: canViewErrors ? unresolvedErrorsCount : 0,
                    totalMatches: totalMatchesCount,
                    communityPosts: communityActivePosts,
                    communityComments: communityActiveComments,
                    communityStories: communityActiveStories,
                    communityPendingReports: canModerate ? communityPendingReports : null
                }
            };

        } catch (err) {
            throw err;
        }
    }
};