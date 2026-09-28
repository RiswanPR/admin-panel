const db = require('../config/connection');
const collection = require('../config/collections');

const SENSITIVE_KEY_REGEX = /(password|token|otp|secret|authorization|credential|cookie|session|api[-_]?key)/i;

const scrubSecrets = (data) => {
    if (!data || typeof data !== 'object') return data;
    if (Array.isArray(data)) return data.map(scrubSecrets);

    const clean = {};
    for (const [key, value] of Object.entries(data)) {
        if (SENSITIVE_KEY_REGEX.test(key)) {
            clean[key] = '[REDACTED]';
        } else if (value && typeof value === 'object') {
            clean[key] = scrubSecrets(value);
        } else {
            clean[key] = value;
        }
    }
    return clean;
};

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
    scrubSecrets,

    logAction: async ({
        actor: directActor = null,
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
            const { ObjectId } = require('mongodb');
            const isValidObjectId = (id) => id && ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
            const actor = directActor || req?.session?.admin || req?.session?.teacher || null;
            const actorEmail = actor?.Email || actor?.email || '';
            const scrubbedMeta = scrubSecrets(metadata) || {};

            // Ensure previousState / newState aliases if previousStatus / newStatus provided
            if (scrubbedMeta.previousStatus && !scrubbedMeta.previousState) {
                scrubbedMeta.previousState = scrubbedMeta.previousStatus;
            }
            if (scrubbedMeta.newStatus && !scrubbedMeta.newState) {
                scrubbedMeta.newState = scrubbedMeta.newStatus;
            }

            const targetId = (entityId && isValidObjectId(entityId))
                ? new ObjectId(entityId)
                : (scrubbedMeta.targetId && isValidObjectId(scrubbedMeta.targetId) ? new ObjectId(scrubbedMeta.targetId) : null);

            const log = {
                action,
                entityType,
                entityId: entityId ? String(entityId) : '',
                targetId,
                entityName: entityName || '',
                status,
                message,
                metadata: scrubbedMeta,
                details: scrubbedMeta,
                actorEmail,
                admin: {
                    id: actor?._id ? String(actor._id) : '',
                    name: getAdminName(actor),
                    email: actorEmail,
                    role: actor?.role || 'admin'
                },
                ...buildRequestMeta(req),
                createdAt: new Date(),
                timestamp: new Date()
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

            const page = Math.max(1, Number(filters.page) || 1);
            const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
            const skip = (page - 1) * limit;

            const [total, records] = await Promise.all([
                db.get().collection(collection.AUDIT_LOG_COLLECTION).countDocuments(query),
                db.get().collection(collection.AUDIT_LOG_COLLECTION)
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limit)
                    .toArray()
            ]);

            // Return array with attached pagination properties for backward compatibility
            records.total = total;
            records.page = page;
            records.limit = limit;
            records.totalPages = Math.ceil(total / limit) || 1;

            return records;
        } catch (err) {
            const empty = [];
            empty.total = 0;
            empty.page = 1;
            empty.limit = 50;
            empty.totalPages = 1;
            return empty;
        }
    },

    clearLogs: async () => {
        await db.get()
            .collection(collection.AUDIT_LOG_COLLECTION)
            .deleteMany({});
    }
};
