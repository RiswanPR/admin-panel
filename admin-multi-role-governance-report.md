# Zeitnah Admin Panel: Multi-Role Governance & Administrative Layer Report

**Document Type:** Administrative Governance Implementation & Security Architecture Report  
**Status:** Pre-Phase 9 Foundation Standard (Approved & Deployed)  
**Target Routes:** `/admin/network/users`, `/admin/network/users/:id`, `/admin/network/audit-roles`  
**Security Level:** Authoritative Governance Control Layer  

---

## 1. Executive Summary

The Zeitnah Admin Panel has been upgraded to serve as the **authoritative governance layer** for the platform's multi-role identity and capability system. 

The upgraded administration interface replaces legacy raw single-role inputs with an enterprise governance dossier. Administrators now have full visual transparency into a user's **primary ecosystem identity**, **additional held roles**, **dynamic computed capabilities**, **verified corporate affiliations**, **independent course learning history**, and **zero-trust verification states**.

All administrative mutations strictly enforce mandatory justification reasons, prevent self-escalation, protect the Educator role from unauthorized assignment, isolate Admin authority from user roles, and record immutable audit logs.

---

## 2. Upgraded Administration User Interfaces

### 2.1. Network Users Directory (`/admin/network/users`)
- **Diagnostic Audit Action:** Added an "Audit Role Consistency" button directly in the page header linking to the diagnostic audit engine.
- **Card View:**
  - Distinct Primary Role badge with role-specific styling (e.g., Purple for `EDUCATOR`, Dark for `FOUNDER`, Blue for `PROFESSIONAL`, Teal for `RECRUITER`).
  - Secondary role pills (`+ ROLE`) indicating additional held identities.
  - Active capabilities counter badge (e.g. `4 Capabilities`).
  - Independent Course Enrollments badge (e.g. `3 Courses`).
- **Table View:**
  - "Primary & Secondary Roles" column displaying both primary identity and secondary badges.
  - "Capabilities & Courses" column displaying capability badges and learning counts.
  - Upgraded action dropdown with direct links to user dossier, role adjustment, and session management.

### 2.2. User Governance Dossier (`/admin/network/users/:id`)
Organized into 6 clean, separated architectural panels:

1. **Panel 1: Multi-Role Identity & Capabilities Governance:**
   - Displays Primary Ecosystem Identity with role definition.
   - Displays Additional Held Roles with quick remove buttons and an "Add Secondary" button.
   - **Computed Capabilities & Permissions Matrix:**
     Renders all 8 platform capabilities, domain category, effective status (`GRANTED`, `GATED (Needs Org)`, or `UNAVAILABLE`), and source roles explaining authorization rationale.
2. **Panel 2: Business Governance & Organization Memberships:**
   - Real-time authorization summary: Business Management (`Authorized` / `Not Authorized`), Opportunity Posting (`Authorized` / `Not Authorized`), and count of approved organizations.
   - Compliance notice: Explaining that holding `FOUNDER` or `RECRUITER` role alone does not grant business access without approved organization membership.
   - Organization memberships table with logo, affiliation role, approval status, and direct link to inspect the organization.
3. **Panel 3: Learning Context & Course Participation:**
   - Architectural Law Banner: Explicitly declaring that course enrollments are independent of user roles and never force Student classification.
   - Enrolled courses list: Course title, category, self-paced duration, and links to course curriculum / chapters.
4. **Panel 4: Professional Profile & Taxonomy Governance:**
   - Discipline, Specialization, Sector, Headline, and Bio.
   - Technical Skills and Engineering Software tools badges.
   - Accordions for Work Experience, Education, Certifications & Licenses, and Project Portfolio.
5. **Panel 5: Zero-Trust Verification Matrix:**
   - Clear architectural notice: "Verification is an independently verified trust state, not a role."
   - Five verification categories: Identity, Professional, Business Affiliation, Certification, and Educator.
   - Evidence document inspection link (protected by capability guard) and administrative audit notes.
6. **Panel 6: Network Connections & Moderation Standing:**
   - Network connections count and moderation reports count with flagged account warnings.

### 2.3. Right Column Administrative Controls
- **Card 1: Account & Multi-Role Governance Controls:**
  - One-click modals for: Change Primary Role, Add Secondary Role, View Role History, Inspect API Contract, Update Verification, Manage Restrictions, Adjust Handle, and Suspend Account.
- **Card 2: Semantic Data Consistency Notice:**
  - Conditionally rendered if `consistencyIssues.length > 0`.
  - Details each inconsistency code, severity, and recommended value, with a direct link to the diagnostic audit page.
- **Card 3: Active Device Sessions:**
  - IP masking, device type, browser, and instant session revocation.
- **Card 4: Administrative Audit Trail:**
  - Chronological history of actions performed on this account.

### 2.4. System-Wide Role Diagnostic Dashboard (`/admin/network/audit-roles`)
- Accessible to administrators with `manage_network` capability.
- Scans all user accounts in MongoDB for:
  - Missing or invalid `primaryRole`
  - Malformed capabilities containing role names
  - Unattached founder or recruiter accounts
  - Orphaned organization memberships
  - Legacy `role` field synchronization drift
- Displays high-level metric cards (`Total Scanned`, `Fully Consistent`, `Pending Normalization`) and detailed cards for each account with confidence ratings and proposed normalized representations.

---

## 3. Administrative Mutation Routes & Endpoints

| HTTP Method | Route Endpoint | Required Admin Capability | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/admin/network/users/:id/primary-role` | `manage_network` (`assign_educator` if EDUCATOR) | Updates user's primary ecosystem identity. Requires mandatory reason. |
| `POST` | `/admin/network/users/:id/secondary-roles/add` | `manage_network` (`assign_educator` if EDUCATOR) | Adds a secondary role without altering primary role. Requires mandatory reason. |
| `POST` | `/admin/network/users/:id/secondary-roles/remove` | `manage_network` (`assign_educator` if EDUCATOR) | Removes a secondary role. Recomputes capabilities. Requires mandatory reason. |
| `GET` | `/admin/network/users/:id/role-history` | `view_audit_logs` | Returns chronological audit log of role mutations for the user. |
| `GET` | `/admin/network/users/:id/contract` | `manage_network` | Generates sanitized canonical User Panel contract preview (zero secrets/PII). |
| `GET` | `/admin/network/audit-roles` | `manage_network` | Renders system-wide diagnostic audit dashboard. |
| `GET` | `/admin/network/users/:id/audit-consistency` | `manage_network` | JSON endpoint returning real-time diagnostic checks for single user. |

---

## 4. Audit Logging Standards

Every privileged role modification generates an immutable audit record in `audit_logs`:

### Audit Actions:
1. **`PRIMARY_ROLE_CHANGED`:**
   - Metadata: `actor`, `actorId`, `targetUserId`, `previousPrimaryRole`, `newPrimaryRole`, `reason`, `timestamp`.
2. **`ROLE_ADDED`:**
   - Metadata: `actor`, `actorId`, `targetUserId`, `roleAdded`, `newRoles`, `reason`, `timestamp`.
3. **`ROLE_REMOVED`:**
   - Metadata: `actor`, `actorId`, `targetUserId`, `roleRemoved`, `newRoles`, `reason`, `timestamp`.
4. **`CAPABILITIES_RECOMPUTED`:**
   - Metadata: `actor`, `targetUserId`, `activeCapabilitiesCount`, `timestamp`.

### Absolute Privacy Guarantee:
Audit logs never record passwords, session tokens, OTP secrets, or unredacted evidence documentation.

---

## 5. Security Safeguards Verified

1. **Self-Escalation Prohibition:**  
   If an administrator's user ID matches the target user ID, role changes are rejected with `Action rejected: You cannot change your own roles.`.
2. **ADMIN Injection Prohibition:**  
   Passing `role: "ADMIN"` throws `Invalid role: ADMIN. Must be one of: STUDENT, EDUCATOR, PROFESSIONAL, MENTOR, RECRUITER, FOUNDER.`.
3. **Educator Protection:**  
   Assigning or removing `EDUCATOR` without `assign_educator` capability throws `Permission denied: assign_educator capability is required to modify the Educator role.`.
4. **Mandatory Governance Reason:**  
   Attempting to update roles with an empty or whitespace reason throws `A governance reason is mandatory for primary role changes.`.
5. **Non-Destructive Invariant:**  
   Role updates use `$set` and `$addToSet` / `$pull` on `roles`, preserving all profile fields, course enrollments, and organization memberships.
