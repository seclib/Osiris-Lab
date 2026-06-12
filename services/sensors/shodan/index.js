'use strict';

const http = require('http');
const { createClient } = require('redis');

const { ShodanClient } = require('./client');
const { loadConfig, publicConfig, validateConfig } = require('./config');
const { createLogger } = require('./logger');
const { RateLimiter } = require('./rateLimiter');
const {
  eventFingerprint,
  transformHostRecord,
  transformSearchResponse,
} = require('./transformer');

const SAFETY_POLICY = Object.freeze({
  purpose: 'OSINT Internet Exposure Intelligence',
  allowed: [
    'GET /shodan/host/{ip}',
    'GET /shodan/host/search',
  ],
  forbidden: [
    'active scanning',
    'network probing',
    'login attempts',
    'brute force',
    'vulnerability exploitation',
    'POST /shodan/scan',
    'POST /shodan/scan/internet',
  ],
});

class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = Math.max(0, Number(ttlMs || 0));
    this.store = new Map();
  }

  get(key) {
    if (!this.ttlMs) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (!ttlMs) return;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  prune() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size() {
    this.prune();
    return this.store.size;
  }
}

class RedisEventPublisher {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    this.client = createClient({ url: this.config.redis.url });
    this.client.on('error', (error) => {
      this.connected = false;
      this.logger.warn('shodan_redis_error', { error: error.message });
    });
    this.client.on('ready', () => {
      this.connected = true;
      this.logger.info('shodan_redis_ready', { stream: this.config.redis.streamKey });
    });
    await this.client.connect();
  }

  async close() {
    if (this.client?.isOpen) await this.client.quit();
    this.connected = false;
  }

  async streamLength() {
    if (!this.client?.isOpen) return 0;
    return Number(await this.client.sendCommand(['XLEN', this.config.redis.streamKey]));
  }

  xaddArgs(event) {
    const args = ['XADD', this.config.redis.streamKey];
    if (this.config.redis.streamMaxLen > 0) {
      args.push('MAXLEN', '~', String(this.config.redis.streamMaxLen));
    }
    args.push('*', 'event', JSON.stringify(event));
    return args;
  }

  async publish(event) {
    return this.client.sendCommand(this.xaddArgs(event));
  }
}

class ShodanSensorService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.client = new ShodanClient({
      apiKey: config.apiKey,
      baseUrl: config.apiBase,
      timeoutMs: config.requestTimeoutMs,
      retryCount: config.retry.count,
      retryBaseMs: config.retry.baseMs,
      retryMaxMs: config.retry.maxMs,
      rateLimiter: this.rateLimiter,
      logger,
      userAgent: config.userAgent,
    });
    this.publisher = new RedisEventPublisher(config, logger);
    this.cache = new TtlCache(config.cache.ttlMs);
    this.dedupe = new TtlCache(config.dedupe.ttlMs);
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.stats = {
      status: config.enabled ? 'INIT' : 'DISABLED',
      polls: 0,
      published: 0,
      skippedDedup: 0,
      backpressureSkips: 0,
      cacheHits: 0,
      failures: 0,
      lastPollAt: null,
      lastSuccessAt: null,
      lastPublishedAt: null,
      lastError: null,
      lastLatencyMs: null,
    };
  }

  async start() {
    if (!this.config.enabled) {
      this.stats.status = 'DISABLED';
      return;
    }

    validateConfig(this.config);
    await this.publisher.connect();
    this.stopped = false;
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.publisher.close();
    this.stats.status = 'STOPPED';
  }

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.runOnce().catch((error) => this.handleFailure(error, Date.now()));
    }, delayMs);
    this.timer.unref?.();
  }

  async cached(key, loader) {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.cacheHits += 1;
      return cached;
    }
    const value = await loader();
    this.cache.set(key, value);
    return value;
  }

  async collectEvents(now) {
    const mode = this.config.input.mode;

    if (mode === 'ip') {
      const record = await this.cached(
        `host:${this.config.input.ip}:${this.config.hostLookup.history}:${this.config.hostLookup.minify}`,
        () => this.client.host(this.config.input.ip, this.config.hostLookup),
      );
      return transformHostRecord(record, { now, mode: 'ip' });
    }

    if (mode === 'asn') {
      return this.collectSearchPages(`asn:${this.config.input.asn}`, now, 'asn');
    }

    return this.collectSearchPages(this.config.input.query, now, 'search');
  }

  async collectSearchPages(query, now, mode) {
    const events = [];
    const start = this.config.search.pageStart;
    const end = start + this.config.search.maxPages;

    for (let page = start; page < end; page += 1) {
      const response = await this.cached(
        `search:${query}:${page}:${this.config.search.minify}`,
        () => this.client.search(query, {
          page,
          minify: this.config.search.minify,
        }),
      );

      events.push(...transformSearchResponse(response, { now, mode }));

      const matchCount = Array.isArray(response?.matches) ? response.matches.length : 0;
      if (matchCount < 100 || events.length >= this.config.maxEventsPerPoll) break;
    }

    return events.slice(0, this.config.maxEventsPerPoll);
  }

  async publishEvents(events) {
    let accepted = 0;

    for (const event of events) {
      const fingerprint = this.config.dedupe.ttlMs ? eventFingerprint(event) : null;
      if (fingerprint && this.dedupe.has(fingerprint)) {
        this.stats.skippedDedup += 1;
        continue;
      }

      const streamId = await this.publisher.publish(event);
      if (fingerprint) this.dedupe.set(fingerprint, true);
      accepted += 1;
      this.stats.lastPublishedAt = new Date().toISOString();
      this.logger.info('shodan_event_published', {
        stream: this.config.redis.streamKey,
        streamId,
        ip: event.payload.ip,
        risk_score: event.risk_score,
      });
    }

    return accepted;
  }

  async runOnce() {
    if (this.running || this.stopped || !this.config.enabled) return this.health();

    this.running = true;
    const started = Date.now();
    this.stats.polls += 1;
    this.stats.lastPollAt = new Date(started).toISOString();

    try {
      const streamLength = await this.publisher.streamLength();
      if (streamLength >= this.config.redis.maxStreamLength) {
        this.stats.status = 'DEGRADED';
        this.stats.backpressureSkips += 1;
        this.logger.warn('shodan_backpressure_skip', {
          stream: this.config.redis.streamKey,
          streamLength,
        });
        return this.health();
      }

      const now = new Date().toISOString();
      const events = await this.collectEvents(now);
      const published = await this.publishEvents(events);

      this.stats.status = 'OK';
      this.stats.published += published;
      this.stats.lastSuccessAt = new Date().toISOString();
      this.stats.lastLatencyMs = Date.now() - started;
      this.stats.lastError = null;

      this.logger.info('shodan_poll_complete', {
        mode: this.config.input.mode,
        events: events.length,
        published,
        skippedDedup: this.stats.skippedDedup,
        latencyMs: this.stats.lastLatencyMs,
      });

      return this.health();
    } catch (error) {
      this.handleFailure(error, started);
      return this.health();
    } finally {
      this.running = false;
      if (!this.stopped) this.schedule(this.config.pollIntervalMs);
    }
  }

  handleFailure(error, started) {
    this.stats.status = 'DEGRADED';
    this.stats.failures += 1;
    this.stats.lastError = error instanceof Error ? error.message : String(error);
    this.stats.lastLatencyMs = Date.now() - started;
    this.logger.warn('shodan_poll_failed', {
      error: this.stats.lastError,
      latencyMs: this.stats.lastLatencyMs,
    });
  }

  health() {
    return {
      service: this.config.serviceName,
      enabled: this.config.enabled,
      mode: this.config.input.mode,
      stream: this.config.redis.streamKey,
      connected: this.publisher.connected,
      running: this.running,
      safety: SAFETY_POLICY,
      stats: {
        ...this.stats,
        cacheSize: this.cache.size(),
        dedupeSize: this.dedupe.size(),
      },
      shodan: this.client.health(),
      rateLimiter: this.rateLimiter.health(),
    };
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function createServer(sensor, config) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      return sendJson(res, 200, {
        status: sensor.health().stats.status,
        sensor: sensor.health(),
        config: publicConfig(config),
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/ready') {
      const health = sensor.health();
      const ready = !config.enabled || health.connected;
      return sendJson(res, ready ? 200 : 503, {
        ready,
        status: health.stats.status,
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      return sendJson(res, 200, {
        service: config.serviceName,
        stats: sensor.health().stats,
        shodan: sensor.health().shodan,
        rateLimiter: sensor.health().rateLimiter,
        time: new Date().toISOString(),
      });
    }

    return sendJson(res, 404, { error: 'not_found' });
  });
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({ service: config.serviceName });
  const sensor = new ShodanSensorService(config, logger);
  const server = createServer(sensor, config);
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shodan_sensor_shutdown_started', { signal });
    await sensor.stop();
    await new Promise((resolve) => server.close(resolve));
    logger.info('shodan_sensor_shutdown_complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      logger.error('shodan_sensor_shutdown_failed', { error: error.message });
      process.exit(1);
    });
  });

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      logger.error('shodan_sensor_shutdown_failed', { error: error.message });
      process.exit(1);
    });
  });

  server.listen(config.server.port, config.server.host, () => {
    logger.info('shodan_sensor_listening', {
      enabled: config.enabled,
      mode: config.input.mode,
      port: config.server.port,
      stream: config.redis.streamKey,
      pollSeconds: config.pollIntervalMs / 1000,
      safety: SAFETY_POLICY.purpose,
    });
  });

  await sensor.start();
}

if (require.main === module) {
  main().catch((error) => {
    const logger = createLogger({ service: 'osiris-sensor-shodan' });
    logger.error('shodan_sensor_start_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}

module.exports = {
  SAFETY_POLICY,
  ShodanSensorService,
  TtlCache,
  createServer,
};
