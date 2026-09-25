'use strict';

/**
 * Zeitnah LMS — Students & Points View & Interaction Test Suite
 * Tests template rendering, buttons, modal triggers, pagination, and client JS logic.
 * Run with: node test/students-points.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');

let totalTests = 0;
let passedTests = 0;

function test(desc, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✔ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✖ FAIL: ${desc}`);
    console.error(`    ${err.message}`);
  }
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('   TESTING STUDENTS & POINTS VIEW & BUTTONS           ');
  console.log('======================================================\n');

  // Register Handlebars helpers matching app.js
  handlebars.registerHelper('eq', (a, b) => String(a) === String(b));
  handlebars.registerHelper('ifEquals', function (a, b, options) {
    return String(a) === String(b) ? options.fn(this) : options.inverse(this);
  });
  handlebars.registerHelper('selected', (a, b) => (String(a) === String(b) ? 'selected' : ''));
  handlebars.registerHelper('add', (a, b) => Number(a || 0) + Number(b || 0));
  handlebars.registerHelper('inc', (val) => Number(val || 0) + 1);
  handlebars.registerHelper('dec', (val) => Math.max(1, Number(val || 1) - 1));
  handlebars.registerHelper('or', function (...args) {
    return args.slice(0, -1).some(Boolean);
  });

  // Register partials
  const awardModalSrc = fs.readFileSync(
    path.join(__dirname, '../views/partials/gamification/award-modal.hbs'),
    'utf8'
  );
  handlebars.registerPartial('gamification/award-modal', awardModalSrc);

  const kpiCardsSrc = fs.readFileSync(
    path.join(__dirname, '../views/partials/gamification/kpi-cards.hbs'),
    'utf8'
  );
  handlebars.registerPartial('gamification/kpi-cards', kpiCardsSrc);

  const studentsPointsSrc = fs.readFileSync(
    path.join(__dirname, '../views/admin/gamification/students-points.hbs'),
    'utf8'
  );

  console.log('\x1b[36m[Group 1] Template Syntax & Handlebars Compilation\x1b[0m');

  test('should compile students-points.hbs and all partials without errors', () => {
    const template = handlebars.compile(studentsPointsSrc);
    const mockData = {
      admins: true,
      currentPage: 'students-points',
      viewMode: 'card',
      kpis: {
        totalStudents: 142,
        activeStudents: 110,
        totalPoints: 24500,
        averagePoints: 172,
      },
      pagination: {
        page: 1,
        limit: 25,
        total: 142,
        totalPages: 6,
        hasPrev: false,
        hasNext: true,
        prevPage: 0,
        nextPage: 2,
      },
      filters: {
        search: '',
        level: '',
        rank: '',
        sort: 'points',
        status: '',
      },
      students: [
        {
          _id: '507f1f77bcf86cd799439011',
          rank: 1,
          displayName: "Liam O'Connor", // Contains single quote to verify safe handling!
          username: '@liam_oc',
          imageUrl: '/img/placeholders/profile.svg',
          initials: 'LO',
          points: 4500,
          level: 7,
          rankTitle: 'Grand Master',
          rankMeta: { icon: 'fa-crown', badgeClass: 'rank-grandmaster' },
          completedClasses: 28,
          completedCourses: 3,
          enrolledCoursesCount: 4,
          streak: 12,
          levelProgress: { currentInLevel: 500, neededInLevel: 1000, percentage: 50 },
          isActive: true,
        },
        {
          _id: '507f1f77bcf86cd799439022',
          rank: 2,
          displayName: 'Amina Said',
          username: '@amina',
          imageUrl: '',
          initials: 'AS',
          points: 1250,
          level: 5,
          rankTitle: 'Expert',
          rankMeta: { icon: 'fa-certificate', badgeClass: 'rank-expert' },
          completedClasses: 14,
          completedCourses: 1,
          enrolledCoursesCount: 2,
          streak: 5,
          levelProgress: { currentInLevel: 250, neededInLevel: 1000, percentage: 25 },
          isActive: true,
        },
      ],
    };

    const html = template(mockData);
    assert(html.includes('Students & Points'), 'Rendered HTML contains title');
    assert(html.includes("Liam O'Connor") || html.includes('Liam O&#x27;Connor'), 'Rendered HTML contains student with apostrophe safely');
    assert(html.includes('Give Points'), 'Contains Give Points header button');
    assert(html.includes('Deduct Points'), 'Contains Deduct Points header button');
    assert(html.includes('students-pointsCardView'), 'Contains Cards View container');
    assert(html.includes('students-pointsTableView'), 'Contains Table View container');
    assert(html.includes('data-gamification-action="award"'), 'Contains Award action button');
    assert(html.includes('data-gamification-action="adjust"'), 'Contains Deduct action button');
  });

  console.log('\n\x1b[36m[Group 2] Action Buttons & Data Attributes\x1b[0m');

  test('should ensure all action buttons have required data attributes for modal triggers', () => {
    const template = handlebars.compile(studentsPointsSrc);
    const mockStudent = {
      _id: '65a001122334455667788990',
      displayName: 'Jane Doe',
      username: '@janedoe',
      points: 800,
      level: 4,
      rankTitle: 'Advanced Learner',
      rankMeta: { icon: 'fa-medal', badgeClass: 'rank-advanced' },
      completedClasses: 8,
      completedCourses: 1,
      enrolledCoursesCount: 2,
      streak: 3,
      levelProgress: { currentInLevel: 300, neededInLevel: 500, percentage: 60 },
      isActive: true,
    };

    const html = template({
      students: [mockStudent],
      pagination: { page: 1, total: 1, totalPages: 1 },
      filters: {},
    });

    assert(
      html.includes('data-gamification-action="award"'),
      'Must contain data-gamification-action="award"'
    );
    assert(
      html.includes('data-student-id="65a001122334455667788990"'),
      'Must bind student id attribute'
    );
    assert(
      html.includes('data-current-balance="800"'),
      'Must bind current balance attribute'
    );
    assert(
      html.includes('data-gamification-action="give-points"'),
      'Header Give Points button has data-gamification-action="give-points"'
    );
  });

  console.log('\n\x1b[36m[Group 3] Client-Side JavaScript Logic & Invariants\x1b[0m');

  const jsContent = fs.readFileSync(
    path.join(__dirname, '../public/javascripts/gamification.js'),
    'utf8'
  );

  test('gamification.js should only reset page on filter change, never on pagination click', () => {
    assert(
      jsContent.includes("if (paramName !== 'page')"),
      'Must guard page reset with if (paramName !== "page")'
    );
  });

  test('gamification.js should handle HTMLElement or options in openAwardPointsModal', () => {
    assert(
      jsContent.includes('options instanceof HTMLElement'),
      'Must support passing element directly to openAwardPointsModal'
    );
  });

  test('gamification.js should provide closeAwardPointsModal and backdrop cleanup', () => {
    assert(
      jsContent.includes('window.closeAwardPointsModal'),
      'Must define window.closeAwardPointsModal'
    );
  });

  test('gamification.js should attach global click delegation for data-gamification-action', () => {
    assert(
      jsContent.includes("data-gamification-action"),
      'Must listen for data-gamification-action clicks'
    );
  });

  console.log('\n======================================================');
  console.log(`TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
  console.log('======================================================\n');

  if (totalTests !== passedTests) {
    process.exit(1);
  }
}

runTestSuite();
