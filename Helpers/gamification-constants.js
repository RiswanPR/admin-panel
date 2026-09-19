'use strict';

/**
 * Zeitnah LMS — Gamification Constants & Pure Utilities
 * Shared between Admin Panel, Teacher Panel, and Student Experience
 */

const LEVEL_THRESHOLDS = [
  { level: 7, points: 4000 },
  { level: 6, points: 2000 },
  { level: 5, points: 1000 },
  { level: 4, points: 500 },
  { level: 3, points: 250 },
  { level: 2, points: 100 },
  { level: 1, points: 0 },
];

const RANK_THRESHOLDS = [
  { rank: 'Grand Master', minPoints: 10000, color: '#f59e0b', badgeClass: 'rank-grandmaster', icon: 'fa-crown' },
  { rank: 'Master', minPoints: 3000, color: '#ec4899', badgeClass: 'rank-master', icon: 'fa-gem' },
  { rank: 'Expert', minPoints: 1000, color: '#8b5cf6', badgeClass: 'rank-expert', icon: 'fa-shield-halved' },
  { rank: 'Advanced Learner', minPoints: 500, color: '#3b82f6', badgeClass: 'rank-advanced', icon: 'fa-star' },
  { rank: 'Learner', minPoints: 100, color: '#10b981', badgeClass: 'rank-learner', icon: 'fa-seedling' },
  { rank: 'Beginner', minPoints: 0, color: '#64748b', badgeClass: 'rank-beginner', icon: 'fa-compass' },
];

const PROFILE_COMPLETION_REWARDS = [
  { milestone: 100, points: 50 },
  { milestone: 75, points: 30 },
  { milestone: 50, points: 20 },
];

const POINT_ACTION_TYPES = {
  MANUAL_AWARD: 'manual_award',
  MANUAL_ADJUSTMENT: 'manual_adjustment',
  CLASS_COMPLETED: 'class_completed',
  COURSE_COMPLETED: 'course_completed',
  WATCH_MINUTES: 'watch_minutes',
  PROFILE_COMPLETION: 'profile_completion',
  MIGRATION_BASELINE: 'migration_baseline',
};

function calculateLevel(points = 0) {
  const pts = Number(points) || 0;
  const match = LEVEL_THRESHOLDS.find((item) => pts >= item.points);
  return match ? match.level : 1;
}

function calculateRank(points = 0) {
  const pts = Number(points) || 0;
  if (pts >= 10000) return 'Grand Master';
  if (pts >= 3000) return 'Master';
  if (pts >= 1000) return 'Expert';
  if (pts >= 500) return 'Advanced Learner';
  if (pts >= 100) return 'Learner';
  return 'Beginner';
}

function getRankMeta(rankName) {
  const found = RANK_THRESHOLDS.find((r) => r.rank.toLowerCase() === String(rankName || '').toLowerCase());
  return found || RANK_THRESHOLDS[RANK_THRESHOLDS.length - 1];
}

function getNextLevelProgress(points = 0) {
  const pts = Math.max(0, Number(points) || 0);
  const ascending = [...LEVEL_THRESHOLDS].sort((a, b) => a.points - b.points);
  const current = [...ascending].reverse().find((item) => pts >= item.points);
  const next = ascending.find((item) => item.points > pts);

  if (!next) {
    return {
      currentLevel: current?.level || 7,
      nextLevel: null,
      currentThreshold: current?.points || 4000,
      nextThreshold: null,
      pointsToNextLevel: 0,
      progressPercent: 100,
    };
  }

  const currentThreshold = current?.points || 0;
  const progressPercent = Math.round(
    ((pts - currentThreshold) / (next.points - currentThreshold)) * 100
  );

  return {
    currentLevel: current?.level || 1,
    nextLevel: next.level,
    currentThreshold,
    nextThreshold: next.points,
    pointsToNextLevel: Math.max(0, next.points - pts),
    progressPercent: Math.min(100, Math.max(0, progressPercent)),
  };
}

function calculateStreak(activityDates = []) {
  if (!Array.isArray(activityDates) || !activityDates.length) {
    return 0;
  }

  const uniqueDates = Array.from(new Set(activityDates))
    .filter(Boolean)
    .sort()
    .reverse();

  if (!uniqueDates.length) return 0;

  let streak = 1;

  for (let i = 1; i < uniqueDates.length; i++) {
    const previous = new Date(`${uniqueDates[i - 1]}T00:00:00.000Z`);
    const current = new Date(`${uniqueDates[i]}T00:00:00.000Z`);
    const diffDays = Math.round((previous.getTime() - current.getTime()) / 86400000);

    if (diffDays !== 1) {
      break;
    }

    streak += 1;
  }

  return streak;
}

function calculatePoints(minutesWatched) {
  const minutes = Number(minutesWatched);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }
  return Math.floor(minutes);
}

module.exports = {
  LEVEL_THRESHOLDS,
  RANK_THRESHOLDS,
  PROFILE_COMPLETION_REWARDS,
  POINT_ACTION_TYPES,
  calculateLevel,
  calculateRank,
  getRankMeta,
  getNextLevelProgress,
  calculateStreak,
  calculatePoints,
};
