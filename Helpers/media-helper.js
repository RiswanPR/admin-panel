const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const { deleteFromS3, extractPathFromUrl } = require('../config/s3-storage');
const { decorateCoverImage } = require('./image-url-helper');

module.exports = {

    addCoverImage: async (data, imageUrl, adminId) => {
        try {
            if (!ObjectId.isValid(adminId)) {
                throw new Error("Invalid admin");
            }

            const coverImage = {
                title: String(data.title || '').trim(),
                category: String(data.category || 'General').trim(),
                image: imageUrl, // Firebase URL
                status: true,
                createdBy: new ObjectId(adminId),
                createdAt: new Date(),
                updatedAt: new Date()
            };

            const result = await db.get()
                .collection(collection.COVER_IMAGES_COLLECTION)
                .insertOne(coverImage);
                
            return result.insertedId;
        } catch (err) {
            throw err;
        }
    },

    getCoverImages: async (query = {}) => {
        try {
            const filter = {};
            if (query.status !== undefined) {
                filter.status = query.status === 'true' || query.status === true;
            }
            if (query.category && query.category !== 'All') {
                filter.category = query.category;
            }
            if (query.search) {
                filter.title = {
                    $regex: String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    $options: 'i'
                };
            }

            const images = await db.get()
                .collection(collection.COVER_IMAGES_COLLECTION)
                .find(filter)
                .sort({ createdAt: -1 })
                .toArray();

            await Promise.all(images.map(decorateCoverImage));
            return images;
        } catch (err) {
            throw err;
        }
    },

    getCoverImageById: async (id) => {
        try {
            if (!ObjectId.isValid(id)) return null;

            const image = await db.get()
                .collection(collection.COVER_IMAGES_COLLECTION)
                .findOne({ _id: new ObjectId(id) });

            return decorateCoverImage(image);
        } catch (err) {
            throw err;
        }
    },

    updateCoverImage: async (id, data) => {
        try {
            if (!ObjectId.isValid(id)) {
                throw new Error("Invalid cover image");
            }

            const updateFields = {
                updatedAt: new Date()
            };

            if (data.title) updateFields.title = String(data.title).trim();
            if (data.category) updateFields.category = String(data.category).trim();
            if (data.status !== undefined) updateFields.status = data.status === 'true' || data.status === true;

            await db.get()
                .collection(collection.COVER_IMAGES_COLLECTION)
                .updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );

            return true;
        } catch (err) {
            throw err;
        }
    },

    deleteCoverImage: async (id) => {
        try {
            if (!ObjectId.isValid(id)) {
                throw new Error("Invalid cover image");
            }

            const image = await db.get()
                .collection(collection.COVER_IMAGES_COLLECTION)
                .findOne({ _id: new ObjectId(id) });

            if (!image) {
                throw new Error("Cover Image not found");
            }

            if (image.image) {
                const storagePath = extractPathFromUrl(image.image);
                if (storagePath) await deleteFromS3(storagePath);
            }

            await db.get()
                .collection(collection.COVER_IMAGES_COLLECTION)
                .deleteOne({ _id: new ObjectId(id) });

            return true;
        } catch (err) {
            throw err;
        }
    }
};
