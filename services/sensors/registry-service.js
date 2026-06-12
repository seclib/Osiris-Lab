'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { SensorRegistry } = require('./registry');

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

function confidenceEnv(name) {
  if (!env(name)) return null;
  const value = numberEnv(name, 0, 0);
  return Math.min(1, value > 1 ? value / 100 : value);
}

function defaultOpenSkyPollSeconds(hasAuth, hasBbox) {
  if (process.env.OPENSKY_POLL_SECONDS) return numberEnv('OPENSKY_POLL_SECONDS', 0, 5);
  if (hasAuth) return 60;
  return hasBbox ? 300 : 900;
}

function jsonLogger(level) {
  return (message, fields = {}) => {
    const payload = {
      level,
      service: 'osiris-sensor-registry',
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

function errorBody(error) {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res) {
  const token = env('SENSOR_REGISTRY_ADMIN_TOKEN');
  if (!token) return true;

  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (safeEqual(presented, token)) return true;

  sendJson(res, 401, { error: 'unauthorized' });
  return false;
}

function openSkyOptions(logger) {
  const clientId = env('OPENSKY_CLIENT_ID');
  const clientSecret = env('OPENSKY_CLIENT_SECRET');
  const bbox = bboxFromEnv();

  return {
    id: 'opensky',
    enabled: false,
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
    pollIntervalMs: defaultOpenSkyPollSeconds(Boolean(clientId && clientSecret), Boolean(bbox)) * 1000,
    requestTimeoutMs: numberEnv('OPENSKY_REQUEST_TIMEOUT_MS', 10000, 1000),
    retryCount: numberEnv('OPENSKY_RETRY_COUNT', 2, 0),
    retryBaseMs: numberEnv('OPENSKY_RETRY_BASE_MS', 1000, 100),
    retryMaxMs: numberEnv('OPENSKY_RETRY_MAX_MS', 60000, 1000),
    minRequestSpacingMs: numberEnv('OPENSKY_MIN_REQUEST_SPACING_MS', 10000, 1000),
    maxBatchSize: numberEnv('OPENSKY_MAX_BATCH_SIZE', 10000, 1),
    maxStreamLength: numberEnv('SENSOR_MAX_STREAM_LENGTH', 500000, 1000),
    backpressurePauseMs: numberEnv('SENSOR_BACKPRESSURE_PAUSE_MS', 5000, 500),
    logger,
  };
}

function firmsOptions(logger) {
  return {
    id: 'firms',
    enabled: false,
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
  };
}

function builtinSensors(logger) {
  return {
    opensky: {
      id: 'opensky',
      module: path.join(__dirname, 'opensky/src/opensky-sensor.js'),
      options: openSkyOptions(logger),
    },
    firms: {
      id: 'firms',
      module: path.join(__dirname, 'firms/src/firms-sensor.js'),
      options: firmsOptions(logger),
    },
  };
}

function parseConfig(logger) {
  const builtins = builtinSensors(logger);
  const raw = env('SENSOR_REGISTRY_CONFIG', env('OSIRIS_SENSOR_REGISTRY_JSON', ''));
  const enabledIds = new Set(csvEnv('SENSOR_REGISTRY_ENABLED_IDS'));

  if (raw) {
    const parsed = JSON.parse(raw);
    const sensors = Array.isArray(parsed) ? parsed : parsed.sensors || [];
    return {
      sensors: sensors.map((sensor) => {
        const builtin = builtins[sensor.id];
        return {
          ...(builtin || {}),
          ...sensor,
          options: {
            ...(builtin?.options || {}),
            ...(sensor.options || {}),
            enabled: sensor.enabled ?? sensor.options?.enabled ?? builtin?.options?.enabled ?? false,
          },
        };
      }),
    };
  }

  return {
    sensors: Object.values(builtins).map((sensor) => ({
      ...sensor,
      enabled: enabledIds.has(sensor.id) || boolEnv(`SENSOR_REGISTRY_${sensor.id.toUpperCase()}_ENABLED`, false),
      options: {
        ...sensor.options,
        enabled: enabledIds.has(sensor.id) || boolEnv(`SENSOR_REGISTRY_${sensor.id.toUpperCase()}_ENABLED`, false),
      },
    })),
  };
}

async function applyConfig(registry, config, options = {}) {
  const autostart = options.autostart !== false;
  const configured = [];

  for (const sensor of config.sensors || []) {
    if (!sensor.id) throw new Error('sensor_config_missing_id');
    if (!registry.definitions.has(sensor.id)) {
      if (!sensor.module && !sensor.path) throw new Error(`sensor_config_missing_module:${sensor.id}`);
      registry.load(sensor.module || sensor.path, sensor.id, sensor.defaults || {});
    }

    const { id, module, path: sensorPath, defaults, options: sensorOptions, ...topLevelOptions } = sensor;
    const mergedOptions = { ...topLevelOptions, ...(sensorOptions || {}) };
    if (options.force === true && registry.get(sensor.id)) {
      await registry.stopSensor(sensor.id, { forgetDesired: false }).catch((error) => {
        logger.warn('sensor_registry_reload_stop_failed', {
          sensor: sensor.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    registry.create(sensor.id, mergedOptions, { force: options.force === true });
    configured.push(sensor.id);

    if (autostart && mergedOptions.enabled !== false) {
      await registry.startSensor(sensor.id);
    } else if (mergedOptions.enabled === false) {
      await registry.stopSensor(sensor.id).catch(() => {});
    }
  }

  return configured;
}

const logger = {
  info: jsonLogger('info'),
  warn: jsonLogger('warn'),
  error: jsonLogger('error'),
  log: jsonLogger('info'),
};

const registry = new SensorRegistry({
  logger,
  autoRestart: boolEnv('SENSOR_REGISTRY_AUTO_RESTART', true),
  failureThreshold: numberEnv('SENSOR_REGISTRY_FAILURE_THRESHOLD', 3, 1),
  restartCooldownMs: numberEnv('SENSOR_REGISTRY_RESTART_COOLDOWN_MS', 15000, 1000),
  maxRestarts: numberEnv('SENSOR_REGISTRY_MAX_RESTARTS', 0, 0),
  healthCheckIntervalMs: numberEnv('SENSOR_REGISTRY_HEALTH_INTERVAL_MS', 15000, 1000),
});

let shuttingDown = false;
let ready = false;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      return sendJson(res, 200, {
        service: 'osiris-sensor-registry',
        ready,
        registry: registry.health(),
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/ready') {
      const health = registry.health();
      const ok = ready && health.status !== 'CRITICAL';
      return sendJson(res, ok ? 200 : 503, {
        service: 'osiris-sensor-registry',
        ready: ok,
        registry: health,
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/sensors') {
      return sendJson(res, 200, registry.health());
    }

    if (segments[0] === 'sensors' && segments[1]) {
      const id = segments[1];
      const action = segments[2] || '';

      if (req.method === 'GET' && !action) {
        const sensor = registry.health().sensors.find((item) => item.id === id);
        return sendJson(res, sensor ? 200 : 404, sensor || { error: 'sensor_not_found' });
      }

      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (!requireAdmin(req, res)) return;

      const body = await readJson(req);
      if (action === 'start') {
        const sensor = await registry.startSensor(id, { enabled: true, ...(body.options || {}) });
        return sendJson(res, 202, { sensor: sensor.health(), registry: registry.health() });
      }
      if (action === 'stop') {
        await registry.stopSensor(id);
        return sendJson(res, 202, { registry: registry.health() });
      }
      if (action === 'restart') {
        const sensor = await registry.restartSensor(id, 'manual_api');
        return sendJson(res, 202, { sensor: sensor.health(), registry: registry.health() });
      }

      return sendJson(res, 404, { error: 'unknown_sensor_action' });
    }

    if (req.method === 'POST' && url.pathname === '/reload') {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const config = body.sensors ? body : parseConfig(logger);
      const configured = await applyConfig(registry, config, {
        autostart: boolEnv('SENSOR_REGISTRY_AUTOSTART', true),
        force: true,
      });
      return sendJson(res, 202, { configured, registry: registry.health() });
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    logger.error('sensor_registry_request_failed', { error: errorBody(error).error });
    return sendJson(res, 500, errorBody(error));
  }
});

server.on('error', (error) => {
  logger.error('sensor_registry_server_error', {
    error: error instanceof Error ? error.message : String(error),
    code: error.code || null,
  });
  process.exit(1);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('sensor_registry_shutdown_started', { signal });
  ready = false;
  await registry.stop();
  await new Promise((resolve) => server.close(resolve));
  logger.info('sensor_registry_shutdown_complete');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('sensor_registry_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('sensor_registry_shutdown_failed', { error: error.message });
    process.exit(1);
  });
});

async function start() {
  const port = numberEnv('PORT', 4710, 1);
  const config = parseConfig(logger);

  server.listen(port, env('HOST', '0.0.0.0'), () => {
    logger.info('sensor_registry_listening', {
      port,
      autoRestart: registry.autoRestart,
      autostart: boolEnv('SENSOR_REGISTRY_AUTOSTART', true),
    });
  });

  await applyConfig(registry, config, {
    autostart: boolEnv('SENSOR_REGISTRY_AUTOSTART', true),
  });
  registry.startMonitor();
  ready = true;
}

start().catch((error) => {
  logger.error('sensor_registry_start_failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
