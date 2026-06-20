
var db = require('../config/connection');
var collection = require('../config/collections');
const vdocipherHelper = require('./vdocipher-helper');
const { ObjectId } = require('mongodb');
const { deleteFromS3, extractPathFromUrl } = require('../config/s3-storage');
const {
    decorateCourse,
    decorateChapter,
    decorateClass,
    decorateExercise,
    decorateProfileImage
} = require('./image-url-helper');

// Helper to delete all S3 & VdoCipher assets associated with a chapter recursively
const deleteChapterFiles = async (chapter) => {
    // 1. Delete chapter cover image from S3
    if (chapter.imageName) {
        try {
            const storagePath = extractPathFromUrl(chapter.imageName);
            if (storagePath) {
                await deleteFromS3(storagePath);
            }
        } catch (e) {
            console.warn('⚠️ Could not delete chapter image from S3:', e.message);
        }
    }

    // 2. Delete classes and their videos, thumbnails, exercises
    if (chapter.classes && Array.isArray(chapter.classes)) {
        for (const classData of chapter.classes) {
            // video
            if (classData.videoSource === 's3' && classData.videoUrl) {
                try {
                    const storagePath = extractPathFromUrl(classData.videoUrl);
                    if (storagePath) {
                        await deleteFromS3(storagePath);
                    }
                } catch (e) {
                    console.warn('⚠️ Could not delete class video from S3:', e.message);
                }
            } else if (classData.videoId) {
                try {
                    await vdocipherHelper.deleteVideo(classData.videoId);
                } catch (e) {
                    console.warn('⚠️ Could not delete class video from VdoCipher:', e.message);
                }
            }

            // thumbnail
            if (classData.thumbnail) {
                try {
                    const storagePath = extractPathFromUrl(classData.thumbnail);
                    if (storagePath) {
                        await deleteFromS3(storagePath);
                    }
                } catch (e) {
                    console.warn('⚠️ Could not delete class thumbnail from S3:', e.message);
                }
            }

            // exercises
            if (classData.exercises && Array.isArray(classData.exercises)) {
                for (const exercise of classData.exercises) {
                    if (exercise.file) {
                        try {
                            const storagePath = extractPathFromUrl(exercise.file);
                            if (storagePath) {
                                await deleteFromS3(storagePath);
                            }
                        } catch (e) {
                            console.warn('⚠️ Could not delete exercise file from S3:', e.message);
                        }
                    }
                }
            }
        }
    }
};

module.exports = {

    addCourse: async (course) => {
        try {
            if (!String(course.name || '').trim()) {
                throw new Error('Course name is required');
            }
            const coursesCount = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .countDocuments();

            let data = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .insertOne({
                    name: String(course.name || '').trim(),
                    Total_Fees: Math.max(0, Number(course.Total_Fees) || 0),
                    accessType: course.accessType === 'paid' ? 'paid' : 'free',
                    type: course.type || 'online',
                    description: String(course.description || '').trim(),
                    order: coursesCount + 1,
                    chapters: [],
                    createdAt: new Date(),
                    updatedAt: new Date()
                });


            return data.insertedId; // 🔥 return instead of callback
        } catch (err) {
            throw err;
        }
    },


    // ✅ GET COURSES (UPDATED - FAST VERSION)
    getCourses: async () => {
        try {
            const courses = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .aggregate([
                    {
                        $addFields: {
                            _idString: { $toString: '$_id' }
                        }
                    },
                    {
                        $lookup: {
                            from: collection.STUDENTS_COLLECTION,
                            localField: '_idString',
                            foreignField: 'course.courseId',
                            as: 'enrolledStudents'
                        }
                    },
                    {
                        $addFields: {
                            studentCount: { $size: '$enrolledStudents' }
                        }
                    },
                    {
                        $project: {
                            enrolledStudents: 0,
                            _idString: 0
                        }
                    },
                    {
                        $sort: { order: 1, createdAt: -1 }
                    }
                ])
                .toArray();

            await Promise.all(courses.map(decorateCourse));
            return courses;

        } catch (err) {
            throw err;
        }
    },
    // imageUrl is the Firebase public URL returned by uploadToS3()
    updateCourseImage: async (id, imageUrl) => {
        try {

            await db.get().collection(collection.COURSE_COLLECTION).updateOne(
                { _id: new ObjectId(id) },
                { $set: { image: imageUrl } }
            );

        } catch (err) {
            throw err;
        }
    },
    deleteCourse: async (courseId) => {
        try {

            let course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({ _id: new ObjectId(courseId) });

            if (!course) {
                throw new Error("Course not found");
            }

            // ✅ DELETE ALL CHAPTERS & THEIR FILES FROM S3 / VDOCIPHER
            if (course.chapters && Array.isArray(course.chapters)) {
                for (const chapter of course.chapters) {
                    await deleteChapterFiles(chapter);
                }
            }

            // ✅ DELETE COURSE IMAGE FROM S3 (if it's an S3 URL)
            if (course.image) {
                const storagePath = extractPathFromUrl(course.image);
                if (storagePath) await deleteFromS3(storagePath);
            }

            // ✅ DELETE FROM DB
            await db.get()
                .collection(collection.COURSE_COLLECTION)
                .deleteOne({ _id: new ObjectId(courseId) });

            return true;

        } catch (err) {
            throw err;
        }
    },
    getCourseDetails: (courseId) => {
        return new Promise(async (resolve, reject) => {
            try {
                if (!ObjectId.isValid(courseId)) return resolve(null);

                let course = await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .findOne({
                        _id: new ObjectId(courseId)
                    });

                resolve(await decorateCourse(course));

            } catch (err) {
                reject(err);
            }
        });
    },
    updateCourse: (courseId, data) => {
        return new Promise(async (resolve, reject) => {
            try {
                if (!ObjectId.isValid(courseId)) {
                    throw new Error('Invalid course id');
                }

                await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .updateOne(
                        { _id: new ObjectId(courseId) },
                        {
                            $set: {
                                name: String(data.name || '').trim(),
                                Total_Fees: Math.max(0, Number(data.Total_Fees) || 0),
                                type: data.type,
                                accessType: data.accessType === 'paid' ? 'paid' : 'free',
                                description: String(data.description || '').trim(),
                                updatedAt: new Date()
                            }
                        }
                    );

                resolve();

            } catch (err) {
                reject(err);
            }
        });
    },
    getCourseChapters: (courseId) => {
        return new Promise(async (resolve, reject) => {
            try {
                if (!ObjectId.isValid(courseId)) {
                    return resolve({
                        courseName: "Course Chapters",
                        chapters: []
                    });
                }

                let course = await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .findOne({
                        _id: new ObjectId(courseId)
                    });

                if (!course) {
                    return resolve({
                        courseName: "Course Chapters",
                        chapters: []
                    });
                }

                // SORT CHAPTERS
                let chapters = (course.chapters || [])
                    .sort((a, b) => a.order - b.order);

                await Promise.all(chapters.map(decorateChapter));

                resolve({
                    courseName: course.name,
                    chapters
                });

            } catch (err) {
                reject(err);
            }
        });
    },

    // imageUrl is the Firebase public URL for the chapter image
    addChapter: async (chapter, imageUrl, uniqueCode) => {
        try {
            if (!ObjectId.isValid(chapter.package)) {
                throw new Error("Invalid course");
            }

            let course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({
                    _id: new ObjectId(chapter.package)
                });

            if (!course) {
                throw new Error("Course not found");
            }

            const chaptersCount = (course.chapters || []).length;

            let chapterObj = {
                package: course.name,
                title: chapter.title,
                order: chaptersCount + 1,
                description: chapter.description,
                imageName: imageUrl,   // stored as Firebase URL
                uniqueCode: uniqueCode,
                courseId: chapter.package,
                classes: []
            };

            let result = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .updateOne(
                    {
                        _id: new ObjectId(chapter.package)
                    },
                    {
                        $push: {
                            chapters: chapterObj
                        }
                    }
                );


            return chapterObj;

        } catch (err) {
            throw err;
        }
    },


    getAllChapters: () => {
        return new Promise(async (resolve, reject) => {
            try {

                let courses = await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .find()
                    .toArray();

                let allChapters = [];

                courses.forEach(course => {

                    if (course.chapters && course.chapters.length) {

                        course.chapters.forEach(chapter => {
                            allChapters.push({
                                ...chapter,
                                courseId: course._id,
                                courseTitle: course.name
                            });
                        });

                    }

                });

                // SORT BY ORDER ASC
                allChapters.sort((a, b) => a.order - b.order);

                await Promise.all(allChapters.map(decorateChapter));
                resolve(allChapters);

            } catch (err) {
                reject(err);
            }
        });
    },
    deleteChapter: async (courseId, uniqueCode) => {
        try {
            if (!ObjectId.isValid(courseId)) {
                return { status: false, message: "Invalid course" };
            }

            // Step 1: Get course
            let course = await db.get().collection(collection.COURSE_COLLECTION).findOne({
                _id: new ObjectId(courseId)
            });

            if (!course) {
                return { status: false, message: "Course not found" };
            }

            // Step 2: Find chapter
            let chapter = course.chapters?.find(ch => ch.uniqueCode == uniqueCode);

            if (!chapter) {
                return { status: false, message: "Chapter not found" };
            }

            // Step 3: Delete chapter from DB
            let result = await db.get().collection(collection.COURSE_COLLECTION).updateOne(
                { _id: new ObjectId(courseId) },
                {
                    $pull: {
                        chapters: { uniqueCode: uniqueCode }
                    }
                }
            );

            if (result.modifiedCount === 0) {
                return { status: false, message: "DB delete failed" };
            }


            // Step 4: Delete all S3 & VdoCipher assets associated with the chapter
            await deleteChapterFiles(chapter);

            return { status: true };

        } catch (err) {
            return { status: false, message: "Unexpected error" };
        }
    },
    updateChapterUltraSafe: async (
        courseId,
        uniqueCode,
        data,
        imageFile
    ) => {
        try {
            if (!ObjectId.isValid(courseId) || !ObjectId.isValid(data.package)) {
                return {
                    status: false,
                    message: 'Invalid course'
                };
            }

            const oldCourse =
                await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .findOne({
                        _id: new ObjectId(courseId)
                    });

            if (!oldCourse) {
                return {
                    status: false,
                    message: 'Old course not found'
                };
            }

            const chapter =
                oldCourse.chapters?.find(
                    ch =>
                        ch.uniqueCode ==
                        uniqueCode
                );

            if (!chapter) {
                return {
                    status: false,
                    message: 'Chapter not found'
                };
            }

            const newCourseId =
                data.package;

            const isCourseChanged =
                String(courseId) !==
                String(newCourseId);

            let newImageName =
                chapter.imageName;  // Firebase URL (existing)

            // New image URL passed in from route after Firebase upload
            if (imageFile) {
                newImageName = imageFile;  // imageFile is already a Firebase URL in the new flow
            }

            const updatedChapter = {
                ...chapter,
                title: data.title || data.name,
                order: data.order !== undefined && data.order !== '' ? Number(data.order) : chapter.order,
                description:
                    data.description,
                imageName:
                    newImageName
            };

            // same course
            if (!isCourseChanged) {

                await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .updateOne(
                        {
                            _id: new ObjectId(
                                courseId
                            ),
                            "chapters.uniqueCode":
                                uniqueCode
                        },
                        {
                            $set: {
                                "chapters.$":
                                    updatedChapter
                            }
                        }
                    );

            } else {
                const newCourse =
                    await db.get()
                        .collection(collection.COURSE_COLLECTION)
                        .findOne({
                            _id: new ObjectId(newCourseId)
                        });

                if (!newCourse) {
                    return {
                        status: false,
                        message: 'New course not found'
                    };
                }

                // remove old
                await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .updateOne(
                        {
                            _id: new ObjectId(
                                courseId
                            )
                        },
                        {
                            $pull: {
                                chapters: {
                                    uniqueCode
                                }
                            }
                        }
                    );

                updatedChapter.package =
                    newCourse.name;

                updatedChapter.courseId =
                    newCourseId;

                await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .updateOne(
                        {
                            _id: new ObjectId(
                                newCourseId
                            )
                        },
                        {
                            $push: {
                                chapters:
                                    updatedChapter
                            }
                        }
                    );
            }

            // Delete old chapter image from Firebase when a new one was uploaded
            if (imageFile && chapter.imageName) {
                try {
                    const oldStoragePath = extractPathFromUrl(chapter.imageName);
                    if (oldStoragePath) await deleteFromS3(oldStoragePath);
                } catch (e) {
                    console.warn('⚠️ Could not delete old chapter image from Firebase:', e.message);
                }
            }

            return {
                status: true
            };

        } catch (err) {
            console.error(
                'Update Error:',
                err.message
            );

            return {
                status: false,
                message: err.message
            };
        }
    },
    getChapter: async (courseId, uniqueCode) => {
        if (!ObjectId.isValid(courseId)) return null;
        let course = await db.get().collection(collection.COURSE_COLLECTION).findOne({
            _id: new ObjectId(courseId)
        });

        if (!course) return null;
        let chapter = (course.chapters || []).find(ch => ch.uniqueCode == uniqueCode);

        return decorateChapter(chapter);
    },
    getChaptersByCourseId: async (courseId) => {
        try {
            if (!ObjectId.isValid(courseId)) return [];

            let course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({ _id: new ObjectId(courseId) });

            if (!course) return [];

            // 🔥 sort chapters by order
            let chapters = (course.chapters || []).sort((a, b) => a.order - b.order);

            await Promise.all(chapters.map(decorateChapter));
            return chapters;

        } catch (err) {
            return [];
        }
    },
    getCourseById: async (courseId) => {
        try {
            if (!ObjectId.isValid(courseId)) return null;
            let course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({ _id: new ObjectId(courseId) });

            return decorateCourse(course);

        } catch (err) {
            return null;
        }
    },


    getChapterByCode: (uniqueCode) => {
        return new Promise(async (resolve, reject) => {

            let course = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .findOne({ "chapters.uniqueCode": uniqueCode });

            if (!course) {
                return resolve(null);
            }

            let chapter = course.chapters.find(ch => ch.uniqueCode === uniqueCode);

            resolve(await decorateChapter(chapter));
        });
    },

    // ======================================
    // ADD EXERCISE
    // ======================================
    // fileUrl is the Firebase public URL for the exercise file
    addExercise: (data, fileUrl) => {
        return new Promise(async (resolve, reject) => {

            try {
                if (
                    !data.chapterId ||
                    !ObjectId.isValid(data.classId) ||
                    !String(data.title || '').trim() ||
                    !fileUrl
                ) {
                    return resolve(false);
                }

                const exerciseObj = {
                    _id: new ObjectId(),
                    title: String(data.title).trim(),
                    file: fileUrl,   // Firebase URL
                    type: data.type
                };

                const result = await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .updateOne(
                        {
                            "chapters.uniqueCode": data.chapterId,
                            "chapters.classes._id": new ObjectId(data.classId)
                        },
                        {
                            $push: {
                                "chapters.$[chapter].classes.$[class].exercises":
                                    exerciseObj
                            }
                        },
                        {
                            arrayFilters: [
                                {
                                    "chapter.uniqueCode":
                                        data.chapterId
                                },
                                {
                                    "class._id":
                                        new ObjectId(data.classId)
                                }
                            ]
                        }
                    );

                resolve(result.modifiedCount > 0);

            } catch (err) {

                console.error(
                    'Add Exercise Error:',
                    err.message
                );

                reject(err);
            }
        });
    },


    // ======================================
    // DELETE EXERCISE
    // ======================================
    deleteExercise: (
        exerciseId,
        chapterId,
        classId
    ) => {
        return new Promise(async (resolve, reject) => {

            try {
                if (!ObjectId.isValid(classId) || !ObjectId.isValid(exerciseId)) {
                    return resolve(false);
                }

                const course =
                    await db.get()
                        .collection(collection.COURSE_COLLECTION)
                        .findOne({
                            "chapters.uniqueCode":
                                chapterId
                        });

                if (!course) {
                    return resolve(false);
                }

                const chapter =
                    course.chapters.find(
                        ch =>
                            ch.uniqueCode ===
                            chapterId
                    );

                if (!chapter) {
                    return resolve(false);
                }

                const classData =
                    (chapter.classes || []).find(
                        cl =>
                            String(cl._id) ===
                            String(classId)
                    );

                if (!classData) {
                    return resolve(false);
                }

                const exercise =
                    (classData.exercises || []).find(
                        ex =>
                            String(ex._id) ===
                            String(exerciseId)
                    );

                // Delete exercise file from Firebase
                if (exercise && exercise.file) {
                    try {
                        const storagePath = extractPathFromUrl(exercise.file);
                        if (storagePath) await deleteFromS3(storagePath);
                    } catch (e) {
                        console.warn('⚠️ Could not delete exercise file from Firebase:', e.message);
                    }
                }

                // remove from DB
                await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .updateOne(
                        {
                            "chapters.uniqueCode": chapterId,
                            "chapters.classes._id": new ObjectId(classId)
                        },
                        {
                            $pull: {
                                "chapters.$[chapter].classes.$[class].exercises": {
                                    _id:
                                        new ObjectId(
                                            exerciseId
                                        )
                                }
                            }
                        },
                        {
                            arrayFilters: [
                                {
                                    "chapter.uniqueCode":
                                        chapterId
                                },
                                {
                                    "class._id":
                                        new ObjectId(classId)
                                }
                            ]
                        }
                    );

                resolve(true);

            } catch (err) {

                console.error(
                    'Delete Exercise Error:',
                    err.message
                );

                reject(err);
            }
        });
    },


    // ======================================
    // GET SINGLE EXERCISE
    // ======================================
    getExercise: (
        exerciseId,
        chapterId,
        classId
    ) => {
        return new Promise(async (resolve, reject) => {

            try {
                if (!ObjectId.isValid(classId) || !ObjectId.isValid(exerciseId)) {
                    return resolve(null);
                }

                const course =
                    await db.get()
                        .collection(collection.COURSE_COLLECTION)
                        .findOne({
                            "chapters.uniqueCode":
                                chapterId
                        });

                if (!course) return resolve(null);

                const chapter =
                    (course.chapters || []).find(
                        ch =>
                            ch.uniqueCode ===
                            chapterId
                    );

                if (!chapter) return resolve(null);

                const classData =
                    (chapter.classes || []).find(
                        cl =>
                            String(cl._id) ===
                            String(classId)
                    );

                if (!classData) return resolve(null);

                const exercise =
                    (classData.exercises || []).find(
                        ex =>
                            String(ex._id) ===
                            String(exerciseId)
                    );

                if (!exercise) return resolve(null);

                resolve({
                    exercise: await decorateExercise(exercise)
                });

            } catch (err) {

                console.error(
                    'Get Exercise Error:',
                    err.message
                );

                reject(err);
            }
        });
    },


    // ======================================
    // UPDATE EXERCISE
    // ======================================
    updateExercise: async (
        data,
        file
    ) => {
        try {
            if (
                !data.chapterId ||
                !ObjectId.isValid(data.classId) ||
                !ObjectId.isValid(data.exerciseId) ||
                !String(data.title || '').trim()
            ) {
                return false;
            }

            const course =
                await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .findOne({
                        "chapters.uniqueCode":
                            data.chapterId
                    });

            if (!course) return false;

            const chapter =
                (course.chapters || []).find(
                    ch =>
                        ch.uniqueCode ===
                        data.chapterId
                );

            if (!chapter) return false;

            const classData =
                (chapter.classes || []).find(
                    cl =>
                        String(cl._id) ===
                        String(data.classId)
                );

            if (!classData) return false;

            const exercise =
                (classData.exercises || []).find(
                    ex =>
                        String(ex._id) ===
                        String(data.exerciseId)
                );

            if (!exercise) return false;

            let newFileName =
                exercise.file;   // existing Firebase URL

            let newType =
                exercise.type;

            // new file uploaded: file = { newUrl, ext } passed from route
            if (file) {
                const ext = file.ext;

                if (ext === 'pdf')                    newType = 'pdf';
                else if (ext === 'xls' || ext === 'xlsx') newType = 'excel';
                else if (ext === 'dwg')               newType = 'autocad';

                // Delete old exercise file from Firebase
                try {
                    const oldStoragePath = extractPathFromUrl(exercise.file);
                    if (oldStoragePath) await deleteFromS3(oldStoragePath);
                } catch (e) {
                    console.warn('⚠️ Could not delete old exercise from Firebase:', e.message);
                }

                newFileName = file.newUrl;  // new Firebase URL
            }

            const result = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .updateOne(
                    {
                        "chapters.uniqueCode": data.chapterId,
                        "chapters.classes._id": new ObjectId(data.classId)
                    },
                    {
                        $set: {
                            "chapters.$[chapter].classes.$[class].exercises.$[exercise].title":
                                data.title,

                            "chapters.$[chapter].classes.$[class].exercises.$[exercise].file":
                                newFileName,

                            "chapters.$[chapter].classes.$[class].exercises.$[exercise].type":
                                newType
                        }
                    },
                    {
                        arrayFilters: [
                            {
                                "chapter.uniqueCode":
                                data.chapterId
                            },
                            {
                                "class._id":
                                    new ObjectId(data.classId)
                            },
                            {
                                "exercise._id":
                                    new ObjectId(data.exerciseId)
                            }
                        ]
                    }
                );

            return result.modifiedCount > 0;

        } catch (err) {

            console.error(
                'Update Exercise Error:',
                err.message
            );

            return false;
        }
    },


    // ======================================
    // GET CLASS EXERCISES
    // ======================================
    getClassExercises: (
        chapterId,
        classId
    ) => {
        return new Promise(async (resolve, reject) => {

            try {
                if (!ObjectId.isValid(classId)) {
                    return resolve(null);
                }

                const course =
                    await db.get()
                        .collection(collection.COURSE_COLLECTION)
                        .findOne({
                            "chapters.uniqueCode":
                                chapterId
                        });

                if (!course) {
                    return resolve(null);
                }

                const chapter =
                    course.chapters.find(
                        ch =>
                            ch.uniqueCode ===
                            chapterId
                    );

                if (!chapter) {
                    return resolve(null);
                }

                const classData =
                    (chapter.classes || []).find(
                        cl =>
                            String(cl._id) ===
                            String(classId)
                    );

                if (!classData) {
                    return resolve(null);
                }

                if (!classData.exercises) {
                    classData.exercises = [];
                }

                await decorateChapter(chapter);
                await decorateClass(classData);

                resolve({
                    chapter,
                    classData
                });

            } catch (err) {

                console.error(
                    'Get Class Exercises Error:',
                    err.message
                );

                reject(err);
            }
        });
    },
    addClass: (data) => {
        return new Promise(async (resolve, reject) => {

            let classObj = {
                _id: new ObjectId(),
                title: data.title,
                videoId: data.videoId
            };

            await db.get().collection(collection.COURSE_COLLECTION).updateOne(
                { "chapters.uniqueCode": data.chapterId },
                {
                    $push: {
                        "chapters.$.classes": classObj
                    }
                }
            );

            resolve();
        });
    },
    // =================================
    // GET COURSE STUDENTS
    // =================================
    getCourseStudents: (courseId) => {
        return new Promise(async (resolve, reject) => {
            try {
                if (!ObjectId.isValid(courseId)) {
                    return resolve({ students: [], courseName: '' });
                }

                // course details
                const course = await db.get()
                    .collection(collection.COURSE_COLLECTION)
                    .findOne({
                        _id: new ObjectId(courseId)
                    });

                // students by courseId
                const students = await db.get()
                    .collection(collection.STUDENTS_COLLECTION)
                    .find({
                        "course.courseId": String(courseId)
                    })
                    .sort({
                        createdAt: -1
                    })
                    .toArray();

                await Promise.all(students.map(student => decorateProfileImage(student, 'image')));

                resolve({
                    students,
                    courseName:
                        course?.name || ''
                });

            } catch (err) {
                console.error(
                    'getCourseStudents Error:',
                    err.message
                );

                reject(err);
            }
        });
    },
    updateChaptersOrder: async (courseId, uniqueCodes) => {
        try {
            if (!ObjectId.isValid(courseId)) throw new Error('Invalid course ID');
            const course = await db.get().collection(collection.COURSE_COLLECTION).findOne({
                _id: new ObjectId(courseId)
            });
            if (!course) throw new Error('Course not found');

            const chapterMap = {};
            (course.chapters || []).forEach(ch => {
                chapterMap[ch.uniqueCode] = ch;
            });

            const newChapters = [];
            uniqueCodes.forEach((code, idx) => {
                if (chapterMap[code]) {
                    const ch = chapterMap[code];
                    ch.order = idx + 1;
                    newChapters.push(ch);
                }
            });

            // fallback for missing codes
            (course.chapters || []).forEach(ch => {
                if (!uniqueCodes.includes(String(ch.uniqueCode))) {
                    ch.order = newChapters.length + 1;
                    newChapters.push(ch);
                }
            });

            await db.get().collection(collection.COURSE_COLLECTION).updateOne(
                { _id: new ObjectId(courseId) },
                { $set: { chapters: newChapters } }
            );
            return true;
        } catch (err) {
            console.error('updateChaptersOrder Error:', err.message);
            throw err;
        }
    }
}
