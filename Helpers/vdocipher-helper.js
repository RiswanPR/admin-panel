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

  // file
  const stream =
    fs.createReadStream(filePath);

  form.append(
    'file',
    stream
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

        // retry once
        if (
          err.code === 'ECONNRESET' ||
          err.message.includes(
            'ECONNRESET'
          )
        ) {


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

      // 1. Generate OTP and playbackInfo
      const otpResponse = await client.post(
        `${API_URL}/${videoId}/otp`,
        { ttl: 300 },
        {
          headers: {
            Authorization: `Apisecret ${API_SECRET}`,
            Accept: 'application/json',
          },
        }
      );

      const { otp, playbackInfo } = otpResponse.data;
      if (!otp || !playbackInfo) {
        console.warn('⚠️ VdoCipher: No OTP or playbackInfo returned');
        return null;
      }

      // 2. Decode playbackInfo (base64 → JSON)
      let playbackData;
      try {
        const decoded = Buffer.from(playbackInfo, 'base64').toString('utf8');
        playbackData = JSON.parse(decoded);
      } catch {
        console.warn('⚠️ VdoCipher: Could not decode playbackInfo');
        return null;
      }

      // 3. Extract the video URL from playbackInfo
      //    playbackInfo typically has: { videoId, ... }
      //    The actual video is fetched via the embed URL with OTP
      //    We use the VdoCipher download endpoint pattern
      const videoUrl = `https://dev.vdocipher.com/api/videos/${videoId}/files`;

      // Try to get file list from VdoCipher API
      let downloadUrl = null;
      try {
        const filesResponse = await client.get(videoUrl, {
          headers: {
            Authorization: `Apisecret ${API_SECRET}`,
            Accept: 'application/json',
          },
        });

        // The files endpoint returns available renditions
        const files = filesResponse.data;
        if (Array.isArray(files) && files.length > 0) {
          // Pick the highest quality file
          const sorted = files.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          downloadUrl = sorted[0]?.file;
        }
      } catch {
        // files endpoint may not be available — fall back to OTP-based approach
      }

      // 4. If we got a download URL, stream it
      if (downloadUrl) {
        const dlResponse = await client.get(downloadUrl, {
          responseType: 'stream',
        });
        return {
          stream: dlResponse.data,
          contentType: dlResponse.headers['content-type'] || 'video/mp4',
        };
      }

      // 5. Fallback: try the player-based approach
      //    Construct the player URL and try to extract video source
      const playerUrl = `https://player.vdocipher.com/v2/?otp=${otp}&playbackInfo=${playbackInfo}`;

      // Attempt to fetch the player page and extract the actual video source URL
      try {
        const playerResponse = await client.get(playerUrl, {
          maxRedirects: 5,
        });

        const html = String(playerResponse.data || '');
        // Try to extract a direct video URL from the player page
        const urlMatch = html.match(/https:\/\/[^"'\s]+\.mp4[^"'\s]*/);
        if (urlMatch) {
          const videoStreamUrl = urlMatch[0];
          const streamResponse = await client.get(videoStreamUrl, {
            responseType: 'stream',
          });
          return {
            stream: streamResponse.data,
            contentType: streamResponse.headers['content-type'] || 'video/mp4',
          };
        }
      } catch {
        // Player-based approach failed
      }

      // 6. If all approaches fail, return null — video-info.json will be used as fallback
      return null;

    } catch (err) {
      return null;
    }
  },

};