const db = require('../config/connection');
const collection = require('../config/collections');
const { ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { deleteFromS3, extractPathFromUrl, uploadFileToS3 } = require('../config/s3-storage');
const { decorateChapter } = require('./image-url-helper');

const vdocipherHelper = require('./vdocipher-helper');

module.exports = {

    // =================================
    // ADD CLASS
    // =================================
    addClass: async (data, files) => {
        try {

            // files.thumbnailUrl is the Firebase URL (set by route after upload)
            // files.video[0] is the multer disk file for VdoCipher
            if (!data.thumbnailUrl) {
                throw new Error('Thumbnail is required');
            }

            if (!files?.video?.[0]) {
                throw new Error('Video is required');
            }

            if (!data.chapterId || !String(data.title || '').trim()) {
                throw new Error('Class title and chapter are required');
            }

            const targetCourse = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({ "chapters.uniqueCode": data.chapterId });

            if (!targetCourse) {
                throw new Error('Chapter not found');
            }

            const thumbnail = data.thumbnailUrl;   // Firebase URL
            const videoPath = files.video[0].path;
            const courseType = data.courseType || 'recording';

            let videoId = null;
            let videoUrl = null;
            let videoSource = 'vdocipher';

            if (courseType === 'online') {
                // ─── ONLINE COURSE → Upload to Amazon S3 ───

                const ext = path.extname(files.video[0].originalname) || '.mp4';
                const destPath = `classes/videos/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
                const mimeType = files.video[0].mimetype || 'video/mp4';

                videoUrl = await uploadFileToS3(videoPath, destPath, mimeType);
                videoSource = 's3';

            } else {
                // ─── RECORDING COURSE → Upload to VdoCipher ───
                const uploadRes = await vdocipherHelper.uploadVideo(
                    videoPath,
                    data.title
                );

                if (!uploadRes.success) {
                    throw new Error(
                        uploadRes.error ||
                        'Video upload failed'
                    );
                }

                videoId = uploadRes.videoId;
                videoSource = 'vdocipher';
            }

            // remove temp uploaded video
            if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
            }

            const chapter = targetCourse.chapters.find(ch => ch.uniqueCode === data.chapterId);
            const classesCount = (chapter && chapter.classes) ? chapter.classes.length : 0;

            // Ensure duration is stored as number (seconds)
            let durationSeconds = Number(data.duration) || 0;

            const newClass = {
                _id: new ObjectId(),
                title: data.title,
                order: classesCount + 1,
                duration: durationSeconds,
                description: data.description,
                thumbnail,             // Firebase URL
                videoId,               // VdoCipher ID (null for online)
                videoUrl,              // S3 URL (null for recording)
                videoSource,           // 'vdocipher' or 's3'
                createdAt: new Date(),
                exercises: []
            };

            const result = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .updateOne(
                    {
                        "chapters.uniqueCode":
                            data.chapterId
                    },
                    {
                        $push: {
                            "chapters.$.classes":
                                newClass
                        }
                    }
                );

            if (!result.modifiedCount) {
                throw new Error('Chapter not found');
            }

            return {
                success: true
            };

        } catch (err) {
            console.error(
                'Add Class Error:',
                err.message
            );

            // If thumbnail was uploaded to Firebase but class save failed,
            // we keep the Firebase file (orphan cleanup can be done separately).
            // Delete temp video if it still exists
            if (files?.video?.[0]) {
                const tempVideo = files.video[0].path;
                if (fs.existsSync(tempVideo)) {
                    fs.unlinkSync(tempVideo);
                }
            }

            return {
                success: false,
                error: err.message
            };
        }
    },


    // =================================
    // DELETE CLASS
    // =================================
    deleteClass: async (chapterCode, classId) => {
        try {
            if (!ObjectId.isValid(classId)) return false;

            const course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({
                    "chapters.uniqueCode":
                        chapterCode
                });

            if (!course) return false;

            let classData = null;

            course.chapters.forEach(
                (chapter) => {
                    if (
                        chapter.uniqueCode ===
                        chapterCode
                    ) {
                        classData =
                            chapter.classes?.find(
                                c =>
                                    String(c._id) ===
                                    String(classId)
                            );
                    }
                }
            );

            if (!classData) return false;

            // delete video based on source
            if (classData.videoSource === 's3' && classData.videoUrl) {
                // ─── DELETE from S3 ───
                try {
                    const storagePath = extractPathFromUrl(classData.videoUrl);
                    if (storagePath) await deleteFromS3(storagePath);
                } catch (e) {
                    console.warn('⚠️ Could not delete class video from S3:', e.message);
                }
            } else if (classData.videoId) {
                // ─── DELETE from VdoCipher ───
                await vdocipherHelper.deleteVideo(
                    classData.videoId
                );
            }

            // delete thumbnail from Firebase
            if (classData.thumbnail) {
                try {
                    const storagePath = extractPathFromUrl(classData.thumbnail);
                    if (storagePath) await deleteFromS3(storagePath);
                } catch (e) {
                    console.warn('⚠️ Could not delete class thumbnail from Firebase:', e.message);
                }
            }

            // delete exercises from S3
            if (classData.exercises && Array.isArray(classData.exercises)) {
                for (const exercise of classData.exercises) {
                    if (exercise.file) {
                        try {
                            const storagePath = extractPathFromUrl(exercise.file);
                            if (storagePath) await deleteFromS3(storagePath);
                        } catch (e) {
                            console.warn('⚠️ Could not delete exercise file from S3:', e.message);
                        }
                    }
                }
            }

            // remove from DB
            await db.get()
                .collection(collection.COURSE_COLLECTION)
                .updateOne(
                    {
                        "chapters.uniqueCode":
                            chapterCode
                    },
                    {
                        $pull: {
                            "chapters.$.classes": {
                                _id: new ObjectId(classId)
                            }
                        }
                    }
                );

            return true;

        } catch (err) {
            console.error(
                'Delete Class Error:',
                err.message
            );

            return false;
        }
    },


    // =================================
    // GET CHAPTER CLASSES
    // =================================
    getChapterClasses: async (chapterCode) => {
        try {

            const course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({
                    "chapters.uniqueCode":
                        chapterCode
                });

            if (!course) return null;

            const chapter =
                course.chapters.find(
                    ch =>
                        ch.uniqueCode ===
                        chapterCode
                );

            if (!chapter) return null;

            if (!chapter.classes) {
                chapter.classes = [];
            }

            chapter.classes.sort(
                (a, b) =>
                    (a.order || 0) -
                    (b.order || 0)
            );

            return decorateChapter(chapter);

        } catch (err) {
            console.error(
                'getChapterClasses Error:',
                err.message
            );

            return null;
        }
    },
    updateClassesOrder: async (chapterCode, classIds) => {
        try {
            const course = await db.get().collection(collection.COURSE_COLLECTION).findOne({
                'chapters.uniqueCode': chapterCode
            });
            if (!course) throw new Error('Chapter not found');

            const chapterIdx = course.chapters.findIndex(ch => ch.uniqueCode === chapterCode);
            if (chapterIdx === -1) throw new Error('Chapter not found');

            const chapter = course.chapters[chapterIdx];
            const classMap = {};
            (chapter.classes || []).forEach(cl => {
                classMap[String(cl._id)] = cl;
            });

            const newClasses = [];
            classIds.forEach((id, idx) => {
                if (classMap[id]) {
                    const cl = classMap[id];
                    cl.order = idx + 1;
                    newClasses.push(cl);
                }
            });

            // fallback for missing classes
            (chapter.classes || []).forEach(cl => {
                if (!classIds.includes(String(cl._id))) {
                    cl.order = newClasses.length + 1;
                    newClasses.push(cl);
                }
            });

            const updatePath = `chapters.${chapterIdx}.classes`;
            await db.get().collection(collection.COURSE_COLLECTION).updateOne(
                { _id: course._id },
                { $set: { [updatePath]: newClasses } }
            );
            return true;
        } catch (err) {
            console.error('updateClassesOrder Error:', err.message);
            throw err;
        }
    },

    getClass: async (chapterCode, classId) => {
        try {
            const course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({ "chapters.uniqueCode": chapterCode });

            if (!course) return null;

            const chapter = course.chapters.find(ch => ch.uniqueCode === chapterCode);
            if (!chapter) return null;

            const classData = (chapter.classes || []).find(c => String(c._id) === String(classId));
            if (!classData) return null;

            const { decorateClass } = require('./image-url-helper');
            return await decorateClass(classData);
        } catch (err) {
            console.error('getClass error:', err);
            return null;
        }
    },

    updateClass: async (chapterCode, classId, data, files) => {
        try {
            if (!String(data.title || '').trim()) {
                throw new Error('Class title is required');
            }

            const course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({ "chapters.uniqueCode": chapterCode });

            if (!course) throw new Error('Course not found');

            const chapterIdx = course.chapters.findIndex(ch => ch.uniqueCode === chapterCode);
            if (chapterIdx === -1) throw new Error('Chapter not found');

            const chapter = course.chapters[chapterIdx];
            const classIdx = (chapter.classes || []).findIndex(c => String(c._id) === String(classId));
            if (classIdx === -1) throw new Error('Class not found');

            const existingClass = chapter.classes[classIdx];
            const courseType = data.courseType || 'recording';

            let newThumbnail = data.thumbnailUrl || existingClass.thumbnail;
            
            // Video update logic if provided
            if (files?.video?.[0]) {
                const videoPath = files.video[0].path;
                
                if (courseType === 'online') {
                    // Upload to S3
                    const videoExt = path.extname(files.video[0].originalname) || '.mp4';
                    const videoDest = `class-videos/${new ObjectId().toString()}${videoExt}`;
                    const uploadedKey = await uploadFileToS3(videoPath, videoDest, files.video[0].mimetype);
                    existingClass.videoUrl = uploadedKey;
                    existingClass.videoId = null;
                    existingClass.videoSource = 's3';
                } else {
                    // Upload to Vdocipher
                    const vdoResponse = await vdocipherHelper.uploadVideo(videoPath, data.title);
                    existingClass.videoId = vdoResponse.videoId;
                    existingClass.videoUrl = null;
                    existingClass.videoSource = 'vdocipher';
                }
                
                if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            }
            
            existingClass.title = data.title;
            existingClass.description = data.description;
            existingClass.thumbnail = newThumbnail;

            const updatePath = `chapters.${chapterIdx}.classes.${classIdx}`;
            
            await db.get().collection(collection.COURSE_COLLECTION).updateOne(
                { _id: course._id },
                { $set: { [updatePath]: existingClass } }
            );

            return true;
        } catch (err) {
            console.error('updateClass Error:', err.message);
            throw err;
        }
    }
};
