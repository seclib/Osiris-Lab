'use strict';

const os = require('os');

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

function headerEnv(prefix) {
  const headers = {
    accept: 'application/json',
    'user-agent': env('EVENT_BUS_USER_AGENT', 'OSIRIS-EventBus/1.0'),
  };
  const apiKey = env(`${prefix}_API_KEY`);
  if (apiKey) {
    const header = env(`${prefix}_API_KEY_HEADER`, 'authorization').toLowerCase();
    const scheme = env(`${prefix}_API_KEY_SCHEME`, header === 'authorization' ? 'Bearer' : '');
    headers[header] = scheme ? `${scheme} ${apiKey}` : apiKey;
  }
  return headers;
}

function feedConfig(id, defaults) {
  return {
    id,
    type: defaults.type,
    enabled: boolEnv(defaults.enabledEnv, defaults.enabledFallback),
    url: env(defaults.urlEnv, defaults.url),
    fallbackUrls: env(defaults.fallbackEnv, '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    pollSeconds: numberEnv(defaults.pollEnv, defaults.pollSeconds, { min: defaults.minPollSeconds || 15 }),
    timeoutMs: numberEnv(`${defaults.prefix}_TIMEOUT_MS`, numberEnv('EVENT_FEED_TIMEOUT_MS', 10000, { min: 1000 }), { min: 1000 }),
    retryCount: numberEnv(`${defaults.prefix}_RETRY_COUNT`, numberEnv('EVENT_FEED_RETRY_COUNT', 2, { min: 0, max: 5 }), { min: 0, max: 5 }),
    retryBaseMs: numberEnv(`${defaults.prefix}_RETRY_BASE_MS`, numberEnv('EVENT_FEED_RETRY_BASE_MS', 500, { min: 100 }), { min: 100 }),
    retryMaxMs: numberEnv(`${defaults.prefix}_RETRY_MAX_MS`, numberEnv('EVENT_FEED_RETRY_MAX_MS', 30000, { min: 1000 }), { min: 1000 }),
    headers: headerEnv(defaults.prefix),
    source: defaults.source,
  };
}

function loadConfig() {
  const streamKey = env('EVENT_STREAM_KEY', 'osiris.stream');

  return {
    serviceName: env('SERVICE_NAME', 'osiris-event-bus'),
    host: env('HOST', '0.0.0.0'),
    port: numberEnv('PORT', 4300, { min: 1, max: 65535 }),
    logLevel: env('LOG_LEVEL', 'info'),
    shutdownGraceMs: numberEnv('SHUTDOWN_GRACE_MS', 10000, { min: 1000 }),
    mode: env('EVENT_BUS_MODE', 'all').toLowerCase(),

    redis: {
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
      streamKey,
      dlqStreamKey: env('EVENT_DLQ_STREAM_KEY', `${streamKey}.dlq`),
      processedStreamKey: env('EVENT_PROCESSED_STREAM_KEY', `${streamKey}.processed`),
      processedChannel: env('EVENT_PROCESSED_CHANNEL', 'osiris.events.processed'),
      group: env('EVENT_CONSUMER_GROUP', 'osiris-intelligence'),
      consumer: env('EVENT_CONSUMER_NAME', `${os.hostname()}-${process.pid}`),
      readCount: numberEnv('EVENT_CONSUMER_READ_COUNT', 100, { min: 1, max: 1000 }),
      blockMs: numberEnv('EVENT_CONSUMER_BLOCK_MS', 5000, { min: 100 }),
      claimCount: numberEnv('EVENT_CONSUMER_CLAIM_COUNT', 100, { min: 1, max: 1000 }),
      minIdleMs: numberEnv('EVENT_CONSUMER_MIN_IDLE_MS', 60000, { min: 1000 }),
      maxRetries: numberEnv('EVENT_CONSUMER_MAX_RETRIES', 5, { min: 0, max: 100 }),
      eventMaxLen: numberEnv('EVENT_STREAM_MAXLEN', 0, { min: 0 }),
      processedMaxLen: numberEnv('EVENT_PROCESSED_STREAM_MAXLEN', 100000, { min: 0 }),
      dlqMaxLen: numberEnv('EVENT_DLQ_STREAM_MAXLEN', 100000, { min: 0 }),
    },

    backpressure: {
      maxStreamLength: numberEnv('EVENT_STREAM_BACKPRESSURE_LENGTH', 500000, { min: 1000 }),
      maxPending: numberEnv('EVENT_STREAM_BACKPRESSURE_PENDING', 50000, { min: 100 }),
      pauseMs: numberEnv('EVENT_BACKPRESSURE_PAUSE_MS', 5000, { min: 500 }),
    },

    feeds: [
      feedConfig('weather', {
        type: 'weather',
        prefix: 'WEATHER',
        source: 'nws',
        enabledEnv: 'EVENT_WEATHER_ENABLED',
        enabledFallback: boolEnv('MODULE_WEATHER_ENABLED', false),
        urlEnv: 'WEATHER_FEED_URL',
        url: 'https://api.weather.gov/alerts/active',
        fallbackEnv: 'WEATHER_FALLBACK_URLS',
        pollEnv: 'WEATHER_POLL_SECONDS',
        pollSeconds: 120,
        minPollSeconds: 30,
      }),
      feedConfig('earthquakes', {
        type: 'quake',
        prefix: 'QUAKE',
        source: 'usgs',
        enabledEnv: 'EVENT_EARTHQUAKES_ENABLED',
        enabledFallback: boolEnv('MODULE_EARTHQUAKES_ENABLED', false),
        urlEnv: 'QUAKE_FEED_URL',
        url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
        fallbackEnv: 'QUAKE_FALLBACK_URLS',
        pollEnv: 'QUAKE_POLL_SECONDS',
        pollSeconds: 60,
        minPollSeconds: 15,
      }),
      feedConfig('wildfires', {
        type: 'wildfire',
        prefix: 'WILDFIRE',
        source: 'eonet',
        enabledEnv: 'EVENT_WILDFIRES_ENABLED',
        enabledFallback: boolEnv('MODULE_WILDFIRES_ENABLED', false),
        urlEnv: 'WILDFIRE_FEED_URL',
        url: 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&limit=100',
        fallbackEnv: 'WILDFIRE_FALLBACK_URLS',
        pollEnv: 'WILDFIRE_POLL_SECONDS',
        pollSeconds: 300,
        minPollSeconds: 60,
      }),
    ],
  };
}

module.exports = {
  boolEnv,
  env,
  loadConfig,
  numberEnv,
};
