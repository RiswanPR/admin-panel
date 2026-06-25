const db = require('../config/connection');
const collection = require('../config/collections');
const bcrypt = require('bcrypt');
const { ObjectId } = require('mongodb');

const SALT_ROUNDS = 10;

// ─────────────────────────────────────────────
// GET ADMIN BY EMAIL
// ─────────────────────────────────────────────
const getAdminByEmail = async (email) => {
  try {
    const admin = await db.get()
      .collection(collection.ADMIN_COLLECTION)
      .findOne({ Email: email.trim().toLowerCase() });

    return admin || null;
  } catch (err) {
    console.error('getAdminByEmail Error:', err.message);
    return null;
  }
};

// ─────────────────────────────────────────────
// GET ADMIN BY ID
// ─────────────────────────────────────────────
const getAdminById = async (id) => {
  try {
    if (!ObjectId.isValid(id)) return null;

    const admin = await db.get()
      .collection(collection.ADMIN_COLLECTION)
      .findOne({ _id: new ObjectId(id) });

    return admin || null;
  } catch (err) {
    console.error('getAdminById Error:', err.message);
    return null;
  }
};

// ─────────────────────────────────────────────
// VERIFY PASSWORD
// ─────────────────────────────────────────────
const verifyAdminPassword = async (admin, plainPassword) => {
  if (!admin || !plainPassword) return false;

  try {
    return await bcrypt.compare(plainPassword, admin.Password);
  } catch (err) {
    console.error('verifyAdminPassword Error:', err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// ADD ADMIN  (called by superuser)
// ─────────────────────────────────────────────
const doSignupAdmin = async (body) => {
  const name = String(body.Name || body.Username || '').trim();
  const email = String(body.Email || '').trim().toLowerCase();
  const password = String(body.Password || '');

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid name and email are required');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const adminDoc = {
    Name: name,
    Email: email,
    Password: hashedPassword,
    Phone_Number: body.Phone_Number || '',
    role: 'admin',                   // regular admin — only superuser can create
    createdAt: new Date()
  };

  const result = await db.get()
    .collection(collection.ADMIN_COLLECTION)
    .insertOne(adminDoc);

  return { ...adminDoc, _id: result.insertedId };
};

// ─────────────────────────────────────────────
// GET ALL ADMINS  (excludes superuser)
// ─────────────────────────────────────────────
const getAllAdmins = async () => {
  try {
    const admins = await db.get()
      .collection(collection.ADMIN_COLLECTION)
      .find({ role: { $ne: 'superuser' } })
      .sort({ createdAt: -1 })
      .toArray();

    return admins;
  } catch (err) {
    console.error('getAllAdmins Error:', err.message);
    return [];
  }
};

// ─────────────────────────────────────────────
// DELETE ADMIN
// ─────────────────────────────────────────────
const deleteAdmin = async (id) => {
  try {
    if (!ObjectId.isValid(id)) {
      return { status: false, message: 'Invalid admin' };
    }

    // never allow deleting superuser
    const admin = await getAdminById(id);
    if (!admin || admin.role === 'superuser') {
      return { status: false, message: 'Cannot delete superuser' };
    }

    await db.get()
      .collection(collection.ADMIN_COLLECTION)
      .deleteOne({ _id: new ObjectId(id) });

    return { status: true };
  } catch (err) {
    console.error('deleteAdmin Error:', err.message);
    return { status: false, message: err.message };
  }
};

module.exports = {
  getAdminByEmail,
  getAdminById,
  verifyAdminPassword,
  doSignupAdmin,
  getAllAdmins,
  deleteAdmin
};
