'use strict';

const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function createLogger(service, level = 'info') {
  const threshold = levels[level] || levels.info;

  function write(name, message, meta = {}) {
    if ((levels[name] || levels.info) < threshold) return;
    const entry = {
      level: name,
      service,
      message,
      time: new Date().toISOString(),
      ...meta,
    };
    const line = JSON.stringify(entry);
    if (name === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}

module.exports = { createLogger };
