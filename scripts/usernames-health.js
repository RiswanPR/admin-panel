#!/usr/bin/env node
'use strict';

/**
 * Zeitnah Academy — Username Health CLI Diagnostic
 * Usage: node scripts/usernames-health.js
 */

require('dotenv').config();
const db = require('../config/connection');
const usernameHelper = require('../Helpers/username-helper');

async function runHealthCheck() {
    console.log('\n======================================================');
    console.log('   ZEITNAH ACADEMY — USERNAME HEALTH & DIAGNOSTICS   ');
    console.log('======================================================\n');

    try {
        await new Promise((resolve, reject) => {
            db.connect((err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        console.log('✔ Connected to MongoDB successfully.\n');

        const health = await usernameHelper.getUsernameHealth();

        console.log('------------------------------------------------------');
        console.log(` Total Accounts Analyzed  : ${health.totalUsers}`);
        console.log(` Valid Usernames          : ${health.validUsernames}`);
        console.log(` Claimed Usernames        : ${health.claimedUsernames}`);
        console.log(` Unclaimed Usernames      : ${health.unclaimedUsernames}`);
        console.log('------------------------------------------------------');
        console.log(` Missing / Empty Usernames: ${health.missingUsernames > 0 ? '\x1b[31m' : '\x1b[32m'}${health.missingUsernames}\x1b[0m`);
        console.log(` Invalid Format Handles   : ${health.invalidFormatUsernames > 0 ? '\x1b[31m' : '\x1b[32m'}${health.invalidFormatUsernames}\x1b[0m`);
        console.log(` Reserved Keyword Clashes : ${health.reservedCollisions > 0 ? '\x1b[31m' : '\x1b[32m'}${health.reservedCollisions}\x1b[0m`);
        console.log(` Duplicate Groups         : ${health.duplicateGroups.length > 0 ? '\x1b[31m' : '\x1b[32m'}${health.duplicateGroups.length}\x1b[0m`);
        console.log('------------------------------------------------------');

        if (health.duplicateGroups.length > 0) {
            console.log('\n\x1b[33m[!] DUPLICATE USERNAME COLLISION DETAILS:\x1b[0m');
            health.duplicateGroups.forEach((group, idx) => {
                console.log(`  ${idx + 1}. Handle: @${group._id} (Count: ${group.count}, User IDs: ${group.userIds.join(', ')})`);
            });
        }

        if (health.totalIssues === 0) {
            console.log('\n\x1b[32m✔ STATUS: HEALTHY (Zero issues detected in usernames identity system)\x1b[0m\n');
        } else {
            console.log(`\n\x1b[33m⚠ STATUS: ATTENTION REQUIRED (${health.totalIssues} issue(s) detected)\x1b[0m`);
            console.log('  Run "npm run usernames:repair" to preview automatic fixes.\n');
        }

        await db.close();
        process.exit(0);
    } catch (err) {
        console.error('\n\x1b[31m✖ Health check failed:\x1b[0m', err.message);
        if (db.close) await db.close();
        process.exit(1);
    }
}

runHealthCheck();
