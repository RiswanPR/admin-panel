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

};