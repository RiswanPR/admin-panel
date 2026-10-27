const axios = require('axios');
const logger = require('./logger');

const RESEND_TIMEOUT_MS = 10000; // 10 second timeout

const getFromStr = () => {
    const resendFrom = process.env.RESEND_FROM_EMAIL;
    if (resendFrom) {
        return resendFrom.replace(/^"(.*)"$/, '$1').trim();
    }
    const name = process.env.SMTP_FROM_NAME || 'Zeitnah LMS';
    const email = process.env.SMTP_FROM_EMAIL || 'noreply@zeitnahacademy.com';
    return `${name} <${email.replace(/^"(.*)"$/, '$1').trim()}>`;
};

const LMS_URL = process.env.LMS_LOGIN_URL || 'https://zeitnahacademy.com/login';

/**
 * Approved Zeitnah Brand Metadata
 */
const ZEITNAH_BRAND = {
    name: 'Zeitnah',
    tagline: 'See the unseen',
    vision: 'Build, connect, discover',
    mission: 'To build the best global civil community where people can enjoy progress, network, opportunities, and success through the freedom of knowledge.',
    supportEmail: 'support@zeitnahacademy.com'
};

/**
 * Standardized Brand Header HTML
 */
const getHeaderHtml = () => `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr>
        <td align="center" style="background:#12314c; background:linear-gradient(135deg,#12314c 0%,#0d2438 100%); padding:36px 32px 28px 32px; text-align:center; border-bottom:1px solid #1e293b;">
            <div style="display:inline-block; padding:8px 18px; background:rgba(159,213,178,.12); border:1px solid rgba(159,213,178,.28); border-radius:12px; text-align:center;">
                <span style="font-size:20px; font-weight:900; letter-spacing:3px; color:#9fd5b2; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; text-transform:uppercase;">ZEITNAH</span>
                <span style="font-size:11px; font-weight:700; letter-spacing:2px; color:#94a3b8; text-transform:uppercase; margin-left:10px; display:inline-block;">SEE THE UNSEEN</span>
            </div>
        </td>
    </tr>
</table>
`;

/**
 * Standardized Brand Footer HTML
 */
const getFooterHtml = () => `
<div style="background-color:#f9fafb; padding:28px 32px; border-top:1px solid #edf2f7; text-align:center;">
    <p style="margin:0 0 6px 0; font-size:13px; font-weight:800; color:#12314c; letter-spacing:1px; text-transform:uppercase;">
        ${ZEITNAH_BRAND.name} &bull; ${ZEITNAH_BRAND.tagline}
    </p>
    <p style="margin:0 0 10px 0; font-size:12px; color:#64748b; line-height:1.6; max-width:480px; margin-left:auto; margin-right:auto;">
        ${ZEITNAH_BRAND.mission}
    </p>
    <p style="margin:0 0 6px 0; font-size:11px; color:#94a3b8;">
        Need help? Contact support at <a href="mailto:${ZEITNAH_BRAND.supportEmail}" style="color:#004ce8; text-decoration:none; font-weight:600;">${ZEITNAH_BRAND.supportEmail}</a>
    </p>
    <p style="margin:0; font-size:11px; color:#94a3b8;">
        &copy; ${new Date().getFullYear()} ${ZEITNAH_BRAND.name}. All rights reserved.
    </p>
</div>
`;

/**
 * Table-based base wrapper for admin emails
 */
const wrapAdminEmail = (contentHtml, previewText = 'Zeitnah — See the unseen') => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zeitnah</title>
    <!--[if mso]>
    <style type="text/css">
        table, td, p, a, span { font-family: Arial, sans-serif !important; }
        table { border-collapse: collapse; }
    </style>
    <![endif]-->
</head>
<body style="margin:0; padding:0; background-color:#f4f7f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; color:#0f172a;">
    <div style="display:none; max-height:0px; overflow:hidden; font-size:1px; line-height:1px; color:#f4f7f8; opacity:0; mso-hide:all;">
        ${previewText}
        &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f7f8; width:100%; padding:40px 16px;">
        <tr>
            <td align="center" style="padding:0;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px; background-color:#ffffff; border:1px solid #e2e8f0; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,.08);">
                    <tr>
                        <td style="padding:0;">
                            ${getHeaderHtml()}
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:36px 32px; color:#0f172a; font-size:15px; line-height:1.6;">
                            ${contentHtml}
                        </td>
                    </tr>
                    <tr>
                        <td style="padding:0;">
                            ${getFooterHtml()}
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

// ── Track last email attempt for health monitoring ──
const emailStats = {
    lastAttempt: null,
    lastSuccess: null,
    lastFailure: null,
    lastFailureReason: null,
    lastSuccessMessageId: null,
};

/**
 * HTML escaping utility for rendering untrusted strings safely in emails
 */
const escapeHtml = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

/**
 * Validates and sanitizes URLs before inserting into email anchor hrefs
 */
const sanitizeUrl = (url, fallback = 'https://zeitnahacademy.com/login') => {
    if (!url || typeof url !== 'string') return fallback;
    const trimmed = url.trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) {
        return escapeHtml(trimmed);
    }
    return fallback;
};

/**
 * Helper to send email via Resend
 */
const sendViaResend = async (to, subject, html, text = null) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        const msg = 'RESEND_API_KEY not configured. Email cannot be sent.';
        logger.error(msg);
        emailStats.lastAttempt = new Date();
        emailStats.lastFailure = new Date();
        emailStats.lastFailureReason = msg;
        throw new Error(msg);
    }

    emailStats.lastAttempt = new Date();

    try {
        const payload = {
            from: getFromStr(),
            to: to,
            subject: subject,
            html: html,
            ...(text ? { text } : {})
        };

        const response = await axios.post('https://api.resend.com/emails', payload, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: RESEND_TIMEOUT_MS
        });

        // Validate response — Resend returns { id: "..." } on success
        if (!response.data || !response.data.id) {
            const msg = 'Resend API returned unexpected response (no message ID)';
            emailStats.lastFailure = new Date();
            emailStats.lastFailureReason = msg;
            throw new Error(msg);
        }

        emailStats.lastSuccess = new Date();
        emailStats.lastSuccessMessageId = response.data.id;
        logger.info(`Email sent successfully to ${to} (Resend ID: ${response.data.id})`);

        return { success: true, messageId: response.data.id };
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            const msg = `Resend API timeout after ${RESEND_TIMEOUT_MS}ms`;
            emailStats.lastFailure = new Date();
            emailStats.lastFailureReason = msg;
            throw new Error(msg);
        }
        const errorMsg = error.response?.data?.message || error.message;
        emailStats.lastFailure = new Date();
        emailStats.lastFailureReason = errorMsg;
        throw new Error(`Resend API Error: ${errorMsg}`);
    }
};

/**
 * Check email provider health (for admin monitoring)
 * Never exposes secrets.
 */
const checkHealth = () => {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL;

    return {
        provider: 'Resend',
        apiKeyConfigured: !!apiKey,
        apiKeyPrefix: apiKey ? apiKey.substring(0, 6) + '...' : null,
        senderConfigured: !!fromEmail,
        senderAddress: fromEmail || null,
        lastAttempt: emailStats.lastAttempt,
        lastSuccess: emailStats.lastSuccess,
        lastSuccessMessageId: emailStats.lastSuccessMessageId,
        lastFailure: emailStats.lastFailure,
        lastFailureReason: emailStats.lastFailureReason,
        status: !apiKey
            ? 'NOT_CONFIGURED'
            : emailStats.lastSuccess && (!emailStats.lastFailure || emailStats.lastSuccess > emailStats.lastFailure)
                ? 'HEALTHY'
                : emailStats.lastFailure
                    ? 'LAST_SEND_FAILED'
                    : 'UNKNOWN'
    };
};

module.exports = {
    escapeHtml,
    sanitizeUrl,
    wrapAdminEmail,
    getHeaderHtml,
    getFooterHtml,

    /**
     * Send a welcome email when a new student is created
     * @param {Object} student - The student object
     */
    sendWelcomeEmail: async (student) => {
        try {
            const rawName = student.Name || student.name || 'Student';
            const safeStudentName = escapeHtml(rawName);
            const safeStudentEmail = escapeHtml(student.email);
            const safeLmsUrl = sanitizeUrl(LMS_URL);

            const contentHtml = `
                <div style="text-align:center; margin-bottom:20px;">
                    <span style="display:inline-block; padding:6px 16px; background:rgba(18,49,76,.08); border:1px solid #cbd5e1; border-radius:20px; font-size:12px; font-weight:700; color:#12314c; letter-spacing:1px; text-transform:uppercase;">
                        🎓 Student Onboarding
                    </span>
                </div>

                <h1 style="margin:0 0 10px 0; color:#0f172a; font-size:24px; font-weight:800; letter-spacing:-0.5px; text-align:center;">Welcome to Zeitnah LMS</h1>
                <p style="margin:0 0 28px 0; color:#475569; font-size:15px; text-align:center; line-height:1.6;">Your learning account has been successfully configured.</p>

                <p style="margin:0 0 18px; color:#334155; font-size:15px; line-height:1.6;">Hello <strong>${safeStudentName}</strong>,</p>
                <p style="margin:0 0 24px; color:#475569; font-size:15px; line-height:1.6;">We are pleased to welcome you to the Zeitnah learning platform. Your student account is active and ready for coursework access.</p>

                <!-- Passwordless Login Card -->
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:24px; margin:28px 0;">
                    <h2 style="margin:0 0 12px; color:#12314c; font-size:17px; font-weight:700;">Passwordless Email &amp; OTP Login</h2>
                    <p style="margin:0 0 12px; color:#475569; font-size:14px; line-height:1.6;">Access your learning portal securely with zero password friction:</p>
                    <ol style="margin:0 0 16px 0; padding-left:20px; color:#475569; font-size:14px; line-height:1.7;">
                        <li>Enter your registered email on the login screen</li>
                        <li>Receive a 6-digit One-Time Password (OTP) in your inbox</li>
                        <li>Verify the code to access your curriculum dashboard</li>
                    </ol>
                    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; font-size:13px; color:#0f172a;">
                        <strong>Registered Email:</strong> <span style="color:#004ce8;">${safeStudentEmail}</span>
                    </div>
                </div>

                <!-- Bulletproof CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:32px auto 20px auto;">
                    <tr>
                        <td align="center" bgcolor="#12314c" style="border-radius:10px;">
                            <a href="${safeLmsUrl}" target="_blank" style="font-size:15px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-weight:700; color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:10px; display:inline-block; box-shadow:0 4px 14px rgba(18,49,76,.25);">
                                Access Your Dashboard &rarr;
                            </a>
                        </td>
                    </tr>
                </table>
            `;

            const html = wrapAdminEmail(contentHtml, 'Welcome to Zeitnah LMS — Your Learning Account is Ready', 'STUDENT ONBOARDING');

            const text = [
                `Welcome to Zeitnah LMS`,
                ``,
                `Hello ${rawName},`,
                `Welcome to Zeitnah LMS. Your learning account has been created successfully.`,
                ``,
                `Secure Login via Email & OTP:`,
                `You can access your dashboard using your registered email address (${student.email}). No password is required.`,
                ``,
                `1. Enter your registered email on the login screen`,
                `2. Receive a One-Time Password (OTP) in your inbox`,
                `3. Verify the OTP to access your dashboard`,
                ``,
                `Access Your Dashboard: ${LMS_URL}`,
                ``,
                `--`,
                `${ZEITNAH_BRAND.name} • ${ZEITNAH_BRAND.tagline}`,
                `${ZEITNAH_BRAND.mission}`,
            ].join('\n');

            await sendViaResend(
                student.email,
                "Welcome to Zeitnah LMS – Your Learning Account is Ready",
                html,
                text
            );

            logger.info(`Welcome email sent successfully to ${student.email}`);
        } catch (error) {
            logger.error('Failed to send Welcome email:', error.message);
        }
    },

    /**
     * Send an email when courses are assigned to an existing student
     * @param {Object} student - The student object
     * @param {Array} courses - Array of course objects assigned
     */
    sendCourseAssignedEmail: async (student, courses) => {
        try {
            const rawName = student.Name || student.name || 'Student';
            const safeStudentName = escapeHtml(rawName);
            const safeStudentEmail = escapeHtml(student.email);
            const safeLmsUrl = sanitizeUrl(LMS_URL);

            const courseItems = (courses || []).map(c => {
                const name = escapeHtml(c.courseName || c.name || 'Enrolled Course');
                return `<li style="margin-bottom:8px; color:#0f172a; font-size:14px;"><strong>${name}</strong></li>`;
            }).join('');

            const contentHtml = `
                <div style="text-align:center; margin-bottom:20px;">
                    <span style="display:inline-block; padding:6px 16px; background:rgba(18,49,76,.08); border:1px solid #cbd5e1; border-radius:20px; font-size:12px; font-weight:700; color:#12314c; letter-spacing:1px; text-transform:uppercase;">
                        📚 Curriculum Update
                    </span>
                </div>

                <h1 style="margin:0 0 10px 0; color:#0f172a; font-size:24px; font-weight:800; letter-spacing:-0.5px; text-align:center;">New Courses Assigned</h1>
                <p style="margin:0 0 28px 0; color:#475569; font-size:15px; text-align:center; line-height:1.6;">Your learning journey continues with updated course enrollments.</p>

                <p style="margin:0 0 18px; color:#334155; font-size:15px; line-height:1.6;">Hello <strong>${safeStudentName}</strong>,</p>
                <p style="margin:0 0 24px; color:#475569; font-size:15px; line-height:1.6;">New curriculum modules have been provisioned to your learning account:</p>

                <!-- Enrolled Course List Card -->
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:14px; padding:22px 24px; margin:24px 0;">
                    <h2 style="margin:0 0 14px; color:#12314c; font-size:16px; font-weight:700;">Enrolled Coursework:</h2>
                    <ul style="margin:0; padding-left:20px; line-height:1.7;">
                        ${courseItems || '<li style="color:#64748b;">Course curriculum updated</li>'}
                    </ul>
                </div>

                <p style="margin:0 0 24px; color:#475569; font-size:14px; line-height:1.6;">
                    Log in with your registered email (<strong>${safeStudentEmail}</strong>) to stream lectures, review instructional materials, and track your learning progress.
                </p>

                <!-- Bulletproof CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:32px auto 20px auto;">
                    <tr>
                        <td align="center" bgcolor="#12314c" style="border-radius:10px;">
                            <a href="${safeLmsUrl}" target="_blank" style="font-size:15px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; font-weight:700; color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:10px; display:inline-block; box-shadow:0 4px 14px rgba(18,49,76,.25);">
                                Access Your Dashboard &rarr;
                            </a>
                        </td>
                    </tr>
                </table>
            `;

            const html = wrapAdminEmail(contentHtml, 'New Courses Added to Your Zeitnah Account', 'CURRICULUM ENROLLMENT');

            const courseListText = (courses || [])
                .map(c => `- ${c.courseName || c.name || 'Enrolled Course'}`)
                .join('\n');

            const text = [
                `New Course Assigned`,
                ``,
                `Hello ${rawName},`,
                `New courses have been added to your Zeitnah learning account:`,
                ``,
                courseListText,
                ``,
                `Log in with your registered email (${student.email}) to access your learning dashboard.`,
                ``,
                `Access Your Dashboard: ${LMS_URL}`,
                ``,
                `--`,
                `${ZEITNAH_BRAND.name} • ${ZEITNAH_BRAND.tagline}`,
                `${ZEITNAH_BRAND.mission}`,
            ].join('\n');

            await sendViaResend(
                student.email,
                "A New Course Has Been Added to Your Account",
                html,
                text
            );

            logger.info(`Course Assigned email sent successfully to ${student.email}`);
        } catch (error) {
            logger.error('Failed to send Course Assigned email:', error.message);
        }
    },

    /**
     * Check email provider health (admin monitoring — never exposes secrets)
     */
    checkHealth,

    /**
     * Diagnostic test email sending (for superuser verification)
     * @param {string} toEmail - Recipient email
     */
    sendTestEmail: async (toEmail) => {
        const safeTimestamp = escapeHtml(new Date().toISOString());

        const contentHtml = `
            <div style="text-align:center; margin-bottom:20px;">
                <span style="display:inline-block; padding:6px 14px; background:rgba(159,213,178,.2); border:1px solid rgba(159,213,178,.4); border-radius:20px; font-size:12px; font-weight:700; color:#0f172a; text-transform:uppercase;">
                    DIAGNOSTIC TEST
                </span>
            </div>

            <h1 style="margin:0 0 10px 0; color:#0f172a; font-size:22px; font-weight:800; text-align:center;">Email Integration Verified</h1>
            <p style="margin:0 0 24px 0; color:#475569; font-size:14px; line-height:1.6; text-align:center;">
                This automated diagnostic message confirms that the Zeitnah Admin email subsystem is operational.
            </p>

            <div style="background:#f8fafc; border-left:4px solid #12314c; border-radius:0 8px 8px 0; padding:16px 20px; margin:24px 0;">
                <p style="margin:0; color:#0f172a; font-size:14px;"><strong>Provider:</strong> Resend API</p>
                <p style="margin:6px 0 0 0; color:#64748b; font-size:13px;"><strong>Timestamp:</strong> ${safeTimestamp}</p>
            </div>
            <p style="margin:0; color:#94a3b8; font-size:12px; text-align:center;">If you received this message, SMTP and Resend API communication is healthy.</p>
        `;

        const html = wrapAdminEmail(contentHtml, 'Zeitnah Admin • Email Diagnostic Test', 'SYSTEM DIAGNOSTICS');

        const text = [
            `Zeitnah Admin • Email Diagnostic Test`,
            ``,
            `This automated diagnostic test confirms that the Zeitnah Admin email subsystem is operational.`,
            ``,
            `Provider: Resend API`,
            `Timestamp: ${new Date().toISOString()}`,
            ``,
            `--`,
            `${ZEITNAH_BRAND.name} • ${ZEITNAH_BRAND.tagline}`,
            `${ZEITNAH_BRAND.mission}`,
        ].join('\n');

        return await sendViaResend(
            toEmail,
            "Zeitnah Admin • Email Diagnostic Test",
            html,
            text
        );
    }
};
