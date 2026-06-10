'use strict';

const { createClient } = require('redis');
const {
  decodeEvent,
  encodeFields,
  flatFieldArgs,
  parseAutoClaimResponse,
  parseStreamResponse,
  validateEvent,
} = require('./event-codec');

class AgentBus {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.stats = {
      published: 0,
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
      this.logger.warn('redis_agent_error', { error: error.message });
    });
    this.client.on('ready', () => {
      this.connected = true;
      this.logger.info('redis_agent_ready');
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
        this.config.redis.inputStream,
        this.config.redis.group,
        '0',
        'MKSTREAM',
      ]);
      this.logger.info('agent_consumer_group_created', {
        stream: this.config.redis.inputStream,
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
      this.config.redis.inputStream,
      '>',
    ]);
    return parseStreamResponse(response);
  }

  async claimIdle(startId = '0-0') {
    const response = await this.client.sendCommand([
      'XAUTOCLAIM',
      this.config.redis.inputStream,
      this.config.redis.group,
      this.config.redis.consumer,
      String(this.config.redis.minIdleMs),
      startId,
      'COUNT',
      String(this.config.redis.claimCount),
    ]);
    return parseAutoClaimResponse(response, this.config.redis.inputStream);
  }

  async ack(streamId) {
    await this.client.sendCommand([
      'XACK',
      this.config.redis.inputStream,
      this.config.redis.group,
      streamId,
    ]);
  }

  async attempts(streamId) {
    const key = `osiris:agent:attempts:${streamId}`;
    const value = await this.client.incr(key);
    await this.client.expire(key, 86400);
    return value;
  }

  async clearAttempts(streamId) {
    await this.client.del(`osiris:agent:attempts:${streamId}`);
  }

  decode(message) {
    const event = decodeEvent(message.fields);
    const errors = validateEvent(event);
    if (errors.length) throw new Error(`invalid_event:${errors.join(',')}`);
    return event;
  }

  async publishInsight(insight) {
    const fields = encodeFields({
      id: insight.id,
      event_id: insight.event_id,
      type: insight.type,
      risk: insight.risk,
      summary: insight.summary,
      reasoning: insight.reasoning,
      timestamp: insight.emitted_at,
      geo: insight.geo_context,
      score: insight.score,
      insight,
    });
    const streamId = await this.client.sendCommand(
      this.xAddArgs(this.config.redis.outputStream, fields, this.config.redis.outputMaxLen),
    );
    this.stats.published += 1;
    this.stats.lastPublishedAt = new Date().toISOString();
    return streamId;
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
      this.xAddArgs(this.config.redis.dlqStream, payload, this.config.redis.dlqMaxLen),
    );
    this.stats.dlq += 1;
  }

  async pendingCount() {
    try {
      const response = await this.client.sendCommand([
        'XPENDING',
        this.config.redis.inputStream,
        this.config.redis.group,
      ]);
      return Number(response?.[0] || 0);
    } catch {
      return 0;
    }
  }

  health() {
    return {
      connected: this.connected,
      inputStream: this.config.redis.inputStream,
      outputStream: this.config.redis.outputStream,
      group: this.config.redis.group,
      consumer: this.config.redis.consumer,
      stats: this.stats,
    };
  }
}

module.exports = {
  AgentBus,
};
