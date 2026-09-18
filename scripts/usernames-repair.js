#!/usr/bin/env node
'use strict';

/**
 * Zeitnah Academy — Bulk Missing Usernames Repair CLI
 * Usage:
 *   node scripts/usernames-repair.js --dry-run   (preview proposed handles)
 *   node scripts/usernames-repair.js --apply     (safely assign proposed handles)
 */

require('dotenv').config();
const db = require('../config/connection');
const usernameHelper = require('../Helpers/username-helper');

async function runRepair() {
    const isApply = process.argv.includes('--apply');
    const isDryRun = !isApply || process.argv.includes('--dry-run');

    console.log('\n======================================================');
    console.log('   ZEITNAH ACADEMY — USERNAME REPAIR & RECOVERY TOOL  ');
    console.log(`   Mode: ${isApply ? '\x1b[33mAPPLY (COMMITTING CHANGES)\x1b[0m' : '\x1b[36mDRY RUN (PREVIEW ONLY)\x1b[0m'}`);
    console.log('======================================================\n');

    try {
        await new Promise((resolve, reject) => {
            db.connect((err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        console.log('✔ Connected to MongoDB successfully.');
        console.log('🔍 Scanning for accounts with missing or blank usernames...\n');

        const preview = await usernameHelper.bulkGenerateMissingPreview(1000);
        const candidates = preview.candidates || [];

        if (!candidates.length) {
            console.log('\x1b[32m✔ No accounts with missing usernames found. All users have valid handles!\x1b[0m\n');
            await db.close();
            process.exit(0);
        }

        console.log(`Found ${candidates.length} account(s) requiring usernames:\n`);
        candidates.forEach((cand, idx) => {
            console.log(`  ${(idx + 1).toString().padStart(3, ' ')}. User ID: ${cand.userId} | ${cand.name} (${cand.email}) -> \x1b[32m@${cand.proposedUsername}\x1b[0m`);
        });

        if (!isApply) {
            console.log('\n------------------------------------------------------');
            console.log('\x1b[36m[i] DRY RUN COMPLETE: 0 changes made to the database.\x1b[0m');
            console.log('To apply these generated handles, run:');
            console.log('    \x1b[32mnpm run usernames:repair -- --apply\x1b[0m');
            console.log('------------------------------------------------------\n');
        } else {
            console.log('\n🚀 Applying handles to database...');
            const results = await usernameHelper.bulkGenerateMissingApply({
                candidates,
                admin: { _id: 'cli_admin_repair', name: 'CLI Tool', email: 'cli@zeitnahacademy.com' }
            });
            console.log('\n------------------------------------------------------');
            console.log(`✔ Successfully repaired: \x1b[32m${results.applied}\x1b[0m`);
            console.log(`✖ Errors encountered   : ${results.errors.length > 0 ? '\x1b[31m' + results.errors.length + '\x1b[0m' : '0'}`);
            console.log('------------------------------------------------------\n');
        }

        await db.close();
        process.exit(0);
    } catch (err) {
        console.error('\n\x1b[31m✖ Repair execution failed:\x1b[0m', err.message);
        if (db.close) await db.close();
        process.exit(1);
    }
}

runRepair();
