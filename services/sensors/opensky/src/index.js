'use strict';

const http = require('http');
const { OpenSkySensor } = require('./opensky-sensor');

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

function csvEnv(name) {
  return env(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function bboxFromEnv() {
  const raw = env('OPENSKY_BBOX');
  if (raw) {
    const [lamin, lomin, lamax, lomax] = raw.split(',').map((value) => Number(value.trim()));
    return { lamin, lomin, lamax, lomax };
  }

  const keys = ['OPENSKY_LAMIN', 'OPENSKY_LOMIN', 'OPENSKY_LAMAX', 'OPENSKY_LOMAX'];
  if (keys.every((key) => env(key))) {
    return {
      lamin: numberEnv('OPENSKY_LAMIN', 0),
      lomin: numberEnv('OPENSKY_LOMIN', 0),
      lamax: numberEnv('OPENSKY_LAMAX', 0),
      lomax: numberEnv('OPENSKY_LOMAX', 0),
    };
  }

  return null;
}

function jsonLogger(level) {
  return (message, fields = {}) => {
    const payload = {
      level,
      service: 'osiris-sensor-opensky',
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

function defaultPollSeconds(hasAuth, hasBbox) {
  if (process.env.OPENSKY_POLL_SECONDS) return numberEnv('OPENSKY_POLL_SECONDS', 0, 5);
  if (hasAuth) return 60;
  return hasBbox ? 300 : 900;
}

const logger = {
  info: jsonLogger('info'),
  warn: jsonLogger('warn'),
  error: jsonLogger('error'),
  log: jsonLogger('info'),
};

const clientId = env('OPENSKY_CLIENT_ID');
const clientSecret = env('OPENSKY_CLIENT_SECRET');
const bbox = bboxFromEnv();
const enabled = boolEnv('OPENSKY_ENABLED', boolEnv('OPENSKY_SENSOR_ENABLED', false));

const sensor = new OpenSkySensor({
  id: env('SENSOR_ID', 'opensky'),
  enabled,
  redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379'),
  streamKey: env('EVENT_STREAM_KEY', env('OSIRIS_STREAM_KEY', 'osiris.stream')),
  streamMaxLen: numberEnv('EVENT_STREAM_MAXLEN', numberEnv('OSIRIS_STREAM_MAXLEN', 0, 0), 0),
  apiUrl: env('OPENSKY_API_URL', 'https://opensky-network.org/api/states/all'),
  authUrl: env('OPENSKY_AUTH_URL', 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'),
  clientId,
  clientSecret,
  bbox,
  icao24: csvEnv('OPENSKY_ICAO24'),
  extended: boolEnv('OPENSKY_EXTENDED', true),
  includeOnGround: boolEnv('OPENSKY_INCLUDE_ON_GROUND', true),
  minAltitudeM: env('OPENSKY_MIN_ALTITUDE_M') ? numberEnv('OPENSKY_MIN_ALTITUDE_M', 0) : null,
  maxAltitudeM: env('OPENSKY_MAX_ALTITUDE_M') ? numberEnv('OPENSKY_MAX_ALTITUDE_M', 0) : null,
  minVelocityMps: env('OPENSKY_MIN_VELOCITY_MPS') ? numberEnv('OPENSKY_MIN_VELOCITY_MPS', 0) : null,
  pollIntervalMs: defaultPollSeconds(Boolean(clientId && clientSecret), Boolean(bbox)) * 1000,
  requestTimeoutMs: numberEnv('OPENSKY_REQUEST_TIMEOUT_MS', 10000, 1000),
  retryCount: numberEnv('OPENSKY_RETRY_COUNT', 2, 0),
  retryBaseMs: numberEnv('OPENSKY_RETRY_BASE_MS', 1000, 100),
  retryMaxMs: numberEnv('OPENSKY_RETRY_MAX_MS', 60000, 1000),
  minRequestSpacingMs: numberEnv('OPENSKY_MIN_REQUEST_SPACING_MS', 10000, 1000),
  maxBatchSize: numberEnv('OPENSKY_MAX_BATCH_SIZE', 10000, 1),
  maxStreamLength: numberEnv('SENSOR_MAX_STREAM_LENGTH', 500000, 1000),
  backpressurePauseMs: numberEnv('SENSOR_BACKPRESSURE_PAUSE_MS', 5000, 500),
  logger,
});

sensor.on('failure', (error) => {
  logger.warn('opensky_sensor_failure', {
    error: error instanceof Error ? error.message : String(error),
    retryAfterMs: error?.retryAfterMs || null,
  });
});

sensor.on('poll', (event) => logger.info('opensky_sensor_poll', event));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
    return sendJson(res, 200, {
      service: 'osiris-sensor-opensky',
      status: enabled ? sensor.health().status : 'DISABLED',
      sensor: sensor.health(),
      time: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    const health = sensor.health();
    const ready = !enabled || health.connected;
    return sendJson(res, ready ? 200 : 503, {
      service: 'osiris-sensor-opensky',
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
  logger.info('opensky_sensor_shutdown_started', { signal });
  await sensor.stop();
  await new Promise((resolve) => server.close(resolve));
  logger.info('opensky_sensor_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('opensky_sensor_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('opensky_sensor_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

async function start() {
  server.listen(numberEnv('PORT', 4701, 1), env('HOST', '0.0.0.0'), () => {
    logger.info('opensky_sensor_listening', {
      enabled,
      port: numberEnv('PORT', 4701, 1),
      stream: sensor.streamKey,
      authMode: sensor.hasAuth() ? 'oauth2_client_credentials' : 'anonymous',
      pollSeconds: sensor.pollIntervalMs / 1000,
    });
  });

  await sensor.start();
}

start().catch((error) => {
  logger.error('opensky_sensor_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
