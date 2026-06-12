'use strict';

const { createClient } = require('redis');
const { eventToStreamFields } = require('./event-schema');

function flatFieldArgs(fields) {
  const args = [];
  for (const [key, value] of Object.entries(fields)) {
    args.push(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return args;
}

class RedisPublisher {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.stats = {
      published: 0,
      rejected: 0,
      lastPublishedAt: null,
      lastError: null,
      backpressureSkips: 0,
    };
  }

  async connect() {
    this.client = createClient({ url: this.config.redis.url });
    this.client.on('error', (error) => {
      this.connected = false;
      this.stats.lastError = error.message;
      this.logger.warn('redis_bridge_error', { error: error.message });
    });
    this.client.on('ready', () => {
      this.connected = true;
      this.logger.info('redis_bridge_ready', { stream: this.config.redis.streamKey });
    });
    await this.client.connect();
  }

  async close() {
    if (this.client?.isOpen) await this.client.quit();
  }

  xAddArgs(event) {
    const fields = eventToStreamFields(event);
    const args = ['XADD', this.config.redis.streamKey];
    if (this.config.redis.eventMaxLen > 0) {
      args.push('MAXLEN', '~', String(this.config.redis.eventMaxLen));
    }
    args.push('*', ...flatFieldArgs(fields));
    return args;
  }

  async streamLength() {
    try {
      return Number(await this.client.sendCommand(['XLEN', this.config.redis.streamKey]));
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      return 0;
    }
  }

  async shouldPause() {
    const length = await this.streamLength();
    const pause = length >= this.config.backpressure.maxStreamLength;
    if (pause) this.stats.backpressureSkips += 1;
    return { pause, length };
  }

  async publish(event) {
    const streamId = await this.client.sendCommand(this.xAddArgs(event));
    this.stats.published += 1;
    this.stats.lastPublishedAt = new Date().toISOString();
    return streamId;
  }

  async publishBatch(events) {
    let accepted = 0;
    let rejected = 0;
    const publishedEvents = [];

    for (const event of events) {
      try {
        const streamId = await this.publish(event);
        publishedEvents.push({ ...event, source_stream_id: streamId });
        accepted += 1;
      } catch (error) {
        rejected += 1;
        this.stats.rejected += 1;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn('bridge_event_publish_failed', {
          id: event?.id,
          type: event?.type,
          error: this.stats.lastError,
        });
      }
    }

    return { accepted, rejected, publishedEvents };
  }

  health() {
    return {
      connected: this.connected,
      stream: this.config.redis.streamKey,
      stats: this.stats,
    };
  }
}

module.exports = { RedisPublisher };
