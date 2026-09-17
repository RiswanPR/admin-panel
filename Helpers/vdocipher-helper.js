const dns = require('dns');

dns.setServers([
  '8.8.8.8',
  '1.1.1.1'
]);
const axios = require('axios'); 
const FormData = require('form-data');
const fs = require('fs');
const http = require('http');
const https = require('https');

const API_SECRET =
  String(
    process.env.VDOCIPHER_API_SECRET || ''
  ).trim();

const API_URL =
  'https://dev.vdocipher.com/api/videos';


// =========================
// AXIOS CLIENT
// =========================
const client = axios.create({
  timeout: 0,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  httpAgent: new http.Agent({
    keepAlive: true,
    maxSockets: 10
  }),
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: 10
  })
});


// =========================
// INTERNAL UPLOAD
// =========================
async function uploadToS3(
  uploadLink,
  clientPayload,
  filePath
) {
  const form = new FormData();

  // VdoCipher payload
  Object.entries(clientPayload).forEach(
    ([key, value]) => {
      if (key !== 'uploadLink') {
        form.append(key, value);
      }
    }
  );

  // REQUIRED S3 policy fields
  form.append(
    'success_action_status',
    '201'
  );

  form.append(
    'success_action_redirect',
    ''
  );

  // file — provide knownLength so the multipart Content-Length
  // header is accurate; some S3 POST policies reject chunked
  // transfer-encoding for large files without it.
  const fileStats = fs.statSync(filePath);
  const stream =
    fs.createReadStream(filePath);

  form.append(
    'file',
    stream,
    { knownLength: fileStats.size }
  );

  try {

    await client.post(
      uploadLink,
      form,
      {
        headers: form.getHeaders()
      }
    );

    return true;

  } finally {
    stream.destroy();
  }
}
module.exports = {

  // =========================
  // UPLOAD VIDEO
  // =========================
  uploadVideo: async (
    filePath,
    title
  ) => {
    try {

      if (!API_SECRET) {
        throw new Error(
          'VDOCIPHER_API_SECRET missing'
        );
      }



      // create upload session
      const createRes =
        await client.put(
          API_URL,
          null,
          {
            params: { title },
            headers: {
              Authorization:
                `Apisecret ${API_SECRET}`
            }
          }
        );

      const data = createRes.data;

      const videoId =
        data.videoId;

      const clientPayload =
        data.clientPayload;

      const uploadLink =
        clientPayload?.uploadLink;

      if (!videoId) {
        throw new Error(
          'Video ID missing'
        );
      }

      if (!uploadLink) {
        throw new Error(
          'Upload URL missing'
        );
      }



      // upload
      try {
        await uploadToS3(
          uploadLink,
          clientPayload,
          filePath
        );
      } catch (err) {

        // retry once on transient network errors
        const isTransient =
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT');

        if (isTransient) {
          console.warn('⚠️ VdoCipher upload transient error, retrying in 2s:', err.code || err.message);
          await new Promise(r => setTimeout(r, 2000));
          await uploadToS3(
            uploadLink,
            clientPayload,
            filePath
          );
        } else {
          throw err;
        }
      }



      return {
        success: true,
        videoId
      };

    } catch (err) {
      console.error(
        '❌ VdoCipher Upload Error:',
        err.response?.data ||
        err.message
      );

      return {
        success: false,
        error:
          err.response?.data?.message ||
          err.message
      };
    }
  },


  // =========================
  // DELETE VIDEO
  // =========================
deleteVideo: async (videoId) => {
    try {

        if (!videoId) return true;

        const response = await client.delete(
            API_URL,
            {
                params: {
                    videos: videoId
                },
                headers: {
                    Accept: 'application/json',
                    Authorization:
                        `Apisecret ${API_SECRET}`,
                    'Content-Type':
                        'application/json'
                }
            }
        );



        return true;

    } catch (err) {
        console.error(
            '❌ VdoCipher Delete Error:',
            err.response?.data || err.message
        );

        return false;
    }
},

  getVideoInfo: async (videoId) => {
    try {
      if (!videoId || !API_SECRET) return null;

      const response = await client.get(
        `${API_URL}/${videoId}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `Apisecret ${API_SECRET}`,
          },
        }
      );

      return response.data || null;
    } catch (err) {
      console.warn('⚠️ VdoCipher getVideoInfo:', err.response?.data?.message || err.message);
      return null;
    }
  },

  // =========================
  // GET VIDEO DOWNLOAD STREAM
  // =========================
  /**
   * Get a downloadable video stream from VdoCipher.
   * Generates an OTP, decodes playbackInfo to extract the
   * actual CDN video URL, then returns a readable stream.
   *
   * @param {string} videoId - VdoCipher video ID
   * @returns {Promise<{stream: Readable, contentType: string}|null>}
   */
  getVideoDownloadStream: async (videoId) => {
    try {
      if (!videoId || !API_SECRET) return null;

      // 1. Fetch file list for the video from VdoCipher API
      const filesUrl = `${API_URL}/${videoId}/files`;
      const filesResponse = await client.get(filesUrl, {
        headers: {
          Authorization: `Apisecret ${API_SECRET}`,
          Accept: 'application/json',
        },
      });

      const files = filesResponse.data;
      if (!Array.isArray(files) || files.length === 0) {
        return null;
      }

      // 2. Find original/downloadable video file
      let targetFile = files.find(f => f.encryption_type === 'original' && f.isDownloadable);

      if (!targetFile) {
        // Fall back to any downloadable file with a video codec or original type
        const videoFiles = files.filter(f => f.isDownloadable && (f.video_codec || f.encryption_type === 'original'));
        if (videoFiles.length > 0) {
          videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
          targetFile = videoFiles[0];
        }
      }

      if (!targetFile || !targetFile.id) {
        return null;
      }

      // 3. Request presigned download URL for the target file
      const fileDetailUrl = `${API_URL}/${videoId}/files/${targetFile.id}`;
      const fileDetailRes = await client.get(fileDetailUrl, {
        headers: {
          Authorization: `Apisecret ${API_SECRET}`,
          Accept: 'application/json',
        },
      });

      const downloadUrl = fileDetailRes.data?.redirect || fileDetailRes.data?.url;
      if (!downloadUrl) {
        return null;
      }

      // 4. Stream video file from presigned URL
      const dlResponse = await axios.get(downloadUrl, {
        responseType: 'stream',
        timeout: 0,
      });

      return {
        stream: dlResponse.data,
        contentType: dlResponse.headers['content-type'] || 'video/mp4',
      };
    } catch (err) {
      console.warn(`⚠️ VdoCipher download stream error (${videoId}):`, err.response?.data?.message || err.message);
      return null;
    }
  },

};