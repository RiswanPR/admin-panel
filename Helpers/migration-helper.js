const { ObjectId } = require('mongodb');
const collection = require('../config/collections');
const logger = require('./logger');

const toObjectId = (id) => {
  if (!id) return null;
  if (id instanceof ObjectId) return id;
  if (typeof id === 'string' && ObjectId.isValid(id)) return new ObjectId(id);
  return null;
};

const slugify = (text) => {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'community';
};

/**
 * Generate a unique slug in network_communities
 */
const generateUniqueSlug = async (db, baseText, excludeId = null) => {
  const baseSlug = slugify(baseText);
  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const query = { slug };
    if (excludeId) {
      query._id = { $ne: toObjectId(excludeId) };
    }
    const existing = await db.collection(collection.NETWORK_COMMUNITIES_COLLECTION).findOne(query, { projection: { _id: 1 } });
    if (!existing) return slug;
    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }
};

/**
 * Non-destructive migration to align Admin Panel data with Platform Architecture
 */
const runPlatformMigration = async (db) => {
  if (!db) return { success: false, reason: 'No DB instance' };

  logger.info('🔄 Checking platform architecture alignment and migrations...');

  try {
    // 1. Sync learning_spaces -> network_communities
    const spacesWithoutCommunity = await db
      .collection(collection.LEARNING_SPACES_COLLECTION)
      .find({
        $or: [
          { communityId: { $exists: false } },
          { communityId: null },
        ],
      })
      .toArray();

    for (const space of spacesWithoutCommunity) {
      const spaceName = space.title || space.name || 'Learning Space';
      const slug = await generateUniqueSlug(db, spaceName);
      const communityDoc = {
        name: spaceName,
        slug,
        description: space.description || '',
        type: space.courseId ? 'COURSE' : 'GENERAL',
        courseId: toObjectId(space.courseId),
        memberCount: Number(space.memberCount || 0),
        discussionCount: 0,
        visibility: space.isPrivate ? 'private' : (space.visibility || 'public'),
        status: space.status === 'archived' ? 'archived' : 'active',
        creatorId: toObjectId(space.ownerId) || toObjectId(space.createdBy) || null,
        rules: [],
        topics: space.tags || [],
        createdAt: space.createdAt ? new Date(space.createdAt) : new Date(),
        updatedAt: new Date(),
      };

      const result = await db.collection(collection.NETWORK_COMMUNITIES_COLLECTION).insertOne(communityDoc);
      const communityId = result.insertedId;

      await db.collection(collection.LEARNING_SPACES_COLLECTION).updateOne(
        { _id: space._id },
        {
          $set: {
            communityId,
            updatedAt: new Date(),
          },
        }
      );
      logger.info(`✅ Linked learning_space ${space._id} to network_community ${communityId}`);
    }

    // 2. Sync learning_space_members -> network_community_memberships
    const legacyMembers = await db.collection(collection.LEARNING_SPACE_MEMBERS_COLLECTION).find({}).toArray();
    for (const member of legacyMembers) {
      const space = await db.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: toObjectId(member.spaceId) });
      if (space && space.communityId && member.userId) {
        const uId = toObjectId(member.userId);
        const cId = toObjectId(space.communityId);
        if (uId && cId) {
          const role = member.role === 'admin' ? 'owner' : (member.role === 'teacher' ? 'moderator' : 'member');
          await db.collection(collection.NETWORK_COMMUNITY_MEMBERSHIPS_COLLECTION).updateOne(
            { communityId: cId, userId: uId },
            {
              $setOnInsert: {
                communityId: cId,
                userId: uId,
                role,
                status: member.status || 'active',
                joinedAt: member.joinedAt ? new Date(member.joinedAt) : (member.createdAt ? new Date(member.createdAt) : new Date()),
                createdAt: new Date(),
              },
            },
            { upsert: true }
          );
        }
      }
    }

    // 3. Sync legacy announcements -> platform_announcements & network_community_announcements
    const legacyAnnouncements = await db.collection(collection.ANNOUNCEMENTS_COLLECTION).find({}).toArray();
    for (const ann of legacyAnnouncements) {
      if (ann.targetType === 'learning_space' && ann.learningSpaceId) {
        const space = await db.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: toObjectId(ann.learningSpaceId) });
        if (space && space.communityId) {
          const cId = toObjectId(space.communityId);
          const authorId = toObjectId(ann.createdBy);
          const existingCommAnn = await db.collection(collection.NETWORK_COMMUNITY_ANNOUNCEMENTS_COLLECTION).findOne({
            communityId: cId,
            title: ann.title,
          });
          if (!existingCommAnn) {
            await db.collection(collection.NETWORK_COMMUNITY_ANNOUNCEMENTS_COLLECTION).insertOne({
              communityId: cId,
              authorId: authorId || null,
              title: ann.title,
              content: ann.content || ann.message || '',
              pinned: Boolean(ann.isPinned),
              createdAt: ann.createdAt ? new Date(ann.createdAt) : new Date(),
              updatedAt: ann.updatedAt ? new Date(ann.updatedAt) : new Date(),
            });
          }
        }
      } else {
        // Platform or course announcement
        const existingPlatformAnn = await db.collection(collection.PLATFORM_ANNOUNCEMENTS_COLLECTION).findOne({
          title: ann.title,
        });
        if (!existingPlatformAnn) {
          let priority = 'LOW';
          if (ann.isCritical || ann.priority === 'urgent') priority = 'CRITICAL';
          else if (ann.priority === 'high') priority = 'HIGH';
          else if (ann.priority === 'medium') priority = 'MEDIUM';

          const type = ann.isCritical ? 'CRITICAL' : (priority === 'HIGH' ? 'HIGH' : 'INFO');
          const audience = ann.targetType === 'course' ? 'COURSE_STUDENTS' : 'ALL_USERS';

          await db.collection(collection.PLATFORM_ANNOUNCEMENTS_COLLECTION).insertOne({
            title: ann.title,
            message: ann.content || ann.message || '',
            type,
            priority,
            audience,
            target: ann.targetType === 'course' && ann.courseId ? { courseId: String(ann.courseId) } : undefined,
            status: ann.status === 'published' ? 'PUBLISHED' : (ann.status === 'archived' ? 'ARCHIVED' : 'DRAFT'),
            startsAt: ann.scheduledAt ? new Date(ann.scheduledAt) : (ann.createdAt ? new Date(ann.createdAt) : new Date()),
            expiresAt: ann.expiresAt ? new Date(ann.expiresAt) : null,
            dismissedBy: [],
            createdAt: ann.createdAt ? new Date(ann.createdAt) : new Date(),
            updatedAt: ann.updatedAt ? new Date(ann.updatedAt) : new Date(),
          });
        }
      }
    }

    // 4. Sync community_followers -> network_connections
    const legacyFollowers = await db.collection(collection.COMMUNITY_FOLLOWERS_COLLECTION).find({}).toArray();
    for (const f of legacyFollowers) {
      const u1 = toObjectId(f.followerId);
      const u2 = toObjectId(f.userId);
      if (u1 && u2 && !u1.equals(u2)) {
        const s1 = u1.toString();
        const s2 = u2.toString();
        const [userLow, userHigh] = s1 < s2 ? [u1, u2] : [u2, u1];
        await db.collection(collection.NETWORK_CONNECTIONS_COLLECTION).updateOne(
          { userLow, userHigh },
          {
            $setOnInsert: {
              requesterId: u1,
              recipientId: u2,
              userLow,
              userHigh,
              status: 'accepted',
              createdAt: f.createdAt ? new Date(f.createdAt) : new Date(),
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
      }
    }

    logger.info('🎉 Platform architecture non-destructive migration completed successfully.');
    return { success: true };
  } catch (err) {
    logger.error(`❌ Migration error: ${err.message}`, err);
    return { success: false, error: err.message };
  }
};

module.exports = {
  runPlatformMigration,
  generateUniqueSlug,
  slugify,
  toObjectId,
};
