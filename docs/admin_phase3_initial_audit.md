# ZEITNAH ADMIN PANEL — PHASE 3 INITIAL ZERO-TRUST AUDIT
## Businesses & Jobs Governance Baseline Analysis

**Date:** 2026-09-28  
**Phase:** Admin Phase 3  
**Status:** COMPLETE & SEALED  
**Scope:** Businesses, Organizations, Owners, Recruiters, Founders, Business Verification, Memberships, Infrastructure Jobs, Job Publishing Governance, Moderation, and Matching Oversight.

---

### 1. Executive Summary

Phase 3 introduces enterprise administrative governance over organizations and infrastructure job opportunities. Prior to Phase 3 implementation, the Admin Panel had rudimentary endpoints for business and job listings which lacked:
1. Verification filtering and deep evidence redaction.
2. Robust multi-collection aggregation for business and job detail dossiers.
3. Strict downstream cascade handling when businesses are suspended.
4. Candidate privacy protection (candidate CV details and PII leaked through unredacted application views).
5. Granular RBAC capabilities for ownership transfer and job moderation.

This zero-trust audit inspects the existing production schema, lifecycle states, route contracts, and security boundaries.

---

### 2. Entity & Schema Audit

#### 2.1 Organizations / Businesses Collection (`ORGANIZATIONS_COLLECTION`)
* **Collection Name:** `organizations`
* **Canonical Fields:**
  * `_id` (ObjectId): Primary business identifier.
  * `name` (String): Legal and commercial entity name.
  * `slug` (String): Unique URL slug handle.
  * `logo` (String, optional): URL path to corporate insignia.
  * `description` (String): Entity background and focus.
  * `website` (String): Official web address.
  * `industry` (String): Sector taxonomy (e.g. Civil & Transport Infrastructure).
  * `infrastructureSectors` (Array of Strings): Specialized sectors (Railways, Energy, Water, etc.).
  * `status` (Enum): `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `SUSPENDED`.
  * `verificationStatus` (Enum): `UNVERIFIED`, `PENDING`, `VERIFIED`, `REJECTED`, `REVOKED`.
  * `createdBy` (ObjectId): Registered primary owner user ID in `students` collection.
  * `createdAt` (Date), `updatedAt` (Date).
  * `reviewedBy` (ObjectId), `reviewedAt` (Date).
  * `suspensionReason` (String), `rejectionReason` (String).

#### 2.2 Organization Memberships (`ORGANIZATION_MEMBERSHIPS_COLLECTION`)
* **Collection Name:** `organization_memberships`
* **Canonical Fields:**
  * `_id` (ObjectId): Membership record ID.
  * `organizationId` (ObjectId): Reference to `organizations`.
  * `userId` (ObjectId): Reference to `students`.
  * `role` (Enum): `owner`, `admin`, `recruiter`, `member`.
  * `verified` (Boolean): Corporate association verified.
  * `status` (String): `ACTIVE`, `INVITED`, `REMOVED`.
  * `joinedAt` (Date).

#### 2.3 Opportunities / Jobs Collection (`OPPORTUNITIES_COLLECTION`)
* **Collection Name:** `opportunities`
* **Canonical Fields:**
  * `_id` (ObjectId): Job posting identifier.
  * `organizationId` (ObjectId): Parent organization reference.
  * `createdBy` (ObjectId): Posting author reference (Recruiter / Founder).
  * `title` (String): Infrastructure job title.
  * `discipline` (String): Infrastructure discipline.
  * `infrastructureSector` (String): Sector alignment.
  * `workMode` (Enum): `Remote`, `Hybrid`, `On-site`.
  * `experienceLevel` (Enum): `Junior`, `Mid`, `Senior`, `Lead`, `Executive`.
  * `minYearsExperience` / `maxYearsExperience` (Number).
  * `location` (String): City / Region / Country.
  * `description` (String): Comprehensive job brief.
  * `requirements` (String): Scope and prerequisites.
  * `requiredSkills` (Array of Strings): Mandatory skills.
  * `requiredSoftware` (Array of Strings): Mandatory CAD/BIM/SCADA software tools.
  * `salaryMin` / `salaryMax` / `salaryCurrency` (Number / String).
  * `status` (Enum): `DRAFT`, `PENDING_REVIEW`, `PUBLISHED`, `PAUSED`, `CLOSED`, `SUSPENDED`, `REJECTED`.
  * `moderationStatus` (String): `APPROVED`, `FLAGGED`, `SUSPENDED_BY_ADMIN`, `UNPUBLISHED_BY_ADMIN`, `REJECTED_BY_ADMIN`.
  * `isFlagged` (Boolean): Flagged indicator.
  * `publishedAt` (Date), `createdAt` (Date), `updatedAt` (Date).

#### 2.4 Supporting Collections
* `job_applications`: Stores job applications. Contains sensitive candidate PII (passport numbers, phone numbers, CV data). Must strictly be aggregated into totals and withdrawal counts without leaking individual records.
* `job_talent_matches`: AI scoring dimensions and compatibility rankings.
* `verification_requests`: Evidence documents and proof of business registration. Must be redacted for unauthorized administrators.
* `moderation_reports`: Compliance reports filed by candidates or admins.
* `audit_logs`: Immutable security log of privileged mutations.

---

### 3. Business Lifecycle Analysis

Transitions supported:
* `PENDING_REVIEW` &rarr; `APPROVED` (via `approveBusiness` — sets `verificationStatus: 'VERIFIED'`).
* `PENDING_REVIEW` &rarr; `REJECTED` (via `rejectBusiness` — requires mandatory reason).
* `APPROVED` &rarr; `SUSPENDED` (via `suspendBusiness` — requires mandatory reason, automatically transitions active `PUBLISHED` jobs to `PAUSED`).
* `SUSPENDED` &rarr; `APPROVED` (via `restoreBusiness` — restores previously auto-paused jobs to `PUBLISHED`).
* Ownership Transfer (via `transferBusinessOwnership` — strictly guarded by `transfer_business_ownership` superuser capability).

---

### 4. Job Lifecycle & Publishing Governance

Transitions supported:
* `PENDING_REVIEW` &rarr; `PUBLISHED` (via `approveJob` — requires parent organization to be `APPROVED` and not `SUSPENDED`).
* `PENDING_REVIEW` &rarr; `REJECTED` (via `rejectJob` — requires mandatory reason).
* `PUBLISHED` &rarr; `PAUSED` (via `unpublishJob` — requires mandatory reason).
* `PUBLISHED` &rarr; `CLOSED` (via `closeJob` — records administrative notes).
* `PUBLISHED` / `PENDING_REVIEW` &rarr; `SUSPENDED` (via `suspendJob` — requires mandatory reason).
* `CLOSED` / `SUSPENDED` / `PAUSED` &rarr; `PUBLISHED` (via `restoreJob` — verifies parent organization is not suspended).
* `FLAGGED` (via `flagJob` — requires mandatory reason, records in moderation log).

---

### 5. Identified Baseline Vulnerabilities & Mitigations

1. **Evidence Exposure:** Previously, raw verification document URLs were exposed in templates. Mitigated using `verificationHelper.redactEvidence` with `view_verification_evidence` capability guard.
2. **Candidate PII Exposure:** Application review previously returned candidate CV files and phone numbers. Mitigated by creating `getJobApplicationsAggregate` which executes MongoDB aggregation `$group` counts only.
3. **Silent Ownership Takeover:** Ownership transfer lacked explicit superuser permission guard. Mitigated by adding `transfer_business_ownership` capability in `permissions-helper.js`.
4. **Suspension Incoherence:** Suspending a business previously left active jobs published on the talent marketplace. Mitigated with auto-pause cascade in `suspendBusiness` and auto-restore in `restoreBusiness`.
5. **IDOR & CastError Crashes:** Malformed IDs previously generated unhandled BSON errors. Mitigated with strict `isValidObjectId` checks returning 400 Bad Request.

---

### 6. Zero-Trust Audit Conclusion

The production database schema is clean and normalized across `organizations`, `organization_memberships`, `opportunities`, `verification_requests`, and `audit_logs`. The Phase 3 architecture builds on this foundation without creating redundant collections or violating existing contracts.
