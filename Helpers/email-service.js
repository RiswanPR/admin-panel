const axios = require('axios');
const logger = require('./logger');

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

/**
 * Helper to send email via Resend
 */
const sendViaResend = async (to, subject, html) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        logger.warn('RESEND_API_KEY not configured. Skipping email send.');
        return;
    }

    try {
        await axios.post('https://api.resend.com/emails', {
            from: getFromStr(),
            to: to,
            subject: subject,
            html: html
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        throw new Error(`Resend API Error: ${errorMsg}`);
    }
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
                            <h2 style="margin:0 0 15px; color:#12314c; font-size:18px; font-weight:700;">Secure Login via Email & OTP</h2>
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
            logger.error('Failed to send Welcome email:', error);
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
            logger.error('Failed to send Course Assigned email:', error);
        }
    }
};
