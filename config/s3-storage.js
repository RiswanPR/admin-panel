/**
 * Amazon S3 Storage helpers.
 *
 * uploadToS3(buffer, destPath, mimeType)
 *   → uploads buffer to S3 with the original content type
 *   → returns the S3 object key that should be stored in MongoDB
 *
 * deleteFromS3(destPath)
 *   → deletes a file from S3 (silently ignores "not found")
 */

const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

if (
  !process.env.AWS_REGION ||
  !process.env.AWS_ACCESS_KEY_ID ||
  !process.env.AWS_SECRET_ACCESS_KEY ||
  !process.env.AWS_S3_BUCKET_NAME
) {
  console.warn('⚠️ Missing AWS S3 environment variables. File uploads will fail.');
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.AWS_S3_BUCKET_NAME;
const bucketRegion = process.env.AWS_REGION;
const signedUrlExpiresIn = Number(process.env.AWS_S3_SIGNED_URL_EXPIRES || 60 * 60);
const isPublicBucket = String(process.env.AWS_S3_PUBLIC || process.env.AWS_S3_BUCKET_PUBLIC || '')
  .toLowerCase() === 'true';

const encodeS3Key = (key) => encodeURIComponent(key).replace(/%2F/g, '/');

const getPublicUrl = (key) => {
  if (!bucketName || !bucketRegion || !key) return null;
  return `https://${bucketName}.s3.${bucketRegion}.amazonaws.com/${encodeS3Key(key)}`;
};

const normalizeKey = (destPath) => String(destPath || '')
  .replace(/^\/+/, '')
  .replace(/\\/g, '/');

/**
 * Upload a Buffer to Amazon S3.
 *
 * @param {Buffer} buffer     - file data
 * @param {string} destPath   - storage path, e.g. "course-images/abc123.jpg"
 * @param {string} mimeType   - MIME type, e.g. "image/jpeg"
 * @returns {Promise<string>} S3 object key
 */
const uploadToS3 = async (buffer, destPath, mimeType) => {
  try {
    const key = normalizeKey(destPath);
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType || 'application/octet-stream',
        CacheControl: 'public, max-age=31536000',
      },
    });

    await upload.done();

    return key;
  } catch (err) {
    throw err;
  }
};

/**
 * Delete a file from Amazon S3 by its storage path.
 * Silently ignores "file not found" errors.
 *
 * @param {string} destPath  - e.g. "course-images/abc123.jpg"
 * @returns {Promise<void>}
 */
const deleteFromS3 = async (destPath) => {
  try {
    const key = extractPathFromUrl(destPath);
    if (!key) return;

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    await s3Client.send(command);
  } catch (err) {
    console.warn('S3 delete warning:', err.message);
  }
};

/**
 * Extract the storage path from an S3 URL or return an already-normalized key.
 * Returns null for non-S3 external URLs and local placeholder filenames.
 *
 * @param {string} url
 * @returns {string|null}
 */
const extractPathFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  try {
    const value = url.trim();

    if (!/^https?:\/\//i.test(value)) {
      const key = normalizeKey(value);
      if (!key || !key.includes('/')) return null;
      return key;
    }

    const parsed = new URL(value);
    const host = parsed.hostname;
    const pathname = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));

    if (host === `${bucketName}.s3.${bucketRegion}.amazonaws.com`) {
      return pathname;
    }

    if (host === `${bucketName}.s3.amazonaws.com`) {
      return pathname;
    }

    if (host === `s3.${bucketRegion}.amazonaws.com` || host === 's3.amazonaws.com') {
      const prefix = `${bucketName}/`;
      return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null;
    }

    return null;
  } catch {
    return null;
  }
};

const getSignedS3Url = async (key, expiresIn = signedUrlExpiresIn) => {
  const objectKey = extractPathFromUrl(key);
  if (!objectKey) return null;

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
  });

  return getSignedUrl(s3Client, command, { expiresIn });
};

const getS3ReadUrl = async (value, options = {}) => {
  if (!value || typeof value !== 'string') return null;
  const key = extractPathFromUrl(value);

  if (!key) {
    return /^https?:\/\//i.test(value) ? value : null;
  }

  if (isPublicBucket) {
    return getPublicUrl(key);
  }

  return getSignedS3Url(key, options.expiresIn);
};

/**
 * Upload a local file to Amazon S3 using streaming (for large files like videos).
 *
 * @param {string} filePath   - absolute path to the local file
 * @param {string} destPath   - storage path, e.g. "class-videos/abc123.mp4"
 * @param {string} mimeType   - MIME type, e.g. "video/mp4"
 * @returns {Promise<string>} S3 object key
 */
const fs = require('fs');

const uploadFileToS3 = async (filePath, destPath, mimeType) => {
  try {
    const fileStream = fs.createReadStream(filePath);
    const key = normalizeKey(destPath);

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: fileStream,
        ContentType: mimeType || 'application/octet-stream',
        CacheControl: 'public, max-age=31536000',
      },
    });

    await upload.done();
    fileStream.destroy();

    return key;
  } catch (err) {
    throw err;
  }
};

module.exports = {
  s3Client,
  bucketName,
  uploadToS3,
  uploadFileToS3,
  deleteFromS3,
  extractPathFromUrl,
  getPublicUrl,
  getSignedS3Url,
  getS3ReadUrl,
};
