'use strict';

const { createHash } = require('crypto');
const { normalizePayload } = require('./normalizers');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventSignature(event) {
  return createHash('sha1')
    .update(JSON.stringify([
      event.id,
      event.type,
      event.timestamp,
      event.geo,
      event.payload,
      event.metadata?.source,
    ]))
    .digest('hex');
}

class EventDeduper {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.seen = new Map();
    this.lastCleanup = 0;
  }

  accept(event) {
    const now = Date.now();
    const signature = eventSignature(event);
    const previous = this.seen.get(event.id);
    if (previous?.signature === signature) {
      previous.lastSeen = now;
      return false;
    }
    this.seen.set(event.id, { signature, lastSeen: now });
    this.cleanup(now);
    return true;
  }

  cleanup(now = Date.now()) {
    if (now - this.lastCleanup < 30000) return;
    this.lastCleanup = now;
    for (const [id, value] of this.seen.entries()) {
      if (now - value.lastSeen > this.ttlMs) this.seen.delete(id);
    }
  }
}

class BridgeWorker {
  constructor(feed, config, logger, publisher, deduper) {
    this.feed = feed;
    this.config = config;
    this.logger = logger;
    this.publisher = publisher;
    this.deduper = deduper;
    this.timer = null;
    this.stopped = true;
    this.running = false;
    this.state = {
      id: feed.id,
      type: feed.type,
      url: feed.url,
      enabled: feed.enabled,
      status: feed.enabled ? 'STARTING' : 'DISABLED',
      polls: 0,
      failures: 0,
      normalized: 0,
      published: 0,
      duplicates: 0,
      rejected: 0,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastLatencyMs: null,
      lastBackpressureAt: null,
    };
  }

  start() {
    if (!this.config.enabled || !this.feed.enabled) {
      this.state.status = 'DISABLED';
      return;
    }
    this.stopped = false;
    const jitterMs = Math.floor(Math.random() * Math.min(5000, this.feed.pollSeconds * 1000));
    this.timer = setTimeout(() => {
      this.tick();
    }, jitterMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delayMs = this.feed.pollSeconds * 1000) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  async fetchJson() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.feed.timeoutMs);
    try {
      const response = await fetch(this.feed.url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          'user-agent': this.config.userAgent,
          ...this.feed.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    const started = Date.now();
    let nextDelayMs = this.feed.pollSeconds * 1000;
    this.state.polls += 1;
    this.state.lastPollAt = new Date(started).toISOString();

    try {
      const backpressure = await this.publisher.shouldPause();
      if (backpressure.pause) {
        this.state.status = 'DEGRADED';
        this.state.lastBackpressureAt = new Date().toISOString();
        this.logger.warn('bridge_backpressure_pause', {
          feed: this.feed.id,
          streamLength: backpressure.length,
          pauseMs: this.config.backpressure.pauseMs,
        });
        nextDelayMs = this.config.backpressure.pauseMs;
        return;
      }

      const payload = await this.fetchJson();
      const normalized = normalizePayload(payload, this.feed, {
        receivedAt: new Date().toISOString(),
        maxEventsPerPoll: this.config.maxEventsPerPoll,
        includeRawPayload: this.config.includeRawPayload,
      });
      const uniqueEvents = [];
      let duplicates = 0;

      for (const event of normalized.events) {
        if (this.deduper.accept(event)) uniqueEvents.push(event);
        else duplicates += 1;
      }

      const published = await this.publisher.publishBatch(uniqueEvents);
      this.state.status = 'OK';
      this.state.normalized += normalized.events.length;
      this.state.published += published.accepted;
      this.state.duplicates += duplicates;
      this.state.rejected += normalized.rejected.length + published.rejected;
      this.state.lastSuccessAt = new Date().toISOString();
      this.state.lastError = null;
      this.state.lastLatencyMs = Date.now() - started;

      this.logger.info('bridge_feed_poll_complete', {
        feed: this.feed.id,
        normalized: normalized.events.length,
        published: published.accepted,
        duplicates,
        rejected: normalized.rejected.length + published.rejected,
        latencyMs: this.state.lastLatencyMs,
      });
    } catch (error) {
      this.state.status = 'DEGRADED';
      this.state.failures += 1;
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.state.lastLatencyMs = Date.now() - started;
      this.logger.warn('bridge_feed_poll_failed', {
        feed: this.feed.id,
        error: this.state.lastError,
        latencyMs: this.state.lastLatencyMs,
      });
    } finally {
      this.running = false;
      if (!this.stopped) {
        await sleep(0);
        this.schedule(nextDelayMs);
      }
    }
  }

  health() {
    return { ...this.state };
  }
}

module.exports = {
  BridgeWorker,
  EventDeduper,
};
