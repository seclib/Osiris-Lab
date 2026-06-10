'use strict';

const { normalizePayload } = require('./normalizers');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

async function fetchJson(url, options) {
  let lastError = null;

  for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: options.headers,
        cache: 'no-store',
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const error = new Error(`http_${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
      }

      return {
        payload: await response.json(),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt >= options.retryCount) break;

      const retryAfterSeconds = Number(error.retryAfter);
      const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
      const backoff = retryAfterMs || Math.min(options.retryMaxMs, options.retryBaseMs * (2 ** attempt));
      await sleep(jitter(backoff));
    }
  }

  throw lastError || new Error('fetch_failed');
}

class PollingFeedWorker {
  constructor(feedConfig, config, logger, bus) {
    this.feedConfig = feedConfig;
    this.config = config;
    this.logger = logger;
    this.bus = bus;
    this.timer = null;
    this.stopped = false;
    this.status = {
      id: feedConfig.id,
      type: feedConfig.type,
      enabled: feedConfig.enabled,
      state: feedConfig.enabled ? 'starting' : 'disabled',
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastLatencyMs: null,
      published: 0,
      rejected: 0,
      backpressurePauses: 0,
    };
  }

  start() {
    if (!this.feedConfig.enabled) {
      this.logger.info('event_feed_worker_disabled', { feed: this.feedConfig.id });
      return;
    }
    this.logger.info('event_feed_worker_starting', {
      feed: this.feedConfig.id,
      type: this.feedConfig.type,
      pollSeconds: this.feedConfig.pollSeconds,
    });
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  schedule(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.poll().catch((error) => {
        this.logger.error('event_feed_worker_unhandled_error', {
          feed: this.feedConfig.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.schedule(this.feedConfig.pollSeconds * 1000);
      });
    }, delayMs);
  }

  async poll() {
    if (this.stopped) return;

    const pressure = await this.bus.shouldPauseIngestion();
    if (pressure.pause) {
      this.status.state = 'backpressure';
      this.status.backpressurePauses += 1;
      this.logger.warn('event_feed_worker_backpressure_pause', {
        feed: this.feedConfig.id,
        streamLength: pressure.length,
        pending: pressure.pending,
      });
      this.schedule(this.config.backpressure.pauseMs);
      return;
    }

    const urls = [this.feedConfig.url, ...this.feedConfig.fallbackUrls].filter(Boolean);
    let finalError = null;

    for (const url of urls) {
      try {
        const result = await fetchJson(url, this.feedConfig);
        const normalized = normalizePayload(result.payload, {
          ...this.feedConfig,
          url,
        });
        const published = await this.bus.publishBatch(normalized.events);

        this.status = {
          ...this.status,
          state: 'ok',
          lastSuccessAt: new Date().toISOString(),
          lastError: null,
          lastLatencyMs: result.latencyMs,
          published: this.status.published + published.accepted,
          rejected: this.status.rejected + normalized.rejected.length + published.rejected,
        };
        this.logger.info('event_feed_worker_poll_ok', {
          feed: this.feedConfig.id,
          url,
          normalized: normalized.events.length,
          rejected: normalized.rejected.length + published.rejected,
          latencyMs: result.latencyMs,
        });
        this.schedule(this.feedConfig.pollSeconds * 1000);
        return;
      } catch (error) {
        finalError = error;
        this.logger.warn('event_feed_worker_url_failed', {
          feed: this.feedConfig.id,
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.status = {
      ...this.status,
      state: 'degraded',
      lastFailureAt: new Date().toISOString(),
      lastError: finalError instanceof Error ? finalError.message : String(finalError || 'unknown_error'),
    };
    this.schedule(this.feedConfig.pollSeconds * 1000);
  }

  health() {
    return { ...this.status };
  }
}

module.exports = {
  PollingFeedWorker,
  fetchJson,
};
