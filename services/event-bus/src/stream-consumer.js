'use strict';

const { validateEvent } = require('./event-schema');

class StreamConsumer {
  constructor(config, logger, bus) {
    this.config = config;
    this.logger = logger;
    this.bus = bus;
    this.stopped = false;
    this.claimCursor = '0-0';
    this.stats = {
      processed: 0,
      failed: 0,
      retried: 0,
      dlq: 0,
      lastProcessedAt: null,
      lastError: null,
    };
  }

  start() {
    this.logger.info('event_stream_consumer_starting', {
      stream: this.config.redis.streamKey,
      group: this.config.redis.group,
      consumer: this.config.redis.consumer,
    });
    this.loop();
    this.claimLoop();
  }

  stop() {
    this.stopped = true;
  }

  async loop() {
    while (!this.stopped) {
      try {
        const messages = await this.bus.readGroup();
        for (const message of messages) {
          await this.handleMessage(message);
        }
      } catch (error) {
        if (!this.stopped) {
          this.stats.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn('event_consumer_read_failed', { error: this.stats.lastError });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  async claimLoop() {
    while (!this.stopped) {
      try {
        const claimed = await this.bus.claimIdle(this.claimCursor);
        this.claimCursor = claimed.nextId || '0-0';
        for (const message of claimed.messages) {
          await this.handleMessage(message);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(1000, this.config.redis.minIdleMs / 2)));
      } catch (error) {
        if (!this.stopped) {
          this.stats.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn('event_consumer_claim_failed', { error: this.stats.lastError });
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  }

  async handleMessage(message) {
    try {
      const event = this.bus.decode(message);
      const errors = validateEvent(event);
      if (errors.length) throw new Error(`invalid_event:${errors.join(',')}`);

      await this.bus.publishProcessed(event, message.id);
      await this.bus.ack(message.id);
      await this.bus.clearAttempts(message.id);

      this.stats.processed += 1;
      this.stats.lastProcessedAt = new Date().toISOString();
      this.logger.debug('event_processed', {
        streamId: message.id,
        id: event.id,
        type: event.type,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const attempts = await this.bus.attempts(message.id);
      this.stats.failed += 1;
      this.stats.lastError = reason;

      if (attempts > this.config.redis.maxRetries) {
        await this.bus.publishDlq(message, reason, attempts);
        await this.bus.ack(message.id);
        await this.bus.clearAttempts(message.id);
        this.stats.dlq += 1;
        this.logger.error('event_moved_to_dlq', {
          streamId: message.id,
          attempts,
          reason,
        });
        return;
      }

      this.stats.retried += 1;
      this.logger.warn('event_processing_failed_will_retry', {
        streamId: message.id,
        attempts,
        reason,
      });
    }
  }

  health() {
    return { ...this.stats };
  }
}

module.exports = { StreamConsumer };
