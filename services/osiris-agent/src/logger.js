'use strict';

function createLogger(serviceName, level = 'info') {
  const levels = ['debug', 'info', 'warn', 'error'];
  const minLevel = levels.includes(level) ? levels.indexOf(level) : levels.indexOf('info');

  function write(severity, message, fields = {}) {
    if (levels.indexOf(severity) < minLevel) return;
    const record = {
      time: new Date().toISOString(),
      severity,
      service: serviceName,
      message,
      ...fields,
    };
    const line = JSON.stringify(record);
    if (severity === 'error') console.error(line);
    else if (severity === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

module.exports = { createLogger };
