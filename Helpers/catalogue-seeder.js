'use strict';

/**
 * Zeitnah Admin Panel — Professional Identity Catalogue Seeder Engine
 * Provides idempotent, non-destructive seeding for catalogue_departments and catalogue_titles.
 *
 * Safety Guarantees:
 * 1. Validates catalogue integrity before any operations (18 depts, 254 titles, version 2026.1).
 * 2. Writes ONLY when target collections are completely empty.
 * 3. Exits cleanly with no writes if collections are already fully seeded.
 * 4. Aborts with detailed diagnostic on partial or conflicting state (NEVER overwrites or deletes).
 * 5. Supports dry-run mode.
 * 6. Ensures safe indexes.
 */

const collection = require('../config/collections');
const { loadAndValidateCatalogue, EXPECTED_DEPARTMENT_COUNT, EXPECTED_TITLE_COUNT, EXPECTED_VERSION } = require('./catalogue-loader');
const { ensureCatalogueIndexes } = require('./index-helper');

/**
 * Checks whether a MongoDB connection URL or environment implies a remote/production cluster.
 */
function isProductionOrRemote(url = '', nodeEnv = '') {
  const cleanUrl = String(url || '').toLowerCase();
  const cleanEnv = String(nodeEnv || '').toLowerCase();

  if (cleanEnv === 'production') return true;
  if (cleanUrl.includes('mongodb+srv://') || cleanUrl.includes('.mongodb.net')) return true;
  if (cleanUrl.includes('production') || cleanUrl.includes('prod')) return true;
  return false;
}

/**
 * Core seeder function.
 * @param {object} db - MongoDB database instance
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - Perform validation and checks without inserting
 * @param {string} [options.sourcePath] - Optional custom path to TS catalogue
 * @param {boolean} [options.allowProductionWrite=false] - Explicit override for production write
 * @returns {Promise<object>} Seeding result summary
 */
async function seedCatalogue(db, options = {}) {
  if (!db || typeof db.collection !== 'function') {
    throw new Error('Valid MongoDB database instance is required.');
  }

  const dryRun = Boolean(options.dryRun);
  const allowProductionWrite = Boolean(options.allowProductionWrite);

  // 1. Production / Remote Safety Guard
  const mongoUrl = process.env.MONGO_URL || '';
  const nodeEnv = process.env.NODE_ENV || '';
  if (!dryRun && isProductionOrRemote(mongoUrl, nodeEnv) && !allowProductionWrite) {
    throw new Error(
      `Safety Guard Blocked Write: Seeding against production/shared MongoDB (${mongoUrl || nodeEnv}) is blocked. Use --dry-run or a confirmed local database.`
    );
  }

  // 2. Load and Validate Authoritative Catalogue from Source
  const catalogue = loadAndValidateCatalogue(options.sourcePath);

  const deptCollName = collection.CATALOGUE_DEPARTMENTS_COLLECTION || 'catalogue_departments';
  const titleCollName = collection.CATALOGUE_TITLES_COLLECTION || 'catalogue_titles';

  const deptColl = db.collection(deptCollName);
  const titleColl = db.collection(titleCollName);

  // 3. Inspect Existing State of Target Collections
  const existingDeptCount = await deptColl.countDocuments({});
  const existingTitleCount = await titleColl.countDocuments({});

  // ──────────────────────────────────────────────────────────
  // CASE 1: Both collections are completely empty -> Safe to seed
  // ──────────────────────────────────────────────────────────
  if (existingDeptCount === 0 && existingTitleCount === 0) {
    if (dryRun) {
      return {
        success: true,
        status: 'DRY_RUN',
        writesPerformed: false,
        catalogueVersion: catalogue.version,
        plannedDepartments: catalogue.departments.length,
        plannedTitles: catalogue.titles.length,
        existingDepartments: 0,
        existingTitles: 0,
        message: `DRY RUN: Validation passed. Exactly ${catalogue.departments.length} departments and ${catalogue.titles.length} titles are validated and ready to be inserted. Zero writes performed.`,
      };
    }

    // A. Safely create indexes before insertion
    await ensureCatalogueIndexes(db);

    // B. Insert departments
    const deptInsertResult = await deptColl.insertMany(catalogue.departments, { ordered: true });
    if (deptInsertResult.insertedCount !== EXPECTED_DEPARTMENT_COUNT) {
      throw new Error(
        `Department insertion error: Expected ${EXPECTED_DEPARTMENT_COUNT} inserted, but got ${deptInsertResult.insertedCount}.`
      );
    }

    // C. Insert titles
    const titleInsertResult = await titleColl.insertMany(catalogue.titles, { ordered: true });
    if (titleInsertResult.insertedCount !== EXPECTED_TITLE_COUNT) {
      throw new Error(
        `Title insertion error: Expected ${EXPECTED_TITLE_COUNT} inserted, but got ${titleInsertResult.insertedCount}.`
      );
    }

    return {
      success: true,
      status: 'SEEDED',
      writesPerformed: true,
      catalogueVersion: catalogue.version,
      insertedDepartments: deptInsertResult.insertedCount,
      insertedTitles: titleInsertResult.insertedCount,
      existingDepartments: 0,
      existingTitles: 0,
      message: `SUCCESS: Seeded ${deptInsertResult.insertedCount} departments and ${titleInsertResult.insertedCount} titles (Version ${catalogue.version}).`,
    };
  }

  // ──────────────────────────────────────────────────────────
  // CASE 2: Both collections contain the exact expected record count
  // ──────────────────────────────────────────────────────────
  if (existingDeptCount === EXPECTED_DEPARTMENT_COUNT && existingTitleCount === EXPECTED_TITLE_COUNT) {
    // Verify that every source department ID and title ID is present
    const existingDeptIds = new Set(
      (await deptColl.find({}, { projection: { id: 1 } }).toArray()).map((d) => d.id)
    );
    const existingTitleIds = new Set(
      (await titleColl.find({}, { projection: { id: 1 } }).toArray()).map((t) => t.id)
    );

    const missingDeptIds = catalogue.departments.filter((d) => !existingDeptIds.has(d.id));
    const missingTitleIds = catalogue.titles.filter((t) => !existingTitleIds.has(t.id));

    if (missingDeptIds.length === 0 && missingTitleIds.length === 0) {
      // Ensure indexes are up to date even if collections are already populated
      if (!dryRun) {
        await ensureCatalogueIndexes(db);
      }

      return {
        success: true,
        status: 'ALREADY_SEEDED',
        writesPerformed: false,
        catalogueVersion: catalogue.version,
        existingDepartments: existingDeptCount,
        existingTitles: existingTitleCount,
        message: `IDEMPOTENT: Target collections already contain all ${EXPECTED_DEPARTMENT_COUNT} departments and ${EXPECTED_TITLE_COUNT} titles matching version ${catalogue.version}. Zero writes performed.`,
      };
    }

    // IDs do not match source
    throw new Error(
      `Conflicting Catalogue Data: Target collections have counts (18 depts, 254 titles), but ${missingDeptIds.length} department IDs and ${missingTitleIds.length} title IDs do not match the authoritative catalogue. Aborting without modifying records.`
    );
  }

  // ──────────────────────────────────────────────────────────
  // CASE 3: Partial or Conflicting Collection State
  // ──────────────────────────────────────────────────────────
  throw new Error(
    `Aborted: Target collections are in a partial or conflicting state (catalogue_departments: ${existingDeptCount}, catalogue_titles: ${existingTitleCount}). Expected exactly 0/0 for initial seed or ${EXPECTED_DEPARTMENT_COUNT}/${EXPECTED_TITLE_COUNT} for already-seeded state. Database will not be modified or overwritten.`
  );
}

module.exports = {
  seedCatalogue,
  isProductionOrRemote,
};
