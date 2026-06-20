/**
 * Amazon S3 Storage helpers.
 *
 * uploadToS3(buffer, destPath, mimeType)
 *   → uploads buffer to S3
 *   → makes the file publicly readable (or accessible via bucket policy)
 *   → returns the permanent public download URL
 *
 * deleteFromS3(destPath)
 *   → deletes a file from S3 (silently ignores "not found")
 */

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

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

/**
 * Upload a Buffer to Amazon S3.
 *
 * @param {Buffer} buffer     - file data
 * @param {string} destPath   - storage path, e.g. "course-images/abc123.jpg"
 * @param {string} mimeType   - MIME type, e.g. "image/jpeg"
 * @returns {Promise<string>} public download URL
 */
const uploadToS3 = async (buffer, destPath, mimeType) => {
  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: destPath,
        Body: buffer,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000',
        // ACL: 'public-read' // Uncomment if your bucket allows ACLs
      },
    });

    await upload.done();

    // Build the permanent public URL
    const publicUrl = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(destPath).replace(/%2F/g, '/')}`;
    return publicUrl;
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
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: destPath,
    });
    await s3Client.send(command);
  } catch (err) {
    console.warn('S3 delete warning:', err.message);
  }
};

/**
 * Extract the storage path from an S3 public URL.
 * Returns null if the URL is not an S3 URL for this bucket.
 *
 * @param {string} url
 * @returns {string|null}
 */
const extractPathFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  try {
    const prefix = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/`;
    if (url.startsWith(prefix)) {
      return decodeURIComponent(url.slice(prefix.length));
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Upload a local file to Amazon S3 using streaming (for large files like videos).
 *
 * @param {string} filePath   - absolute path to the local file
 * @param {string} destPath   - storage path, e.g. "class-videos/abc123.mp4"
 * @param {string} mimeType   - MIME type, e.g. "video/mp4"
 * @returns {Promise<string>} public download URL
 */
const fs = require('fs');

const uploadFileToS3 = async (filePath, destPath, mimeType) => {
  try {
    const fileStream = fs.createReadStream(filePath);

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: destPath,
        Body: fileStream,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000',
      },
    });

    await upload.done();
    fileStream.destroy();

    const publicUrl = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(destPath).replace(/%2F/g, '/')}`;
    return publicUrl;
  } catch (err) {
    throw err;
  }
};

module.exports = {
  uploadToS3,
  uploadFileToS3,
  deleteFromS3,
  extractPathFromUrl,
};
