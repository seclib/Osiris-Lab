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

function defaultFeeds() {
  return [
    {
      id: 'tracking',
      type: 'tracking',
      url: env('OSIRIS_BRAIN_TRACKING_URL', 'http://osiris-tracking:4201/tracks?limit=10000&stale=false'),
      pollSeconds: numberEnv('OSIRIS_BRAIN_TRACKING_POLL_SECONDS', 15, { min: 5 }),
      enabled: boolEnv('OSIRIS_BRAIN_TRACKING_ENABLED', true),
      source: 'osiris-tracking',
    },
    {
      id: 'earthquakes',
      type: 'quake',
      url: env('OSIRIS_BRAIN_EARTHQUAKES_URL', 'http://osiris:3000/api/earthquakes'),
      pollSeconds: numberEnv('OSIRIS_BRAIN_EARTHQUAKES_POLL_SECONDS', 60, { min: 15 }),
      enabled: boolEnv('OSIRIS_BRAIN_EARTHQUAKES_ENABLED', true),
      source: 'osiris-earthquakes',
    },
    {
      id: 'wildfires',
      type: 'wildfire',
      url: env('OSIRIS_BRAIN_WILDFIRES_URL', 'http://osiris:3000/api/fires'),
      pollSeconds: numberEnv('OSIRIS_BRAIN_WILDFIRES_POLL_SECONDS', 300, { min: 60 }),
      enabled: boolEnv('OSIRIS_BRAIN_WILDFIRES_ENABLED', true),
      source: 'osiris-wildfires',
    },
    {
      id: 'weather',
      type: 'weather',
      url: env('OSIRIS_BRAIN_WEATHER_URL', 'http://osiris:3000/api/weather'),
      pollSeconds: numberEnv('OSIRIS_BRAIN_WEATHER_POLL_SECONDS', 120, { min: 30 }),
      enabled: boolEnv('OSIRIS_BRAIN_WEATHER_ENABLED', true),
      source: 'osiris-weather',
    },
  ];
}

function normalizeFeed(feed, index) {
  const id = String(feed.id || `feed-${index + 1}`);
  return {
    id,
    type: String(feed.type || id).toLowerCase(),
    url: String(feed.url || ''),
    pollSeconds: Math.max(5, Number(feed.pollSeconds || feed.poll_seconds || 60)),
    enabled: feed.enabled !== false,
    source: String(feed.source || id),
    timeoutMs: Math.max(1000, Number(feed.timeoutMs || feed.timeout_ms || process.env.OSIRIS_BRAIN_REQUEST_TIMEOUT_MS || 8000)),
    headers: feed.headers && typeof feed.headers === 'object' ? feed.headers : {},
  };
}

function parseFeedsJson() {
  const raw = env('OSIRIS_BRAIN_FEEDS_JSON');
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('OSIRIS_BRAIN_FEEDS_JSON must be a JSON array');
  return parsed;
}

function parseFeedsString() {
  const raw = env('OSIRIS_BRAIN_FEEDS');
  if (!raw) return null;
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, type, url, pollSeconds = '60', enabled = 'true'] = entry.split('|').map((part) => part.trim());
      return {
        id,
        type,
        url,
        pollSeconds: Number(pollSeconds),
        enabled: !['0', 'false', 'no', 'off', 'disabled'].includes(enabled.toLowerCase()),
      };
    });
}

function loadFeeds() {
  const configured = parseFeedsJson() || parseFeedsString() || defaultFeeds();
  return configured
    .map(normalizeFeed)
    .filter((feed) => feed.url);
}

function loadConfig() {
  const streamKey = env('OSIRIS_BRAIN_STREAM_KEY', env('EVENT_STREAM_KEY', 'osiris.stream'));

  return {
    serviceName: env('SERVICE_NAME', 'osiris-brain'),
    enabled: boolEnv('OSIRIS_BRAIN_ENABLED', true),
    host: env('HOST', '0.0.0.0'),
    port: numberEnv('PORT', 4500, { min: 1, max: 65535 }),
    logLevel: env('LOG_LEVEL', 'info'),
    userAgent: env('OSIRIS_BRAIN_USER_AGENT', 'OSIRIS-BrainBridge/1.0'),
    shutdownGraceMs: numberEnv('SHUTDOWN_GRACE_MS', 10000, { min: 1000 }),
    maxEventsPerPoll: numberEnv('OSIRIS_BRAIN_MAX_EVENTS_PER_POLL', 10000, { min: 1 }),
    includeRawPayload: boolEnv('OSIRIS_BRAIN_INCLUDE_RAW_PAYLOAD', false),
    dedupeTtlMs: numberEnv('OSIRIS_BRAIN_DEDUPE_TTL_MS', 900000, { min: 30000 }),
    feeds: loadFeeds(),
    redis: {
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
      streamKey,
      eventMaxLen: numberEnv('OSIRIS_BRAIN_STREAM_MAXLEN', numberEnv('EVENT_STREAM_MAXLEN', 0, { min: 0 }), { min: 0 }),
    },
    backpressure: {
      maxStreamLength: numberEnv('OSIRIS_BRAIN_BACKPRESSURE_LENGTH', 500000, { min: 1000 }),
      pauseMs: numberEnv('OSIRIS_BRAIN_BACKPRESSURE_PAUSE_MS', 5000, { min: 500 }),
    },
    instance: {
      host: os.hostname(),
      pid: process.pid,
    },
  };
}

module.exports = {
  boolEnv,
  env,
  loadConfig,
  numberEnv,
};
