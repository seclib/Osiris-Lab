'use strict';

const http = require('http');
const { FirmsSensor } = require('./firms-sensor');

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function numberEnv(name, fallback, min = undefined) {
  const parsed = Number(process.env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return typeof min === 'number' ? Math.max(min, value) : value;
}

function confidenceEnv(name) {
  if (!env(name)) return null;
  const value = numberEnv(name, 0, 0);
  return Math.min(1, value > 1 ? value / 100 : value);
}

function jsonLogger(level) {
  return (message, fields = {}) => {
    const payload = {
      level,
      service: 'osiris-sensor-firms',
      message,
      time: new Date().toISOString(),
      ...fields,
    };
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const logger = {
  info: jsonLogger('info'),
  warn: jsonLogger('warn'),
  error: jsonLogger('error'),
  log: jsonLogger('info'),
};

const enabled = boolEnv('FIRMS_ENABLED', boolEnv('FIRMS_SENSOR_ENABLED', false));

const sensor = new FirmsSensor({
  id: env('SENSOR_ID', 'nasa-firms'),
  enabled,
  redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379'),
  streamKey: env('EVENT_STREAM_KEY', env('OSIRIS_STREAM_KEY', 'osiris.stream')),
  streamMaxLen: numberEnv('EVENT_STREAM_MAXLEN', numberEnv('OSIRIS_STREAM_MAXLEN', 0, 0), 0),
  apiBase: env('FIRMS_API_BASE', 'https://firms.modaps.eosdis.nasa.gov/api/area/csv'),
  mapKey: env('FIRMS_MAP_KEY', env('NASA_FIRMS_MAP_KEY')),
  firmsSource: env('FIRMS_SOURCE', 'VIIRS_SNPP_NRT'),
  area: env('FIRMS_AREA', 'world'),
  dayRange: numberEnv('FIRMS_DAY_RANGE', 1, 1),
  date: env('FIRMS_DATE'),
  minConfidence: confidenceEnv('FIRMS_MIN_CONFIDENCE'),
  minFrp: env('FIRMS_MIN_FRP') ? numberEnv('FIRMS_MIN_FRP', 0) : null,
  pollIntervalMs: numberEnv('FIRMS_POLL_SECONDS', 300, 60) * 1000,
  requestTimeoutMs: numberEnv('FIRMS_REQUEST_TIMEOUT_MS', 20000, 1000),
  retryCount: numberEnv('FIRMS_RETRY_COUNT', 2, 0),
  retryBaseMs: numberEnv('FIRMS_RETRY_BASE_MS', 1000, 100),
  retryMaxMs: numberEnv('FIRMS_RETRY_MAX_MS', 60000, 1000),
  minRequestSpacingMs: numberEnv('FIRMS_MIN_REQUEST_SPACING_MS', 5000, 1000),
  maxBatchSize: numberEnv('FIRMS_MAX_BATCH_SIZE', 10000, 1),
  maxStreamLength: numberEnv('SENSOR_MAX_STREAM_LENGTH', 500000, 1000),
  backpressurePauseMs: numberEnv('SENSOR_BACKPRESSURE_PAUSE_MS', 5000, 500),
  logger,
});

sensor.on('failure', (error) => {
  logger.warn('firms_sensor_failure', {
    error: error instanceof Error ? error.message : String(error),
    retryAfterMs: error?.retryAfterMs || null,
  });
});

sensor.on('poll', (event) => logger.info('firms_sensor_poll', event));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
    return sendJson(res, 200, {
      service: 'osiris-sensor-firms',
      status: enabled ? sensor.health().status : 'DISABLED',
      sensor: sensor.health(),
      time: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    const health = sensor.health();
    const ready = !enabled || health.connected;
    return sendJson(res, ready ? 200 : 503, {
      service: 'osiris-sensor-firms',
      ready,
      sensor: health,
      time: new Date().toISOString(),
    });
  }

  return sendJson(res, 404, { error: 'not_found' });
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('firms_sensor_shutdown_started', { signal });
  await sensor.stop();
  await new Promise((resolve) => server.close(resolve));
  logger.info('firms_sensor_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('firms_sensor_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('firms_sensor_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

async function start() {
  const port = numberEnv('PORT', 4703, 1);
  server.listen(port, env('HOST', '0.0.0.0'), () => {
    logger.info('firms_sensor_listening', {
      enabled,
      port,
      stream: sensor.streamKey,
      firmsSource: sensor.firmsSource,
      area: sensor.area,
      pollSeconds: sensor.pollIntervalMs / 1000,
    });
  });

  await sensor.start();
}

start().catch((error) => {
  logger.error('firms_sensor_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
