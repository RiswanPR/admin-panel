const axios = require('axios');
const logger = require('./logger');

const RESEND_TIMEOUT_MS = 10000; // 10 second timeout

const getFromStr = () => {
    const resendFrom = process.env.RESEND_FROM_EMAIL;
    if (resendFrom) {
        // If the env variable is already formatted like "Name <email>", use it directly
        return resendFrom.replace(/^"(.*)"$/, '$1').trim();
    }
    const name = process.env.SMTP_FROM_NAME || 'Zeitnah LMS';
    const email = process.env.SMTP_FROM_EMAIL || 'noreply@zeitnahacademy.com';
    return `${name} <${email.replace(/^"(.*)"$/, '$1').trim()}>`;
};

const LMS_URL = process.env.LMS_LOGIN_URL || 'https://beta.zeitnahacademy.com/login';
const LOGO_HTML = `
<div style="text-align: center; margin-bottom: 30px;">
    <div style="
        width:78px;
        height:78px;
        margin:auto;
        background:#9fd5b2;
        border-radius:22px;
        display:flex;
        align-items:center;
        justify-content:center;
        box-shadow:0 10px 30px rgba(159,213,178,.35);
        font-size:32px;
        line-height:78px;
        text-align:center;
    ">🎓</div>
</div>
`;

const FOOTER_HTML = `
<div style="background:#f9fafb; border-top:1px solid #edf2f7; padding:28px; text-align:center; margin-top:40px; border-radius: 0 0 28px 28px;">
    <p style="margin:0; color:#94a3b8; font-size:13px; line-height:1.8;">
        Zeitnah Group of Institutions<br>
        Premium Education • Trusted Systems<br><br>
        Need help? Contact support at support@zeitnahacademy.com
    </p>
</div>
`;

// ── Track last email attempt for health monitoring ──
const emailStats = {
    lastAttempt: null,
    lastSuccess: null,
    lastFailure: null,
    lastFailureReason: null,
    lastSuccessMessageId: null,
};

/**
 * Helper to send email via Resend
 */
const sendViaResend = async (to, subject, html) => {
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
        const response = await axios.post('https://api.resend.com/emails', {
            from: getFromStr(),
            to: to,
            subject: subject,
            html: html
        }, {
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
    /**
     * Send a welcome email when a new student is created
     * @param {Object} student - The student object
     */
    sendWelcomeEmail: async (student) => {
        try {
            const studentName = student.Name || student.name || 'Student';
            const studentEmail = student.email;

            const html = `
            <div style="margin:0; padding:0; background:#f4f7f8; font-family:Helvetica,Arial,sans-serif; padding-top: 40px; padding-bottom: 40px;">
                <div style="max-width:620px; margin:0 auto; background:#ffffff; border-radius:28px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.12);">
                    
                    <div style="background:linear-gradient(135deg,#12314c 0%,#0d2438 100%); padding:45px 40px; text-align:center;">
                        ${LOGO_HTML}
                        <h1 style="margin:0; color:white; font-size:28px; font-weight:800; letter-spacing:-0.5px;">Welcome to Zeitnah LMS</h1>
                        <p style="margin:10px 0 0; color:#9fd5b2; font-size:15px; font-weight:500;">Your Learning Account is Ready</p>
                    </div>

                    <div style="padding:40px;">
                        <p style="margin:0 0 20px; color:#475569; font-size:16px; line-height:1.6;">Hello <strong>${studentName}</strong>,</p>
                        <p style="margin:0 0 20px; color:#475569; font-size:16px; line-height:1.6;">Welcome to Zeitnah LMS. Your learning account has been created successfully.</p>
                        
                        <div style="background:#f8fafc; border:1px solid #e5e7eb; border-radius:16px; padding:25px; margin:30px 0;">
                            <h2 style="margin:0 0 15px; color:#12314c; font-size:18px; font-weight:700;">Secure Login via Email &amp; OTP</h2>
                            <p style="margin:0 0 10px; color:#64748b; font-size:15px; line-height:1.5;">You can now access your dashboard using your registered email address. <strong>No password is required.</strong></p>
                            <ol style="margin:0; padding-left:20px; color:#64748b; font-size:15px; line-height:1.6;">
                                <li>Enter your registered email below</li>
                                <li>Receive a One-Time Password (OTP)</li>
                                <li>Verify the OTP to access your dashboard</li>
                            </ol>
                            <p style="margin:15px 0 0; color:#0f172a; font-size:15px; font-weight:600;">Registered Email: ${studentEmail}</p>
                        </div>

                        <div style="text-align:center; margin:40px 0 20px;">
                            <a href="${LMS_URL}" style="background:#12314c; color:#ffffff; font-size:16px; font-weight:600; text-decoration:none; padding:16px 36px; border-radius:12px; display:inline-block; box-shadow:0 10px 25px rgba(18,49,76,.2);">Access Your Dashboard</a>
                        </div>
                    </div>

                    ${FOOTER_HTML}
                </div>
            </div>
            `;

            await sendViaResend(
                studentEmail,
                "Welcome to Zeitnah LMS – Your Learning Account is Ready",
                html
            );

            logger.info(`Welcome email sent successfully to ${studentEmail}`);
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
            const studentName = student.Name || student.name || 'Student';
            const studentEmail = student.email;
            const courseListHtml = courses.map(c => `<li style="margin-bottom:8px;"><strong>${c.courseName || c.name || 'Unknown Course'}</strong></li>`).join('');

            const html = `
            <div style="margin:0; padding:0; background:#f4f7f8; font-family:Helvetica,Arial,sans-serif; padding-top: 40px; padding-bottom: 40px;">
                <div style="max-width:620px; margin:0 auto; background:#ffffff; border-radius:28px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.12);">
                    
                    <div style="background:linear-gradient(135deg,#12314c 0%,#0d2438 100%); padding:45px 40px; text-align:center;">
                        ${LOGO_HTML}
                        <h1 style="margin:0; color:white; font-size:28px; font-weight:800; letter-spacing:-0.5px;">New Course Assigned</h1>
                        <p style="margin:10px 0 0; color:#9fd5b2; font-size:15px; font-weight:500;">Your learning journey continues!</p>
                    </div>

                    <div style="padding:40px;">
                        <p style="margin:0 0 20px; color:#475569; font-size:16px; line-height:1.6;">Hello <strong>${studentName}</strong>,</p>
                        <p style="margin:0 0 20px; color:#475569; font-size:16px; line-height:1.6;">Good news! New courses have been added to your learning account.</p>
                        
                        <div style="background:#f8fafc; border:1px solid #e5e7eb; border-radius:16px; padding:25px; margin:30px 0;">
                            <h2 style="margin:0 0 15px; color:#12314c; font-size:16px; font-weight:700;">You have been enrolled in:</h2>
                            <ul style="margin:0; padding-left:20px; color:#0f172a; font-size:15px; line-height:1.6;">
                                ${courseListHtml}
                            </ul>
                        </div>

                        <p style="margin:0 0 20px; color:#64748b; font-size:15px; line-height:1.6;">You can log in using your registered email address <strong>(${studentEmail})</strong> and receive an OTP to access your learning dashboard.</p>

                        <div style="text-align:center; margin:40px 0 20px;">
                            <a href="${LMS_URL}" style="background:#12314c; color:#ffffff; font-size:16px; font-weight:600; text-decoration:none; padding:16px 36px; border-radius:12px; display:inline-block; box-shadow:0 10px 25px rgba(18,49,76,.2);">Access Your Dashboard</a>
                        </div>
                    </div>

                    ${FOOTER_HTML}
                </div>
            </div>
            `;

            await sendViaResend(
                studentEmail,
                "A New Course Has Been Added to Your Account",
                html
            );

            logger.info(`Course Assigned email sent successfully to ${studentEmail}`);
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
        const html = `
        <div style="margin:0; padding:30px; font-family:Helvetica,Arial,sans-serif; background:#f4f7f8;">
            <div style="max-width:550px; margin:0 auto; background:#ffffff; border-radius:18px; padding:30px; border:1px solid #e2e8f0; box-shadow:0 10px 30px rgba(0,0,0,.08);">
                <div style="display:inline-block; background:#9fd5b2; color:#12314c; padding:6px 14px; border-radius:20px; font-size:12px; font-weight:700; margin-bottom:15px;">DIAGNOSTIC TEST</div>
                <h2 style="margin:0 0 12px; color:#12314c; font-size:22px;">Email Integration Verified</h2>
                <p style="margin:0 0 16px; color:#475569; font-size:15px; line-height:1.6;">This is an automated diagnostic test from the <strong>Zeitnah Academy Admin Panel</strong>.</p>
                <div style="background:#f8fafc; border-left:4px solid #12314c; padding:12px 16px; margin:20px 0; border-radius:0 8px 8px 0;">
                    <p style="margin:0; color:#334155; font-size:14px;"><strong>Provider:</strong> Resend API</p>
                    <p style="margin:4px 0 0; color:#64748b; font-size:13px;">Timestamp: ${new Date().toISOString()}</p>
                </div>
                <p style="margin:0; color:#94a3b8; font-size:12px;">If you received this message, the email subsystem is operating correctly.</p>
            </div>
        </div>
        `;

        return await sendViaResend(
            toEmail,
            "Zeitnah Admin • Email Diagnostic Test",
            html
        );
    }
};
