const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');
const logger = require('./logger');

// ─────────────────────────────────────────────────────────
// SERVER-SIDE HTML SANITIZER (XSS PROTECTION)
// ─────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
  'span', 'div', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'
]);

const sanitizeHtml = (html) => {
  if (typeof html !== 'string') return '';

  // 1. Strip dangerous tags with their entire contents
  let sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<math\b[^<]*(?:(?!<\/math>)<[^<]*)*<\/math>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // 2. Tokenize and filter all HTML tags (handling slash delimiters and whitespace variations)
  sanitized = sanitized.replace(/<(\/?)([a-zA-Z0-9_-]+)([\s\S]*?)>/g, (match, isClosing, rawTagName, attrs) => {
    const tag = rawTagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      return '';
    }

    if (isClosing) {
      return `</${tag}>`;
    }

    // For <a> tags, strictly sanitize href and strip all other attributes
    if (tag === 'a') {
      const hrefMatch = attrs.match(/href\s*=\s*(?:(["'`])([\s\S]*?)\1|([^\s>]+))/i);
      let href = '#';
      const rawHref = hrefMatch ? (hrefMatch[2] || hrefMatch[3] || '').trim() : '';

      // Decode entities to detect obfuscated protocols like jav&#x09;ascript: or &NewLine;
      const decodedHref = rawHref
        .replace(/&[a-z0-9]+;/gi, '')
        .replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(n))
        .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/[\u0000-\u001f\s]/g, '');

      if (/^(https?:\/\/|\/|mailto:)/i.test(decodedHref) && !/^(javascript|vbscript|data):/i.test(decodedHref)) {
        href = rawHref.replace(/[<>"'`]/g, '');
      }
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">`;
    }

    // For void tags
    if (tag === 'br' || tag === 'hr') {
      return `<${tag}>`;
    }

    // For all other allowed tags, strip ALL attributes (eliminates any inline event handlers or styles)
    return `<${tag}>`;
  });

  return sanitized.trim();
};

const escapeRegex = (str) => String(str).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─────────────────────────────────────────────────────────
// SCOPE VALIDATION FOR TEACHERS
// ─────────────────────────────────────────────────────────

const getTeacherPermittedScope = async (teacherId) => {
  if (!teacherId || !ObjectId.isValid(teacherId)) {
    return { courses: [], spaces: [] };
  }

  const teacher = await db.get()
    .collection(collection.TEACHER_COLLECTION)
    .findOne({ _id: new ObjectId(teacherId) });

  const assignedCourses = (teacher?.assignedCourses || []).map(String);

  const courses = await db.get()
    .collection(collection.COURSE_COLLECTION)
    .find({ _id: { $in: assignedCourses.map(id => new ObjectId(id)) } }, { projection: { _id: 1, name: 1 } })
    .toArray();

  const spaces = await db.get()
    .collection(collection.LEARNING_SPACES_COLLECTION)
    .find({
      $or: [
        { teachers: new ObjectId(teacherId) },
        { teachers: String(teacherId) },
        { ownerId: new ObjectId(teacherId) }
      ],
      status: { $ne: 'archived' }
    }, { projection: { _id: 1, name: 1, code: 1 } })
    .toArray();

  return { courses, spaces };
};

// ─────────────────────────────────────────────────────────
// CRUD OPERATIONS
// ─────────────────────────────────────────────────────────

const createAnnouncement = async (data, actor, req = null) => {
  const title = String(data.title || '').trim();
  const rawMessage = String(data.message || '').trim();

  if (!title) {
    throw new Error('Announcement title is required.');
  }
  if (title.length > 200) {
    throw new Error('Title cannot exceed 200 characters.');
  }
  if (!rawMessage) {
    throw new Error('Announcement message cannot be empty.');
  }

  const sanitizedMessage = sanitizeHtml(rawMessage);
  const isTeacher = actor?.role === 'teacher';
  const isAdmin = actor?.role === 'admin' || actor?.role === 'superuser';

  if (!actor || (!isAdmin && !isTeacher)) {
    throw new Error('Unauthorized. You do not have permission to create announcements.');
  }

  // Teacher Restrictions:
  if (isTeacher) {
    if (data.isCritical === true || data.isCritical === 'true') {
      throw new Error('Forbidden: Teachers cannot create critical announcements.');
    }
    if (data.priority === 'critical') {
      throw new Error('Forbidden: Teachers cannot set critical priority.');
    }
    if (['platform', 'maintenance', 'critical'].includes(data.type)) {
      throw new Error(`Forbidden: Teachers cannot create ${data.type} announcements.`);
    }
    if (!['course', 'learning_space'].includes(data.targetType)) {
      throw new Error('Forbidden: Teachers can only target assigned courses or learning spaces.');
    }
  }

  // Validate Type
  const validTypes = ['general', 'course', 'learning_space', 'platform', 'maintenance', 'critical'];
  const type = validTypes.includes(data.type) ? data.type : 'general';

  // Validate Priority
  const validPriorities = ['normal', 'important', 'critical'];
  let priority = validPriorities.includes(data.priority) ? data.priority : 'normal';
  if (isTeacher && priority === 'critical') priority = 'normal';

  // Critical Flag
  const isCritical = Boolean(isAdmin && (data.isCritical === true || data.isCritical === 'true' || priority === 'critical'));

  // Target Type & Target IDs
  const validTargets = ['platform', 'specific_users', 'course', 'teacher_students', 'learning_space', 'role'];
  const targetType = validTargets.includes(data.targetType) ? data.targetType : (isTeacher ? 'course' : 'platform');

  let courseId = null;
  let learningSpaceId = null;
  let targetIds = [];

  if (targetType === 'course') {
    if (!data.courseId || !ObjectId.isValid(data.courseId)) {
      throw new Error('A valid course must be selected.');
    }
    courseId = new ObjectId(data.courseId);

    // If teacher, verify course ownership
    if (isTeacher) {
      const scope = await getTeacherPermittedScope(actor._id);
      const hasCourse = scope.courses.some(c => c._id.toString() === courseId.toString());
      if (!hasCourse) {
        throw new Error('Forbidden: You can only target courses assigned to you.');
      }
    }
  } else if (targetType === 'learning_space') {
    if (!data.learningSpaceId || !ObjectId.isValid(data.learningSpaceId)) {
      throw new Error('A valid learning space must be selected.');
    }
    learningSpaceId = new ObjectId(data.learningSpaceId);

    // If teacher, verify space assignment
    if (isTeacher) {
      const scope = await getTeacherPermittedScope(actor._id);
      const hasSpace = scope.spaces.some(s => s._id.toString() === learningSpaceId.toString());
      if (!hasSpace) {
        throw new Error('Forbidden: You can only target learning spaces assigned to you.');
      }
    }
  } else if (targetType === 'specific_users') {
    const rawIds = Array.isArray(data.targetIds) ? data.targetIds : String(data.targetIds || '').split(',');
    targetIds = rawIds.map(s => String(s).trim()).filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
    if (!targetIds.length) {
      throw new Error('At least one valid user must be selected for specific user targeting.');
    }
  } else if (targetType === 'role') {
    const roles = Array.isArray(data.targetRoles) ? data.targetRoles : [data.targetRoles || 'students'];
    targetIds = roles.filter(r => ['students', 'teachers', 'admins'].includes(r));
  }

  // Dates & Status
  const now = new Date();
  let scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (scheduledAt && isNaN(scheduledAt.getTime())) scheduledAt = null;

  let expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  if (expiresAt && isNaN(expiresAt.getTime())) expiresAt = null;

  if (expiresAt && scheduledAt && expiresAt <= scheduledAt) {
    throw new Error('Expiry date must be after scheduled date.');
  }
  if (expiresAt && expiresAt <= now) {
    throw new Error('Expiry date must be in the future.');
  }

  let isPublished = false;
  let publishedAt = null;
  let status = 'draft';

  if (data.publishNow === true || data.publishNow === 'true' || data.status === 'published') {
    isPublished = true;
    publishedAt = now;
    status = 'published';
  } else if (scheduledAt && scheduledAt > now) {
    status = 'scheduled';
  } else if (data.status === 'archived') {
    status = 'archived';
  }

  const database = db.get();
  let platformAnnouncementId = null;
  let communityAnnouncementId = null;

  // Platform Architecture: Route to appropriate platform collection
  if (targetType === 'learning_space' && learningSpaceId) {
    const space = await database.collection(collection.LEARNING_SPACES_COLLECTION).findOne({ _id: learningSpaceId });
    if (space && space.communityId) {
      const commAnnDoc = {
        communityId: new ObjectId(space.communityId),
        authorId: new ObjectId(actor._id),
        title,
        content: sanitizedMessage,
        pinned: Boolean(data.isPinned),
        createdAt: now,
        updatedAt: now
      };
      const commAnnResult = await database.collection(collection.NETWORK_COMMUNITY_ANNOUNCEMENTS_COLLECTION).insertOne(commAnnDoc);
      communityAnnouncementId = commAnnResult.insertedId;
    }
  } else {
    // Route to platform_announcements
    const platformType = isCritical ? 'CRITICAL' : (priority === 'critical' ? 'CRITICAL' : (priority === 'important' || priority === 'high' ? 'IMPORTANT' : 'INFO'));
    const platformPriority = isCritical ? 'CRITICAL' : (priority === 'critical' ? 'CRITICAL' : (priority === 'important' || priority === 'high' ? 'HIGH' : 'LOW'));
    const audience = targetType === 'course' ? 'COURSE_STUDENTS' : (targetType === 'role' ? (data.targetRoles?.includes('teachers') ? 'TEACHERS' : 'STUDENTS') : 'ALL_USERS');

    const platformAnnDoc = {
      title,
      message: sanitizedMessage,
      type: platformType,
      priority: platformPriority,
      audience,
      target: targetType === 'course' && courseId ? { courseId: courseId.toString() } : undefined,
      status: isPublished ? 'PUBLISHED' : (status === 'archived' ? 'ARCHIVED' : 'DRAFT'),
      startsAt: scheduledAt || now,
      expiresAt: expiresAt || null,
      dismissedBy: [],
      createdAt: now,
      updatedAt: now
    };

    const platformAnnResult = await database.collection(collection.PLATFORM_ANNOUNCEMENTS_COLLECTION).insertOne(platformAnnDoc);
    platformAnnouncementId = platformAnnResult.insertedId;
  }

  const doc = {
    title,
    message: sanitizedMessage,
    type,
    priority,
    status,
    isCritical,
    isPublished,
    platformAnnouncementId,
    communityAnnouncementId,
    createdBy: new ObjectId(actor._id),
    createdByRole: actor.role || 'admin',
    createdByName: actor.Name || actor.name || actor.Email || actor.email || 'User',
    targetType,
    targetIds,
    courseId,
    learningSpaceId,
    scheduledAt,
    publishedAt,
    expiresAt,
    createdAt: now,
    updatedAt: now
  };

  const result = await database
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .insertOne(doc);

  const announcementId = result.insertedId;

  // If published, write a notification record
  if (isPublished) {
    try {
      await database.collection(collection.NOTIFICATIONS_COLLECTION).insertOne({
        recipientId: null,
        actorId: new ObjectId(actor._id),
        type: 'ANNOUNCEMENT',
        category: targetType === 'learning_space' ? 'COMMUNITY' : 'SYSTEM',
        priority: isCritical ? 'HIGH' : 'NORMAL',
        title,
        message: title,
        isRead: false,
        idempotencyKey: `announcement_${announcementId}`,
        createdAt: now
      });
    } catch (notifErr) {
      logger.warn(`Notification log warning: ${notifErr.message}`);
    }
  }

  // Audit Logging
  await auditHelper.logAction({
    req,
    action: isCritical ? 'CRITICAL_ANNOUNCEMENT_CREATE' : 'ANNOUNCEMENT_CREATE',
    entityType: 'announcement',
    entityId: announcementId.toString(),
    entityName: title,
    status: 'success',
    message: `Announcement "${title}" created (${status}, ${type}, ${priority}).`,
    metadata: {
      isCritical,
      priority,
      targetType,
      courseId: courseId ? courseId.toString() : null,
      learningSpaceId: learningSpaceId ? learningSpaceId.toString() : null,
      platformAnnouncementId: platformAnnouncementId ? platformAnnouncementId.toString() : null,
      communityAnnouncementId: communityAnnouncementId ? communityAnnouncementId.toString() : null,
      status
    }
  });

  return { ...doc, _id: announcementId };
};

const updateAnnouncement = async (id, data, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid announcement ID.');

  const existing = await db.get()
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!existing) throw new Error('Announcement not found.');

  const isTeacher = actor?.role === 'teacher';
  const isAdmin = actor?.role === 'admin' || actor?.role === 'superuser';

  if (!actor || (!isAdmin && !isTeacher)) {
    throw new Error('Unauthorized.');
  }

  // Teachers can ONLY update their own announcements
  if (isTeacher) {
    if (existing.createdBy.toString() !== actor._id.toString()) {
      throw new Error('Forbidden: You can only edit your own announcements.');
    }
    if (data.isCritical === true || data.isCritical === 'true' || data.priority === 'critical') {
      throw new Error('Forbidden: Teachers cannot make announcements critical.');
    }
    if (['platform', 'maintenance', 'critical'].includes(data.type)) {
      throw new Error(`Forbidden: Teachers cannot change announcement to ${data.type}.`);
    }
    if (data.targetType && !['course', 'learning_space'].includes(data.targetType)) {
      throw new Error('Forbidden: Teachers can only target assigned courses or learning spaces.');
    }
  }

  const title = data.title !== undefined ? String(data.title).trim() : existing.title;
  if (!title) throw new Error('Announcement title cannot be empty.');

  const message = data.message !== undefined ? sanitizeHtml(String(data.message).trim()) : existing.message;
  if (!message) throw new Error('Announcement message cannot be empty.');

  const type = data.type || existing.type;
  let priority = data.priority || existing.priority;
  if (isTeacher && priority === 'critical') priority = 'normal';

  const isCritical = isAdmin ? (data.isCritical !== undefined ? Boolean(data.isCritical === true || data.isCritical === 'true' || priority === 'critical') : existing.isCritical) : false;

  const targetType = data.targetType || existing.targetType;
  let courseId = existing.courseId;
  let learningSpaceId = existing.learningSpaceId;

  if (targetType === 'course') {
    const cId = data.courseId || existing.courseId;
    if (!cId || !ObjectId.isValid(cId)) throw new Error('Valid course required.');
    courseId = new ObjectId(cId);

    if (isTeacher) {
      const scope = await getTeacherPermittedScope(actor._id);
      const hasCourse = scope.courses.some(c => c._id.toString() === courseId.toString());
      if (!hasCourse) throw new Error('Forbidden: Course not assigned to you.');
    }
  }

  if (targetType === 'learning_space') {
    const sId = data.learningSpaceId || existing.learningSpaceId;
    if (!sId || !ObjectId.isValid(sId)) throw new Error('Valid learning space required.');
    learningSpaceId = new ObjectId(sId);

    if (isTeacher) {
      const scope = await getTeacherPermittedScope(actor._id);
      const hasSpace = scope.spaces.some(s => s._id.toString() === learningSpaceId.toString());
      if (!hasSpace) throw new Error('Forbidden: Learning space not assigned to you.');
    }
  }

  let scheduledAt = data.scheduledAt !== undefined ? (data.scheduledAt ? new Date(data.scheduledAt) : null) : existing.scheduledAt;
  let expiresAt = data.expiresAt !== undefined ? (data.expiresAt ? new Date(data.expiresAt) : null) : existing.expiresAt;

  if (expiresAt && scheduledAt && expiresAt <= scheduledAt) {
    throw new Error('Expiry date must be after scheduled date.');
  }

  const updateFields = {
    title,
    message,
    type,
    priority,
    isCritical,
    targetType,
    courseId,
    learningSpaceId,
    scheduledAt,
    expiresAt,
    updatedAt: new Date()
  };

  if (data.status) {
    updateFields.status = data.status;
    if (data.status === 'published') {
      updateFields.isPublished = true;
      if (!existing.isPublished || !existing.publishedAt) {
        updateFields.publishedAt = new Date();
      }
    } else {
      updateFields.isPublished = false;
    }
  }

  const database = db.get();
  await database
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: updateFields });

  // Sync with platform collections
  if (existing.platformAnnouncementId) {
    const platformType = isCritical ? 'CRITICAL' : (priority === 'critical' ? 'CRITICAL' : (priority === 'important' || priority === 'high' ? 'IMPORTANT' : 'INFO'));
    const platformPriority = isCritical ? 'CRITICAL' : (priority === 'critical' ? 'CRITICAL' : (priority === 'important' || priority === 'high' ? 'HIGH' : 'LOW'));
    const audience = targetType === 'course' ? 'COURSE_STUDENTS' : (targetType === 'role' ? (data.targetRoles?.includes('teachers') ? 'TEACHERS' : 'STUDENTS') : 'ALL_USERS');

    await database.collection(collection.PLATFORM_ANNOUNCEMENTS_COLLECTION).updateOne(
      { _id: new ObjectId(existing.platformAnnouncementId) },
      {
        $set: {
          title,
          message,
          type: platformType,
          priority: platformPriority,
          audience,
          target: targetType === 'course' && courseId ? { courseId: courseId.toString() } : undefined,
          status: updateFields.status ? (updateFields.status === 'published' ? 'PUBLISHED' : (updateFields.status === 'archived' ? 'ARCHIVED' : 'DRAFT')) : undefined,
          startsAt: scheduledAt || undefined,
          expiresAt: expiresAt !== undefined ? expiresAt : undefined,
          updatedAt: new Date()
        }
      }
    );
  }

  if (existing.communityAnnouncementId) {
    await database.collection(collection.NETWORK_COMMUNITY_ANNOUNCEMENTS_COLLECTION).updateOne(
      { _id: new ObjectId(existing.communityAnnouncementId) },
      {
        $set: {
          title,
          content: message,
          pinned: data.isPinned !== undefined ? Boolean(data.isPinned) : undefined,
          updatedAt: new Date()
        }
      }
    );
  }

  await auditHelper.logAction({
    req,
    action: isCritical ? 'CRITICAL_ANNOUNCEMENT_EDIT' : 'ANNOUNCEMENT_EDIT',
    entityType: 'announcement',
    entityId: id.toString(),
    entityName: title,
    status: 'success',
    message: `Announcement "${title}" updated.`,
    metadata: { previousPriority: existing.priority, newPriority: priority, isCritical }
  });

  return { ...existing, ...updateFields };
};

const getAnnouncementById = async (id) => {
  if (!ObjectId.isValid(id)) return null;

  const announcement = await db.get()
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!announcement) return null;

  // Resolve course name if applicable
  if (announcement.courseId) {
    const course = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .findOne({ _id: announcement.courseId }, { projection: { name: 1 } });
    announcement.courseName = course?.name || 'Unknown Course';
  }

  // Resolve space name if applicable
  if (announcement.learningSpaceId) {
    const space = await db.get()
      .collection(collection.LEARNING_SPACES_COLLECTION)
      .findOne({ _id: announcement.learningSpaceId }, { projection: { name: 1, code: 1 } });
    announcement.learningSpaceName = space?.name || 'Unknown Space';
  }

  return announcement;
};

const getAnnouncements = async (filters = {}) => {
  const query = {};

  if (filters.search) {
    const regex = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [
      { title: regex },
      { message: regex },
      { createdByName: regex }
    ];
  }

  if (filters.type && filters.type !== 'all') {
    query.type = filters.type;
  }

  if (filters.priority && filters.priority !== 'all') {
    query.priority = filters.priority;
  }

  if (filters.status && filters.status !== 'all') {
    query.status = filters.status;
  }

  if (filters.targetType && filters.targetType !== 'all') {
    query.targetType = filters.targetType;
  }

  if (filters.creatorRole && filters.creatorRole !== 'all') {
    query.createdByRole = filters.creatorRole;
  }

  if (filters.learningSpaceId && ObjectId.isValid(filters.learningSpaceId)) {
    query.learningSpaceId = new ObjectId(filters.learningSpaceId);
  }

  if (filters.courseId && ObjectId.isValid(filters.courseId)) {
    query.courseId = new ObjectId(filters.courseId);
  }

  // Teacher scope filter: teacher can only see announcements they created, or targeted to their courses/spaces
  if (filters.actor?.role === 'teacher') {
    const teacherId = filters.actor._id;
    const scope = await getTeacherPermittedScope(teacherId);
    const courseIds = scope.courses.map(c => c._id);
    const spaceIds = scope.spaces.map(s => s._id);

    query.$or = [
      { createdBy: new ObjectId(teacherId) },
      { targetType: 'course', courseId: { $in: courseIds } },
      { targetType: 'learning_space', learningSpaceId: { $in: spaceIds } }
    ];
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(1, Number(filters.limit) || 15), 100);
  const skip = (page - 1) * limit;

  const total = await db.get()
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .countDocuments(query);

  const announcements = await db.get()
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  // Quick lookup for course & space names
  const courseIds = announcements.filter(a => a.courseId).map(a => a.courseId);
  const spaceIds = announcements.filter(a => a.learningSpaceId).map(a => a.learningSpaceId);

  const courseMap = {};
  if (courseIds.length) {
    const courses = await db.get()
      .collection(collection.COURSE_COLLECTION)
      .find({ _id: { $in: courseIds } }, { projection: { _id: 1, name: 1 } })
      .toArray();
    courses.forEach(c => { courseMap[c._id.toString()] = c.name; });
  }

  const spaceMap = {};
  if (spaceIds.length) {
    const spaces = await db.get()
      .collection(collection.LEARNING_SPACES_COLLECTION)
      .find({ _id: { $in: spaceIds } }, { projection: { _id: 1, name: 1, code: 1 } })
      .toArray();
    spaces.forEach(s => { spaceMap[s._id.toString()] = s.name; });
  }

  announcements.forEach(a => {
    if (a.courseId) a.courseName = courseMap[a.courseId.toString()] || 'Unknown Course';
    if (a.learningSpaceId) a.learningSpaceName = spaceMap[a.learningSpaceId.toString()] || 'Unknown Space';
  });

  return {
    announcements,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1
  };
};

const publishAnnouncement = async (id, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid announcement ID.');

  const announcement = await db.get()
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!announcement) throw new Error('Announcement not found.');

  const isTeacher = actor?.role === 'teacher';
  const isAdmin = actor?.role === 'admin' || actor?.role === 'superuser';

  if (!actor || (!isAdmin && !isTeacher)) {
    throw new Error('Unauthorized.');
  }

  if (isTeacher) {
    if (announcement.createdBy.toString() !== actor._id.toString()) {
      throw new Error('Forbidden: You can only publish your own announcements.');
    }
    if (announcement.isCritical || announcement.priority === 'critical') {
      throw new Error('Forbidden: Teachers cannot publish critical announcements.');
    }
  }

  const database = db.get();
  const now = new Date();
  await database
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isPublished: true,
          status: 'published',
          publishedAt: now,
          updatedAt: now
        }
      }
    );

  if (announcement.platformAnnouncementId) {
    await database.collection(collection.PLATFORM_ANNOUNCEMENTS_COLLECTION).updateOne(
      { _id: new ObjectId(announcement.platformAnnouncementId) },
      { $set: { status: 'PUBLISHED', updatedAt: now } }
    );
  }

  try {
    await database.collection(collection.NOTIFICATIONS_COLLECTION).insertOne({
      recipientId: null,
      actorId: new ObjectId(actor._id),
      type: 'ANNOUNCEMENT',
      category: announcement.targetType === 'learning_space' ? 'COMMUNITY' : 'SYSTEM',
      priority: announcement.isCritical ? 'HIGH' : 'NORMAL',
      title: announcement.title,
      message: announcement.title,
      isRead: false,
      idempotencyKey: `announcement_publish_${id}`,
      createdAt: now
    });
  } catch (notifErr) {
    logger.warn(`Notification publish warning: ${notifErr.message}`);
  }

  await auditHelper.logAction({
    req,
    action: announcement.isCritical ? 'CRITICAL_ANNOUNCEMENT_PUBLISH' : 'ANNOUNCEMENT_PUBLISH',
    entityType: 'announcement',
    entityId: id.toString(),
    entityName: announcement.title,
    status: 'success',
    message: `Announcement "${announcement.title}" published.`,
    metadata: { isCritical: announcement.isCritical, publishedAt: now }
  });

  return true;
};

const unpublishAnnouncement = async (id, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid announcement ID.');

  const database = db.get();
  const announcement = await database
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!announcement) throw new Error('Announcement not found.');

  const isTeacher = actor?.role === 'teacher';
  const isAdmin = actor?.role === 'admin' || actor?.role === 'superuser';

  if (!actor || (!isAdmin && !isTeacher)) throw new Error('Unauthorized.');

  if (isTeacher && announcement.createdBy.toString() !== actor._id.toString()) {
    throw new Error('Forbidden: You can only unpublish your own announcements.');
  }

  const now = new Date();
  await database
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isPublished: false,
          status: 'draft',
          updatedAt: now
        }
      }
    );

  if (announcement.platformAnnouncementId) {
    await database.collection(collection.PLATFORM_ANNOUNCEMENTS_COLLECTION).updateOne(
      { _id: new ObjectId(announcement.platformAnnouncementId) },
      { $set: { status: 'DRAFT', updatedAt: now } }
    );
  }

  await auditHelper.logAction({
    req,
    action: 'ANNOUNCEMENT_UNPUBLISH',
    entityType: 'announcement',
    entityId: id.toString(),
    entityName: announcement.title,
    status: 'success',
    message: `Announcement "${announcement.title}" unpublished to draft.`
  });

  return true;
};

const duplicateAnnouncement = async (id, actor, req = null) => {
  const existing = await getAnnouncementById(id);
  if (!existing) throw new Error('Announcement not found.');

  const isTeacher = actor?.role === 'teacher';
  const isAdmin = actor?.role === 'admin' || actor?.role === 'superuser';
  if (!actor || (!isAdmin && !isTeacher)) {
    throw new Error('Unauthorized.');
  }

  if (isTeacher && existing.createdBy.toString() !== actor._id.toString()) {
    throw new Error('Forbidden: You can only duplicate your own announcements.');
  }

  const cloneData = {
    ...existing,
    title: `${existing.title} (Copy)`,
    status: 'draft',
    isPublished: false,
    publishedAt: null,
    scheduledAt: null,
    expiresAt: null,
    isCritical: isTeacher ? false : existing.isCritical,
    priority: isTeacher && existing.priority === 'critical' ? 'normal' : existing.priority
  };
  delete cloneData._id;

  const clone = await createAnnouncement(cloneData, actor, req);

  await auditHelper.logAction({
    req,
    action: 'ANNOUNCEMENT_DUPLICATE',
    entityType: 'announcement',
    entityId: clone._id.toString(),
    entityName: clone.title,
    status: 'success',
    message: `Announcement "${existing.title}" duplicated as "${clone.title}".`,
    metadata: { sourceId: id.toString(), cloneId: clone._id.toString() }
  });

  return clone;
};

const deleteAnnouncement = async (id, actor, req = null) => {
  if (!ObjectId.isValid(id)) throw new Error('Invalid announcement ID.');

  const database = db.get();
  const announcement = await database
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .findOne({ _id: new ObjectId(id) });

  if (!announcement) throw new Error('Announcement not found.');

  const isTeacher = actor?.role === 'teacher';
  const isAdmin = actor?.role === 'admin' || actor?.role === 'superuser';

  if (!actor || (!isAdmin && !isTeacher)) throw new Error('Unauthorized.');

  if (isTeacher && announcement.createdBy.toString() !== actor._id.toString()) {
    throw new Error('Forbidden: You can only delete your own announcements.');
  }

  if (announcement.platformAnnouncementId) {
    await database.collection(collection.PLATFORM_ANNOUNCEMENTS_COLLECTION).deleteOne({
      _id: new ObjectId(announcement.platformAnnouncementId)
    });
  }

  if (announcement.communityAnnouncementId) {
    await database.collection(collection.NETWORK_COMMUNITY_ANNOUNCEMENTS_COLLECTION).deleteOne({
      _id: new ObjectId(announcement.communityAnnouncementId)
    });
  }

  await database
    .collection(collection.ANNOUNCEMENTS_COLLECTION)
    .deleteOne({ _id: new ObjectId(id) });

  await auditHelper.logAction({
    req,
    action: announcement.isCritical ? 'CRITICAL_ANNOUNCEMENT_DELETE' : 'ANNOUNCEMENT_DELETE',
    entityType: 'announcement',
    entityId: id.toString(),
    entityName: announcement.title,
    status: 'success',
    message: `Announcement "${announcement.title}" deleted.`
  });

  return true;
};

module.exports = {
  sanitizeHtml,
  getTeacherPermittedScope,
  createAnnouncement,
  updateAnnouncement,
  getAnnouncementById,
  getAnnouncements,
  publishAnnouncement,
  unpublishAnnouncement,
  duplicateAnnouncement,
  deleteAnnouncement
};
