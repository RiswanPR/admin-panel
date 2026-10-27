const axios = require('axios');
const logger = require('./logger');
const { escapeHtml, wrapAdminEmail } = require('./email-service');

const RESEND_TIMEOUT_MS = 10000;

const getFromEmail = () => {
    const resendFrom = process.env.RESEND_FROM_EMAIL;
    if (resendFrom) {
        return resendFrom.replace(/^"(.*)"$/, '$1').trim();
    }
    return 'Zeitnah Admin <onboarding@resend.dev>';
};

module.exports = {
    sendAdminOtpEmail: async (email, otp) => {
        const apiKey = process.env.RESEND_API_KEY;
        const fromEmail = getFromEmail();

        // ── RESEND NOT CONFIGURED — development mode fallback ──
        if (!apiKey) {
            if (process.env.NODE_ENV === 'production') {
                logger.error('RESEND_API_KEY is not configured in production.');
                throw new Error('Email service is not configured. Please contact administrator.');
            }
            // Do NOT log plaintext authentication secrets
            logger.info(`[DEV MODE] Admin OTP generated for ${email} (dispatch suppressed: RESEND_API_KEY unconfigured)`);
            return; // skip email, OTP is still securely stored in session
        }

        const contentHtml = `
            <div style="text-align:center; margin-bottom:20px;">
                <span style="display:inline-block; padding:6px 16px; background:rgba(18,49,76,.08); border:1px solid #cbd5e1; border-radius:20px; font-size:12px; font-weight:700; color:#12314c; letter-spacing:1px; text-transform:uppercase;">
                    🔒 Administrator Security
                </span>
            </div>

            <h1 style="margin:0 0 10px 0; color:#0f172a; font-size:24px; font-weight:800; letter-spacing:-0.5px; text-align:center;">
                Admin Login Verification
            </h1>
            <p style="margin:0 0 28px 0; color:#475569; font-size:15px; text-align:center; line-height:1.6;">
                Use the following one-time password to complete your administrator sign-in.
            </p>

            <!-- OTP Card: Solid border, centered, monospaced, tap-to-select -->
            <div style="background-color:#f8fafc; border:1px solid #cbd5e1; border-radius:14px; padding:28px 24px; text-align:center; margin:24px 0 28px 0;">
                <span style="font-size:11px; font-weight:800; color:#12314c; letter-spacing:2px; text-transform:uppercase; display:block; margin-bottom:12px;">
                    One-Time Administrator Code
                </span>
                <div style="font-size:38px; font-weight:800; letter-spacing:12px; color:#0f172a; font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,Courier,monospace; line-height:1; padding-left:12px; -webkit-user-select:all; user-select:all;">
                    ${escapeHtml(otp)}
                </div>
            </div>

            <!-- Timer Indicator (Strict 5-minute validity) -->
            <div style="text-align:center; margin-bottom:28px;">
                <span style="display:inline-block; padding:6px 16px; background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.3); border-radius:20px; font-size:12px; font-weight:700; color:#b45309;">
                    ⏱️ Valid for 5 minutes only
                </span>
            </div>

            <!-- Security Warning Card -->
            <div style="background:#f1f5f9; border-left:4px solid #12314c; border-radius:0 8px 8px 0; padding:16px 20px;">
                <h4 style="margin:0 0 6px 0; font-size:13px; font-weight:700; color:#0f172a;">
                    🔒 Administrator Security Notice
                </h4>
                <p style="margin:0; font-size:13px; color:#475569; line-height:1.5;">
                    Never share this authentication code with anyone. Zeitnah personnel will never request your administrator OTP. If you did not initiate this login request, please verify your account credentials immediately.
                </p>
            </div>
        `;

        const html = wrapAdminEmail(contentHtml, `Your Admin Login OTP is ${otp}`, 'SECURE AUTHENTICATION');

        // Send via Resend API
        try {
            const response = await axios.post('https://api.resend.com/emails', {
                from: fromEmail,
                to: email,
                subject: "Your Admin Login OTP • Zeitnah",
                text: `Your OTP for admin login is ${otp}. It will expire in 5 minutes. Never share this code with anyone.`,
                html: html
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: RESEND_TIMEOUT_MS
            });

            // Validate Resend response
            if (!response.data || !response.data.id) {
                throw new Error('Resend API returned unexpected response (no message ID)');
            }

            logger.info(`Admin OTP email sent successfully to ${email} (Resend ID: ${response.data.id})`);
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                logger.error(`OTP email timeout after ${RESEND_TIMEOUT_MS}ms to ${email}`);
                throw new Error('Email service timed out. Please try again.');
            }
            const errorMsg = error.response?.data?.message || error.message;
            logger.error(`Failed to send OTP email via Resend to ${email}: ${errorMsg}`);
            throw new Error(`Failed to send OTP email: ${errorMsg}`);
        }
    }
};
