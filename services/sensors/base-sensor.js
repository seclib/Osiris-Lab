'use strict';

const EventEmitter = require('events');
const { createEvent, eventToStreamFields } = require('./event-schema');

function flatFieldArgs(fields) {
  const args = [];
  for (const [key, value] of Object.entries(fields)) {
    args.push(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return args;
}

function asPositiveNumber(value, fallback, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

class BaseSensor extends EventEmitter {
  constructor(options = {}) {
    super();

    if (new.target === BaseSensor) {
      throw new TypeError('BaseSensor is abstract; extend it for a concrete OSINT sensor');
    }

    this.id = String(options.id || options.name || this.constructor.name).trim();
    this.type = String(options.type || '').trim().toLowerCase();
    this.source = String(options.source || this.id).trim();
    this.enabled = options.enabled !== false;
    this.redisUrl = options.redisUrl || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.streamKey = options.streamKey || process.env.OSIRIS_STREAM_KEY || process.env.EVENT_STREAM_KEY || 'osiris.stream';
    this.streamMaxLen = asPositiveNumber(options.streamMaxLen ?? process.env.OSIRIS_STREAM_MAXLEN, 0, 0);
    this.pollIntervalMs = asPositiveNumber(options.pollIntervalMs ?? process.env.SENSOR_POLL_INTERVAL_MS, 60000, 1000);
    this.requestTimeoutMs = asPositiveNumber(options.requestTimeoutMs ?? process.env.SENSOR_REQUEST_TIMEOUT_MS, 8000, 1000);
    this.maxBatchSize = asPositiveNumber(options.maxBatchSize ?? process.env.SENSOR_MAX_BATCH_SIZE, 1000, 1);
    this.maxStreamLength = asPositiveNumber(options.maxStreamLength ?? process.env.SENSOR_MAX_STREAM_LENGTH, 500000, 1000);
    this.backpressurePauseMs = asPositiveNumber(options.backpressurePauseMs ?? process.env.SENSOR_BACKPRESSURE_PAUSE_MS, 5000, 500);
    this.maxConsecutiveFailures = asPositiveNumber(options.maxConsecutiveFailures ?? process.env.SENSOR_MAX_FAILURES, 5, 1);
    this.defaultConfidence = asPositiveNumber(options.defaultConfidence ?? process.env.SENSOR_DEFAULT_CONFIDENCE, 0.7, 0);
    this.defaultConfidence = Math.min(1, this.defaultConfidence > 1 ? this.defaultConfidence / 100 : this.defaultConfidence);
    this.logger = options.logger || console;
    this.client = options.redisClient || null;
    this.ownsClient = !options.redisClient;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.connected = false;
    this.stats = {
      status: this.enabled ? 'INIT' : 'DISABLED',
      polls: 0,
      published: 0,
      rejected: 0,
      failures: 0,
      consecutiveFailures: 0,
      backpressureSkips: 0,
      lastPollAt: null,
      lastSuccessAt: null,
      lastPublishedAt: null,
      lastError: null,
      lastLatencyMs: null,
    };
  }

  async connect() {
    if (this.client) {
      this.connected = true;
      return;
    }

    let createClient;
    try {
      ({ createClient } = require('redis'));
    } catch (error) {
      throw new Error('redis_dependency_missing: run npm install in services/sensors');
    }

    this.client = createClient({ url: this.redisUrl });
    this.client.on('error', (error) => {
      this.connected = false;
      this.stats.lastError = error.message;
      this.log('warn', 'sensor_redis_error', { error: error.message });
    });
    this.client.on('ready', () => {
      this.connected = true;
      this.log('info', 'sensor_redis_ready', { stream: this.streamKey });
    });
    await this.client.connect();
  }

  async close() {
    if (this.ownsClient && this.client?.isOpen) await this.client.quit();
    this.connected = false;
  }

  async start({ immediate = true } = {}) {
    if (!this.enabled) {
      this.stats.status = 'DISABLED';
      return;
    }

    this.validateConfiguration();
    await this.connect();
    await this.onStart();
    this.stopped = false;
    this.stats.status = 'STARTING';
    if (immediate) this.schedule(0);
    else this.schedule(this.pollIntervalMs);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.onStop();
    await this.close();
    this.stats.status = 'STOPPED';
  }

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runOnce().catch((error) => {
        this.handleFailure(error, Date.now());
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async runOnce() {
    if (this.running || this.stopped || !this.enabled) return this.health();

    this.running = true;
    const started = Date.now();
    this.stats.polls += 1;
    this.stats.lastPollAt = new Date(started).toISOString();

    try {
      const backpressure = await this.shouldPauseForBackpressure();
      if (backpressure.pause) {
        this.stats.status = 'DEGRADED';
        this.stats.backpressureSkips += 1;
        this.log('warn', 'sensor_backpressure_pause', {
          stream: this.streamKey,
          streamLength: backpressure.length,
          pauseMs: this.backpressurePauseMs,
        });
        return this.health();
      }

      const rawRecords = await this.collect();
      const records = Array.isArray(rawRecords) ? rawRecords : rawRecords ? [rawRecords] : [];
      const events = [];
      const rejected = [];

      for (const [index, record] of records.slice(0, this.maxBatchSize).entries()) {
        try {
          events.push(this.normalize(record));
        } catch (error) {
          rejected.push({
            index,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (records.length > this.maxBatchSize) {
        rejected.push({ reason: `batch_limit_exceeded:${records.length - this.maxBatchSize}` });
      }

      const published = await this.publishBatch(events);
      this.stats.status = 'OK';
      this.stats.published += published.accepted;
      this.stats.rejected += rejected.length + published.rejected;
      this.stats.consecutiveFailures = 0;
      this.stats.lastSuccessAt = new Date().toISOString();
      this.stats.lastLatencyMs = Date.now() - started;
      this.stats.lastError = null;

      this.emit('poll', {
        sensor: this.id,
        collected: records.length,
        normalized: events.length,
        published: published.accepted,
        rejected: rejected.length + published.rejected,
        latencyMs: this.stats.lastLatencyMs,
      });

      this.log('info', 'sensor_poll_complete', {
        collected: records.length,
        normalized: events.length,
        published: published.accepted,
        rejected: rejected.length + published.rejected,
        latencyMs: this.stats.lastLatencyMs,
      });

      return this.health();
    } catch (error) {
      this.handleFailure(error, started);
      return this.health();
    } finally {
      this.running = false;
      if (!this.stopped) this.schedule(this.nextDelayMs());
    }
  }

  async collect() {
    throw new Error('collect_not_implemented');
  }

  normalize(record) {
    return createEvent({
      ...record,
      type: record?.type || this.type,
      source: record?.source || this.source,
      confidence: record?.confidence ?? this.defaultConfidence,
      metadata: {
        sensor_id: this.id,
        ...(record?.metadata && typeof record.metadata === 'object' ? record.metadata : {}),
      },
    });
  }

  async fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'user-agent': `OSIRIS-Sensor/${this.id}`,
          ...(options.headers || {}),
        },
        body: options.body,
      });

      if (!response.ok) throw new Error(`http_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  xAddArgs(event) {
    const args = ['XADD', this.streamKey];
    if (this.streamMaxLen > 0) args.push('MAXLEN', '~', String(this.streamMaxLen));
    args.push('*', ...flatFieldArgs(eventToStreamFields(event)));
    return args;
  }

  async publish(event) {
    const streamId = await this.client.sendCommand(this.xAddArgs(event));
    this.stats.lastPublishedAt = new Date().toISOString();
    return streamId;
  }

  async publishBatch(events) {
    let accepted = 0;
    let rejected = 0;
    const streamIds = [];

    for (const event of events) {
      try {
        streamIds.push(await this.publish(event));
        accepted += 1;
      } catch (error) {
        rejected += 1;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        this.log('warn', 'sensor_publish_failed', {
          id: event?.id,
          type: event?.type,
          error: this.stats.lastError,
        });
      }
    }

    return { accepted, rejected, streamIds };
  }

  async streamLength() {
    try {
      return Number(await this.client.sendCommand(['XLEN', this.streamKey]));
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      return 0;
    }
  }

  async shouldPauseForBackpressure() {
    const length = await this.streamLength();
    return { pause: length >= this.maxStreamLength, length };
  }

  nextDelayMs() {
    if (this.stats.consecutiveFailures <= 0) return this.pollIntervalMs;
    const factor = 2 ** Math.min(this.stats.consecutiveFailures, this.maxConsecutiveFailures);
    return Math.min(this.pollIntervalMs * factor, this.pollIntervalMs + 60000);
  }

  handleFailure(error, started) {
    this.stats.status = 'DEGRADED';
    this.stats.failures += 1;
    this.stats.consecutiveFailures += 1;
    this.stats.lastError = error instanceof Error ? error.message : String(error);
    this.stats.lastLatencyMs = Date.now() - started;
    this.emit('failure', error);
    this.log('warn', 'sensor_poll_failed', {
      error: this.stats.lastError,
      latencyMs: this.stats.lastLatencyMs,
      consecutiveFailures: this.stats.consecutiveFailures,
    });
  }

  validateConfiguration() {
    if (!this.id) throw new Error('sensor_id_required');
    if (!this.type) throw new Error('sensor_type_required');
    if (!this.source) throw new Error('sensor_source_required');
    if (!this.streamKey) throw new Error('sensor_stream_key_required');
  }

  health() {
    return {
      id: this.id,
      type: this.type,
      source: this.source,
      enabled: this.enabled,
      stream: this.streamKey,
      connected: this.connected,
      running: this.running,
      ...this.stats,
    };
  }

  log(level, message, fields = {}) {
    const logger = this.logger?.[level] || this.logger?.log || console.log;
    logger.call(this.logger, message, {
      sensor: this.id,
      type: this.type,
      source: this.source,
      ...fields,
    });
  }

  async onStart() {}

  async onStop() {}
}

module.exports = { BaseSensor };
