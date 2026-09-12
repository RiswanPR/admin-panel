const axios = require('axios');
const logger = require('./logger');

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
            logger.info(`🔑 [DEV MODE] Admin OTP for ${email}: ${otp}`);
            return; // skip email, OTP is still stored in session
        }

        // Send via Resend API
        try {
            const response = await axios.post('https://api.resend.com/emails', {
                from: fromEmail,
                to: email,
                subject: "Your Admin Login OTP • Zeitnah",
                text: `Your OTP for admin login is ${otp}. It will expire in 5 minutes.`,
                html: `
    <div style="
        margin:0;
        padding:0;
        background:#f4f7f8;
        font-family:Helvetica,Arial,sans-serif;
    ">
        <div style="
            max-width:620px;
            margin:40px auto;
            background:#ffffff;
            border-radius:28px;
            overflow:hidden;
            box-shadow:0 20px 60px rgba(0,0,0,.12);
        ">
            
            <!-- HEADER -->
            <div style="
                background:linear-gradient(135deg,#12314c 0%,#0d2438 100%);
                padding:45px 40px;
                text-align:center;
                position:relative;
            ">
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
                ">
                    🔐
                </div>

                <p style="
                    margin:25px 0 0;
                    color:#9fd5b2;
                    font-size:13px;
                    letter-spacing:3px;
                    text-transform:uppercase;
                    font-weight:600;
                ">
                    Secure Authentication
                </p>

                <h1 style="
                    margin:12px 0 0;
                    color:white;
                    font-size:34px;
                    font-weight:800;
                    letter-spacing:-1px;
                ">
                    Admin Login OTP
                </h1>
            </div>

            <!-- BODY -->
            <div style="padding:50px 40px;text-align:center;">
                
                <p style="
                    margin:0;
                    color:#6b7280;
                    font-size:17px;
                    line-height:1.8;
                ">
                    Use the following one-time password to continue your secure login.
                </p>

                <div style="
                    margin:38px auto;
                    width:max-content;
                    background:linear-gradient(135deg,#f6ed4a 0%,#e6dd42 100%);
                    color:#12314c;
                    font-size:42px;
                    font-weight:900;
                    letter-spacing:12px;
                    padding:22px 38px;
                    border-radius:22px;
                    box-shadow:0 15px 40px rgba(246,237,74,.35);
                ">
                    ${otp}
                </div>

                <div style="
                    background:#f8fafc;
                    border:1px solid #e5e7eb;
                    border-radius:18px;
                    padding:20px;
                    margin-top:25px;
                    color:#475569;
                    font-size:14px;
                    line-height:1.8;
                ">
                    ⏳ Expires in <b>5 minutes</b><br>
                    🔒 Never share this code with anyone
                </div>

            </div>

            <!-- FOOTER -->
            <div style="
                background:#f9fafb;
                border-top:1px solid #edf2f7;
                padding:28px;
                text-align:center;
            ">
                <p style="
                    margin:0;
                    color:#94a3b8;
                    font-size:13px;
                    line-height:1.8;
                ">
                    Zeitnah Group of Institutions<br>
                    Premium Education • Trusted Systems
                </p>
            </div>

        </div>
    </div>
    `
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
