const assert = require('assert');
const { escapeHtml, sanitizeUrl } = require('../Helpers/email-service');
const emailService = require('../Helpers/email-service');
const mailHelpers = require('../Helpers/mail-helper');
const axios = require('axios');

console.log('--- Running Admin Panel Email Security & Phase 2 Template Tests ---');

// Test 1: escapeHtml escapes HTML special characters
(() => {
    const raw = '<script>alert("xss") & \'test\'</script>';
    const escaped = escapeHtml(raw);
    assert.strictEqual(
        escaped,
        '&lt;script&gt;alert(&quot;xss&quot;) &amp; &#039;test&#039;&lt;/script&gt;',
        'escapeHtml must escape <, >, ", \', and &'
    );
    console.log('✓ escapeHtml successfully neutralizes tags, quotes, and ampersands');
})();

// Test 2: escapeHtml handles null, undefined, numbers, and empty strings
(() => {
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
    assert.strictEqual(escapeHtml(''), '');
    assert.strictEqual(escapeHtml(123456), '123456');
    console.log('✓ escapeHtml safely handles non-string and falsy inputs');
})();

// Test 3: sanitizeUrl allows valid HTTP/HTTPS URLs and rejects unsafe protocols
(() => {
    assert.strictEqual(sanitizeUrl('https://zeitnahacademy.com/login'), 'https://zeitnahacademy.com/login');
    assert.strictEqual(sanitizeUrl('http://localhost:3000/dashboard'), 'http://localhost:3000/dashboard');
    assert.strictEqual(sanitizeUrl('javascript:alert(1)'), 'https://zeitnahacademy.com/login');
    assert.strictEqual(sanitizeUrl('data:text/html,<script>alert(1)</script>'), 'https://zeitnahacademy.com/login');
    assert.strictEqual(sanitizeUrl('vbscript:msgbox(1)'), 'https://zeitnahacademy.com/login');
    assert.strictEqual(sanitizeUrl('https://zeitnahacademy.com/login" onmouseover="alert(1)'), 'https://zeitnahacademy.com/login');
    assert.strictEqual(sanitizeUrl(''), 'https://zeitnahacademy.com/login');
    assert.strictEqual(sanitizeUrl(null), 'https://zeitnahacademy.com/login');
    console.log('✓ sanitizeUrl allows valid URLs and blocks javascript:/data: protocol injection and quote breakout');
})();

// Test 4: End-to-end HTML escaping & Phase 2 rendering in email payloads
(() => {
    const originalPost = axios.post;

    let capturedPayload = null;
    axios.post = async (url, payload) => {
        capturedPayload = payload;
        return { data: { id: 'test-resend-id-999' } };
    };

    const originalApiKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_test_mock_key';

    try {
        // Test 4A: Welcome Email Escaping and Phase 2 Brand Header/Footer
        const maliciousStudent = {
            Name: '<script>alert("student-xss")</script>',
            email: 'student"onmouseover="alert(1)@evil.com'
        };

        emailService.sendWelcomeEmail(maliciousStudent);

        setImmediate(() => {
            assert.ok(capturedPayload, 'Payload must be dispatched to Resend');
            assert.ok(!capturedPayload.html.includes('<script>alert'), 'HTML must not contain raw script tag');
            assert.ok(capturedPayload.html.includes('&lt;script&gt;alert(&quot;student-xss&quot;)&lt;/script&gt;'), 'Name must be escaped');
            assert.ok(capturedPayload.html.includes('student&quot;onmouseover=&quot;alert(1)@evil.com'), 'Email must be escaped');
            assert.ok(capturedPayload.html.includes('ZEITNAH'), 'Brand title must be present');
            assert.ok(capturedPayload.html.includes('SEE THE UNSEEN'), 'Brand tagline must be present');
            assert.ok(capturedPayload.html.includes('max-width:600px'), 'Table container must enforce 600px max-width');
            assert.ok(capturedPayload.text, 'Plain text alternative must be present');
            assert.ok(capturedPayload.text.includes('<script>alert("student-xss")</script>'), 'Plain text contains readable raw text');
            console.log('✓ sendWelcomeEmail safely escapes user input, renders Phase 2 table layout, and provides plain text');

            // Test 4B: Course Assigned Email Escaping
            capturedPayload = null;
            const maliciousCourses = [
                { courseName: '<img src=x onerror=alert("course-xss") />' },
                { name: 'Normal Course & Advanced "Robotics"' }
            ];

            emailService.sendCourseAssignedEmail(maliciousStudent, maliciousCourses);

            setImmediate(() => {
                assert.ok(capturedPayload, 'Payload must be dispatched to Resend');
                assert.ok(!capturedPayload.html.includes('<img src=x'), 'Course HTML must not contain raw img tag');
                assert.ok(capturedPayload.html.includes('&lt;img src=x onerror=alert(&quot;course-xss&quot;) /&gt;'), 'Course name must be escaped');
                assert.ok(capturedPayload.html.includes('Normal Course &amp; Advanced &quot;Robotics&quot;'), 'Ampersands and quotes must be escaped');
                assert.ok(capturedPayload.text, 'Plain text alternative must be present');
                console.log('✓ sendCourseAssignedEmail safely escapes course names and provides plain text');

                // Test 4C: Admin Login OTP Email
                capturedPayload = null;
                mailHelpers.sendAdminOtpEmail('admin@zeitnahacademy.com', '719304');

                setImmediate(() => {
                    assert.ok(capturedPayload, 'Payload must be dispatched to Resend');
                    assert.ok(capturedPayload.html.includes('719304'), 'OTP must be rendered');
                    assert.ok(capturedPayload.html.includes('border:1px solid #cbd5e1'), 'Solid card border must be used');
                    assert.ok(capturedPayload.html.includes('-webkit-user-select:all'), 'Tap-to-select CSS must be present');
                    assert.ok(capturedPayload.html.includes('Valid for 5 minutes only'), 'Must state 5-minute validity for admin OTP');
                    assert.ok(capturedPayload.text.includes('719304'), 'Plain text must include OTP');
                    assert.ok(capturedPayload.text.includes('5 minutes'), 'Plain text must state 5 minutes');
                    console.log('✓ sendAdminOtpEmail renders solid OTP card, 5-minute notice, and plain text');

                    // Test 4D: Admin Diagnostic Test Email
                    capturedPayload = null;
                    emailService.sendTestEmail('superadmin@zeitnahacademy.com');

                    setImmediate(() => {
                        assert.ok(capturedPayload, 'Payload must be dispatched to Resend');
                        assert.ok(capturedPayload.html.includes('Email Integration Verified'), 'Must render test title');
                        assert.ok(capturedPayload.text.includes('Email Diagnostic Test'), 'Plain text must be present in test email');
                        console.log('✓ sendTestEmail provides both Phase 2 HTML and plain text');

                        // Cleanup
                        axios.post = originalPost;
                        process.env.RESEND_API_KEY = originalApiKey;
                        console.log('All Admin Panel Email Security & Template Tests PASSED!\n');
                    });
                });
            });
        });
    } catch (err) {
        axios.post = originalPost;
        process.env.RESEND_API_KEY = originalApiKey;
        throw err;
    }
})();
