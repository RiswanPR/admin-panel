const cloudinary = require('cloudinary').v2;

const cloudinaryConfig = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
};

if (Object.values(cloudinaryConfig).every(Boolean)) {
    cloudinary.config(cloudinaryConfig);
}

module.exports = cloudinary;
