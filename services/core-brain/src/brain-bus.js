'use strict';

const { createClient } = require('redis');
const {
  decodeEvent,
  encodeFields,
  flatFieldArgs,
  parseAutoClaimResponse,
  parseStreamResponse,
} = require('./event-codec');

class BrainBus {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = null;
    this.connected = false;
    this.stats = {
      published: 0,
      insights: 0,
      alerts: 0,
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
      this.logger.warn('brain_redis_error', { error: error.message });
    });
    this.client.on('ready', () => {
      this.connected = true;
      this.logger.info('brain_redis_ready');
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
      this.logger.info('brain_consumer_group_created', {
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
    const key = `osiris:brain:attempts:${streamId}`;
    const attempts = await this.client.incr(key);
    await this.client.expire(key, 86400);
    return attempts;
  }

  async clearAttempts(streamId) {
    await this.client.del(`osiris:brain:attempts:${streamId}`);
  }

  decode(message) {
    return decodeEvent(message.fields);
  }

  async publishIntelligence(intelligence) {
    const fields = encodeFields({
      id: intelligence.id,
      type: intelligence.type,
      severity: intelligence.score.severity,
      final_score: String(intelligence.score.final),
      source_event_id: intelligence.source_event.id,
      timestamp: intelligence.timestamp,
      intelligence,
    });

    await this.client.sendCommand(
      this.xAddArgs(this.config.redis.outputStream, fields, this.config.redis.outputMaxLen),
    );
    await this.client.setEx(`osiris:intelligence:latest:${intelligence.id}`, 3600, JSON.stringify(intelligence));
    await this.client.publish(this.config.redis.channel, JSON.stringify(intelligence));

    this.stats.published += 1;
    this.stats.lastPublishedAt = new Date().toISOString();
  }

  async publishAlert(intelligence) {
    const fields = encodeFields({
      id: intelligence.id,
      severity: intelligence.score.severity,
      final_score: String(intelligence.score.final),
      source_event_id: intelligence.source_event.id,
      timestamp: intelligence.timestamp,
      alert: intelligence,
    });

    await this.client.sendCommand(
      this.xAddArgs(this.config.redis.alertStream, fields, this.config.redis.alertMaxLen),
    );
    await this.client.publish(this.config.redis.alertChannel, JSON.stringify(intelligence));
    this.stats.alerts += 1;
  }

  async publishInsight(insight) {
    const fields = encodeFields({
      event_id: insight.event_id,
      intelligence_id: insight.intelligence_id,
      type: insight.type,
      risk: insight.risk,
      timestamp: insight.emitted_at,
      insight,
    });

    await this.client.sendCommand(
      this.xAddArgs(this.config.redis.insightStream, fields, this.config.redis.insightMaxLen),
    );
    await this.client.publish(this.config.redis.insightChannel, JSON.stringify(insight));
    this.stats.insights += 1;
  }

  async publishDlq(message, reason, attempts) {
    await this.client.sendCommand(
      this.xAddArgs(this.config.redis.dlqStream, {
        source_stream: message.stream,
        source_stream_id: message.id,
        reason,
        attempts: String(attempts),
        failed_at: new Date().toISOString(),
        ...message.fields,
      }, this.config.redis.dlqMaxLen),
    );
    this.stats.dlq += 1;
  }

  async streamLength(stream = this.config.redis.inputStream) {
    try {
      return Number(await this.client.sendCommand(['XLEN', stream]));
    } catch {
      return 0;
    }
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
      connected: Boolean(this.client?.isOpen && this.connected),
      inputStream: this.config.redis.inputStream,
      outputStream: this.config.redis.outputStream,
      group: this.config.redis.group,
      consumer: this.config.redis.consumer,
      ...this.stats,
    };
  }
}

module.exports = { BrainBus };
