'use strict';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /password/i,
  /secret/i,
  /token/i,
];

function redactValue(key, value) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(String(key)))) return '[redacted]';
  if (value && typeof value === 'object' && !Array.isArray(value)) return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === 'object' ? redactSecrets(item) : item));
  return value;
}

function redactSecrets(fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) safe[key] = redactValue(key, value);
  return safe;
}

function normalizeLevel(level) {
  const normalized = String(level || 'info').trim().toLowerCase();
  return LEVELS[normalized] ? normalized : 'info';
}

function createLogger(options = {}) {
  const service = options.service || 'osiris-sensor-shodan';
  const minLevel = normalizeLevel(options.level || process.env.LOG_LEVEL || 'info');
  const minPriority = LEVELS[minLevel];
  const baseFields = options.baseFields && typeof options.baseFields === 'object' ? options.baseFields : {};

  function write(level, message, fields = {}) {
    if (LEVELS[level] < minPriority) return;

    const payload = {
      level,
      service,
      message,
      time: new Date().toISOString(),
      ...redactSecrets(baseFields),
      ...redactSecrets(fields),
    };

    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    log: (message, fields) => write('info', message, fields),
    child(childFields = {}) {
      return createLogger({
        service,
        level: minLevel,
        baseFields: {
          ...baseFields,
          ...childFields,
        },
      });
    },
  };
}

module.exports = {
  createLogger,
  redactSecrets,
};
