require('dotenv').config();

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var fs = require('fs');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var session = require('express-session');
var exphbs = require('express-handlebars');
var helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

var usersRouter = require('./routes/users');
var teacherRouter = require('./routes/teacher');
var adminGovernanceRouter = require('./routes/admin-governance');
var db = require('./config/connection');

// CRON
const cron = require('node-cron');
const studentHelper = require('./Helpers/student-helper');
const { ensureIndexes } = require('./Helpers/index-helper');
const { runPlatformMigration } = require('./Helpers/migration-helper');

// ── Orphaned Temporary Upload Housekeeping ──
// Cleans up interrupted or stale multipart temp files (>2h old) to prevent disk exhaustion
const cleanupOrphanedTempFiles = () => {
  const tempDirs = [
    path.join(__dirname, 'temp/videos'),
    path.join(__dirname, 'temp/exercises')
  ];
  const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();

  tempDirs.forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs.readdirSync(dir);
      files.forEach((file) => {
        const filePath = path.join(dir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && (now - stats.mtimeMs > maxAgeMs)) {
            fs.unlinkSync(filePath);
            console.log(`🧹 Cleaned up orphaned temp upload: ${filePath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
          }
        } catch (fileErr) {
          // File may have been deleted concurrently
        }
      });
    } catch (dirErr) {
      console.warn(`⚠️ Temp directory cleanup warning for ${dir}:`, dirErr.message);
    }
  });
};

// Run temp cleanup on startup and every 2 hours
cleanupOrphanedTempFiles();
cron.schedule('0 */2 * * *', () => {
  cleanupOrphanedTempFiles();
});

// Run daily student expiration check at midnight
cron.schedule('0 0 * * *', async () => {
  try {
    console.log('⏰ Running daily student expiration check...');
    await studentHelper.updateExpiredStudents();
    console.log('✅ Student expiration check complete.');
  } catch (err) {
    console.error('❌ Student expiration check failed:', err.message);
  }
});

var app = express();
app.use(compression());

const requiredEnv = [
  'SESSION_SECRET', 'MONGO_URL',
  'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_BUCKET_NAME'
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  throw new Error(`Missing required environment variable(s): ${missingEnv.join(', ')}`);
}

// Email configuration validation (warn, don't crash)
const emailEnv = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'];
const missingEmailEnv = emailEnv.filter((key) => !process.env[key]);
if (missingEmailEnv.length) {
  console.warn(`⚠️  Missing email configuration: ${missingEmailEnv.join(', ')} — Emails will not be sent.`);
}

// Trust the local reverse proxy (Nginx on loopback).
// Using 'loopback' is safer than `1` or `true` because it only trusts
// proxies at 127.0.0.1 / ::1, preventing external IP spoofing.
// Always enabled (not gated by NODE_ENV) so rate-limiting and session
// security work correctly in all environments behind Nginx.
app.set('trust proxy', 'loopback');

// ======================================
// SECURITY — HTTP HEADERS (helmet)
// ======================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'code.jquery.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
      imgSrc:      ["'self'", 'data:', 'res.cloudinary.com', 'storage.googleapis.com', 'firebasestorage.googleapis.com', '*.amazonaws.com'],
      frameSrc:    ["'self'", 'player.vdocipher.com'],
      mediaSrc:    ["'self'", '*.amazonaws.com'],
      connectSrc:  ["'self'"],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    }
  },
  // Allow iframes only on same origin
  frameguard: { action: 'sameorigin' },
  // Hide X-Powered-By header
  hidePoweredBy: true,
  // DNS Prefetch Control
  dnsPrefetchControl: { allow: false },
  // Strict Referrer Policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));


// ======================================
// GLOBAL RATE LIMITER (all routes)
// ======================================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                   // max 300 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please try again later.',
  skip: (req) => {
    // skip static asset requests
    return req.path.startsWith('/stylesheets') ||
           req.path.startsWith('/javascripts') ||
           req.path.startsWith('/images') ||
           req.path.startsWith('/course-images') ||
           req.path.startsWith('/student-images');
  }
});

app.use(globalLimiter);


// ======================================
// VIEW ENGINE
// ======================================
app.engine(
  'hbs',
  exphbs.engine({
    extname: 'hbs',
    defaultLayout: 'layout',
    layoutsDir: path.join(__dirname, 'views/Layout'),
    partialsDir: path.join(__dirname, 'views/partials'),

    helpers: {
      eq: (a, b) => String(a) === String(b),
      gt: (a, b) => a > b,
      lt: (a, b) => a < b,

      ifEquals: function (a, b, options) {
        return String(a) === String(b)
          ? options.fn(this)
          : options.inverse(this);
      },

      inc: function (value) {
        return Number(value || 0) + 1;
      },

      dec: function (value) {
        return Math.max(1, Number(value || 1) - 1);
      },

      ifGt: function (a, b, options) {
        return Number(a) > Number(b) ? options.fn(this) : options.inverse(this);
      },

      ifLt: function (a, b, options) {
        return Number(a) < Number(b) ? options.fn(this) : options.inverse(this);
      },

      selected: function (a, b) {
        return String(a) === String(b)
          ? 'selected'
          : '';
      },

      includesCourse: function (courseId, studentCourses) {
        if (!studentCourses || !Array.isArray(studentCourses)) return '';
        const isEnrolled = studentCourses.some(c => String(c.courseId) === String(courseId));
        return isEnrolled ? 'selected' : '';
      },

      resolveImage: function(imagePath, folderName) {
        const placeholder = folderName && folderName.includes('teacher')
          ? '/img/placeholders/profile.svg'
          : '/img/placeholders/course-cover.svg';
        if (!imagePath) return placeholder;
        if (imagePath.startsWith('http')) return imagePath;
        if (imagePath.includes('/')) return placeholder;
        return `/${folderName}/${imagePath}`;
      },

      formatDate: function (date) {
        if (!date) return '';

        const d = new Date(date);
        if (isNaN(d.getTime())) return '';

        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');

        return `${year}-${month}-${day}`;
      },

      formatDateTime: function (date) {
        if (!date) return '';

        const d = new Date(date);
        if (isNaN(d.getTime())) return '';

        return d.toLocaleString('en-IN', {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
      },

      formatDuration: function (seconds) {
        seconds = Number(seconds) || 0;
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
        if (minutes > 0) return `${minutes}m ${secs}s`;
        return `${secs}s`;
      },

      includes: function (arr, item) {
        if (!arr) return false;
        if (Array.isArray(arr)) {
          return arr.map(String).includes(String(item));
        }
        return String(arr).includes(String(item));
      },

      json: function (context) {
        return JSON.stringify(context || {});
      },

      truncate: function (str, len) {
        if (!str) return '';
        const max = Number(len) || 100;
        if (str.length <= max) return str;
        return str.substring(0, max) + '...';
      },

      badgeClass: function (type, val) {
        const value = String(val || '').toLowerCase();
        if (type === 'priority') {
          if (value === 'critical') return 'badge-priority-critical';
          if (value === 'important') return 'badge-priority-important';
          return 'badge-priority-normal';
        }
        if (type === 'status') {
          if (['published', 'active', 'approved', 'verified', 'resolved', 'highly_compatible'].includes(value)) return 'badge-status-active';
          if (['pending', 'under_review', 'reviewed', 'potentially_compatible', 'draft'].includes(value)) return 'badge-status-scheduled';
          if (['archived', 'blocked', 'rejected', 'suspended', 'closed'].includes(value)) return 'badge-status-archived';
          return 'badge-status-draft';
        }
        return '';
      },
      mathRound: function(val) {
        return Math.round(Number(val) || 0);
      },
      upper: function(str) {
        return String(str || '').toUpperCase();
      },
      lower: function(str) {
        return String(str || '').toLowerCase();
      },
      or: function(...args) {
        return args.slice(0, -1).some(Boolean);
      }
    }
  })
);

app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// ======================================
// MIDDLEWARE
// ======================================
// Use 'combined' format in production, 'dev' in development
app.use(logger(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Safe payload limits (was 10gb — DoS risk!)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use(cookieParser());

// NoSQL Injection Protection: sanitise keys starting with $ recursively
const mongoSanitize = (obj) => {
  if (obj && typeof obj === 'object') {
    for (const key in obj) {
      if (key.startsWith('$')) {
        delete obj[key];
      } else if (typeof obj[key] === 'object') {
        mongoSanitize(obj[key]);
      }
    }
  }
};

app.use((req, res, next) => {
  if (req.body) mongoSanitize(req.body);
  if (req.query) mongoSanitize(req.query);
  if (req.params) mongoSanitize(req.params);
  next();
});


// Reject cross-origin browser mutations. This protects existing forms and
// fetch calls without requiring a breaking token rollout across every view.
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const source = req.get('origin') || req.get('referer');
  
  // Allow if missing or 'null' (sometimes sent by privacy extensions or local dev)
  if (!source || source === 'null') {
    return next();
  }

  try {
    const sourceUrl = new URL(source);
    // Split expectedHost to remove port if necessary, but matching exactly is usually fine
    const expectedHost = req.get('x-forwarded-host') || req.get('host');
    
    // Some proxies may append ports, or expected host might differ slightly in local dev
    // If they match perfectly, great.
    if (sourceUrl.host !== expectedHost) {
        // Fallback for tricky proxy environments: check if hostname matches at least
        if (sourceUrl.hostname !== expectedHost.split(':')[0]) {
            return res.status(403).json({
              success: false,
              message: 'Cross-origin request rejected.'
            });
        }
    }
  } catch (err) {
    return res.status(403).json({
      success: false,
      message: 'Invalid request origin.'
    });
  }

  next();
});

// ── Block sensitive path probes (scanners, bots) ──
app.use((req, res, next) => {
  // Allow RFC 8615 well-known URIs (e.g. /.well-known/security.txt)
  if (req.path.startsWith('/.well-known/')) {
    return next();
  }
  const BLOCKED_PATHS = /^\/(\.|_|env|git|aws|docker|dump|credential|proc|wp-|xmlrpc)/i;
  if (BLOCKED_PATHS.test(req.path)) {
    return res.status(403).end();
  }
  next();
});

// Serve /security.txt from .well-known
app.get('/security.txt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'security.txt'));
});

// static files
app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

// ── SESSION ──
const isProduction = process.env.NODE_ENV === 'production';
const MongoStore = require('connect-mongo').default;

const sessionStore = MongoStore.create({
  mongoUrl: process.env.MONGO_URL,
  collectionName: 'sessions',
  ttl: 24 * 60 * 60 // 1 day
});

sessionStore.on('error', (err) => {
  console.warn('⚠️ Session store warning:', err.message);
});

app.use(
  session({
    name: 'zeitnah.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      maxAge:   1000 * 60 * 60 * 24, // 1 day
      httpOnly: true,                  // JS cannot read this cookie (XSS protection)
      secure:   isProduction,          // HTTPS-only in production
      sameSite: 'lax'                  // CSRF protection
    }
  })
);


// ======================================
// DATABASE
// ======================================
const maxRetries = 5;
const retryDelay = 5000; // 5 seconds

const connectWithRetry = (attempt = 1) => {
  db.connect((err) => {
    if (err) {
      console.error(`❌ Database connection attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        console.log(`🔄 Retrying database connection in ${retryDelay / 1000}s...`);
        setTimeout(() => connectWithRetry(attempt + 1), retryDelay);
      } else {
        console.error('❌ Max database connection retries reached. Application running in offline/unconnected state.');
      }
    } else {
      console.log('✅ Database Connected (MongoDB)');
      ensureIndexes(db.get())
        .then(() => runPlatformMigration(db.get()))
        .catch((err) => {
          console.warn('⚠️ Database setup / migration warning:', err.message);
        });
    }
  });
};

connectWithRetry();


// ======================================
// ROUTES
// ======================================
app.use((req, res, next) => {
  if (!db.get()) {
    return res.status(503).send('Service is starting. Please try again shortly.');
  }
  next();
});

app.use('/admin', adminGovernanceRouter);
app.use('/', adminGovernanceRouter);
app.use('/', usersRouter);
app.use('/teacher', teacherRouter);

// ======================================
// ERROR HANDLING
// ======================================

// 404
app.use((req, res, next) => {
  next(createError(404));
});

// error handler
app.use((err, req, res, next) => {
  // Only log full error in development (skip 404s to reduce noise)
  if (process.env.NODE_ENV !== 'production') {
    if (err.status !== 404) {
      console.log('APP ERROR:', err.message);
    }
  }

  res.locals.message = err.message;
  // Serialize error to a plain object so Handlebars can access 'status'
  // as an own property (http-errors puts 'status' on the prototype,
  // which triggers Handlebars' prototype-access security warning).
  const status = err.status || err.statusCode || 500;
  res.locals.error =
    req.app.get('env') === 'development'
      ? { status, stack: err.stack }
      : { status };

  res.status(status);
  res.render('error');
});


// ======================================
// EXPORT
// ======================================
module.exports = app;
