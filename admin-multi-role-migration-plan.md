# Zeitnah Multi-Role Architecture: Safe Non-Destructive Migration Plan

**Document Type:** Phased Migration Strategy & Execution Protocol  
**Status:** Pre-Phase 9 Foundation Standard (Approved)  
**Safety Mandate:** Zero-Risk / Non-Destructive / Zero Production Data Mutations Until Explicit Sign-Off  
**Execution Command Requirement:** Strict Dry-Run Mode Mandatory; NO Automated Bulk Writes  

---

## 1. Safety Mandates & Migration Invariants

1. **NO Automated Mass-Migration During Foundation Work:**  
   The current foundation work strictly prohibits unverified bulk mutation of production MongoDB collections.
2. **NO Destructive Deletions:**  
   No user records, course enrollments, profile fields, work experience items, certificates, or organization memberships will ever be deleted or truncated during migration.
3. **Runtime Compatibility First:**  
   The Admin Panel and underlying APIs already implement an in-memory runtime compatibility layer (`governanceHelper.resolveCanonicalUserRoles()`). Existing users with legacy schema shapes are normalized on-the-fly without requiring immediate database writes.
4. **Mandatory Audit Logging for Every Mutation:**  
   Any role adjustment made by an administrator through the governance interface produces an auditable record in `audit_logs` specifying actor ID, previous state, new state, and mandatory governance reason.

---

## 2. Five-Phase Phased Rollout Roadmap

```
  ┌─────────────────────────────────────────────────────────────┐
  │ PHASE 1: Runtime Resolution Layer (COMPLETED)               │
  │ • In-memory normalization of legacy user records            │
  │ • Real-time capability derivation                           │
  │ • Decoupled course participation                            │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────────┐
  │ PHASE 2: Administrative Governance UI (COMPLETED)           │
  │ • Admin multi-role controls (/admin/network/users/:id)      │
  │ • Add/remove secondary roles with mandatory reason          │
  │ • Admin audit logging for every mutation                    │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────────┐
  │ PHASE 3: Dry-Run Diagnostic Auditing (COMPLETED)            │
  │ • node scripts/audit-multi-role-users.js                    │
  │ • Inconsistency detection & confidence scoring              │
  │ • Zero database writes                                      │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────────┐
  │ PHASE 4: Controlled Migration Protocol (PLANNED POST-P9)    │
  │ • MongoDB snapshot backup verification                      │
  │ • Opt-in normalization script with rollback manifest        │
  │ • Non-destructive $set operations only                      │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────────┐
  │ PHASE 5: User Panel API Contract Alignment (PHASE 9)        │
  │ • User Panel frontend consumes canonical contract           │
  │ • Deprecation of legacy schema defaults                     │
  └─────────────────────────────────────────────────────────────┘
```

---

## 3. Dry-Run Diagnostic Audit Tool

A dedicated dry-run diagnostic script has been created at:
`scripts/audit-multi-role-users.js`

### Execution Syntax:
```bash
# Standard human-readable console report (Strict Dry-Run)
node scripts/audit-multi-role-users.js

# Machine-readable JSON output for automated reporting
node scripts/audit-multi-role-users.js --json

# Filter audit by a single target user ID
node scripts/audit-multi-role-users.js --userId=6a4153e7475174bdc2332b89
```

### Dry-Run Output Guarantee:
- Establishes read-only connection to MongoDB.
- Scans `users`, `organizations`, `organization_memberships`, and `community_profiles`.
- Produces:
  1. User ID and username
  2. Current `primaryRole`, `roles`, and `capabilities`
  3. Identified inconsistencies (`PRIMARY_ROLE_MISSING`, `MALFORMED_CAPABILITIES_DETECTED`, etc.)
  4. Proposed normalized representation
  5. Justification reason and confidence score (`HIGH` / `MEDIUM`)
  6. Recommended action (`CANONICAL_NORMALIZATION` or `NO_ACTION`)
- **ZERO `updateOne`, `updateMany`, `replaceOne`, or `delete` operations are executed.**

---

## 4. Proposed Normalization Rules (Non-Destructive)

When an account is normalized, the migration strictly applies additive transformations:

```javascript
// Example input legacy document:
{
  "_id": ObjectId("6a4153e7475174bdc2332b89"),
  "name": "Riswan",
  "username": "riswan",
  "role": "student",
  "capabilities": ["STUDENT"],
  "course": [ObjectId("69a1ff3e99326ef447ecdb01")]
}

// Proposed Non-Destructive Update ($set):
{
  "$set": {
    "primaryRole": "STUDENT",
    "roles": ["STUDENT"],
    "capabilities": [
      "ACCESS_COURSES",
      "ACCESS_JOBS",
      "ACCESS_CAREER_INTELLIGENCE"
    ],
    "updatedAt": new Date()
  }
}
```

### Safeguards:
- `course` array is untouched.
- `role` field remains `"student"` for legacy backward compatibility.
- Passwords, usernames, tokens, profile details, and affiliations remain completely unaltered.

---

## 5. Controlled Future Execution Protocol (Post-Sign-Off Only)

Before any batch database writes are authorized in future phases, the following checklist must be satisfied:

1. **Prerequisite 1: Backup Verification**
   ```bash
   mongodump --uri="mongodb://localhost:27017/lms-platform" --out="/backup/pre-migration-$(date +%Y%m%d)"
   ```
2. **Prerequisite 2: Dry-Run Output Inspection**
   Run `node scripts/audit-multi-role-users.js` and verify that all proposed updates have confidence `HIGH`.
3. **Prerequisite 3: Architectural Peer Review**
   Review proposed changes with the Lead Architecture and Product Governance team.
4. **Prerequisite 4: Granular Rollback Manifest**
   Any script executing database updates must write each modified document's prior state into a timestamped rollback JSON file (`/backups/rollback-manifest-<timestamp>.json`).

### Non-Destructive Rollback Command (Standard):
In the event of an unexpected edge case, the rollback manifest can be applied without data loss:
```javascript
// Reversion logic restores previous primaryRole, roles, and capabilities from manifest
await db.collection('students').updateOne(
  { _id: new ObjectId(manifest.userId) },
  { $set: manifest.previousState }
);
```

---

## 6. Verification & Health Monitoring

Post-migration health is continuously verified using:
1. **Automated Test Suite:**
   ```bash
   npm run test:governance
   npm test
   ```
2. **Admin Diagnostic Dashboard:**
   Navigating to `/admin/network/audit-roles` displays real-time health metrics, flagging any account with inconsistent roles or malformed capabilities.
