const db = require('../config/connection');
const collection = require('../config/collections');

const formatRelativeTime = (date) => {
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
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
};

const getNotificationMeta = (action = '', entityType = '', status = 'success') => {
    const text = `${action} ${entityType}`.toLowerCase();
    
    if (status === 'failed' || status === 'error') {
        return { icon: 'fa-solid fa-triangle-exclamation', color: '#dc3545', bg: 'rgba(220, 53, 69, 0.12)' };
    }
    if (text.includes('student') || text.includes('user')) {
        return { icon: 'fa-solid fa-user-graduate', color: '#1d4e89', bg: 'rgba(29, 78, 137, 0.12)' };
    }
    if (text.includes('course')) {
        return { icon: 'fa-solid fa-book-open', color: '#198754', bg: 'rgba(25, 135, 84, 0.12)' };
    }
    if (text.includes('chapter')) {
        return { icon: 'fa-solid fa-layer-group', color: '#b8860b', bg: 'rgba(184, 134, 11, 0.12)' };
    }
    if (text.includes('video') || text.includes('class')) {
        return { icon: 'fa-solid fa-video', color: '#6f42c1', bg: 'rgba(111, 66, 193, 0.12)' };
    }
    if (text.includes('teacher')) {
        return { icon: 'fa-solid fa-chalkboard-user', color: '#0dcaf0', bg: 'rgba(13, 202, 240, 0.12)' };
    }
    if (text.includes('auth') || text.includes('password') || text.includes('login')) {
        return { icon: 'fa-solid fa-shield-halved', color: '#fd7e14', bg: 'rgba(253, 126, 20, 0.12)' };
    }
    return { icon: 'fa-solid fa-bell', color: '#12314c', bg: 'rgba(18, 49, 76, 0.12)' };
};

module.exports = {
    getRecentNotifications: async (limit = 15) => {
        try {
            const dbConn = db.get();
            const logs = await dbConn.collection(collection.AUDIT_LOG_COLLECTION)
                .find({})
                .sort({ createdAt: -1 })
                .limit(Math.min(Math.max(limit, 1), 50))
                .toArray();

            return logs.map(log => {
                const meta = getNotificationMeta(log.action, log.entityType, log.status);
                return {
                    id: log._id ? String(log._id) : '',
                    action: log.action || 'System Action',
                    message: log.message || `${log.action || 'Updated'} ${log.entityName || log.entityType || ''}`.trim(),
                    actor: log.admin?.name || 'System Admin',
                    status: log.status || 'success',
                    relativeTime: formatRelativeTime(log.createdAt),
                    createdAt: log.createdAt,
                    icon: meta.icon,
                    color: meta.color,
                    bg: meta.bg
                };
            });
        } catch (err) {
            return [];
        }
    },

    getUnreadCount: async (lastSeenTime) => {
        try {
            const dbConn = db.get();
            let query = {};
            if (lastSeenTime) {
                const seenDate = new Date(lastSeenTime);
                if (!isNaN(seenDate.getTime())) {
                    query.createdAt = { $gt: seenDate };
                }
            } else {
                // If never checked before, unread are from the last 24h
                const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                query.createdAt = { $gt: oneDayAgo };
            }

            const count = await dbConn.collection(collection.AUDIT_LOG_COLLECTION).countDocuments(query);
            return Math.min(count, 99);
        } catch (err) {
            return 0;
        }
    }
};
