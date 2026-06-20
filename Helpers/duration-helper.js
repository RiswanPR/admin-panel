module.exports = {
  secondsToDisplay: (seconds) => {
    seconds = Number(seconds) || 0;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  },

  secondsToFormatted: (seconds) => {
    seconds = Number(seconds) || 0;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const pad = (n) => String(n).padStart(2, '0');
    if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
    return `${pad(minutes)}:${pad(secs)}`;
  },

  // For total duration display (in minutes)
  secondsToMinutes: (seconds) => {
    const minutes = (Number(seconds) || 0) / 60;
    return Number(minutes.toFixed(1)) + " min";
  }
};
