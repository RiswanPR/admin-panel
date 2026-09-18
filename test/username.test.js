'use strict';

/**
 * Zeitnah Academy — Username Identity System Test Suite
 * Run with: node test/username.test.js
 */

const assert = require('assert');
const usernameHelper = require('../Helpers/username-helper');

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

async function testAsync(desc, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✔ PASS: ${desc}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✖ FAIL: ${desc}`);
        console.error(`    ${err.message}`);
    }
}

async function runAllTests() {
    console.log('\n======================================================');
    console.log('   RUNNING USERNAME IDENTITY SYSTEM TEST SUITE        ');
    console.log('======================================================\n');

    // 1. NORMALIZATION TESTS
    console.log('\x1b[36m[Group 1] Normalization & Sanitization\x1b[0m');
    test('should remove leading @ symbol and trim spaces', () => {
        assert.strictEqual(usernameHelper.normalizeUsername('@john_doe  '), 'john_doe');
        assert.strictEqual(usernameHelper.normalizeUsername('@@@superman'), 'superman');
        assert.strictEqual(usernameHelper.normalizeUsername('  @alice  '), 'alice');
    });

    test('should convert input to lowercase', () => {
        assert.strictEqual(usernameHelper.normalizeUsername('John_Doe_99'), 'john_doe_99');
        assert.strictEqual(usernameHelper.normalizeUsername('RiyasAdmin'), 'riyasadmin');
    });

    test('should handle falsy/empty values gracefully', () => {
        assert.strictEqual(usernameHelper.normalizeUsername(''), '');
        assert.strictEqual(usernameHelper.normalizeUsername(null), '');
        assert.strictEqual(usernameHelper.normalizeUsername(undefined), '');
    });

    // 2. VALIDATION REGEX TESTS
    console.log('\n\x1b[36m[Group 2] Validation Rules (3-30 chars, alphanumeric + [._-], starts/ends alphanumeric)\x1b[0m');
    test('should accept valid handles', () => {
        const validUsernames = ['riyas', 'john.doe', 'alex_123', 'student-01', 'user99', 'a.b-c_d'];
        validUsernames.forEach(u => {
            const res = usernameHelper.validateUsername(u);
            assert.strictEqual(res.isValid, true, `Expected "${u}" to be valid`);
        });
    });

    test('should reject usernames shorter than 3 characters', () => {
        const res = usernameHelper.validateUsername('ab');
        assert.strictEqual(res.isValid, false);
        assert.match(res.error, /at least 3 characters/i);
    });

    test('should reject usernames longer than 30 characters', () => {
        const res = usernameHelper.validateUsername('a'.repeat(31));
        assert.strictEqual(res.isValid, false);
        assert.match(res.error, /cannot exceed 30 characters/i);
    });

    test('should reject handles that start or end with symbols', () => {
        assert.strictEqual(usernameHelper.validateUsername('.alex').isValid, false);
        assert.strictEqual(usernameHelper.validateUsername('_alex').isValid, false);
        assert.strictEqual(usernameHelper.validateUsername('-alex').isValid, false);
        assert.strictEqual(usernameHelper.validateUsername('alex.').isValid, false);
        assert.strictEqual(usernameHelper.validateUsername('alex_').isValid, false);
        assert.strictEqual(usernameHelper.validateUsername('alex-').isValid, false);
    });

    test('should reject handles with consecutive dots or symbols', () => {
        assert.strictEqual(usernameHelper.validateUsername('john..doe').isValid, false);
    });

    test('should reject handles with illegal characters', () => {
        const illegal = ['john doe', 'john@doe', 'alex!#$', 'cool*star', 'user+name'];
        illegal.forEach(u => {
            assert.strictEqual(usernameHelper.validateUsername(u).isValid, false, `Expected "${u}" to be invalid`);
        });
    });

    // 3. RESERVED USERNAMES
    console.log('\n\x1b[36m[Group 3] System Core Reserved Handles\x1b[0m');
    await testAsync('should detect core reserved handles regardless of case', async () => {
        const coreHandles = ['admin', 'ADMIN', 'Admin', 'administrator', 'support', 'profile', 'community', 'api', 'login', 'register', 'zeitnah'];
        for (const h of coreHandles) {
            const res = await usernameHelper.isReservedUsername(usernameHelper.normalizeUsername(h));
            assert.strictEqual(res.isReserved, true, `Expected handle "${h}" to be reserved`);
        }
    });

    await testAsync('should not mark common non-reserved handles as reserved', async () => {
        const ordinary = ['riyas_developer', 'johnny99', 'student_learner'];
        for (const h of ordinary) {
            const res = await usernameHelper.isReservedUsername(usernameHelper.normalizeUsername(h));
            assert.strictEqual(res.isReserved, false, `Expected "${h}" not to be reserved`);
        }
    });

    // 4. BASE HANDLE GENERATOR
    console.log('\n\x1b[36m[Group 4] Handle Derivation Algorithm\x1b[0m');
    test('should derive clean handles from name and email', () => {
        assert.strictEqual(usernameHelper.deriveBaseHandle('John Doe', 'john@example.com'), 'john_doe');
        assert.strictEqual(usernameHelper.deriveBaseHandle('   Riyas  P.R.  ', 'riyas@test.com'), 'riyas_p_r');
        assert.strictEqual(usernameHelper.deriveBaseHandle('', 'student123@zeitnah.com'), 'student123');
        assert.strictEqual(usernameHelper.deriveBaseHandle('', ''), 'learner');
    });

    // 5. COOLDOWN CALCULATION
    console.log('\n\x1b[36m[Group 5] Cooldown Logic\x1b[0m');
    test('should calculate active cooldown within 14 days', () => {
        const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        const cooldown = usernameHelper.calculateCooldownRemaining(tenDaysAgo, 14);
        assert.strictEqual(cooldown.isCooldownActive, true);
        assert.strictEqual(cooldown.daysRemaining >= 3 && cooldown.daysRemaining <= 5, true);
    });

    test('should report inactive cooldown after 14 days', () => {
        const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
        const cooldown = usernameHelper.calculateCooldownRemaining(twentyDaysAgo, 14);
        assert.strictEqual(cooldown.isCooldownActive, false);
        assert.strictEqual(cooldown.daysRemaining, 0);
    });

    test('should handle accounts that never changed usernames', () => {
        const cooldown = usernameHelper.calculateCooldownRemaining(null, 14);
        assert.strictEqual(cooldown.isCooldownActive, false);
        assert.strictEqual(cooldown.daysRemaining, 0);
    });

    // 6. INVARIANT CHECKS
    console.log('\n\x1b[36m[Group 6] Platform Invariants\x1b[0m');
    test('username constraints constants should be properly defined', () => {
        assert.strictEqual(usernameHelper.USERNAME_MIN_LENGTH, 3);
        assert.strictEqual(usernameHelper.USERNAME_MAX_LENGTH, 30);
        assert.strictEqual(Array.isArray(usernameHelper.SYSTEM_RESERVED_USERNAMES), true);
        assert.strictEqual(usernameHelper.SYSTEM_RESERVED_USERNAMES.includes('admin'), true);
    });

    console.log('\n------------------------------------------------------');
    console.log(`Test Execution Summary: ${passedTests}/${totalTests} tests passed.`);
    if (passedTests === totalTests) {
        console.log('\x1b[32m✔ ALL USERNAME IDENTITY SYSTEM TESTS PASSED SUCCESSFULLY!\x1b[0m\n');
        process.exit(0);
    } else {
        console.log('\x1b[31m✖ SOME TESTS FAILED!\x1b[0m\n');
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
