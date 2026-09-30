#!/usr/bin/env node
'use strict';

/**
 * Zeitnah Admin Panel — Multi-Role & Capability Architecture CLI Audit
 * DRY-RUN Migration Preview & Semantic Diagnostic Tool (Requirement 14)
 * 
 * STRICT INVARIANT:
 * This script is 100% DRY-RUN by default. It performs ZERO destructive mutations
 * and modifies NO database records. It audits real user records and prints proposed
 * canonical normalizations with confidence ratings and explicit rationale.
 *
 * Usage:
 *   node scripts/audit-multi-role-users.js
 *   node scripts/audit-multi-role-users.js --json
 */

require('dotenv').config();
const db = require('../config/connection');
const governanceHelper = require('../Helpers/governance-helper');

async function runMultiRoleAudit() {
  const isJsonOutput = process.argv.includes('--json');

  if (!isJsonOutput) {
    console.log('\n================================================================');
    console.log('   ZEITNAH ECOSYSTEM: MULTI-ROLE & CAPABILITY ARCHITECTURE AUDIT');
    console.log('   MODE: STRICT DRY-RUN (ZERO PRODUCTION WRITES / NON-DESTRUCTIVE)');
    console.log('================================================================\n');
  }

  try {
    await new Promise((resolve, reject) => {
      db.connect((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (!isJsonOutput) {
      console.log('✔ Connected to MongoDB successfully.\n');
      console.log('Analyzing users, organizations, and memberships for semantic consistency...\n');
    }

    const auditResult = await governanceHelper.auditUserRoleConsistency();

    if (isJsonOutput) {
      console.log(JSON.stringify(auditResult, null, 2));
      process.exit(0);
    }

    console.log('----------------------------------------------------------------');
    console.log(` TOTAL ACCOUNTS ANALYZED        : ${auditResult.totalScanned}`);
    console.log(` FULLY CONSISTENT ACCOUNTS      : \x1b[32m${auditResult.consistentCount}\x1b[0m`);
    console.log(` INCONSISTENT / PENDING NORM    : ${auditResult.inconsistentCount > 0 ? '\x1b[33m' : '\x1b[32m'}${auditResult.inconsistentCount}\x1b[0m`);
    console.log('----------------------------------------------------------------\n');

    console.log('================================================================');
    console.log('   DETAILED USER AUDIT & PROPOSED NORMALIZATIONS                ');
    console.log('================================================================\n');

    auditResult.reports.forEach((rep, index) => {
      const statusColor = rep.isConsistent ? '\x1b[32m[CONSISTENT]\x1b[0m' : '\x1b[33m[NEEDS_NORMALIZATION]\x1b[0m';
      console.log(`[#${index + 1}] User: ${rep.displayName} (@${rep.username}) — ${statusColor}`);
      console.log(`    ID                     : ${rep.userId}`);
      console.log(`    Current primaryRole    : ${rep.currentPrimaryRole || '<none>'}`);
      console.log(`    Current roles          : ${JSON.stringify(rep.currentRoles)}`);
      console.log(`    Current capabilities   : ${JSON.stringify(rep.currentCapabilities)}`);

      if (rep.inconsistencies.length > 0) {
        console.log(`    \x1b[31mInconsistencies Found (${rep.inconsistencies.length}):\x1b[0m`);
        rep.inconsistencies.forEach(inc => {
          console.log(`      • [${inc.severity}] ${inc.code}: ${inc.message}`);
          console.log(`        Current: ${JSON.stringify(inc.currentValue)} -> Recommended: ${JSON.stringify(inc.recommendedValue)}`);
        });
      } else {
        console.log(`    Inconsistencies        : None detected (Clean)`);
      }

      console.log(`    \x1b[36mProposed Normalization:\x1b[0m`);
      console.log(`      primaryRole          : "${rep.normalizedProposal.primaryRole}"`);
      console.log(`      roles                : ${JSON.stringify(rep.normalizedProposal.roles)}`);
      console.log(`      capabilities         : ${JSON.stringify(rep.normalizedProposal.capabilities)}`);
      console.log(`    Action                 : \x1b[1m${rep.recommendedAction}\x1b[0m`);
      console.log(`    Confidence             : \x1b[32m${rep.confidence}\x1b[0m`);
      console.log('----------------------------------------------------------------');
    });

    console.log('\n================================================================');
    console.log('   MIGRATION SAFETY VERIFICATION & NEXT STEPS                   ');
    console.log('================================================================');
    console.log('• This report reflects a dry-run migration preview.');
    console.log('• No records were modified or deleted in MongoDB.');
    console.log('• Course enrollments, profile fields, and business memberships remain preserved.');
    console.log('• Admin Panel can safely govern multi-role users via the Admin UI.\n');

    process.exit(0);
  } catch (err) {
    console.error('\x1b[31m[!] Audit Execution Error:\x1b[0m', err.message);
    process.exit(1);
  }
}

runMultiRoleAudit();
