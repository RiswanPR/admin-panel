const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const auditHelper = require('./audit-helper');

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
// Must start and end with an alphanumeric character; interior can have alphanumeric, underscore, hyphen, or dot.
// Cannot contain consecutive dots (..)
const USERNAME_FORMAT_REGEX = /^[a-z0-9][a-z0-9_.-]*[a-z0-9]$/;

// Core immutable system reserved keywords
const SYSTEM_RESERVED_USERNAMES = Object.freeze([
  'admin', 'administrator', 'support', 'profile', 'community', 'api',
  'login', 'register', 'signup', 'zeitnah', 'student', 'teacher',
  'instructor', 'superuser', 'settings', 'courses', 'chapters', 'classes',
  'dashboard', 'root', 'system', 'help', 'u', 'user', 'users', 'auth',
  'null', 'undefined', 'moderator', 'staff', 'billing', 'terms',
  'privacy', 'security', 'feed', 'notifications', 'messages', 'chat',
  'explore', 'search', 'home', 'app', 'account', 'verify', 'password',
  'reset', 'edit', 'delete', 'create', 'update', 'status'
]);

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize username:
 * - string coercion
 * - trim whitespace
 * - strip all leading '@'
 * - lowercase
 */
const normalizeUsername = (username) => {
  if (typeof username !== 'string') return '';
  let clean = username.trim();
  clean = clean.replace(/^@+/, '').trim();
  return clean.toLowerCase();
};

/**
 * Pure helper to derive a clean alphanumeric base handle from a person's name or email
 */
const deriveBaseHandle = (name = '', email = '') => {
  let base = '';
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim();

  if (cleanName) {
    base = cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  if (!base || base.length < USERNAME_MIN_LENGTH) {
    if (cleanEmail) {
      const emailPrefix = cleanEmail.split('@')[0] || '';
      base = emailPrefix
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    }
  }

  if (!base || base.length < USERNAME_MIN_LENGTH) {
    base = 'learner';
  }

  if (base.length > 20) {
    base = base.substring(0, 20).replace(/_+$/, '');
  }

  if (!/^[a-z0-9]/.test(base)) base = 'u' + base;
  if (!/[a-z0-9]$/.test(base)) base = base + '1';

  return base;
};

/**
 * Pure helper to calculate whether a user is currently within their cooldown window
 */
const calculateCooldownRemaining = (changedAt, cooldownDays = 14) => {
  if (!changedAt) {
    return { isCooldownActive: false, daysRemaining: 0 };
  }
  const dateObj = changedAt instanceof Date ? changedAt : new Date(changedAt);
  if (isNaN(dateObj.getTime())) {
    return { isCooldownActive: false, daysRemaining: 0 };
  }
  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - dateObj.getTime();
  if (elapsed < cooldownMs) {
    const remainingMs = cooldownMs - elapsed;
    return {
      isCooldownActive: true,
      daysRemaining: Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
    };
  }
  return { isCooldownActive: false, daysRemaining: 0 };
};

/**
 * Validate a candidate username against platform rules:
 * - 3 to 30 characters
 * - lowercase alphanumeric, underscore, dot, hyphen
 * - must start and end with an alphanumeric character
 * - no consecutive dots (..)
 */
const validateUsername = (rawUsername) => {
  const username = normalizeUsername(rawUsername);

  if (!username) {
    return { isValid: false, error: 'Username cannot be empty.' };
  }

  if (username.length < USERNAME_MIN_LENGTH) {
    return { isValid: false, error: `Username must be at least ${USERNAME_MIN_LENGTH} characters.` };
  }

  if (username.length > USERNAME_MAX_LENGTH) {
    return { isValid: false, error: `Username cannot exceed ${USERNAME_MAX_LENGTH} characters.` };
  }

  if (username.includes('..')) {
    return { isValid: false, error: 'Username cannot contain consecutive dots.' };
  }

  if (!USERNAME_FORMAT_REGEX.test(username)) {
    return {
      isValid: false,
      error: 'Username can only contain letters, numbers, underscores, hyphens, and dots, and must start and end with a letter or number.'
    };
  }

  return { isValid: true, username };
};

/**
 * Check if a normalized username is reserved (core system or custom reserved collection)
 */
const isReservedUsername = async (normalizedUsername) => {
  if (!normalizedUsername) return { isReserved: false };

  // 1. Check core system keywords
  if (SYSTEM_RESERVED_USERNAMES.includes(normalizedUsername)) {
    return {
      isReserved: true,
      isSystemCore: true,
      reason: 'Core platform keyword reserved by Zeitnah'
    };
  }

  // 2. Check dynamic database reserved collection if available
  try {
    const reservedDoc = await db.get()
      .collection(collection.RESERVED_USERNAMES_COLLECTION)
      .findOne({ keyword: normalizedUsername });

    if (reservedDoc) {
      return {
        isReserved: true,
        isSystemCore: false,
        reason: reservedDoc.reason || 'Reserved by administrator'
      };
    }
  } catch (err) {
    // Database might not be initialized yet in test mode
  }

  return { isReserved: false };
};

/**
 * Check real-time username availability against the MongoDB users collection
 */
const checkAvailability = async (rawUsername, excludeUserId = null) => {
  const validation = validateUsername(rawUsername);
  if (!validation.isValid) {
    return { available: false, reason: validation.error, username: validation.username || '' };
  }

  const normalized = validation.username;

  // Reserved check
  const reservedCheck = await isReservedUsername(normalized);
  if (reservedCheck.isReserved) {
    return {
      available: false,
      reason: `@${normalized} is a reserved system handle and cannot be assigned.`,
      username: normalized,
      isReserved: true
    };
  }

  // Case-insensitive query against MongoDB users collection
  const query = {
    username: new RegExp(`^${escapeRegex(normalized)}$`, 'i')
  };

  if (excludeUserId && ObjectId.isValid(excludeUserId)) {
    query._id = { $ne: new ObjectId(excludeUserId) };
  }

  const existing = await db.get()
    .collection(collection.STUDENTS_COLLECTION)
    .findOne(query);

  if (existing) {
    return {
      available: false,
      reason: `@${normalized} is already taken by another account.`,
      username: normalized
    };
  }

  return {
    available: true,
    username: normalized
  };
};

/**
 * Algorithmic generator for usernames:
 * - Derives from user's full name, falling back to email prefix
 * - Sanitizes to lowercase alphanumeric and underscores
 * - Appends random numbers if collision detected
 */
const generateUsernameForUser = async (user = {}, excludeUserId = null) => {
  const name = String(user.name || user.Name || '').trim();
  const email = String(user.email || user.Email || '').trim();

  let base = deriveBaseHandle(name, email);

  // Truncate to leave space for suffix
  if (base.length > 20) {
    base = base.substring(0, 20).replace(/_+$/, '');
  }

  // Ensure base starts and ends with alphanumeric
  if (!/^[a-z0-9]/.test(base)) base = 'u' + base;
  if (!/[a-z0-9]$/.test(base)) base = base + '1';

  // Test base candidate first
  const baseCheck = await checkAvailability(base, excludeUserId);
  if (baseCheck.available) {
    return base;
  }

  // Try standard numerical suffixes
  for (let i = 1; i <= 50; i++) {
    const suffix = i < 10 ? `0${i}` : `${i}`;
    const candidate = `${base}_${suffix}`;
    const candidateCheck = await checkAvailability(candidate, excludeUserId);
    if (candidateCheck.available) {
      return candidate;
    }
  }

  // If still colliding, use timestamp-based random suffix
  for (let attempt = 0; attempt < 20; attempt++) {
    const randomSuffix = Math.floor(100 + Math.random() * 9000);
    const candidate = `${base}${randomSuffix}`;
    const candidateCheck = await checkAvailability(candidate, excludeUserId);
    if (candidateCheck.available) {
      return candidate;
    }
  }

  // Fallback guaranteed unique format
  const fallback = `user_${Date.now().toString().slice(-6)}`;
  return fallback;
};

/**
 * Synchronize username with CommunityProfile collection if it exists
 */
const syncCommunityProfile = async (userId, newUsername) => {
  try {
    const profileCollection = db.get().collection(collection.COMMUNITY_PROFILES_COLLECTION);
    const idString = String(userId);

    // Try matching by userId (string or ObjectId)
    await profileCollection.updateMany(
      {
        $or: [
          { userId: idString },
          { userId: new ObjectId(userId) }
        ]
      },
      {
        $set: {
          username: newUsername,
          updatedAt: new Date()
        }
      }
    );
  } catch (err) {
    // Non-fatal if community profile collection does not exist or fails
  }
};

/**
 * Execute administrative username change:
 * - Validates input and target user
 * - Ensures uniqueness
 * - Updates user in users collection
 * - Preserves usernameClaimed
 * - Sets usernameChangedAt
 * - Syncs CommunityProfile
 * - Logs audit trail with previous and new usernames
 */
const changeUsername = async ({
  userId,
  newUsername,
  reason = 'Administrative update',
  admin = null,
  req = null
}) => {
  if (!userId || !ObjectId.isValid(userId)) {
    throw new Error('A valid User ID is required.');
  }

  const user = await db.get()
    .collection(collection.STUDENTS_COLLECTION)
    .findOne({ _id: new ObjectId(userId) });

  if (!user) {
    throw new Error('User account not found.');
  }

  const availability = await checkAvailability(newUsername, userId);
  if (!availability.available) {
    throw new Error(availability.reason || 'Selected username is not available.');
  }

  const normalized = availability.username;
  const previousUsername = user.username || '';

  // Calculate if cooldown was bypassed
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const lastChanged = user.usernameChangedAt ? new Date(user.usernameChangedAt) : null;
  const cooldownActive = Boolean(lastChanged && (Date.now() - lastChanged.getTime()) < fourteenDaysMs);

  // Update User document in MongoDB users collection
  // IMPORTANT: Preserve usernameClaimed! Do NOT reset to false.
  const updateFields = {
    username: normalized,
    usernameChangedAt: new Date(),
    updatedAt: new Date()
  };

  // If user previously had no username, maintain whatever claim state existed (default to false if unset)
  if (user.usernameClaimed === undefined) {
    updateFields.usernameClaimed = false;
  }

  await db.get()
    .collection(collection.STUDENTS_COLLECTION)
    .updateOne(
      { _id: new ObjectId(userId) },
      { $set: updateFields }
    );

  // Synchronize CommunityProfile
  await syncCommunityProfile(userId, normalized);

  // Log detailed audit action
  await auditHelper.logAction({
    req,
    action: 'ADMIN_USERNAME_CHANGED',
    entityType: 'user',
    entityId: String(userId),
    entityName: user.name || user.Name || user.email || 'User',
    status: 'success',
    message: `Admin changed username from @${previousUsername || 'none'} to @${normalized}`,
    metadata: {
      previousUsername,
      newUsername: normalized,
      reason: String(reason || 'Admin update').trim(),
      cooldownBypassed: cooldownActive,
      lastChangedBefore: lastChanged
    }
  });

  return {
    success: true,
    userId: String(userId),
    previousUsername,
    newUsername: normalized,
    cooldownBypassed: cooldownActive
  };
};

/**
 * Diagnostics & Health Engine:
 * Returns aggregate metrics and issue detections across the users collection.
 */
const getUsernameHealth = async () => {
  const usersCollection = db.get().collection(collection.STUDENTS_COLLECTION);

  // Aggregation for duplicate usernames (case-insensitive)
  const duplicatePipeline = [
    {
      $match: {
        username: { $exists: true, $ne: '', $ne: null }
      }
    },
    {
      $group: {
        _id: { $toLower: '$username' },
        count: { $sum: 1 },
        userIds: { $push: '$_id' },
        names: { $push: { $ifNull: ['$name', '$Name'] } },
        emails: { $push: '$email' }
      }
    },
    {
      $match: {
        count: { $gt: 1 }
      }
    }
  ];

  const [
    totalUsers,
    claimedCount,
    unclaimedCount,
    duplicatesResult,
    customReserved
  ] = await Promise.all([
    usersCollection.countDocuments(),
    usersCollection.countDocuments({ usernameClaimed: true }),
    usersCollection.countDocuments({
      $or: [
        { usernameClaimed: false },
        { usernameClaimed: null },
        { usernameClaimed: { $exists: false } }
      ]
    }),
    usersCollection.aggregate(duplicatePipeline).toArray(),
    db.get().collection(collection.RESERVED_USERNAMES_COLLECTION).find({}).toArray().catch(() => [])
  ]);

  const allReservedKeywords = new Set([
    ...SYSTEM_RESERVED_USERNAMES,
    ...customReserved.map(r => r.keyword)
  ]);

  // Scan users for missing, invalid, and reserved names
  // Using projection for speed
  const allUsers = await usersCollection.find({}, {
    projection: { _id: 1, name: 1, Name: 1, email: 1, username: 1, usernameClaimed: 1, usernameChangedAt: 1 }
  }).toArray();

  let missingCount = 0;
  let invalidCount = 0;
  let reservedInUseCount = 0;
  let validCount = 0;

  const missingUsers = [];
  const invalidUsers = [];
  const reservedUsers = [];

  for (const user of allUsers) {
    const raw = user.username;
    if (!raw || typeof raw !== 'string' || !raw.trim()) {
      missingCount++;
      if (missingUsers.length < 20) {
        missingUsers.push({
          _id: user._id,
          name: user.name || user.Name || 'Unnamed',
          email: user.email || '—'
        });
      }
      continue;
    }

    const validation = validateUsername(raw);
    if (!validation.isValid) {
      invalidCount++;
      if (invalidUsers.length < 20) {
        invalidUsers.push({
          _id: user._id,
          name: user.name || user.Name || 'Unnamed',
          email: user.email || '—',
          username: raw,
          reason: validation.error
        });
      }
      continue;
    }

    const norm = validation.username;
    if (allReservedKeywords.has(norm)) {
      reservedInUseCount++;
      if (reservedUsers.length < 20) {
        reservedUsers.push({
          _id: user._id,
          name: user.name || user.Name || 'Unnamed',
          email: user.email || '—',
          username: raw
        });
      }
      continue;
    }

    validCount++;
  }

  const totalDuplicates = duplicatesResult.reduce((sum, d) => sum + d.count, 0);
  const totalIssues = missingCount + invalidCount + duplicatesResult.length + reservedInUseCount;

  return {
    totalUsers,
    validCount,
    claimedCount,
    unclaimedCount,
    missingCount,
    invalidCount,
    duplicateGroupsCount: duplicatesResult.length,
    duplicateUsersCount: totalDuplicates,
    reservedInUseCount,
    totalIssues,
    duplicates: duplicatesResult,
    sampleMissing: missingUsers,
    sampleInvalid: invalidUsers,
    sampleReserved: reservedUsers
  };
};

/**
 * Resolve a username collision between User A and User B
 */
const resolveConflict = async ({
  winnerUserId,
  loserUserId,
  loserNewUsername = '',
  admin = null,
  req = null
}) => {
  if (!ObjectId.isValid(winnerUserId) || !ObjectId.isValid(loserUserId)) {
    throw new Error('Both winner and loser user IDs are required.');
  }

  const loser = await db.get()
    .collection(collection.STUDENTS_COLLECTION)
    .findOne({ _id: new ObjectId(loserUserId) });

  if (!loser) throw new Error('Loser account not found.');

  // Determine new username for loser
  let finalLoserUsername = loserNewUsername ? normalizeUsername(loserNewUsername) : '';
  if (!finalLoserUsername) {
    finalLoserUsername = await generateUsernameForUser(loser, loserUserId);
  } else {
    const avail = await checkAvailability(finalLoserUsername, loserUserId);
    if (!avail.available) {
      throw new Error(`Replacement username '@${finalLoserUsername}' is not available.`);
    }
  }

  const previousUsername = loser.username || '';

  // Update loser account
  await db.get()
    .collection(collection.STUDENTS_COLLECTION)
    .updateOne(
      { _id: new ObjectId(loserUserId) },
      {
        $set: {
          username: finalLoserUsername,
          usernameChangedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

  await syncCommunityProfile(loserUserId, finalLoserUsername);

  // Log conflict resolution audit
  await auditHelper.logAction({
    req,
    action: 'USERNAME_CONFLICT_RESOLVED',
    entityType: 'user',
    entityId: String(loserUserId),
    entityName: loser.name || loser.Name || loser.email || 'User',
    status: 'success',
    message: `Conflict resolved: @${previousUsername} retained by ${winnerUserId}; ${loserUserId} reassigned to @${finalLoserUsername}`,
    metadata: {
      winnerUserId: String(winnerUserId),
      loserUserId: String(loserUserId),
      previousUsername,
      loserNewUsername: finalLoserUsername
    }
  });

  return {
    success: true,
    winnerUserId: String(winnerUserId),
    loserUserId: String(loserUserId),
    previousUsername,
    loserNewUsername: finalLoserUsername
  };
};

/**
 * Preview dry-run for bulk generating usernames for missing/invalid accounts
 */
const bulkGenerateMissingPreview = async (limit = 100) => {
  const usersCollection = db.get().collection(collection.STUDENTS_COLLECTION);

  const missingUsers = await usersCollection.find({
    $or: [
      { username: { $exists: false } },
      { username: null },
      { username: '' }
    ]
  }).limit(limit).toArray();

  const candidates = [];
  for (const user of missingUsers) {
    const suggested = await generateUsernameForUser(user, user._id);
    candidates.push({
      userId: String(user._id),
      name: user.name || user.Name || 'Unnamed',
      email: user.email || '—',
      currentUsername: user.username || '—',
      suggestedUsername: suggested
    });
  }

  return {
    totalMissing: await usersCollection.countDocuments({
      $or: [
        { username: { $exists: false } },
        { username: null },
        { username: '' }
      ]
    }),
    previewCount: candidates.length,
    candidates
  };
};

/**
 * Apply bulk generation of missing usernames
 */
const bulkGenerateMissingApply = async ({ candidates = [], admin = null, req = null }) => {
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error('No candidates provided for bulk generation.');
  }

  const usersCollection = db.get().collection(collection.STUDENTS_COLLECTION);
  const results = { updated: 0, failed: 0, errors: [] };

  for (const c of candidates) {
    try {
      if (!ObjectId.isValid(c.userId)) continue;
      const avail = await checkAvailability(c.suggestedUsername, c.userId);
      let finalUsername = c.suggestedUsername;

      if (!avail.available) {
        // Regenerate if colliding
        finalUsername = await generateUsernameForUser({ name: c.name, email: c.email }, c.userId);
      }

      await usersCollection.updateOne(
        { _id: new ObjectId(c.userId) },
        {
          $set: {
            username: finalUsername,
            usernameClaimed: false, // Generated usernames start as unclaimed
            usernameChangedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      await syncCommunityProfile(c.userId, finalUsername);
      results.updated++;
    } catch (err) {
      results.failed++;
      results.errors.push({ userId: c.userId, error: err.message });
    }
  }

  await auditHelper.logAction({
    req,
    action: 'USERNAME_BULK_REPAIR',
    entityType: 'user',
    status: 'success',
    message: `Bulk generated usernames: ${results.updated} updated, ${results.failed} failed`,
    metadata: { updatedCount: results.updated, failedCount: results.failed }
  });

  return results;
};

/**
 * Server-side paginated, searchable, filterable user directory query
 */
const getUsersWithUsernames = async ({
  search = '',
  claimStatus = 'all', // 'all', 'claimed', 'unclaimed'
  accountStatus = 'all', // 'all', 'active', 'blocked', 'expired'
  role = 'all', // 'all', 'student', 'registered', 'teacher', 'admin'
  issueFilter = 'all', // 'all', 'missing', 'invalid', 'duplicate', 'recent'
  page = 1,
  limit = 20,
  sortField = 'createdAt',
  sortDir = -1
}) => {
  const usersCollection = db.get().collection(collection.STUDENTS_COLLECTION);
  const query = {};

  // 1. Search across name, username, email, phone, _id
  if (search && search.trim()) {
    const rawSearch = search.trim();
    const cleanSearch = normalizeUsername(rawSearch);
    const searchRegex = new RegExp(escapeRegex(rawSearch), 'i');
    const cleanRegex = new RegExp(escapeRegex(cleanSearch), 'i');

    const orClauses = [
      { name: searchRegex },
      { Name: searchRegex },
      { email: searchRegex },
      { Phone_Number: searchRegex },
      { username: cleanRegex }
    ];

    if (ObjectId.isValid(rawSearch)) {
      orClauses.push({ _id: new ObjectId(rawSearch) });
    }

    query.$or = orClauses;
  }

  // 2. Claim status filter
  if (claimStatus === 'claimed') {
    query.usernameClaimed = true;
  } else if (claimStatus === 'unclaimed') {
    query.$or = [
      { usernameClaimed: false },
      { usernameClaimed: null },
      { usernameClaimed: { $exists: false } }
    ];
  }

  // 3. Account status filter
  if (accountStatus === 'active') {
    query['account_Status.isBlocked'] = { $ne: true };
    query['account_Status.isActive'] = { $ne: false };
    query.status = true;
  } else if (accountStatus === 'blocked') {
    query['account_Status.isBlocked'] = true;
  } else if (accountStatus === 'expired') {
    query.status = false;
  }

  // 4. Role / Type filter
  if (role === 'registered') {
    // Registered users have empty or missing course array
    query.$or = [
      { course: { $exists: false } },
      { course: { $size: 0 } },
      { course: null }
    ];
  } else if (role === 'student') {
    query.course = { $exists: true, $not: { $size: 0 } };
  } else if (role === 'teacher') {
    query.role = 'teacher';
  } else if (role === 'admin') {
    query.role = 'admin';
  }

  // 5. Issue filter
  if (issueFilter === 'missing') {
    query.$or = [
      { username: { $exists: false } },
      { username: null },
      { username: '' }
    ];
  } else if (issueFilter === 'recent') {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    query.usernameChangedAt = { $gte: sevenDaysAgo };
  }

  // Sorting
  const sort = {};
  const validSortFields = {
    name: 'name',
    username: 'username',
    createdAt: 'createdAt',
    usernameChangedAt: 'usernameChangedAt',
    lastSeen: 'account_Status.lastSeen'
  };
  const key = validSortFields[sortField] || 'createdAt';
  sort[key] = sortDir === 1 ? 1 : -1;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(100, Math.max(5, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * pageSize;

  const [users, total] = await Promise.all([
    usersCollection
      .find(query)
      .sort(sort)
      .skip(skip)
      .limit(pageSize)
      .toArray(),
    usersCollection.countDocuments(query)
  ]);

  // Decorate each user with claim status, display properties, and cooldown metadata
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  users.forEach((u) => {
    u.displayName = u.name || u.Name || 'Learner';
    u.displayEmail = u.email || '—';
    u.displayUsername = u.username ? `@${u.username}` : 'No username';
    u.isClaimed = Boolean(u.usernameClaimed);
    u.hasUsername = Boolean(u.username && u.username.trim());

    const changedAt = u.usernameChangedAt ? new Date(u.usernameChangedAt) : null;
    u.lastChangedDate = changedAt
      ? changedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : 'Never';

    // Cooldown status (for normal users)
    const inCooldown = Boolean(changedAt && (now - changedAt.getTime()) < fourteenDaysMs);
    u.isCooldownActive = inCooldown;
    if (inCooldown && changedAt) {
      const remainingMs = fourteenDaysMs - (now - changedAt.getTime());
      u.cooldownDaysRemaining = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    } else {
      u.cooldownDaysRemaining = 0;
    }

    u.courseCount = Array.isArray(u.course) ? u.course.length : 0;
    u.isStudent = u.courseCount > 0;
  });

  return {
    users,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / pageSize) || 1,
    limit: pageSize
  };
};

/**
 * Reserved Usernames Management
 */
const getReservedKeywordsList = async (search = '') => {
  const customList = await db.get()
    .collection(collection.RESERVED_USERNAMES_COLLECTION)
    .find({})
    .sort({ keyword: 1 })
    .toArray()
    .catch(() => []);

  const combined = [];

  // Core system reserved
  SYSTEM_RESERVED_USERNAMES.forEach((kw) => {
    combined.push({
      keyword: kw,
      isSystemCore: true,
      reason: 'Core platform protected handle',
      createdAt: null
    });
  });

  // Custom added reserved
  customList.forEach((c) => {
    combined.push({
      keyword: c.keyword,
      isSystemCore: false,
      reason: c.reason || 'Administrator reserved handle',
      createdAt: c.createdAt || null,
      addedBy: c.addedBy || 'Admin'
    });
  });

  if (search && search.trim()) {
    const s = normalizeUsername(search);
    return combined.filter(item => item.keyword.includes(s));
  }

  return combined;
};

const addReservedKeyword = async ({ keyword, reason = '', admin = null, req = null }) => {
  const norm = normalizeUsername(keyword);
  if (!norm || norm.length < 2) {
    throw new Error('A valid keyword of at least 2 characters is required.');
  }

  if (SYSTEM_RESERVED_USERNAMES.includes(norm)) {
    throw new Error(`'${norm}' is already a core system reserved keyword.`);
  }

  const existing = await db.get()
    .collection(collection.RESERVED_USERNAMES_COLLECTION)
    .findOne({ keyword: norm });

  if (existing) {
    throw new Error(`'${norm}' is already on the reserved list.`);
  }

  const doc = {
    keyword: norm,
    reason: String(reason || 'Administrative restriction').trim(),
    addedBy: admin ? (admin.Name || admin.Email || 'Admin') : 'Admin',
    createdAt: new Date()
  };

  await db.get()
    .collection(collection.RESERVED_USERNAMES_COLLECTION)
    .insertOne(doc);

  await auditHelper.logAction({
    req,
    action: 'RESERVED_USERNAME_ADDED',
    entityType: 'reserved_username',
    entityName: norm,
    status: 'success',
    message: `Added '@${norm}' to reserved usernames`,
    metadata: { keyword: norm, reason }
  });

  return { success: true, keyword: norm };
};

const deleteReservedKeyword = async ({ keyword, admin = null, req = null }) => {
  const norm = normalizeUsername(keyword);

  if (SYSTEM_RESERVED_USERNAMES.includes(norm)) {
    throw new Error(`Cannot delete core system reserved keyword '${norm}'.`);
  }

  const result = await db.get()
    .collection(collection.RESERVED_USERNAMES_COLLECTION)
    .deleteOne({ keyword: norm });

  if (result.deletedCount === 0) {
    throw new Error(`Keyword '${norm}' was not found in custom reserved list.`);
  }

  await auditHelper.logAction({
    req,
    action: 'RESERVED_USERNAME_REMOVED',
    entityType: 'reserved_username',
    entityName: norm,
    status: 'success',
    message: `Removed '@${norm}' from reserved usernames`,
    metadata: { keyword: norm }
  });

  return { success: true, keyword: norm };
};

module.exports = {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  SYSTEM_RESERVED_USERNAMES,
  normalizeUsername,
  validateUsername,
  isReservedUsername,
  isUsernameReserved: isReservedUsername,
  deriveBaseHandle,
  calculateCooldownRemaining,
  checkAvailability,
  generateUsernameForUser,
  syncCommunityProfile,
  changeUsername,
  getUsernameHealth,
  resolveConflict,
  bulkGenerateMissingPreview,
  bulkGenerateMissingApply,
  getUsersWithUsernames,
  getReservedKeywordsList,
  addReservedKeyword,
  deleteReservedKeyword
};
