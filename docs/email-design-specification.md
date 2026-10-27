# Zeitnah Email Design Specification & Implementation Standards

**Version:** 1.0 (Phase 1 Foundation)
**Status:** Approved Product Direction
**Scope:** `user-panel-zeitnah` (NestJS) & `admin-panel` (Express.js)

---

## 1. Brand Identity & Product Direction

Every email dispatched across the Zeitnah ecosystem represents the voice of the community and platform.

- **Brand Name:** Zeitnah
- **Tagline:** See the unseen
- **Vision:** Build, connect, discover
- **Mission:** To build the best global civil community where people can enjoy progress, network, opportunities, and success through the freedom of knowledge.
- **Approved From Address:** `Zeitnah <noreply@zeitnahacademy.com>` (production) / `Zeitnah <onboarding@resend.dev>` (sandbox testing)
- **Approved Support Contact:** `support@zeitnahacademy.com`

> [!IMPORTANT]
> Obsolete identities such as *"Zeitnah Group of Institutions"* or *"Premium Education • Trusted Systems"* are deprecated and strictly replaced by the official Zeitnah brand and mission.

---

## 2. Visual Principles

### 1. Intelligent Hybrid Mode
- **Premium Light (Default):** Registration OTP, Login OTP, Welcome emails, Course assignments, Enquiries, Digest summaries, and Administrative notifications default to a clean, editorial **light background (`#f4f7f8`)** with an elevated pure white container (`#ffffff`) and deep navy header banner (`#12314c`).
- **Dark Security Variant:** Suspicious login alerts, passwordless security reminders, and critical system error reports use a dedicated **dark-slate canvas (`#0b0f19`)** with slate containers (`#0f172a`), mint accents (`#9fd5b2`), and amber/red warnings (`#fbbf24` / `#f87171`) to convey urgency and technical gravity.

### 2. Expressive Editorial Typography
- Primary Body Font: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
- Code / Token Font: `'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace`
- Outlook MSO Fallback: `Arial, sans-serif`
- High-contrast headings with tight letter-spacing (`-0.5px`) and generous line heights (`1.6` on body text).

### 3. Layout Dignity & Generous Whitespace
- Maximum content width of **600px**, centered on the canvas.
- Single-column flow to guarantee flawless rendering on mobile screens.
- Avoid cluttered ribbons, borders, and competing badges. Each email has **one primary objective**.

---

## 3. Shared Design Tokens

Reference implementation: `backend/src/common/templates/email-design-tokens.ts`

### A. Color Palette — Premium Light (Default)
| Token Name | Value | Purpose |
| :--- | :--- | :--- |
| `canvasBg` | `#f4f7f8` | Outer email background |
| `containerBg` | `#ffffff` | Elevated email body card |
| `headerBgSolid` | `#12314c` | Top brand header block |
| `headerText` | `#ffffff` | Brand header title |
| `brandMint` | `#9fd5b2` | Zeitnah brand accent / badge |
| `textPrimary` | `#0f172a` | Main headlines & primary body text |
| `textSecondary` | `#475569` | Explanatory copy & metadata labels |
| `textMuted` | `#64748b` | Timestamps & secondary guidance |
| `textSubtle` | `#94a3b8` | Legal disclaimer text |
| `cardBg` | `#f8fafc` | Inner content cards (OTP, metadata) |
| `cardBorder` | `#e2e8f0` | Subtle card outlines |
| `footerBg` | `#f9fafb` | Bottom footer band |
| `primaryButtonBg` | `#12314c` | Primary CTA background |
| `primaryButtonText`| `#ffffff` | Primary CTA text |

### B. Color Palette — Dark Security Variant
| Token Name | Value | Purpose |
| :--- | :--- | :--- |
| `canvasBg` | `#0b0f19` | Dark outer background |
| `containerBg` | `#0f172a` | Dark slate inner card |
| `textPrimary` | `#f8fafc` | High-contrast white heading |
| `textSecondary` | `#cbd5e1` | Light gray body text |
| `cardBg` | `#0b0f19` | High-contrast recessed card |
| `cardBorder` | `#1e293b` | Dark slate border |
| `warningAmber` | `#fbbf24` | 3-minute expiry / timer badge |
| `dangerRed` | `#f87171` | Security alert / trigger badge |

### C. Geometry & Spacing
- Container Maximum Width: `600px`
- Outer Padding: `40px 16px` (mobile-responsive `20px 12px`)
- Card Border Radius: `16px` outer, `12px` nested cards, `8px` buttons/inputs
- Elevation Shadow: `0 10px 30px rgba(0, 0, 0, 0.08)` (light) / `0 20px 25px -5px rgba(0, 0, 0, 0.5)` (dark)

---

## 4. OTP / Verification Code Conventions (Benchmarked to Amazon Prime Video)

### 1. Solid High-Contrast Card
- Dashed borders (`border: 1px dashed ...`) are prohibited; they resemble retail coupons.
- The verification code card MUST use a solid, subtle border (`1px solid #cbd5e1` on light, `1px solid #334155` on dark).
- Numerals must be bold, large (`36px` to `40px`), monospaced, centered, and letter-spaced (`10px`).

### 2. Copy-Code Ergonomics in Email Clients
- **Technical Invariant:** JavaScript execution (`<script>`, `onclick`, `navigator.clipboard`) is **blocked and stripped by all email clients**. Never add a non-functional `<button onclick="...">Copy</button>`.
- **Email-Safe Tap-to-Copy:** The verification code container MUST include the inline style:
  ```css
  -webkit-user-select: all; user-select: all;
  ```
  On iOS and Android email clients, tapping the code highlights all 6 digits instantly with a single tap for effortless copying.
- Zero spurious whitespace, tabs, or newlines inside the code container.

### 3. Expiration Synchronization
- **User Panel Authentication OTPs:** Configured in backend for **3 minutes** (`3 * 60 * 1000`). All user emails and Support FAQs must state **3 minutes**.
- **Admin Panel Authentication OTPs:** Configured in backend for **5 minutes** (`5 * 60 * 1000`). Admin emails must state **5 minutes**.

---

## 5. Technical Email-Client Compatibility Rules

To ensure consistent rendering across Microsoft Outlook (Windows Word engine), Gmail (iOS/Android/Web), Apple Mail (macOS/iOS), and Yahoo Mail:

1. **Table-Based Presentation Structure:**
   Always wrap cards and major layout blocks in `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">`. Never rely solely on `<div>` with `max-width` (Outlook ignores `max-width` on divs).
2. **Prohibited CSS Properties:**
   - `display: flex` / `display: grid`: Unsupported in desktop Outlook; flex containers collapse. Use table cells (`<td align="center">`) for centering.
   - `width: max-content`: Collapses or expands to 100% in Outlook. Use explicit pixel widths or table layouts.
   - External CSS stylesheets: Stripped by Gmail. All critical styles must be inlined on the element.
3. **MSO Font Fallbacks:**
   Include MSO conditional comments in the `<head>`:
   ```html
   <!--[if mso]>
   <style type="text/css">
     table, td, p, a, span { font-family: Arial, sans-serif !important; }
   </style>
   <![endif]-->
   ```
4. **Mandatory Plain-Text Alternative:**
   Every single email dispatched must provide both `html` and `text` parts (`multipart/alternative`). This ensures deliverability, improves spam reputation scores, and provides readable content on Apple Watch and assistive screen readers.
5. **Strict HTML Escaping Boundary:**
   All untrusted, user-submitted, or dynamic data (names, emails, subjects, messages, course titles) MUST be escaped via `escapeHtml()` at the HTML rendering boundary. URLs in anchors must be validated via `sanitizeUrl()`.

---

## 6. Future Phase 2 Preview Gallery Specification

In Phase 2, a standalone, local development preview gallery will be created. The gallery must adhere to these strict requirements:

1. **Local-Only Rendering:** Runs entirely locally (e.g., via a lightweight Vite/Express preview route or Jest visual generator).
2. **Zero Provider Dispatch:** Must NEVER invoke Resend, SMTP, or any external network service.
3. **Synthetic Sample Fixtures:** All preview data must be synthetic test fixtures (e.g., `student@example.test`, OTP `482910`). Zero real credentials, tokens, or PII.
4. **Side-by-Side Verification:** Display both the rendered HTML preview and the plain-text fallback side by side.
5. **Responsive Viewport Toggles:** Allow previewing at Desktop (600px), Tablet (480px), and Mobile (360px).
6. **Coverage:** Must render all 10 active email templates in both light and dark variants.

---

## 7. Phase 2 Template Migration Plan

| ID | Template Name | Current State | Phase 2 Target Archetype |
| :--- | :--- | :--- | :--- |
| **T1** | Registration OTP | Dark dashed card | **Premium Light** with solid OTP card & tap-to-select |
| **T2** | Login OTP | Dark dashed card | **Premium Light** with solid OTP card & tap-to-select |
| **T3** | Suspicious Login Alert | Dark slate | **Dark Security Variant** with session grid & action CTA |
| **T4** | Support Ticket Staff Alert | Inline unescaped div | **Premium Light** with table layout & sanitized fields |
| **T5** | Course Enquiry Alert | Inline email-templates.ts | **Premium Light** with student card & phone action |
| **T6** | Troubleshoot Incident Report| Dark error tables | **Dark Security Variant** with categorized collapsible tables |
| **T7** | Admin Login OTP | Yellow gradient div | **Premium Light** with solid OTP card (5-min expiry) |
| **T8** | Admin Student Welcome | Light div with emoji | **Premium Light** with official brandmark & login guide |
| **T9** | Admin Course Assigned | Light div with emoji | **Premium Light** with enrolled course pill cards |
| **T10**| Admin Diagnostic Test | Standalone card | **Premium Light** system diagnostic verification card |
