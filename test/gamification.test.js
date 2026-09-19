'use strict';

/**
 * Zeitnah LMS — Gamification & Leaderboard System Test Suite
 * Run with: node test/gamification.test.js
 */

const assert = require('assert');
const {
  LEVEL_THRESHOLDS,
  RANK_THRESHOLDS,
  calculateLevel,
  calculateRank,
  getNextLevelProgress,
  calculateStreak,
  calculatePoints,
} = require('../Helpers/gamification-constants');

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

async function runAllTests() {
  console.log('\n======================================================');
  console.log('   RUNNING ZEITNAH GAMIFICATION SYSTEM TEST SUITE     ');
  console.log('======================================================\n');

  // 1. LEVEL CALCULATION TESTS
  console.log('\x1b[36m[Group 1] Level Calculation & Thresholds\x1b[0m');
  test('should correctly compute level 1 for 0 to 99 points', () => {
    assert.strictEqual(calculateLevel(0), 1);
    assert.strictEqual(calculateLevel(50), 1);
    assert.strictEqual(calculateLevel(99), 1);
  });

  test('should correctly compute level 2 for 100 to 249 points', () => {
    assert.strictEqual(calculateLevel(100), 2);
    assert.strictEqual(calculateLevel(199), 2);
    assert.strictEqual(calculateLevel(249), 2);
  });

  test('should correctly compute level 3 for 250 to 499 points', () => {
    assert.strictEqual(calculateLevel(250), 3);
    assert.strictEqual(calculateLevel(499), 3);
  });

  test('should correctly compute level 4 for 500 to 999 points', () => {
    assert.strictEqual(calculateLevel(500), 4);
    assert.strictEqual(calculateLevel(999), 4);
  });

  test('should correctly compute level 5 for 1000 to 1999 points', () => {
    assert.strictEqual(calculateLevel(1000), 5);
    assert.strictEqual(calculateLevel(1999), 5);
  });

  test('should correctly compute level 6 for 2000 to 3999 points', () => {
    assert.strictEqual(calculateLevel(2000), 6);
    assert.strictEqual(calculateLevel(3999), 6);
  });

  test('should correctly compute level 7 for 4000+ points', () => {
    assert.strictEqual(calculateLevel(4000), 7);
    assert.strictEqual(calculateLevel(8500), 7);
    assert.strictEqual(calculateLevel(50000), 7);
  });

  // 2. RANK CALCULATION TESTS
  console.log('\n\x1b[36m[Group 2] Rank / Title Calculations\x1b[0m');
  test('should assign Beginner to < 100 points', () => {
    assert.strictEqual(calculateRank(0), 'Beginner');
    assert.strictEqual(calculateRank(99), 'Beginner');
  });

  test('should assign Learner to 100 - 499 points', () => {
    assert.strictEqual(calculateRank(100), 'Learner');
    assert.strictEqual(calculateRank(499), 'Learner');
  });

  test('should assign Advanced Learner to 500 - 999 points', () => {
    assert.strictEqual(calculateRank(500), 'Advanced Learner');
    assert.strictEqual(calculateRank(999), 'Advanced Learner');
  });

  test('should assign Expert to 1000 - 2999 points', () => {
    assert.strictEqual(calculateRank(1000), 'Expert');
    assert.strictEqual(calculateRank(2999), 'Expert');
  });

  test('should assign Master to 3000 - 9999 points', () => {
    assert.strictEqual(calculateRank(3000), 'Master');
    assert.strictEqual(calculateRank(9999), 'Master');
  });

  test('should assign Grand Master to 10000+ points', () => {
    assert.strictEqual(calculateRank(10000), 'Grand Master');
    assert.strictEqual(calculateRank(25000), 'Grand Master');
  });

  // 3. NEXT LEVEL PROGRESS TESTS
  console.log('\n\x1b[36m[Group 3] Next Level Progress & Percentage\x1b[0m');
  test('should accurately calculate progress from level 1 to level 2 (0 to 100)', () => {
    const p50 = getNextLevelProgress(50);
    assert.strictEqual(p50.currentLevel, 1);
    assert.strictEqual(p50.nextLevel, 2);
    assert.strictEqual(p50.pointsToNextLevel, 50);
    assert.strictEqual(p50.progressPercent, 50);
  });

  test('should accurately calculate progress at level 4 (500 to 1000)', () => {
    const p750 = getNextLevelProgress(750);
    assert.strictEqual(p750.currentLevel, 4);
    assert.strictEqual(p750.nextLevel, 5);
    assert.strictEqual(p750.pointsToNextLevel, 250);
    assert.strictEqual(p750.progressPercent, 50);
  });

  test('should handle max level (level 7, 4000+ pts)', () => {
    const pMax = getNextLevelProgress(4500);
    assert.strictEqual(pMax.currentLevel, 7);
    assert.strictEqual(pMax.nextLevel, null);
    assert.strictEqual(pMax.pointsToNextLevel, 0);
    assert.strictEqual(pMax.progressPercent, 100);
  });

  // 4. STREAK CALCULATION TESTS
  console.log('\n\x1b[36m[Group 4] Streak Calculations\x1b[0m');
  test('should calculate 0 streak for empty dates', () => {
    assert.strictEqual(calculateStreak([]), 0);
    assert.strictEqual(calculateStreak(null), 0);
  });

  test('should calculate 1 for single date', () => {
    assert.strictEqual(calculateStreak(['2026-09-18']), 1);
  });

  test('should calculate 3 for 3 consecutive days', () => {
    const dates = ['2026-09-16', '2026-09-17', '2026-09-18'];
    assert.strictEqual(calculateStreak(dates), 3);
  });

  test('should break streak when day is missed', () => {
    const dates = ['2026-09-10', '2026-09-11', '2026-09-17', '2026-09-18'];
    assert.strictEqual(calculateStreak(dates), 2);
  });

  test('should handle duplicate dates on same day without double counting', () => {
    const dates = ['2026-09-17', '2026-09-17', '2026-09-18', '2026-09-18'];
    assert.strictEqual(calculateStreak(dates), 2);
  });

  // 5. POINTS CALCULATION TESTS
  console.log('\n\x1b[36m[Group 5] Watch Minutes to Points\x1b[0m');
  test('should calculate 1 point per whole minute', () => {
    assert.strictEqual(calculatePoints(10), 10);
    assert.strictEqual(calculatePoints(10.7), 10);
    assert.strictEqual(calculatePoints(0), 0);
    assert.strictEqual(calculatePoints(-5), 0);
  });

  // 6. COURSE PROGRESS POINTS CALCULATION TESTS
  console.log('\n\x1b[36m[Group 6] Course Progress Points Calculation\x1b[0m');
  const { calculateCourseProgressPoints, ensureGamification } = require('../Helpers/gamification-helper');

  test('should calculate course points from watch seconds, class completion, and course completion', () => {
    const courseItem = {
      courseId: 'course-101',
      courseName: 'Quantity Surveying',
      learningProgress: {
        totalClasses: 10,
        completedClasses: 10,
        completionPercent: 100
      },
      classProgress: [
        { classId: 'c1', watchedSeconds: 3600, completed: true }, // 60 min = 60 pts, completed = 25 pts -> 85
        { classId: 'c2', watchedSeconds: 1800, completed: true }, // 30 min = 30 pts, completed = 25 pts -> 55
        { classId: 'c3', watchedSeconds: 600, completed: false }, // 10 min = 10 pts, completed = 0 -> 10
      ]
    };
    // Total watch: 3600 + 1800 + 600 = 6000 sec = 100 min = 100 pts
    // Completed classes: 2 * 25 = 50 pts
    // Course completed: 10/10 = 100 pts
    // Total = 100 + 50 + 100 = 250 pts
    const points = calculateCourseProgressPoints(courseItem);
    assert.strictEqual(points, 250);
  });

  test('should ensure gamification fields structure on empty user', () => {
    const user = {};
    const gam = ensureGamification(user);
    assert.strictEqual(gam.totalPoints, 0);
    assert.strictEqual(gam.level, 1);
    assert.strictEqual(gam.rank, 'Beginner');
    assert.strictEqual(Array.isArray(gam.achievements), true);
    assert.strictEqual(Array.isArray(gam.recentActivities), true);
  });

  console.log('\n------------------------------------------------------');
  console.log(`Test Execution Summary: ${passedTests}/${totalTests} passed.`);
  console.log('------------------------------------------------------\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runAllTests();
