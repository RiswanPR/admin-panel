/**
 * Multer configuration.
 *
 * All IMAGE uploaders and the EXERCISE uploader now use memoryStorage —
 * files land in req.file.buffer and are uploaded directly to Amazon S3.
 * No local copies are written.
 *
 * The VIDEO uploader still uses diskStorage (temp/videos) because
 * VdoCipher requires a local file path to upload.
 */

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');


// ===============================
// ENSURE TEMP VIDEO FOLDER
// (still needed for VdoCipher uploads)
// ===============================
const ensureFolder = (folder) => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
};

ensureFolder('./temp/videos');


// ===============================
// FILE NAME GENERATOR
// ===============================
const makeName = (file) => {
    const ext = path.extname(file.originalname);
    return Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
};


// ===============================
// FILTERS
// ===============================
const imageFilter = (req, file, cb) => {
    const allowed  = /jpg|jpeg|png|webp/i;
    const ext      = path.extname(file.originalname).replace('.', '').toLowerCase();
    const validMime = file.mimetype.startsWith('image/');

    if (allowed.test(ext) && validMime) return cb(null, true);
    cb(new Error('Only JPG, JPEG, PNG, WEBP allowed'));
};

const videoFilter = (req, file, cb) => {
    const allowed  = /mp4|mov/i;
    const ext      = path.extname(file.originalname).replace('.', '').toLowerCase();
    const validMime = file.mimetype === 'video/mp4' || file.mimetype === 'video/quicktime';

    if (allowed.test(ext) && validMime) return cb(null, true);
    cb(new Error('Only MP4 and MOV video files are allowed'));
};

const exerciseFilter = (req, file, cb) => {
    const allowed = /pdf|xls|xlsx|dwg|zip/i;
    const ext     = path.extname(file.originalname).replace('.', '').toLowerCase();

    if (allowed.test(ext)) return cb(null, true);
    cb(new Error('Only PDF / Excel / DWG / ZIP allowed'));
};


// ===============================
// MEMORY STORAGE (images & exercises → S3)
// ===============================
const memStorage = multer.memoryStorage();


// ===============================
// IMAGE UPLOADERS (memory → S3)
// ===============================
const makeImageUploader = () => multer({
    storage:    memStorage,
    fileFilter: imageFilter,
    limits:     { fileSize: 5 * 1024 * 1024 }  // 5 MB
});

const uploadCourse   = makeImageUploader();
const uploadChapter  = makeImageUploader();
const uploadStudent  = makeImageUploader();
const uploadTeacher  = makeImageUploader();
const uploadThumbnail = makeImageUploader();


// ===============================
// VIDEO UPLOAD (disk → VdoCipher)
// ===============================
const uploadVideo = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, './temp/videos'),
        filename:    (req, file, cb) => cb(null, makeName(file))
    }),
    fileFilter: videoFilter,
    limits: { fileSize: 5 * 1024 * 1024 * 1024 }  // 5 GB
});


// ===============================
// EXERCISE UPLOAD (memory → S3)
// ===============================
const uploadExercise = multer({
    storage:    memStorage,
    fileFilter: exerciseFilter,
    limits:     { fileSize: 100 * 1024 * 1024 }  // 100 MB
});


// ===============================
// CLASS UPLOAD (thumbnail → memory/S3, video → disk/VdoCipher)
// ===============================
const uploadClass = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            // Only video goes to disk; thumbnail goes through memory.
            // However multer can only use ONE storage engine per instance.
            // We use diskStorage and handle thumbnail upload in the route.
            if (file.fieldname === 'thumbnail') {
                cb(null, './temp/videos');   // temp only; route uploads to S3 then deletes
            } else {
                cb(null, './temp/videos');
            }
        },
        filename: (req, file, cb) => cb(null, makeName(file))
    }),

    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'thumbnail') return imageFilter(req, file, cb);
        if (file.fieldname === 'video')     return videoFilter(req, file, cb);
        cb(new Error('Invalid field'));
    },

    limits: { fileSize: 5 * 1024 * 1024 * 1024 }  // 5 GB
});


const uploadCover = makeImageUploader();


// ===============================
// EXPORTS
// ===============================
module.exports = {
    uploadCourse,
    uploadChapter,
    uploadStudent,
    uploadTeacher,
    uploadThumbnail,
    uploadVideo,
    uploadExercise,
    uploadCover,
    uploadClass
};