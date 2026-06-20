const db = require('../config/connection');
const collection = require('../config/collections');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');

const backupDir = path.join(__dirname, '../backups');

const ensureBackupDir = () => {
    fs.mkdirSync(backupDir, { recursive: true });
};

module.exports = {

    getSettings: async () => {
        try {

            let settings = await db.get()
                .collection(collection.SETTINGS_COLLECTION)
                .findOne({});

            // default create
            if (!settings) {

                const defaultSettings = {
                    academyName: "Zeitnah Academy",
                    email: "admin@zeitnahacademy.com",
                    phone: "+91 XXXXX XXXXX",
                    address: "",
                    logo: "logo.png",
                    theme: "dark",
                    createdAt: new Date()
                };

                await db.get()
                    .collection(collection.SETTINGS_COLLECTION)
                    .insertOne(defaultSettings);

                return defaultSettings;
            }

            return settings;

        } catch (err) {
            throw err;
        }
    },

    updateAcademyProfile: async (data) => {
        try {

            await db.get()
                .collection(collection.SETTINGS_COLLECTION)
                .updateOne(
                    {},
                    {
                        $set: {
                            academyName: data.academyName,
                            email: data.email,
                            phone: data.phone,
                            address: data.address,
                            updatedAt: new Date()
                        }
                    },
                    { upsert: true }
                );

            return true;

        } catch (err) {
            throw err;
        }
    },

    updateTheme: async (theme) => {
        try {

            await db.get()
                .collection(collection.SETTINGS_COLLECTION)
                .updateOne(
                    {},
                    {
                        $set: {
                            theme: theme,
                            updatedAt: new Date()
                        }
                    },
                    { upsert: true }
                );

            return true;

        } catch (err) {
            throw err;
        }
    },

    exportStudentsCSV: async () => {
        try {
            ensureBackupDir();

            const students = await db.get()
                .collection(collection.STUDENTS_COLLECTION)
                .find({})
                .toArray();

            const parser = new Parser();
            const csv = parser.parse(students);
            const fileName = 'students-' + Date.now() + '.csv';
            const filePath = path.join(backupDir, fileName);

            fs.writeFileSync(filePath, csv);

            return filePath;

        } catch (err) {
            throw err;
        }
    },

    exportCoursesJSON: async () => {
        try {
            ensureBackupDir();

            const courses = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .find({})
                .toArray();

            const fileName = 'courses-' + Date.now() + '.json';
            const filePath = path.join(backupDir, fileName);

            fs.writeFileSync(
                filePath,
                JSON.stringify(courses, null, 2)
            );

            return filePath;

        } catch (err) {
            throw err;
        }
    },

    fullBackup: async () => {
        try {
            ensureBackupDir();

            const backupData = {};

            backupData.students = await db.get()
                .collection(collection.STUDENTS_COLLECTION)
                .find({})
                .toArray();

            backupData.courses = await db.get()
                .collection(collection.COURSE_COLLECTION)
                .find({})
                .toArray();

            backupData.settings = await db.get()
                .collection(collection.SETTINGS_COLLECTION)
                .find({})
                .toArray();

            backupData.auditLogs = await db.get()
                .collection(collection.AUDIT_LOG_COLLECTION)
                .find({})
                .toArray();

            const fileName = 'zeitnah-backup-' + Date.now() + '.json';
            const filePath = path.join(backupDir, fileName);

            fs.writeFileSync(
                filePath,
                JSON.stringify(backupData, null, 2)
            );

            return filePath;

        } catch (err) {
            throw err;
        }
    },

};
