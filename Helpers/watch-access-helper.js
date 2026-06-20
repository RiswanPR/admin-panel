const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');

module.exports = {
  // Generate secure watch token for class
  generateWatchToken: async (classId, teacherId, ipAddress) => {
    try {
      const token = {
        _id: new ObjectId(),
        classId: new ObjectId(classId),
        teacherId: new ObjectId(teacherId),
        ipAddress,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24-hour expiry
        used: false
      };

      await db.get()
        .collection('class_watch_tokens')
        .insertOne(token);

      return token._id.toString();
    } catch (err) {
      console.error('Generate Watch Token Error:', err.message);
      throw err;
    }
  },

  // Verify watch token
  verifyWatchToken: async (tokenId, classId, ipAddress) => {
    try {
      if (!ObjectId.isValid(tokenId) || !ObjectId.isValid(classId)) {
        return false;
      }

      const token = await db.get()
        .collection('class_watch_tokens')
        .findOne({
          _id: new ObjectId(tokenId),
          classId: new ObjectId(classId),
          expiresAt: { $gt: new Date() },
          ipAddress
        });

      if (!token) return false;

      // Mark as used
      await db.get()
        .collection('class_watch_tokens')
        .updateOne(
          { _id: new ObjectId(tokenId) },
          { $set: { used: true, usedAt: new Date() } }
        );

      return true;
    } catch (err) {
      console.error('Verify Watch Token Error:', err.message);
      return false;
    }
  },

  // Cleanup expired tokens (run periodically)
  cleanupExpiredTokens: async () => {
    try {
      await db.get()
        .collection('class_watch_tokens')
        .deleteMany({
          expiresAt: { $lt: new Date() }
        });
    } catch (err) {
      console.error('Cleanup Expired Tokens Error:', err.message);
    }
  },

  // Get class with access control
  getClassForWatch: async (classId, chapterCode) => {
    try {
      if (!ObjectId.isValid(classId)) return null;

      const course = await db.get()
        .collection(collection.COURSE_COLLECTION)
        .findOne({ 'chapters.uniqueCode': chapterCode });

      if (!course) return null;

      const chapter = course.chapters.find(ch => ch.uniqueCode === chapterCode);
      if (!chapter) return null;

      const classData = chapter.classes?.find(c => String(c._id) === String(classId));
      if (!classData) return null;

      return {
        classData,
        course,
        chapter
      };
    } catch (err) {
      console.error('Get Class For Watch Error:', err.message);
      return null;
    }
  }
};
