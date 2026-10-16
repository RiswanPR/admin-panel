#!/usr/bin/env node
'use strict';

/**
 * Zeitnah Admin Panel — Phase 1: Professional Identity Catalogue Database Seeder
 *
 * Seeds the authoritative Phase 2 Professional Identity catalogue (18 departments,
 * 254 department-scoped titles, version 2026.1) into catalogue_departments
 * and catalogue_titles collections.
 *
 * Usage:
 *   node scripts/seed-catalogue.js [--dry-run]
 *
 * Options:
 *   --dry-run   Validate catalogue and database state without performing writes.
 *   --help      Show usage information.
 */

require('dotenv').config();
const db = require('../config/connection');
const { seedCatalogue } = require('../Helpers/catalogue-seeder');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Zeitnah Professional Identity Catalogue Seeder (Phase 1)

Usage:
  node scripts/seed-catalogue.js [options]

Options:
  --dry-run                 Perform all validations and checks without writing to MongoDB.
  --allow-production-write  Explicit override to permit writes to a remote/production database.
  --help, -h                Show this help message.
`);
  process.exit(0);
}

const isDryRun = args.includes('--dry-run');
const allowProductionWrite = args.includes('--allow-production-write');

async function run() {
  console.log('================================================================');
  console.log('  ZEITNAH ADMIN — PROFESSIONAL IDENTITY CATALOGUE DATABASE SEED  ');
  console.log('================================================================');
  console.log(`Mode               : ${isDryRun ? '\x1b[33mDRY RUN (Read-Only / No Writes)\x1b[0m' : '\x1b[32mWRITE MODE\x1b[0m'}`);
  console.log(`Target Database    : ${process.env.MONGO_DB_NAME || 'lms-platform'}`);
  console.log(`Target Mongo URL   : ${process.env.MONGO_URL ? process.env.MONGO_URL.replace(/:([^@]+)@/, ':****@') : 'mongodb://127.0.0.1:27017'}`);
  console.log('----------------------------------------------------------------');

  let dbConnected = false;
  try {
    try {
      await new Promise((resolve, reject) => {
        db.connect((err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      dbConnected = true;
      console.log('✔ Connected to MongoDB successfully.');
      console.log('Inspecting catalogue source and collections...\n');
    } catch (connErr) {
      if (isDryRun) {
        console.log(`ℹ MongoDB is currently offline or unreachable (${connErr.message}).`);
        console.log('  Executing standalone static catalogue validation and extraction...\n');
        const { loadAndValidateCatalogue } = require('../Helpers/catalogue-loader');
        const catalogue = loadAndValidateCatalogue();
        console.log('----------------------------------------------------------------');
        console.log(`Status             : \x1b[36mDRY_RUN (Offline Mode)\x1b[0m`);
        console.log(`Catalogue Version  : ${catalogue.version}`);
        console.log(`Writes Performed   : \x1b[33mNO\x1b[0m`);
        console.log(`Planned Departments: ${catalogue.departments.length}`);
        console.log(`Planned Titles     : ${catalogue.titles.length}`);
        console.log(`Source Path        : ${catalogue.sourcePath}`);
        console.log('----------------------------------------------------------------');
        console.log(`\n\x1b[32m✔ DRY RUN SUCCESS: Authoritative Phase 2 catalogue verified with exactly ${catalogue.departments.length} departments and ${catalogue.titles.length} department-scoped titles. All composite IDs and verbatim labels verified. Zero writes performed.\x1b[0m\n`);
        process.exit(0);
      } else {
        throw connErr;
      }
    }

    const result = await seedCatalogue(db.get(), {
      dryRun: isDryRun,
      allowProductionWrite,
    });

    console.log('----------------------------------------------------------------');
    console.log(`Status             : \x1b[36m${result.status}\x1b[0m`);
    console.log(`Catalogue Version  : ${result.catalogueVersion}`);
    console.log(`Writes Performed   : ${result.writesPerformed ? '\x1b[32mYES\x1b[0m' : '\x1b[33mNO\x1b[0m'}`);
    if (result.insertedDepartments !== undefined) {
      console.log(`Departments Seeded : ${result.insertedDepartments}`);
      console.log(`Titles Seeded      : ${result.insertedTitles}`);
    } else if (result.plannedDepartments !== undefined) {
      console.log(`Planned Departments: ${result.plannedDepartments}`);
      console.log(`Planned Titles     : ${result.plannedTitles}`);
    } else if (result.existingDepartments !== undefined) {
      console.log(`Existing Depts     : ${result.existingDepartments}`);
      console.log(`Existing Titles    : ${result.existingTitles}`);
    }
    console.log('----------------------------------------------------------------');
    console.log(`\n\x1b[32m${result.message}\x1b[0m\n`);

    if (dbConnected) {
      await db.close();
    }
    process.exit(0);
  } catch (err) {
    console.error('\n\x1b[31m✖ Seeding Aborted:\x1b[0m', err.message, '\n');
    if (dbConnected) {
      try {
        await db.close();
      } catch (_) {}
    }
    process.exit(1);
  }
}

run();
