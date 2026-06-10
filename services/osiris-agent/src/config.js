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
  const inputStream = env('OSIRIS_AGENT_INPUT_STREAM', env('EVENT_STREAM_KEY', 'osiris.stream'));
  const outputStream = env('OSIRIS_AGENT_OUTPUT_STREAM', 'osiris.insights');

  return {
    serviceName: env('SERVICE_NAME', 'osiris-agent'),
    enabled: boolEnv('OSIRIS_AGENT_ENABLED', true),
    host: env('HOST', '0.0.0.0'),
    port: numberEnv('PORT', 4600, { min: 1, max: 65535 }),
    logLevel: env('LOG_LEVEL', 'info'),
    shutdownGraceMs: numberEnv('SHUTDOWN_GRACE_MS', 10000, { min: 1000 }),
    redis: {
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
      inputStream,
      outputStream,
      dlqStream: env('OSIRIS_AGENT_DLQ_STREAM', `${outputStream}.dlq`),
      group: env('OSIRIS_AGENT_CONSUMER_GROUP', 'osiris-agent'),
      consumer: env('OSIRIS_AGENT_CONSUMER_NAME', `${os.hostname()}-${process.pid}`),
      readCount: numberEnv('OSIRIS_AGENT_READ_COUNT', 100, { min: 1, max: 1000 }),
      blockMs: numberEnv('OSIRIS_AGENT_BLOCK_MS', 5000, { min: 100 }),
      minIdleMs: numberEnv('OSIRIS_AGENT_MIN_IDLE_MS', 60000, { min: 1000 }),
      claimCount: numberEnv('OSIRIS_AGENT_CLAIM_COUNT', 100, { min: 1, max: 1000 }),
      maxRetries: numberEnv('OSIRIS_AGENT_MAX_RETRIES', 5, { min: 0, max: 100 }),
      outputMaxLen: numberEnv('OSIRIS_AGENT_OUTPUT_MAXLEN', 100000, { min: 0 }),
      dlqMaxLen: numberEnv('OSIRIS_AGENT_DLQ_MAXLEN', 100000, { min: 0 }),
    },
    processing: {
      concurrency: numberEnv('OSIRIS_AGENT_CONCURRENCY', 8, { min: 1, max: 128 }),
      maxPending: numberEnv('OSIRIS_AGENT_BACKPRESSURE_MAX_PENDING', 50000, { min: 100 }),
      backpressureSleepMs: numberEnv('OSIRIS_AGENT_BACKPRESSURE_SLEEP_MS', 500, { min: 50 }),
      emitBelowThreshold: boolEnv('OSIRIS_AGENT_EMIT_LOW_RISK', false),
      minInsightScore: numberEnv('OSIRIS_AGENT_MIN_INSIGHT_SCORE', 25, { min: 0, max: 100 }),
      alertMinScore: numberEnv('OSIRIS_AGENT_ALERT_MIN_SCORE', 75, { min: 0, max: 100 }),
    },
    state: {
      entityTtlMs: numberEnv('OSIRIS_AGENT_ENTITY_TTL_MS', 1800000, { min: 60000 }),
      hazardTtlMs: numberEnv('OSIRIS_AGENT_HAZARD_TTL_MS', 21600000, { min: 300000 }),
      maxEvents: numberEnv('OSIRIS_AGENT_STATE_MAX_EVENTS', 20000, { min: 1000 }),
      correlationRadiusKm: numberEnv('OSIRIS_AGENT_CORRELATION_RADIUS_KM', 120, { min: 1 }),
      correlationWindowMs: numberEnv('OSIRIS_AGENT_CORRELATION_WINDOW_MS', 3600000, { min: 60000 }),
      clusterRadiusKm: numberEnv('OSIRIS_AGENT_CLUSTER_RADIUS_KM', 80, { min: 1 }),
      clusterWindowMs: numberEnv('OSIRIS_AGENT_CLUSTER_WINDOW_MS', 1800000, { min: 60000 }),
    },
    ollama: {
      enabled: boolEnv('OSIRIS_AGENT_OLLAMA_ENABLED', false),
      url: env('OLLAMA_URL', env('OSIRIS_AGENT_OLLAMA_URL', 'http://ollama:11434')).replace(/\/$/, ''),
      model: env('OLLAMA_MODEL', env('OSIRIS_AGENT_OLLAMA_MODEL', 'qwen2.5:7b-instruct')),
      timeoutMs: numberEnv('OSIRIS_AGENT_OLLAMA_TIMEOUT_MS', 2500, { min: 250 }),
      minScore: numberEnv('OSIRIS_AGENT_OLLAMA_MIN_SCORE', 55, { min: 0, max: 100 }),
    },
  };
}

module.exports = {
  boolEnv,
  env,
  loadConfig,
  numberEnv,
};
