# Zeitnah Admin Panel: Multi-Role + Identity + Capability Architecture

**Document Type:** Authoritative Technical Specification & Architecture Manual  
**Status:** Pre-Phase 9 Foundation Standard (Approved)  
**Target Systems:** Zeitnah Admin Panel & Shared MongoDB Ecosystem  
**Classification:** Authoritative Governance Architecture Layer  

---

## 1. Executive Summary & Core Invariants

The Zeitnah multi-role architecture establishes the Admin Panel as the authoritative governance layer for identity, role assignments, dynamic capability computation, and corporate authorization across the ecosystem. 

Before this architectural foundation was deployed, legacy systems conflated user roles (such as `STUDENT` or `FOUNDER`) with feature permissions, and automatically assumed single-role identities. In real-world data, users possessing Founder or Managing Director experience and course enrollments were discovered with `primaryRole: "FOUNDER"` while their stored capabilities array was defaulted to `["STUDENT"]`.

This specification formalizes **six canonical identity pillars**, enforces zero-trust permission derivation, guarantees that course participation never forces a Student classification, and ensures that platform administration remains completely isolated from user multi-roles.

### Architectural Invariants:
1. **Never conflate Roles with Capabilities:** Roles represent held ecosystem identities; Capabilities represent computed platform feature entitlements.
2. **Never force Student identity due to Learning:** Enrolling in or completing courses is an independent learning relationship and must never override or mutate a user's `primaryRole` or legitimate ecosystem roles.
3. **Never grant automatic Business Access from Role alone:** Holding `FOUNDER` or `RECRUITER` identity does not grant platform-wide business access; authorized organization ownership or active membership in an `APPROVED` organization is strictly required.
4. **Never expose Admin platform privileges to User multi-roles:** The `ADMIN` role is governed strictly through `permissions-helper.js` and capability guards, never selectable in user self-service or multi-role arrays.
5. **Never permit Educator self-assignment:** The `EDUCATOR` role remains admin-governed, requiring the administrative `assign_educator` capability to assign or remove, with all actions audit logged.
6. **Zero-Trust backward compatibility:** All legacy fields (`role`, `primaryRole`, legacy arrays) remain preserved with a non-destructive runtime compatibility layer.

---

## 2. Canonical Identity & Authorization Taxonomy

The platform strictly recognizes six canonical ecosystem identities:

| Role Name | Taxonomy Type | Description | Self-Service Eligible | Default Capabilities |
| :--- | :--- | :--- | :---: | :--- |
| `STUDENT` | Learning / Early Career | Enrolled learner, academic researcher, or early-stage engineer | Yes | `ACCESS_COURSES`, `ACCESS_JOBS`, `ACCESS_CAREER_INTELLIGENCE` |
| `PROFESSIONAL` | Practitioner / Industry | Practicing engineer, specialist, consultant, or infrastructure professional | Yes | `ACCESS_COURSES`, `ACCESS_JOBS`, `ACCESS_PORTFOLIO`, `ACCESS_CAREER_INTELLIGENCE` |
| `MENTOR` | Senior Advisory | Experienced practitioner offering career mentorship and domain guidance | Admin / Vetted | `ACCESS_COURSES`, `ACCESS_JOBS`, `ACCESS_PORTFOLIO`, `ACCESS_CAREER_INTELLIGENCE`, `OFFER_MENTORSHIP` |
| `RECRUITER` | Talent Acquisition | Talent recruiter or HR representative hiring engineering personnel | Organization-Linked | `ACCESS_COURSES`, `ACCESS_JOBS`, `ACCESS_CAREER_INTELLIGENCE`, `MANAGE_BUSINESS` *(Gated)*, `POST_OPPORTUNITIES` *(Gated)* |
| `FOUNDER` | Enterprise Leadership | Enterprise owner, startup founder, director, or firm partner | Organization-Linked | `ACCESS_COURSES`, `ACCESS_JOBS`, `ACCESS_PORTFOLIO`, `ACCESS_CAREER_INTELLIGENCE`, `MANAGE_BUSINESS` *(Gated)*, `POST_OPPORTUNITIES` *(Gated)* |
| `EDUCATOR` | Academic Faculty | Accredited professor, institutional trainer, or university instructor | **NO (Admin-Only)** | `ACCESS_COURSES`, `ACCESS_JOBS`, `ACCESS_CAREER_INTELLIGENCE`, `CONDUCT_CLASSES` |

*Note: `ADMIN` is a platform governance authority, NOT an ecosystem identity. It is deliberately omitted from `CANONICAL_ROLES`.*

---

## 3. Separation of Concerns Matrix

The architecture cleanly decouples six distinct domain models that were previously blurred:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CANONICAL IDENTITY SEPARATION                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. PRIMARY ECOSYSTEM IDENTITY (primaryRole)                                │
│     → Preferred ecosystem presentation (e.g. "FOUNDER")                    │
│                                                                             │
│  2. HELD LEGITIMATE ROLES (roles)                                          │
│     → Array of verified identities held (e.g. ["FOUNDER", "STUDENT"])       │
│                                                                             │
│  3. COMPUTED CAPABILITIES (capabilities)                                    │
│     → Real-time action permissions derived from roles & business gates     │
│       (e.g. ["ACCESS_COURSES", "ACCESS_JOBS", "MANAGE_BUSINESS"])           │
│                                                                             │
│  4. BUSINESS AUTHORIZATION (businessAuthorization)                         │
│     → Active ownership/membership in verified APPROVED organizations        │
│                                                                             │
│  5. LEARNING CONTEXT (learningContext)                                      │
│     → Course enrollments, lesson progress, certificates                     │
│                                                                             │
│  6. INDEPENDENT VERIFICATION (verificationBreakdown)                       │
│     → Identity, Professional, Affiliation, Certification, Educator status   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Fine-Grained Capability Resolution Engine

Capabilities are fine-grained permission identifiers evaluated by `governanceHelper.computeUserCapabilities(user, context)`.

### Canonical Capability Definitions:
```javascript
const CANONICAL_CAPABILITIES = {
  ACCESS_COURSES: 'ACCESS_COURSES',                       // View and participate in learning coursework
  ACCESS_JOBS: 'ACCESS_JOBS',                             // Search and inspect platform opportunities
  MANAGE_BUSINESS: 'MANAGE_BUSINESS',                     // Corporate dashboard & company administration (Gated)
  POST_OPPORTUNITIES: 'POST_OPPORTUNITIES',               // Publish job requisitions & manage talent (Gated)
  ACCESS_PORTFOLIO: 'ACCESS_PORTFOLIO',                   // Curate public engineering portfolio
  ACCESS_CAREER_INTELLIGENCE: 'ACCESS_CAREER_INTELLIGENCE', // Market intelligence, salaries, & skill graph
  OFFER_MENTORSHIP: 'OFFER_MENTORSHIP',                   // Host advisory slots & guide talent
  CONDUCT_CLASSES: 'CONDUCT_CLASSES'                      // Grade submissions & manage curricula
};
```

### Evaluation Algorithm:
1. **Base Accumulation:** The user's canonical roles are resolved via `resolveCanonicalUserRoles(user)`. For each role in `roles`, the default capabilities are collected into a set.
2. **Learning Decoupling:** If the user has course enrollments (`user.course.length > 0`), `ACCESS_COURSES` is automatically guaranteed regardless of held roles.
3. **Authorization Gating:** Capabilities with `requiresAuthorizedOrg: true` (`MANAGE_BUSINESS`, `POST_OPPORTUNITIES`) are strictly validated against `evaluateBusinessAuthorization()`.
   - If the user holds `FOUNDER` or `RECRUITER` but has **no approved organization**, these capabilities are marked `active: false, businessGated: true`.
   - If the user has an active membership or ownership in an `APPROVED` organization, the capability is granted (`active: true, businessGated: false`).

---

## 5. Business Authorization & Anti-Spoofing Architecture

Holding `primaryRole = "FOUNDER"` or `roles = ["FOUNDER", "RECRUITER"]` is a declared credential, **not** an authorization key to arbitrary company data.

### Strict Governance Rules (Requirement 10):
- `evaluateBusinessAuthorization(user, memberships, organizations)` queries `organization_memberships` where `userId == user._id`.
- Memberships must link to an organization with `status === "APPROVED"`.
- The membership role must be one of `['OWNER', 'ADMIN', 'RECRUITER', 'MANAGER']`.
- If an organization is `PENDING`, `REJECTED`, or `SUSPENDED`, or if the user's membership is inactive, authorization is denied.
- Even if a user attempts to spoof organization membership data, missing approval records in the `organizations` collection will prevent capability activation.

---

## 6. Course Participation Independence (Requirement 11)

A critical flaw in legacy systems was auto-classifying users taking courses as `student` and mutating their profile.

In the Zeitnah canonical architecture:
- Enrolling in a course stores an enrollment reference in `user.course`.
- `resolveCanonicalUserRoles(user)` determines roles strictly from `user.primaryRole`, `user.roles`, and `user.role`. It **never** mutates `primaryRole` to `STUDENT` due to course enrollments.
- A Founder who studies remains `primaryRole: "FOUNDER"`, while benefiting from `ACCESS_COURSES` capability.

---

## 7. Educator Role Security Safeguards (Requirement 8)

The `EDUCATOR` role confers academic credibility and instructional capabilities:
1. **Admin Capability Guard:** Ordinary users and unauthorized administrators cannot assign `EDUCATOR`. The endpoint `/admin/network/users/:id/primary-role` and helper `setPrimaryRole` strictly check `permissionsHelper.hasCapability(actor, 'assign_educator')`.
2. **Self-Service Prohibition:** User-facing profile update endpoints in the User Panel reject any payload containing `EDUCATOR`.
3. **Audit Logging:** Every grant or revocation of `EDUCATOR` generates a high-priority entry in `audit_logs` recording actor ID, target user ID, reason, and timestamp.
4. **Metadata Context:** Assigning `EDUCATOR` sets `educatorContext: { assignedBy, assignedAt, verifiedByAdmin: true }` and marks `account_Status.isVerified = true`.

---

## 8. Administrative Isolation (Requirement 9)

- Administrators govern the platform via `ADMIN_COLLECTION` and session capability checks (`permissionsHelper`).
- The user collection (`STUDENTS_COLLECTION`) represents platform participants.
- `ADMIN` is strictly forbidden from appearing in `CANONICAL_ROLES`.
- Passing `role: "ADMIN"` to `setPrimaryRole`, `addSecondaryRole`, or `assignUserRole` immediately throws an error: `Invalid role: ADMIN. Must be one of: STUDENT, EDUCATOR, PROFESSIONAL, MENTOR, RECRUITER, FOUNDER.`

---

## 9. User Panel Safe Contract Specification (Requirement 16)

For Phase 9 integration, the Admin Panel exposes a canonical contract generator `governanceHelper.getCanonicalUserContract(userId)` that produces a sanitized, privacy-guaranteed payload:

```json
{
  "userId": "6a4153e7475174bdc2332b89",
  "username": "riswan",
  "displayName": "Riswan",
  "primaryRole": "FOUNDER",
  "roles": ["FOUNDER", "STUDENT"],
  "capabilities": [
    "ACCESS_COURSES",
    "ACCESS_JOBS",
    "ACCESS_PORTFOLIO",
    "ACCESS_CAREER_INTELLIGENCE",
    "MANAGE_BUSINESS",
    "POST_OPPORTUNITIES"
  ],
  "capabilityDetails": [
    {
      "id": "MANAGE_BUSINESS",
      "name": "Business Management",
      "active": true,
      "granted": true,
      "sourceRoles": ["FOUNDER"],
      "requiresAuthorizedOrg": true,
      "businessGated": false
    }
  ],
  "businessAccess": {
    "hasBusinessManagement": true,
    "canPostOpportunities": true,
    "authorizedOrganizationsCount": 1,
    "authorizedOrganizations": [
      {
        "organizationId": "6a4153e7475174bdc2332999",
        "name": "Ritech Engineering LLP",
        "slug": "ritech-engineering",
        "membershipRole": "Owner",
        "isOwner": true
      }
    ]
  },
  "learningContext": {
    "isEnrolled": true,
    "coursesCount": 3,
    "courses": [
      {
        "courseId": "69a1ff3e99326ef447ecdb01",
        "title": "BIM Modeling for Transport Infrastructure",
        "category": "Civil & Infrastructure"
      }
    ]
  },
  "professionalContext": {
    "discipline": "Civil & Transportation",
    "skills": ["AutoCAD Civil 3D", "Structural Analysis"],
    "software": ["Revit", "Synchro 4D"]
  },
  "verification": {
    "isIdentityVerified": false,
    "categories": [
      { "category": "IDENTITY", "status": "UNVERIFIED" },
      { "category": "PROFESSIONAL", "status": "UNVERIFIED" }
    ]
  }
}
```

### Absolute Zero-Trust Data Privacy Exclusions:
The contract strictly excludes:
- `password`, `Password` (argon2 hashes)
- `otp`, `otpSecret`, `otpExpires`
- `refreshToken`, `deviceSessions`, `cookie`
- Internal admin permissions (`canManageUsers`, `assign_educator`, etc.)
- Unredacted private government identification evidence URLs
