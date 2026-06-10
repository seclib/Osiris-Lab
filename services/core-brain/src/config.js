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

function loadConfig() {
  const inputStream = env('BRAIN_INPUT_STREAM', env('EVENT_STREAM_KEY', 'osiris.stream'));
  const outputStream = env('BRAIN_OUTPUT_STREAM', 'osiris.intelligence');

  return {
    serviceName: env('SERVICE_NAME', 'osiris-core-brain'),
    host: env('HOST', '0.0.0.0'),
    port: numberEnv('PORT', 4400, { min: 1, max: 65535 }),
    logLevel: env('LOG_LEVEL', 'info'),
    shutdownGraceMs: numberEnv('SHUTDOWN_GRACE_MS', 10000, { min: 1000 }),
    enabled: boolEnv('MODULE_INTELLIGENCE_ENABLED', true),

    redis: {
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
      inputStream,
      outputStream,
      alertStream: env('BRAIN_ALERT_STREAM', `${outputStream}.alerts`),
      insightStream: env('BRAIN_INSIGHT_STREAM', 'osiris.insights'),
      dlqStream: env('BRAIN_DLQ_STREAM', `${outputStream}.dlq`),
      channel: env('BRAIN_PUBSUB_CHANNEL', 'osiris.intelligence.events'),
      alertChannel: env('BRAIN_ALERT_CHANNEL', 'osiris.intelligence.alerts'),
      insightChannel: env('BRAIN_INSIGHT_CHANNEL', 'osiris.insights.events'),
      group: env('BRAIN_CONSUMER_GROUP', 'osiris-core-brain'),
      consumer: env('BRAIN_CONSUMER_NAME', `${os.hostname()}-${process.pid}`),
      readCount: numberEnv('BRAIN_READ_COUNT', 100, { min: 1, max: 1000 }),
      blockMs: numberEnv('BRAIN_BLOCK_MS', 5000, { min: 100 }),
      claimCount: numberEnv('BRAIN_CLAIM_COUNT', 100, { min: 1, max: 1000 }),
      minIdleMs: numberEnv('BRAIN_MIN_IDLE_MS', 60000, { min: 1000 }),
      maxRetries: numberEnv('BRAIN_MAX_RETRIES', 5, { min: 0, max: 100 }),
      outputMaxLen: numberEnv('BRAIN_OUTPUT_MAXLEN', 250000, { min: 0 }),
      alertMaxLen: numberEnv('BRAIN_ALERT_MAXLEN', 100000, { min: 0 }),
      insightMaxLen: numberEnv('BRAIN_INSIGHT_MAXLEN', 250000, { min: 0 }),
      dlqMaxLen: numberEnv('BRAIN_DLQ_MAXLEN', 100000, { min: 0 }),
    },

    state: {
      entityTtlMs: numberEnv('BRAIN_ENTITY_TTL_MS', 30 * 60 * 1000, { min: 60000 }),
      hazardTtlMs: numberEnv('BRAIN_HAZARD_TTL_MS', 6 * 60 * 60 * 1000, { min: 60000 }),
      maxEntityHistory: numberEnv('BRAIN_ENTITY_HISTORY', 12, { min: 2, max: 200 }),
      maxEntities: numberEnv('BRAIN_MAX_ENTITIES', 50000, { min: 1000 }),
      maxHazards: numberEnv('BRAIN_MAX_HAZARDS', 20000, { min: 100 }),
      dedupeTtlMs: numberEnv('BRAIN_ALERT_DEDUPE_TTL_MS', 15 * 60 * 1000, { min: 10000 }),
    },

    detection: {
      minTrackDtSeconds: numberEnv('BRAIN_MIN_TRACK_DT_SECONDS', 5, { min: 1 }),
      speedJumpKnots: numberEnv('BRAIN_SPEED_JUMP_KNOTS', 160, { min: 10 }),
      headingJumpDegrees: numberEnv('BRAIN_HEADING_JUMP_DEGREES', 75, { min: 10, max: 180 }),
      aircraftHazardRadiusKm: numberEnv('BRAIN_AIRCRAFT_HAZARD_RADIUS_KM', 75, { min: 1 }),
      vesselHazardRadiusKm: numberEnv('BRAIN_VESSEL_HAZARD_RADIUS_KM', 100, { min: 1 }),
      hazardHazardRadiusKm: numberEnv('BRAIN_HAZARD_CORRELATION_RADIUS_KM', 150, { min: 1 }),
      densityGridKm: numberEnv('BRAIN_DENSITY_GRID_KM', 25, { min: 1 }),
      densityWindowMs: numberEnv('BRAIN_DENSITY_WINDOW_MS', 10 * 60 * 1000, { min: 60000 }),
      densityThreshold: numberEnv('BRAIN_DENSITY_THRESHOLD', 40, { min: 2 }),
    },

    backpressure: {
      maxPending: numberEnv('BRAIN_BACKPRESSURE_MAX_PENDING', 50000, { min: 0 }),
      sleepMs: numberEnv('BRAIN_BACKPRESSURE_SLEEP_MS', 500, { min: 50, max: 30000 }),
    },

    alerting: {
      minScore: numberEnv('BRAIN_ALERT_MIN_SCORE', 70, { min: 0, max: 100 }),
      minRisk: numberEnv('BRAIN_ALERT_MIN_RISK', 60, { min: 0, max: 100 }),
      minConfidence: numberEnv('BRAIN_ALERT_MIN_CONFIDENCE', 55, { min: 0, max: 100 }),
      criticalScore: numberEnv('BRAIN_CRITICAL_SCORE', 88, { min: 0, max: 100 }),
    },
  };
}

module.exports = {
  boolEnv,
  env,
  loadConfig,
  numberEnv,
};
