/**
 * Course Backup Helper
 *
 * Downloads an entire course as a ZIP file with the folder hierarchy:
 *   CourseName/
 *   ├── course-image.{ext}
 *   ├── manifest.json
 *   ├── ChapterTitle/
 *   │   ├── chapter-image.{ext}
 *   │   ├── ClassTitle/
 *   │   │   ├── thumbnail.{ext}
 *   │   │   ├── video.mp4            (S3 videos only)
 *   │   │   ├── video-info.json      (VdoCipher metadata)
 *   │   │   ├── ExerciseTitle/
 *   │   │   │   └── exercise-file.{ext}
 *
 * - S3 assets are streamed directly into the archive (no temp files).
 * - VdoCipher (DRM) videos cannot be downloaded as raw files;
 *   a video-info.json with metadata is included instead.
 */

const archiver = require('archiver');
const path = require('path');
const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const { getS3ObjectStream, extractPathFromUrl } = require('../config/s3-storage');
const vdocipherHelper = require('./vdocipher-helper');

// ─── Helpers ──────────────────────────────────────────────

/**
 * Sanitize a name for use as a filesystem folder/file name.
 * Removes characters that are unsafe in file paths.
 */
const sanitizeName = (name) => {
  if (!name || typeof name !== 'string') return 'Untitled';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')   // Remove illegal FS chars
    .replace(/\.{2,}/g, '.')                   // Collapse dots
    .replace(/\s+/g, ' ')                      // Collapse whitespace
    .trim()
    || 'Untitled';
};

/**
 * Extract file extension from an S3 key or URL.
 * Falls back to the provided default.
 */
const getExtFromKey = (key, fallback = '') => {
  if (!key || typeof key !== 'string') return fallback;

  // Try the S3 object key first
  const objKey = extractPathFromUrl(key);
  if (objKey) {
    const ext = path.extname(objKey).toLowerCase();
    if (ext) return ext;
  }

  // Try the raw value
  try {
    const ext = path.extname(new URL(key).pathname).toLowerCase();
    if (ext) return ext;
  } catch {
    const ext = path.extname(key).toLowerCase();
    if (ext) return ext;
  }

  return fallback;
};

/**
 * Append a readable stream to the archive and wait for the entry to finish.
 * Ensures sequential streaming for large video files without memory accumulation.
 */
const appendStreamFile = (archive, stream, archivePath) => {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      if (entry.name === archivePath) {
        cleanup();
        resolve(true);
      }
    };
    const onError = (err) => {
      cleanup();
      console.warn(`⚠️ Backup: error writing entry "${archivePath}":`, err.message);
      resolve(false);
    };
    const cleanup = () => {
      archive.removeListener('entry', onEntry);
      archive.removeListener('error', onError);
    };

    archive.on('entry', onEntry);
    archive.on('error', onError);
    archive.append(stream, { name: archivePath });
  });
};

/**
 * Append an S3-stored file to the archive.
 * Returns true if the file was successfully appended.
 */
const appendS3File = async (archive, s3Key, archivePath) => {
  if (!s3Key) return false;

  try {
    const result = await getS3ObjectStream(s3Key);
    if (!result || !result.stream) return false;

    return await appendStreamFile(archive, result.stream, archivePath);
  } catch (err) {
    console.warn(`⚠️ Backup: could not stream S3 file "${s3Key}":`, err.message);
    return false;
  }
};

// ─── Main Export ──────────────────────────────────────────

/**
 * Stream a course backup as a ZIP directly to the Express response.
 *
 * @param {string} courseId  - MongoDB ObjectId string
 * @param {import('express').Response} res - Express response
 */
const downloadCourseBackup = async (courseId, res) => {
  // 1. Fetch the raw course document (no URL decoration)
  const course = await db.get()
    .collection(collection.COURSE_COLLECTION)
    .findOne({ _id: new ObjectId(courseId) });

  if (!course) {
    throw new Error('Course not found');
  }

  const courseName = sanitizeName(course.name);
  const zipFileName = `${courseName}-backup.zip`;

  // 2. Set response headers for ZIP download
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(zipFileName)}"`
  );

  // 3. Create archive and pipe to response
  const archive = archiver('zip', { zlib: { level: 5 } });

  archive.on('error', (err) => {
    console.error('❌ Archive error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Backup failed' });
    }
  });

  archive.on('warning', (err) => {
    console.warn('⚠️ Archive warning:', err.message);
  });

  archive.pipe(res);

  // 4. Course-level image
  if (course.image) {
    const ext = getExtFromKey(course.image, '.jpg');
    await appendS3File(archive, course.image, `${courseName}/course-image${ext}`);
  }

  // 5. Walk chapters → classes → exercises
  const chapters = (course.chapters || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  let totalClasses = 0;
  let totalExercises = 0;
  let totalFiles = 0;

  for (let chIdx = 0; chIdx < chapters.length; chIdx++) {
    const chapter = chapters[chIdx];
    const chapterName = sanitizeName(chapter.title || chapter.name);
    const chapterPath = `${courseName}/${String(chIdx + 1).padStart(2, '0')}-${chapterName}`;

    // Chapter image
    if (chapter.imageName) {
      const ext = getExtFromKey(chapter.imageName, '.jpg');
      const ok = await appendS3File(archive, chapter.imageName, `${chapterPath}/chapter-image${ext}`);
      if (ok) totalFiles++;
    }

    const classes = (chapter.classes || []).sort((a, b) => (a.order || 0) - (b.order || 0));

    for (let clIdx = 0; clIdx < classes.length; clIdx++) {
      const classData = classes[clIdx];
      const className = sanitizeName(classData.title);
      const classPath = `${chapterPath}/${String(clIdx + 1).padStart(2, '0')}-${className}`;
      totalClasses++;

      // Class thumbnail
      if (classData.thumbnail) {
        const ext = getExtFromKey(classData.thumbnail, '.jpg');
        const ok = await appendS3File(archive, classData.thumbnail, `${classPath}/thumbnail${ext}`);
        if (ok) totalFiles++;
      }

      // Class video
      if (classData.videoSource === 's3' && classData.videoUrl) {
        // ─── S3 video: stream directly ───
        const ext = getExtFromKey(classData.videoUrl, '.mp4');
        const ok = await appendS3File(archive, classData.videoUrl, `${classPath}/video${ext}`);
        if (ok) totalFiles++;
      } else if (classData.videoId) {
        // ─── VdoCipher video: try to download, fall back to metadata ───
        let videoDownloaded = false;

        try {
          const videoStream = await vdocipherHelper.getVideoDownloadStream(classData.videoId);
          if (videoStream && videoStream.stream) {
            const ok = await appendStreamFile(archive, videoStream.stream, `${classPath}/video.mp4`);
            if (ok) {
              videoDownloaded = true;
              totalFiles++;
            }
          }
        } catch (err) {
          console.warn(`⚠️ Backup: VdoCipher download failed for ${classData.videoId}:`, err.message);
        }

        // Always include metadata, whether video was downloaded or not
        const videoInfo = await vdocipherHelper.getVideoInfo(classData.videoId);
        const metaJson = JSON.stringify({
          source: 'vdocipher',
          videoId: classData.videoId,
          title: classData.title,
          videoDownloaded,
          info: videoInfo || { note: 'Could not fetch video details' },
          note: videoDownloaded
            ? 'Video file was successfully downloaded and included in this backup.'
            : 'This video is DRM-protected on VdoCipher. The video file could not be downloaded programmatically. Use the VdoCipher dashboard (Config > Advanced) to download the original file manually.'
        }, null, 2);

        archive.append(metaJson, { name: `${classPath}/video-info.json` });
        if (!videoDownloaded) totalFiles++;
      }

      // Class exercises
      const exercises = classData.exercises || [];
      for (const exercise of exercises) {
        totalExercises++;
        const exName = sanitizeName(exercise.title);
        const exPath = `${classPath}/${exName}`;

        if (exercise.file) {
          const ext = getExtFromKey(exercise.file, '.pdf');
          const fileName = `${exName}${ext}`;
          const ok = await appendS3File(archive, exercise.file, `${exPath}/${fileName}`);
          if (ok) totalFiles++;
        }
      }
    }
  }

  // 6. Manifest file with course metadata
  const manifest = {
    backupVersion: '1.0',
    generatedAt: new Date().toISOString(),
    course: {
      id: String(course._id),
      name: course.name,
      type: course.type,
      accessType: course.accessType,
      fees: course.Total_Fees,
      description: course.description,
    },
    stats: {
      chapters: chapters.length,
      classes: totalClasses,
      exercises: totalExercises,
      filesIncluded: totalFiles,
    }
  };

  archive.append(JSON.stringify(manifest, null, 2), {
    name: `${courseName}/manifest.json`
  });

  // 7. Finalize — this will flush all remaining data and end the response
  await archive.finalize();
};

module.exports = {
  downloadCourseBackup,
};
