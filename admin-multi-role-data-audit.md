# Zeitnah Data Model Audit: Multi-Role & Capability System

**Document Type:** Forensic Codebase & Database Semantic Audit Report  
**Status:** Pre-Phase 9 Foundation Audit (Completed)  
**Author:** Zeitnah Admin Governance Core Architecture Team  
**Scope:** Shared MongoDB Database (`lms-platform`), Admin Panel Codebase, and User Panel Backend Schemas  

---

## 1. Executive Summary & Root Cause Finding

An urgent real-data inconsistency was highlighted prior to Phase 9:
> **Observed Case:** A platform user had `primaryRole = "FOUNDER"` with extensive Managing Director / Founder work experience and multiple course enrollments, but their stored database record showed:
> `capabilities = ["STUDENT"]`

### Forensic Investigation Finding:
Through static code inspection of the shared NestJS schema at `/user-panel-zeitnah/backend/src/schemas/user.schema.ts` (line 445):
```typescript
@Prop({ type: [String], default: ['STUDENT'] })
capabilities!: string[];
```
coupled with the profile update controller at `profile.service.ts`:
1. When any user account is initially registered, Mongoose / NestJS schema defaults `capabilities` to `['STUDENT']`.
2. Role names (specifically `"STUDENT"`) were mistakenly inserted into the `capabilities` field as a schema default.
3. When the user subsequently declared their identity as `"FOUNDER"`, the update route mutated `primaryRole: "FOUNDER"` but did not recompute or update `capabilities`.
4. As a result, the user record persisted `primaryRole: "FOUNDER"` alongside the orphaned schema default `capabilities: ["STUDENT"]`.

### Determination Among Candidate Hypotheses:
- **A. Legacy role storage:** Partially true — older versions stored `role: "student"`.
- **B. Malformed capabilities:** **PRIMARY FACTOR** — Role names (`"STUDENT"`) were stored where functional permissions belonged.
- **C. Activity context:** Disproven — Taking a course did not populate this array; the schema default did.
- **D. Feature permission:** Disproven — The platform had no feature called `"STUDENT"`; it was a role name masquerading as a capability.
- **E. Accidental data inconsistency:** **PRIMARY FACTOR** — Caused by decoupling the `primaryRole` update from the static schema default initialization.

**Official Classification:** Combination of **B (Malformed capabilities)** and **E (Accidental schema-default inconsistency)**.

---

## 2. Deep Schema & Field-by-Field Audit

A comprehensive inspection of the shared MongoDB collections reveals the following schema semantics:

### 2.1. `users` (Students Collection: `user` / `students`)

| Field Name | Type | Historical Meaning | Canonical Architecture Meaning | Inconsistency Risk |
| :--- | :--- | :--- | :--- | :--- |
| `_id` | ObjectId | Unique Account Identifier | Canonical Identity UUID | None |
| `primaryRole` | String | Preferred role or undefined in legacy | Preferred Ecosystem Presentation Identity (`STUDENT`, `EDUCATOR`, `PROFESSIONAL`, etc.) | Legacy accounts had this field missing |
| `role` | String | Legacy lowercase role (`"student"`, `"teacher"`) | Preserved for backward compatibility (mirrors lowercased `primaryRole`) | Can fall out of sync with `primaryRole` |
| `roles` | Array[String] | Absent in legacy schema | Authorized Ecosystem Roles held by user | Missing in legacy accounts |
| `capabilities` | Array[String] | Contained `['STUDENT']` by schema default | Fine-grained computed permission keys (e.g. `ACCESS_COURSES`, `MANAGE_BUSINESS`) | Contained role names instead of permission tokens |
| `course` | Array[ObjectId/Object] | Enrolled course references | Independent Learning Relationship | Previously caused false assumptions that user is a Student |
| `educatorContext` | Object | Absent or unstructured | Admin audit metadata: `{ assignedBy, assignedAt, verifiedByAdmin }` | Self-service spoofing if unprotected |
| `recruiterContext` | Object | Corporate recruiting parameters | Hiring preferences & verified business links | Unattached recruiter state |
| `businessMemberships` | Array/Ref | Organization links | Governed via dedicated collection `organization_memberships` | Unsynchronized caches |
| `account_Status` | Object | `{ isVerified, isBlocked, restrictions, lastSeen }` | Account state, zero-trust RBAC restriction flags, last seen heartbeat | Verification previously confused with role |
| `username` | String | User handle | Unique platform handle governed by regex & cooldown | Duplicate or unnormalized handles |

### 2.2. `community_profiles` Collection

Stores rich networking and professional infrastructure credentials:
- `userId`: Reference to `users._id`
- `discipline`: Infrastructure discipline (e.g. "Civil & Transportation", "Power & Energy")
- `infrastructureSector`: Target sector
- `specialization`: Domain specialization
- `headline`, `bio`: Professional self-presentation
- `skills`: Array of technical competencies (linked to Skill Graph)
- `software`: Engineering software tools (e.g. AutoCAD, Revit, Primavera P6)
- `experience`: Array of professional work history (`company`, `title`, `startDate`, `endDate`, `current`, `description`)
- `education`: Array of academic credentials (`institution`, `degree`, `fieldOfStudy`, `startYear`, `endYear`)
- `certifications`: Professional licenses and credentials
- `projects`: Engineering project deliverables and portfolio showcases

### 2.3. `organizations` and `organization_memberships` Collections

- `organizations`: Contains `name`, `slug`, `status` (`PENDING`, `APPROVED`, `SUSPENDED`, `REJECTED`), `ownerId`, `createdBy`, `verificationStatus`.
- `organization_memberships`: Contains `organizationId`, `userId`, `role` (`OWNER`, `ADMIN`, `RECRUITER`, `MEMBER`), `status` (`ACTIVE`, `SUSPENDED`), `verified`.

**Audit Takeaway:** Business management authorization is strictly dependent on an active record in `organization_memberships` pointing to an `APPROVED` organization.

### 2.4. `verification_requests` Collection

- Zero-trust evidence review storage: `category` (`IDENTITY`, `PROFESSIONAL`, `BUSINESS_AFFILIATION`, `CERTIFICATION`, `EDUCATOR`), `status` (`PENDING`, `UNDER_REVIEW`, `VERIFIED`, `REJECTED`), `evidenceUrl`, `idNumber`, `notes`.
- Evidence documents require specific administrative capability (`view_verification_evidence`) to decrypt/unredact.

---

## 3. Real Database Inspection (Current Development State)

Running the strict dry-run diagnostic script `scripts/audit-multi-role-users.js` across the active local MongoDB instance (`lms-platform`) produced the following census:

```
----------------------------------------------------------------
 TOTAL ACCOUNTS ANALYZED        : 6
 FULLY CONSISTENT ACCOUNTS      : 0
 INCONSISTENT / PENDING NORM    : 6
----------------------------------------------------------------
```

### Detailed Breakdown of Existing Development Accounts:

1. **User `kutty` (`6a11ff3e99326ef447ecdbef`):**
   - Current State: `primaryRole: undefined`, `role: "student"`, `capabilities: []`
   - Finding: `PRIMARY_ROLE_MISSING` (Legacy account registered before multi-role rollout).
   - Canonical Normalization Proposal: `primaryRole: "STUDENT"`, `roles: ["STUDENT"]`, `capabilities: ["ACCESS_COURSES", "ACCESS_JOBS", "ACCESS_CAREER_INTELLIGENCE"]`.

2. **User `Razal` (`6a124f8d22010005dc1fc6c6`):**
   - Current State: `primaryRole: undefined`, `role: "student"`, `capabilities: []`
   - Finding: `PRIMARY_ROLE_MISSING`.

3. **User `fff` (`6a1f15a84e52a552663c700e`):**
   - Current State: `primaryRole: undefined`, `role: "student"`, `capabilities: []`
   - Finding: `PRIMARY_ROLE_MISSING`.

4. **User `Riswan` (`6a4153e7475174bdc2332b89`):**
   - Current State: `primaryRole: undefined`, `role: "student"`, `capabilities: []`
   - Finding: `PRIMARY_ROLE_MISSING`.

5. **User `wd` (`6a46ddb60f2316105301f0f9`):**
   - Current State: `primaryRole: undefined`, `role: "student"`, `capabilities: []`
   - Finding: `PRIMARY_ROLE_MISSING`.

6. **User `Heartbeat Test Student` (`6a50a6a554e97bf1ba48ec14`):**
   - Current State: `primaryRole: undefined`, `role: "student"`, `capabilities: []`
   - Finding: `PRIMARY_ROLE_MISSING`.

---

## 4. Semantic Rules & Diagnostic Checks Enforced

The diagnostic engine in `governanceHelper.auditUserRoleConsistency()` runs 8 non-destructive semantic tests against each user:

1. **`PRIMARY_ROLE_MISSING`:** Checks if `user.primaryRole` is missing or empty.
2. **`INVALID_PRIMARY_ROLE`:** Checks if `user.primaryRole` is not one of the six `CANONICAL_ROLES`.
3. **`INVALID_SECONDARY_ROLE`:** Checks if `user.roles` contains unrecognized roles or `ADMIN`.
4. **`DUPLICATE_ROLES`:** Checks if `user.roles` contains duplicates.
5. **`MALFORMED_CAPABILITIES_DETECTED`:** Checks if `user.capabilities` contains role names like `"STUDENT"`, `"FOUNDER"`, or `"RECRUITER"`.
6. **`UNATTACHED_BUSINESS_ROLE`:** Checks if a user has `FOUNDER` or `RECRUITER` role without any approved organization membership.
7. **`ORPHANED_MEMBERSHIP_ORGANIZATION`:** Checks if a user has an organization membership referencing a deleted or non-existent organization.
8. **`ROLE_FIELD_OUT_OF_SYNC`:** Checks if legacy `user.role` disagrees with modern `user.primaryRole`.

### What is NOT an Error (Safe Invariants):
- **Course enrollment without Student role:** Valid. A Founder or Professional who enrolls in courses is simply learning, not downgraded to Student.
- **Experience titled "Founder" without Founder role:** Valid. Work experience is a historical CV record, not an ecosystem role.
- **Unverified account holding a role:** Valid. Verification is an independent trust state, not a prerequisite for identity assignment.
