const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');

const writeLog = (type, args) => {
  const message = args.map(arg => {
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    return typeof arg === 'object' ? JSON.stringify(arg) : arg;
  }).join(' ');
  
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
  
  // Console logging for process monitors and container logs
  if (type === 'error') {
    console.error(...args);
  } else if (type === 'warn') {
    console.warn(...args);
  } else {
    console.log(...args);
  }

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    // Always write to combined.log
    fs.appendFileSync(path.join(LOG_DIR, 'combined.log'), line);
    // Additionally write errors to error.log
    if (type === 'error') {
      fs.appendFileSync(path.join(LOG_DIR, 'error.log'), line);
    }
  } catch (err) {
    // Fail silently to prevent application crash if disk is full/unwritable
  }
};

module.exports = {
  info: (...args) => writeLog('info', args),
  error: (...args) => writeLog('error', args),
  warn: (...args) => writeLog('warn', args)
};
