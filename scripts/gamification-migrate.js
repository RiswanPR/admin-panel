'use strict';

/**
 * Zeitnah LMS — Idempotent Gamification Points Migration Script
 * Migrates existing student points into baseline point_transactions ledger records.
 * Safe to run multiple times. Never resets or duplicates points.
 *
 * Usage: node scripts/gamification-migrate.js
 */

require('dotenv').config();
const db = require('../config/connection');
const gamificationHelper = require('../Helpers/gamification-helper');

async function runMigration() {
  console.log('====================================================');
  console.log('  ZEITNAH GAMIFICATION — LEGACY POINTS MIGRATION     ');
  console.log('====================================================');

  db.connect(async (err) => {
    if (err) {
      console.error('❌ Database connection failed:', err.message);
      process.exit(1);
    }

    try {
      console.log(' Connected to MongoDB. Inspecting student balances...');
      const result = await gamificationHelper.migrateLegacyPoints();

      console.log('\n----------------------------------------------------');
      console.log(`Total students inspected : ${result.totalChecked}`);
      console.log(`New baseline records created: ${result.migratedCount}`);
      console.log(`Already reconciled / skipped: ${result.skippedCount}`);
      console.log('----------------------------------------------------');
      console.log('✅ Migration completed successfully.\n');

      await db.close();
      process.exit(0);
    } catch (migErr) {
      console.error('❌ Migration failed:', migErr.message);
      await db.close();
      process.exit(1);
    }
  });
}

runMigration();
