require('dotenv').config();

var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var session = require('express-session');
var exphbs = require('express-handlebars');
var helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

var usersRouter = require('./routes/users');
var teacherRouter = require('./routes/teacher');
var db = require('./config/connection');

// CRON
const cron = require('node-cron');
const studentHelper = require('./Helpers/student-helper');
const { ensureIndexes } = require('./Helpers/index-helper');

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

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

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

// static files
app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

// ── SESSION ──
const isProduction = process.env.NODE_ENV === 'production';
const MongoStore = require('connect-mongo').default;

app.use(
  session({
    name: 'zeitnah.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URL,
      collectionName: 'sessions',
      ttl: 24 * 60 * 60 // 1 day
    }),
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
      ensureIndexes(db.get()).catch((indexErr) => {
        console.warn('⚠️ Database index setup warning:', indexErr.message);
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
  res.locals.error =
    req.app.get('env') === 'development'
      ? err
      : {};

  res.status(err.status || 500);
  res.render('error');
});


// ======================================
// EXPORT
// ======================================
module.exports = app;
