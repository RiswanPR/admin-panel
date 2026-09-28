# ZEITNAH ADMIN PANEL — PHASE 3 ARCHITECTURE SPECIFICATION
## Businesses & Jobs Governance Architecture

**Date:** 2026-09-28  
**Phase:** Admin Phase 3  
**Status:** COMPLETE & SEALED  

---

### 1. Architectural Principles

1. **Governance, Not Management:** The Admin Panel serves as an oversight, compliance, verification, and moderation control center. Employer recruitment consoles, application screening, and candidate communication belong strictly to the User Panel.
2. **Zero Candidate PII Leakage:** Under candidate data sovereignty, the Admin Panel must never expose candidate resumes, passports, telephone numbers, or unredacted CV data. Only aggregate application counts and compatibility rankings are projected.
3. **Least Privilege RBAC:** Every administrative mutation requires explicit capability validation via `requireCapability()`. Sensitive ownership transfers require superuser-exclusive capability.
4. **Deterministic Auditing:** All mutations record actor, target entity, previous state, new state, client IP, user agent, and timestamp with automated credential scrubbing.
5. **State Machine Integrity:** All transitions are guarded against invalid states (e.g. unverified business cannot publish jobs, suspended business cannot have active public jobs).

---

### 2. Entity Relationship Diagram

```
+------------------------------------+
|           organizations            |
|------------------------------------|
| _id: ObjectId                      |<---------------+
| name: String                       |                |
| slug: String (Indexed, Unique)     |                |
| status: Enum                       |                |
| verificationStatus: Enum           |                |
| createdBy: ObjectId (User Ref)     |--+             |
+------------------------------------+  |             |
                                        |             |
+------------------------------------+  |  +------------------------------------+
|       students (Users)             |  |  |     organization_memberships       |
|------------------------------------|  |  |------------------------------------|
| _id: ObjectId                      |<-+  | _id: ObjectId                      |
| username: String                   |     | organizationId: ObjectId --------->+
| name: String                       |<----+ userId: ObjectId                   |
| email: String                      |     | role: owner|admin|recruiter|member |
| primaryRole: Enum                  |     +------------------------------------+
+------------------------------------+
        ^
        | (Created By)
+------------------------------------+
|           opportunities            |
|------------------------------------|
| _id: ObjectId                      |
| organizationId: ObjectId --------->+
| createdBy: ObjectId (User Ref)     |
| title: String                      |
| discipline: String                 |
| infrastructureSector: String       |
| status: PUBLISHED|DRAFT|PAUSED|... |
| moderationStatus: FLAGGED|...      |
+------------------------------------+
        |                  |
        v                  v
+----------------+  +--------------------+
|job_applications|  | job_talent_matches |
| (Aggregations) |  |   (AI Telemetry)   |
+----------------+  +--------------------+
```

---

### 3. Permission & Capability Matrix

| Role | Capabilities Granted | Scope & Constraints |
| :--- | :--- | :--- |
| **Superuser** | ALL capabilities including `transfer_business_ownership`, `manage_businesses`, `manage_jobs`, `view_verification_evidence` | Unrestricted enterprise governance |
| **Business Admin** | `manage_businesses`, `view_business_members`, `view_employer_data`, `manage_jobs` | Business approval, review, member role changes; CANNOT transfer ownership |
| **Verification Admin** | `verify_profiles`, `view_verification_evidence`, `view_employer_data` | Inspect raw verification evidence, adjudicate corporate verification |
| **General Admin** | `manage_businesses`, `manage_jobs`, `moderate_jobs` | Standard listing, approval, suspension, moderation |
| **Analyst / Viewer** | `view_business_members`, `view_employer_data`, `view_matching_data` | Read-only inspection; sensitive verification evidence is REDACTED |
| **Normal User / None** | ZERO administrative capabilities | 401 / 403 Access Denied |

---

### 4. Lifecycle State Machines

#### 4.1 Business Lifecycle
```
                 +-------------+
                 |    DRAFT    |
                 +-------------+
                        |
                        v
                 +---------------+
         +------>| PENDING_REVIEW|<------+
         |       +---------------+       |
         |         /           \         |
         |  Approve             Reject   |
         |       /               \       |
         |      v                 v      |
   +----------+                +----------+
   | APPROVED |                | REJECTED |
   +----------+                +----------+
     |      ^
  Suspend Restore
     |      |
     v      |
   +-----------+
   | SUSPENDED |
   +-----------+
```

#### 4.2 Job Publishing & Moderation Lifecycle
```
                 +-------------+
                 |    DRAFT    |
                 +-------------+
                        | Submit
                        v
                 +----------------+
                 | PENDING_REVIEW |
                 +----------------+
                  /              \
     Approve (Requires            Reject (Mandatory
     Approved Employer)             Reason)
                /                  \
               v                    v
        +-----------+         +----------+
        | PUBLISHED |         | REJECTED |
        +-----------+         +----------+
          /   |   \
   Unpublish Close Suspend
        /     |     \
       v      v      v
   +------+ +------+ +-----------+
   |PAUSED| |CLOSED| | SUSPENDED |
   +------+ +------+ +-----------+
       \      |      /
        Restore (Requires
        Active Employer)
              \
               v
         +-----------+
         | PUBLISHED |
         +-----------+
```

---

### 5. Suspension Cascade & Downstream Effects

When an administrator executes `suspendBusiness(id, reason)`:
1. `organizations.status` &rarr; `'SUSPENDED'`, `verificationStatus` &rarr; `'REVOKED'`, `suspensionReason` &rarr; `reason`.
2. Downstream Job Cascade: All active postings (`status: { $in: ['PUBLISHED', 'published'] }`) belonging to this business are automatically updated to:
   * `status` &rarr; `'PAUSED'`
   * `pausedReason` &rarr; `'Business suspended by administration'`
3. Job Creation / Publishing Guard: Any attempt to publish a job under a suspended business is rejected (`Cannot publish job: Parent organization is suspended by administration.`).
4. Restoration: When `restoreBusiness(id)` is executed:
   * `organizations.status` &rarr; `'APPROVED'`, `verificationStatus` &rarr; `'VERIFIED'`.
   * All jobs that were auto-paused with `pausedReason: 'Business suspended by administration'` are automatically restored to `PUBLISHED` with `pausedReason: null`.
   * Jobs that were manually paused for other reasons (e.g. incorrect salary) remain safely paused.

---

### 6. Privacy & Redaction Engine

1. **Corporate Evidence Protection:**
   * Documents submitted in `verification_requests` (trade registers, tax certificates, IDs) contain proprietary business data.
   * `verificationHelper.redactEvidence(doc, canViewEvidence)`:
     * If `canViewEvidence === false`: `evidenceUrl: null`, `documentUrl: null`, `idNumber: masked`.
     * If `canViewEvidence === true`: Unredacted URLs accessible only to authorized administrators.
2. **Candidate Data Sovereignty:**
   * `governanceHelper.getJobApplicationsAggregate(jobId)` uses MongoDB aggregation pipeline:
     ```javascript
     { $match: { jobId: objId } },
     { $group: { _id: '$status', count: { $sum: 1 } } }
     ```
   * Individual CV credentials, candidate emails, passport IDs, and phone numbers are never queried or sent to the Admin Panel.

---

### 7. Performance & Query Design

* **Pagination Invariant:** All listing queries enforce `Math.max(1, page)` and `Math.min(limit, 100)` with `.skip((page - 1) * limit).limit(limit)`.
* **Bounded Lookups:** Lookups across `organizations` and `students` use `$in: [...]` with deduplicated ObjectIds, eliminating N+1 queries.
* **Regex Safety:** All text searches sanitize inputs with `escapeRegex()` before constructing `RegExp`, preventing ReDoS attacks.
* **Indexes Utilized:**
  * `organizations`: `{ slug: 1 }`, `{ status: 1 }`, `{ createdBy: 1 }`
  * `organization_memberships`: `{ organizationId: 1, userId: 1 }`
  * `opportunities`: `{ organizationId: 1 }`, `{ status: 1 }`, `{ createdAt: -1 }`
  * `audit_logs`: `{ entityType: 1, entityId: 1 }`, `{ targetId: 1 }`, `{ createdAt: -1 }`
