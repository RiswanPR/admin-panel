const { getS3ReadUrl, extractPathFromUrl } = require('../config/s3-storage');

const PLACEHOLDERS = {
  course: '/img/placeholders/course-cover.svg',
  chapter: '/img/placeholders/course-cover.svg',
  class: '/img/placeholders/course-cover.svg',
  cover: '/img/placeholders/course-cover.svg',
  profile: '/img/placeholders/profile.svg',
  certificate: '/img/placeholders/course-cover.svg',
};

const localImageUrl = (value, folderName, fallback) => {
  if (!value || typeof value !== 'string') return fallback;
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
  if (extractPathFromUrl(value)) return null;
  return `/${folderName}/${value.replace(/^\/+/, '')}`;
};

const resolveImageUrl = async (value, folderName, fallback = PLACEHOLDERS.course) => {
  if (!value || typeof value !== 'string') return fallback;

  const s3Url = await getS3ReadUrl(value);
  if (s3Url) return s3Url;

  return localImageUrl(value, folderName, fallback);
};

const decorateCourse = async (course) => {
  if (!course) return course;

  course.imageKey = extractPathFromUrl(course.image) || course.image || '';
  course.imageUrl = await resolveImageUrl(course.image, 'course-images', PLACEHOLDERS.course);
  course.coverImageUrl = course.imageUrl;

  if (Array.isArray(course.chapters)) {
    await Promise.all(course.chapters.map(decorateChapter));
  }

  return course;
};

const decorateChapter = async (chapter) => {
  if (!chapter) return chapter;

  chapter.imageKey = extractPathFromUrl(chapter.imageName) || chapter.imageName || '';
  chapter.imageUrl = await resolveImageUrl(chapter.imageName, 'chapter-images', PLACEHOLDERS.chapter);
  chapter.coverImageUrl = chapter.imageKey;
  chapter.coverImageDisplayUrl = chapter.imageUrl;

  if (Array.isArray(chapter.classes)) {
    await Promise.all(chapter.classes.map(decorateClass));
  }

  return chapter;
};

const decorateClass = async (classData) => {
  if (!classData) return classData;

  classData.thumbnailKey = extractPathFromUrl(classData.thumbnail) || classData.thumbnail || '';
  classData.thumbnailUrl = await resolveImageUrl(classData.thumbnail, 'class-images', PLACEHOLDERS.class);
  classData.imageUrl = classData.thumbnailUrl;

  const videoUrl = await getS3ReadUrl(classData.videoUrl);
  if (videoUrl) classData.videoDisplayUrl = videoUrl;

  if (Array.isArray(classData.exercises)) {
    await Promise.all(classData.exercises.map(decorateExercise));
  }

  return classData;
};

const decorateExercise = async (exercise) => {
  if (!exercise) return exercise;

  const fileUrl = await getS3ReadUrl(exercise.file);
  if (fileUrl) exercise.fileUrl = fileUrl;

  return exercise;
};

const decorateProfileImage = async (entity, field = 'profileImage') => {
  if (!entity) return entity;

  entity[`${field}Key`] = extractPathFromUrl(entity[field]) || entity[field] || '';
  entity[`${field}Url`] = await resolveImageUrl(entity[field], `${field === 'image' ? 'student' : 'teacher'}-images`, PLACEHOLDERS.profile);

  return entity;
};

const decorateCoverImage = async (image) => {
  if (!image) return image;

  image.imageKey = extractPathFromUrl(image.image) || image.image || '';
  image.imageUrl = await resolveImageUrl(image.image, 'cover-images', PLACEHOLDERS.cover);

  return image;
};

module.exports = {
  PLACEHOLDERS,
  resolveImageUrl,
  decorateCourse,
  decorateChapter,
  decorateClass,
  decorateExercise,
  decorateProfileImage,
  decorateCoverImage,
};
