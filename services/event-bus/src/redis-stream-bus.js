'use strict';

const { createClient } = require('redis');
const { eventFromStreamFields, eventToStreamFields, fieldsToObject } = require('./event-schema');

function flatFieldArgs(fields) {
  const args = [];
  for (const [key, value] of Object.entries(fields)) {
    args.push(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return args;
}

function parseStreamResponse(response) {
  if (!Array.isArray(response)) return [];
  const output = [];
  for (const streamResult of response) {
    const streamName = streamResult?.[0];
    const messages = streamResult?.[1] || [];
    for (const message of messages) {
      output.push({
        stream: streamName,
        id: message[0],
        fields: fieldsToObject(message[1]),
      });
    }
  }
  return output;
}

function parseAutoClaimResponse(response, stream) {
  if (!Array.isArray(response)) return { nextId: '0-0', messages: [] };
  const messages = Array.isArray(response[1]) ? response[1] : [];
  return {
    nextId: response[0] || '0-0',
    messages: messages.map((message) => ({
      stream,
      id: message[0],
      fields: fieldsToObject(message[1]),
    })),
  };
}

class RedisStreamBus {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.stats = {
      published: 0,
      publishRejected: 0,
      dlq: 0,
      lastPublishedAt: null,
      lastError: null,
    };
  }

  async connect() {
    this.client = createClient({ url: this.config.redis.url });
    this.client.on('error', (error) => {
      this.connected = false;
      this.stats.lastError = error.message;
      this.logger.warn('redis_event_bus_error', { error: error.message });
    });
    this.client.on('ready', () => {
      this.connected = true;
      this.logger.info('redis_event_bus_ready');
    });
    await this.client.connect();
  }

  async close() {
    if (this.client?.isOpen) await this.client.quit();
  }

  async ensureGroup() {
    try {
      await this.client.sendCommand([
        'XGROUP',
        'CREATE',
        this.config.redis.streamKey,
        this.config.redis.group,
        '0',
        'MKSTREAM',
      ]);
      this.logger.info('event_consumer_group_created', {
        stream: this.config.redis.streamKey,
        group: this.config.redis.group,
      });
    } catch (error) {
      if (!String(error.message || error).includes('BUSYGROUP')) throw error;
    }
  }

  xAddArgs(stream, fields, maxLen) {
    const args = ['XADD', stream];
    if (maxLen > 0) args.push('MAXLEN', '~', String(maxLen));
    args.push('*', ...flatFieldArgs(fields));
    return args;
  }

  async publish(event) {
    const fields = eventToStreamFields(event);
    const id = await this.client.sendCommand(
      this.xAddArgs(this.config.redis.streamKey, fields, this.config.redis.eventMaxLen),
    );
    this.stats.published += 1;
    this.stats.lastPublishedAt = new Date().toISOString();
    return id;
  }

  async publishBatch(events) {
    let accepted = 0;
    let rejected = 0;

    for (const event of events) {
      try {
        await this.publish(event);
        accepted += 1;
      } catch (error) {
        rejected += 1;
        this.stats.publishRejected += 1;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn('event_publish_failed', {
          id: event?.id,
          type: event?.type,
          error: this.stats.lastError,
        });
      }
    }

    return { accepted, rejected };
  }

  async publishProcessed(event, sourceStreamId) {
    const processed = {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      source_stream_id: sourceStreamId,
      processed_at: new Date().toISOString(),
      geo: JSON.stringify(event.geo),
      metadata: JSON.stringify(event.metadata),
      event: JSON.stringify(event),
    };

    await this.client.setEx(`osiris:event:latest:${event.type}:${event.id}`, 3600, JSON.stringify(event));
    await this.client.publish(
      this.config.redis.processedChannel,
      JSON.stringify({ event, source_stream_id: sourceStreamId }),
    );
    await this.client.sendCommand(
      this.xAddArgs(this.config.redis.processedStreamKey, processed, this.config.redis.processedMaxLen),
    );
  }

  async publishDlq(message, reason, attempts) {
    const payload = {
      source_stream: message.stream,
      source_stream_id: message.id,
      reason,
      attempts: String(attempts),
      failed_at: new Date().toISOString(),
      ...message.fields,
    };
    await this.client.sendCommand(
      this.xAddArgs(this.config.redis.dlqStreamKey, payload, this.config.redis.dlqMaxLen),
    );
    this.stats.dlq += 1;
  }

  async readGroup() {
    const response = await this.client.sendCommand([
      'XREADGROUP',
      'GROUP',
      this.config.redis.group,
      this.config.redis.consumer,
      'COUNT',
      String(this.config.redis.readCount),
      'BLOCK',
      String(this.config.redis.blockMs),
      'STREAMS',
      this.config.redis.streamKey,
      '>',
    ]);
    return parseStreamResponse(response);
  }

  async claimIdle(startId = '0-0') {
    const response = await this.client.sendCommand([
      'XAUTOCLAIM',
      this.config.redis.streamKey,
      this.config.redis.group,
      this.config.redis.consumer,
      String(this.config.redis.minIdleMs),
      startId,
      'COUNT',
      String(this.config.redis.claimCount),
    ]);
    return parseAutoClaimResponse(response, this.config.redis.streamKey);
  }

  async ack(streamId) {
    await this.client.sendCommand([
      'XACK',
      this.config.redis.streamKey,
      this.config.redis.group,
      streamId,
    ]);
  }

  async attempts(streamId) {
    const key = `osiris:event:attempts:${streamId}`;
    const value = await this.client.incr(key);
    await this.client.expire(key, 86400);
    return value;
  }

  async clearAttempts(streamId) {
    await this.client.del(`osiris:event:attempts:${streamId}`);
  }

  async streamLength() {
    try {
      return Number(await this.client.sendCommand(['XLEN', this.config.redis.streamKey]));
    } catch {
      return 0;
    }
  }

  async pendingCount() {
    try {
      const response = await this.client.sendCommand([
        'XPENDING',
        this.config.redis.streamKey,
        this.config.redis.group,
      ]);
      return Number(response?.[0] || 0);
    } catch {
      return 0;
    }
  }

  async shouldPauseIngestion() {
    const length = await this.streamLength();
    const pending = await this.pendingCount();
    return {
      pause: length >= this.config.backpressure.maxStreamLength || pending >= this.config.backpressure.maxPending,
      length,
      pending,
    };
  }

  decode(message) {
    return eventFromStreamFields(message.fields);
  }

  health() {
    return {
      connected: Boolean(this.client?.isOpen && this.connected),
      stream: this.config.redis.streamKey,
      group: this.config.redis.group,
      consumer: this.config.redis.consumer,
      ...this.stats,
    };
  }
}

module.exports = {
  RedisStreamBus,
};
