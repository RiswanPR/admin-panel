/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║           ZEITNAH — SUPERUSER SEED SCRIPT               ║
 * ║                                                          ║
 * ║  Run ONCE to create the superuser account:               ║
 * ║    node seed-superuser.js                                ║
 * ║                                                          ║
 * ║  ⚠️  Credentials are read from .env:                    ║
 * ║    SUPERUSER_EMAIL and SUPERUSER_PASSWORD                ║
 * ║                                                          ║
 * ║  Keep this file SECRET — do not share or commit.         ║
 * ╚══════════════════════════════════════════════════════════╝
 */

require('dotenv').config();

const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

// ─────────────────────────────────────────────
// LOAD CREDENTIALS FROM ENVIRONMENT (never hardcode!)
// ─────────────────────────────────────────────
const SUPERUSER_EMAIL = process.env.SUPERUSER_EMAIL;
const SUPERUSER_PASSWORD = process.env.SUPERUSER_PASSWORD;
const SUPERUSER_NAME = process.env.SUPERUSER_NAME || 'Super Admin';
const SUPERUSER_PHONE = process.env.SUPERUSER_PHONE || '';

if (!SUPERUSER_EMAIL || !SUPERUSER_PASSWORD) {
    console.error('\n❌  SUPERUSER_EMAIL and SUPERUSER_PASSWORD must be set in your .env file.\n');
    process.exit(1);
}

// ─────────────────────────────────────────────
// DB CONFIG
// ─────────────────────────────────────────────
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGO_DB_NAME || 'lms-platform';

async function seed() {
    const client = new MongoClient(MONGO_URL);

    try {
        await client.connect();
        console.log('✅ Connected to MongoDB');

        const db = client.db(DB_NAME);
        const adminsColl = db.collection('admin');

        // check if superuser already exists
        const existing = await adminsColl.findOne({ role: 'superuser' });

        if (existing) {
            console.log('⚠️  A superuser already exists:', existing.Email);
            console.log('   Delete it manually from the DB to re-seed.');
            return;
        }

        // hash the password
        const hashedPassword = await bcrypt.hash(SUPERUSER_PASSWORD, 12);

        await adminsColl.insertOne({
            Name: SUPERUSER_NAME,
            Email: SUPERUSER_EMAIL.trim().toLowerCase(),
            Password: hashedPassword,
            Phone_Number: SUPERUSER_PHONE,
            role: 'superuser',
            createdAt: new Date()
        });

        console.log('');
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║  ✅  Superuser created successfully!          ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log('║  Email   :', SUPERUSER_EMAIL.padEnd(34), '║');
        console.log('║  Password: (as set in .env — keep it safe)  ║');
        console.log('║  Role    : superuser                         ║');
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');
        console.log('🔒  Secret admin-creation URL: /superuser/add-admin');
        console.log('    Do NOT share this URL.');
        console.log('');
        console.log('⚠️   You can now remove SUPERUSER_PASSWORD from .env for extra safety.');

    } catch (err) {
        console.error('❌ Seed Error:', err.message);
    } finally {
        await client.close();
    }
}

seed();
