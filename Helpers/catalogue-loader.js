'use strict';

/**
 * Zeitnah Admin Panel — Professional Identity Catalogue Loader & Extractor
 * Reads and validates the authoritative Phase 2 catalogue directly from the
 * TypeScript source module in user-panel-zeitnah/backend.
 *
 * Enforces strict validation:
 * - Exactly 18 departments
 * - Exactly 254 department-scoped title occurrences
 * - Version 2026.1
 * - Preserves verbatim labels, casings, IDs, statuses, and ordering
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE_TS_PATH = path.resolve(
  __dirname,
  '../../user-panel-zeitnah/backend/src/modules/profile/constants/professional-catalogue.ts'
);

const EXPECTED_VERSION = '2026.1';
const EXPECTED_DEPARTMENT_COUNT = 18;
const EXPECTED_TITLE_COUNT = 254;

/**
 * Extracts the raw catalogue object from the TypeScript file using either
 * the typescript compiler in user-panel-zeitnah/backend or a zero-dependency
 * JavaScript AST evaluator.
 */
function extractFromTsSource(tsSource) {
  // Try using the TypeScript compiler if available in the monorepo
  let ts = null;
  try {
    ts = require(path.resolve(__dirname, '../../user-panel-zeitnah/backend/node_modules/typescript'));
  } catch (err) {
    try {
      ts = require('typescript');
    } catch (fallbackErr) {
      ts = null;
    }
  }

  if (ts && typeof ts.transpileModule === 'function') {
    const jsCode = ts.transpileModule(tsSource, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;

    const mod = {};
    const exportsObj = {};
    const fn = new Function('exports', 'module', jsCode);
    fn(exportsObj, mod);
    const result = mod.exports || exportsObj;

    return {
      version: result.PROFESSIONAL_CATALOGUE_VERSION,
      departments: result.PROFESSIONAL_DEPARTMENTS,
    };
  }

  // Fallback: zero-dependency clean extraction
  const versionMatch = tsSource.match(/PROFESSIONAL_CATALOGUE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  const version = versionMatch ? versionMatch[1] : null;

  const startMarker = 'PROFESSIONAL_DEPARTMENTS';
  const startIdx = tsSource.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(`Marker '${startMarker}' not found in TypeScript source.`);
  }

  const arrayStart = tsSource.indexOf('[', startIdx);
  const arrayEnd = tsSource.lastIndexOf('] as const;');
  if (arrayStart === -1 || arrayEnd === -1) {
    throw new Error('Could not locate bounds of PROFESSIONAL_DEPARTMENTS array.');
  }

  const rawArray = tsSource.slice(arrayStart, arrayEnd + 1);
  const departments = new Function(`return ${rawArray}`)();

  return { version, departments };
}

/**
 * Loads, parses, and rigorously validates the authoritative catalogue.
 * @param {string} [customPath] - Optional override path to the source TS file
 * @returns {{ version: string, departments: Array<object>, titles: Array<object>, summary: object, sourcePath: string }}
 */
function loadAndValidateCatalogue(customPath = null) {
  const sourcePath = customPath || process.env.PROFESSIONAL_CATALOGUE_SOURCE_PATH || DEFAULT_SOURCE_TS_PATH;

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Authoritative catalogue source file not found at: ${sourcePath}`);
  }

  const tsSource = fs.readFileSync(sourcePath, 'utf8');
  const raw = extractFromTsSource(tsSource);

  if (!raw.version || typeof raw.version !== 'string') {
    throw new Error(`Invalid catalogue version extracted: ${raw.version}`);
  }
  if (raw.version !== EXPECTED_VERSION) {
    throw new Error(`Catalogue version mismatch: expected '${EXPECTED_VERSION}', received '${raw.version}'.`);
  }

  if (!Array.isArray(raw.departments)) {
    throw new Error('Extracted PROFESSIONAL_DEPARTMENTS is not an array.');
  }

  if (raw.departments.length !== EXPECTED_DEPARTMENT_COUNT) {
    throw new Error(
      `Department count mismatch: expected exactly ${EXPECTED_DEPARTMENT_COUNT}, received ${raw.departments.length}.`
    );
  }

  const now = new Date();
  const departmentDocs = [];
  const titleDocs = [];
  const seenDeptIds = new Set();
  const seenTitleIds = new Set();
  let totalTitleCount = 0;

  raw.departments.forEach((dept, deptIdx) => {
    // 1. Department Validation
    if (!dept || typeof dept !== 'object') {
      throw new Error(`Department at index ${deptIdx} is not an object.`);
    }

    const deptId = typeof dept.id === 'string' ? dept.id.trim() : '';
    if (!deptId) {
      throw new Error(`Department at index ${deptIdx} has an empty or invalid 'id'.`);
    }

    if (seenDeptIds.has(deptId)) {
      throw new Error(`Duplicate department ID detected: '${deptId}' at index ${deptIdx}.`);
    }
    seenDeptIds.add(deptId);

    const deptName = typeof dept.name === 'string' ? dept.name.trim() : '';
    if (!deptName) {
      throw new Error(`Department '${deptId}' has an empty or invalid 'name'.`);
    }

    if (dept.status !== 'active' && dept.status !== 'retired') {
      throw new Error(`Department '${deptId}' has invalid status: '${dept.status}'.`);
    }

    if (!Array.isArray(dept.titles) || dept.titles.length === 0) {
      throw new Error(`Department '${deptId}' has no titles array.`);
    }

    const deptDoc = {
      id: dept.id,
      name: dept.name,
      status: dept.status,
      displayOrder: deptIdx + 1,
      catalogueVersion: raw.version,
      aliases: Array.isArray(dept.aliases) ? dept.aliases : [],
      createdAt: now,
      updatedAt: now,
    };
    departmentDocs.push(deptDoc);

    // 2. Department-Scoped Titles Validation
    dept.titles.forEach((title, titleIdx) => {
      totalTitleCount += 1;

      if (!title || typeof title !== 'object') {
        throw new Error(`Title at index ${titleIdx} in department '${deptId}' is not an object.`);
      }

      const titleId = typeof title.id === 'string' ? title.id.trim() : '';
      if (!titleId) {
        throw new Error(`Title at index ${titleIdx} in department '${deptId}' has an empty or invalid 'id'.`);
      }

      if (seenTitleIds.has(titleId)) {
        throw new Error(`Duplicate title ID detected across catalogue: '${titleId}'.`);
      }
      seenTitleIds.add(titleId);

      // Enforce department scoping prefix: `<deptId>:<title-slug>`
      if (!titleId.startsWith(`${deptId}:`)) {
        throw new Error(
          `Title ID '${titleId}' is not properly scoped to department '${deptId}' (expected prefix '${deptId}:').`
        );
      }

      const titleLabel = typeof title.label === 'string' ? title.label.trim() : '';
      if (!titleLabel) {
        throw new Error(`Title '${titleId}' in department '${deptId}' has an empty or invalid 'label'.`);
      }

      if (title.status !== 'active' && title.status !== 'retired') {
        throw new Error(`Title '${titleId}' has invalid status: '${title.status}'.`);
      }

      const titleDoc = {
        id: title.id,
        departmentId: dept.id,
        label: title.label,
        status: title.status,
        displayOrder: titleIdx + 1,
        catalogueVersion: raw.version,
        aliases: Array.isArray(title.aliases) ? title.aliases : [],
        createdAt: now,
        updatedAt: now,
      };
      titleDocs.push(titleDoc);
    });
  });

  if (totalTitleCount !== EXPECTED_TITLE_COUNT) {
    throw new Error(
      `Total title count mismatch: expected exactly ${EXPECTED_TITLE_COUNT}, received ${totalTitleCount}.`
    );
  }

  return {
    version: raw.version,
    departments: departmentDocs,
    titles: titleDocs,
    summary: {
      version: raw.version,
      departmentCount: departmentDocs.length,
      titleCount: titleDocs.length,
      uniqueDepartmentIds: seenDeptIds.size,
      uniqueTitleIds: seenTitleIds.size,
    },
    sourcePath,
  };
}

module.exports = {
  loadAndValidateCatalogue,
  extractFromTsSource,
  EXPECTED_VERSION,
  EXPECTED_DEPARTMENT_COUNT,
  EXPECTED_TITLE_COUNT,
  DEFAULT_SOURCE_TS_PATH,
};
