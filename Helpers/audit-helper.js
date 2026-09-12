const db = require('../config/connection');
const collection = require('../config/collections');

const getAdminName = (admin) => {
    if (!admin) return 'System';

    return admin.Name ||
        admin.name ||
        admin.Email ||
        admin.email ||
        'Admin';
};

const buildRequestMeta = (req) => {
    if (!req) return {};

    return {
        ipAddress:
            req.headers['x-forwarded-for'] ||
            req.socket?.remoteAddress ||
            req.ip ||
            '',
        userAgent:
            req.headers['user-agent'] ||
            ''
    };
};

const escapeRegex = (value) => {
    return String(value)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

module.exports = {
    logAction: async ({
        req = null,
        action,
        entityType = '',
        entityId = '',
        entityName = '',
        status = 'success',
        message = '',
        metadata = {}
    }) => {
        try {
            const actor = req?.session?.admin || req?.session?.teacher || null;

            const log = {
                action,
                entityType,
                entityId: entityId ? String(entityId) : '',
                entityName: entityName || '',
                status,
                message,
                metadata,
                admin: {
                    id: actor?._id ? String(actor._id) : '',
                    name: getAdminName(actor),
                    email: actor?.Email || actor?.email || ''
                },
                ...buildRequestMeta(req),
                createdAt: new Date()
            };

            await db.get()
                .collection(collection.AUDIT_LOG_COLLECTION)
                .insertOne(log);

            return true;
        } catch (err) {
            return false;
        }
    },

    getLogs: async (filters = {}) => {
        try {
            const query = {};

            if (filters.action) {
                query.action = filters.action;
            }

            if (filters.entityType) {
                query.entityType = filters.entityType;
            }

            if (filters.status) {
                query.status = filters.status;
            }

            if (filters.search) {
                const searchRegex = new RegExp(escapeRegex(filters.search), 'i');
                query.$or = [
                    { action: searchRegex },
                    { entityType: searchRegex },
                    { entityName: searchRegex },
                    { message: searchRegex },
                    { 'admin.name': searchRegex },
                    { 'admin.email': searchRegex }
                ];
            }

            const requestedLimit = Number(filters.limit) || 200;
            const safeLimit = Math.min(Math.max(requestedLimit, 1), 1000);

            return await db.get()
                .collection(collection.AUDIT_LOG_COLLECTION)
                .find(query)
                .sort({ createdAt: -1 })
                .limit(safeLimit)
                .toArray();
        } catch (err) {
            return [];
        }
    },

    clearLogs: async () => {
        await db.get()
            .collection(collection.AUDIT_LOG_COLLECTION)
            .deleteMany({});
    }
};
