'use strict';

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function numberEnv(name, fallback, options = {}) {
  const parsed = Number(process.env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  if (typeof options.min === 'number' && value < options.min) return options.min;
  if (typeof options.max === 'number' && value > options.max) return options.max;
  return value;
}

function csvEnv(name) {
  return env(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function prefixedHeader(name, value, scheme) {
  if (!value) return null;
  return {
    name,
    value: scheme ? `${scheme} ${value}` : value,
  };
}

function authHeaders(prefix) {
  const mode = env(`${prefix}_AUTH_MODE`, 'none').toLowerCase();
  const headers = {};

  if (mode === 'basic') {
    const username = env(`${prefix}_USERNAME`, env(`${prefix}_CLIENT_ID`));
    const password = env(`${prefix}_PASSWORD`, env(`${prefix}_CLIENT_SECRET`));
    if (username || password) {
      headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
  }

  if (mode === 'bearer') {
    const token = env(`${prefix}_TOKEN`, env(`${prefix}_API_KEY`));
    if (token) headers.authorization = `Bearer ${token}`;
  }

  if (mode === 'api-key') {
    const header = env(`${prefix}_API_KEY_HEADER`, 'x-api-key');
    const key = env(`${prefix}_API_KEY`);
    if (key) headers[header.toLowerCase()] = key;
  }

  const customHeader = prefixedHeader(
    env(`${prefix}_CUSTOM_AUTH_HEADER`),
    env(`${prefix}_CUSTOM_AUTH_VALUE`),
    env(`${prefix}_CUSTOM_AUTH_SCHEME`),
  );
  if (customHeader) headers[customHeader.name.toLowerCase()] = customHeader.value;

  return headers;
}

function loadConfig() {
  const adsbEnabled = boolEnv('ADSB_ENABLED', boolEnv('MODULE_ADSB_ENABLED', false));
  const aisEnabled = boolEnv('AIS_ENABLED', boolEnv('MODULE_AIS_ENABLED', false));

  return {
    serviceName: env('SERVICE_NAME', 'osiris-tracking-service'),
    host: env('HOST', '0.0.0.0'),
    port: numberEnv('PORT', 4201, { min: 1, max: 65535 }),
    logLevel: env('LOG_LEVEL', 'info'),
    shutdownGraceMs: numberEnv('SHUTDOWN_GRACE_MS', 10000, { min: 1000 }),

    redis: {
      url: env('REDIS_URL'),
      keyPrefix: env('REDIS_KEY_PREFIX', 'osiris:tracks'),
      ttlSeconds: numberEnv('TRACK_CACHE_TTL_SECONDS', 900, { min: 30 }),
      streamKey: env('TRACK_STREAM_KEY', 'osiris:streams:tracks.normalized'),
      publishChannel: env('TRACK_UPDATES_CHANNEL', 'osiris:tracks:updates'),
      eventStreamEnabled: boolEnv('EVENT_STREAM_ENABLED', true),
      eventStreamKey: env('EVENT_STREAM_KEY', 'osiris.stream'),
      eventStreamMaxLen: numberEnv('EVENT_STREAM_MAXLEN', 0, { min: 0 }),
      enabled: boolEnv('REDIS_ENABLED', Boolean(env('REDIS_URL'))),
    },

    api: {
      ingestToken: env('TRACK_INGEST_TOKEN'),
      maxBodyBytes: numberEnv('MAX_BODY_BYTES', 2_000_000, { min: 4096 }),
      corsOrigin: env('CORS_ORIGIN', '*'),
    },

    freshness: {
      aircraftStaleAfterSeconds: numberEnv('AIRCRAFT_STALE_AFTER_SECONDS', 120, { min: 10 }),
      vesselStaleAfterSeconds: numberEnv('VESSEL_STALE_AFTER_SECONDS', 600, { min: 30 }),
      hardDeleteAfterSeconds: numberEnv('TRACK_HARD_DELETE_AFTER_SECONDS', 7200, { min: 600 }),
    },

    ingestion: {
      requestTimeoutMs: numberEnv('PROVIDER_TIMEOUT_MS', 8000, { min: 1000 }),
      retryCount: numberEnv('PROVIDER_RETRY_COUNT', 2, { min: 0, max: 5 }),
      retryBaseMs: numberEnv('PROVIDER_RETRY_BASE_MS', 500, { min: 100 }),
      retryMaxMs: numberEnv('PROVIDER_RETRY_MAX_MS', 30000, { min: 1000 }),
    },

    adsb: {
      enabled: adsbEnabled,
      provider: env('ADSB_PROVIDER', 'opensky'),
      url: env('ADSB_URL', 'https://opensky-network.org/api/states/all'),
      fallbackUrls: csvEnv('ADSB_FALLBACK_URLS'),
      pollSeconds: numberEnv('ADSB_POLL_SECONDS', 15, { min: 5 }),
      minRequestSpacingMs: numberEnv('ADSB_MIN_REQUEST_SPACING_MS', 5000, { min: 1000 }),
      headers: {
        ...authHeaders('ADSB'),
        ...authHeaders('OPENSKY'),
      },
    },

    ais: {
      enabled: aisEnabled,
      provider: env('AIS_PROVIDER', 'generic-http'),
      url: env('AIS_URL', env('VESSEL_API_URL')),
      websocketUrl: env('AIS_WS_URL'),
      fallbackUrls: csvEnv('AIS_FALLBACK_URLS'),
      pollSeconds: numberEnv('AIS_POLL_SECONDS', 30, { min: 10 }),
      minRequestSpacingMs: numberEnv('AIS_MIN_REQUEST_SPACING_MS', 10000, { min: 1000 }),
      headers: {
        ...authHeaders('AIS'),
        ...authHeaders('VESSEL'),
      },
    },
  };
}

module.exports = {
  boolEnv,
  csvEnv,
  env,
  loadConfig,
  numberEnv,
};
