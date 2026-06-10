'use strict';

const { StateStore } = require('./state-store');
const { detectAnomalies } = require('./anomaly-detector');
const { correlate } = require('./correlation-engine');
const { scoreEvent } = require('./scoring-engine');
const { buildInsight } = require('./insight-builder');
const { OllamaClient } = require('./ollama-client');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StreamAgent {
  constructor(config, logger, bus) {
    this.config = config;
    this.logger = logger;
    this.bus = bus;
    this.state = new StateStore(config);
    this.ollama = new OllamaClient(config, logger);
    this.stopped = false;
    this.claimCursor = '0-0';
    this.inFlight = new Set();
    this.stats = {
      consumed: 0,
      processed: 0,
      published: 0,
      skipped: 0,
      failed: 0,
      dlq: 0,
      backpressure: 0,
      lastProcessedAt: null,
      lastError: null,
    };
  }

  start() {
    if (!this.config.enabled) {
      this.logger.info('osiris_agent_disabled');
      return;
    }
    this.logger.info('osiris_agent_starting', {
      inputStream: this.config.redis.inputStream,
      outputStream: this.config.redis.outputStream,
      group: this.config.redis.group,
      concurrency: this.config.processing.concurrency,
      ollamaEnabled: this.config.ollama.enabled,
    });
    this.loop();
    this.claimLoop();
  }

  stop() {
    this.stopped = true;
  }

  async drain(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size && Date.now() < deadline) {
      await sleep(25);
    }
  }

  async waitForSlot() {
    while (!this.stopped && this.inFlight.size >= this.config.processing.concurrency) {
      await sleep(10);
    }
  }

  dispatch(message) {
    const task = this.handleMessage(message)
      .catch((error) => {
        this.stats.failed += 1;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error('agent_unhandled_message_failure', {
          streamId: message.id,
          error: this.stats.lastError,
        });
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  async backpressureDelay() {
    const pending = await this.bus.pendingCount();
    if (pending <= this.config.processing.maxPending) return;
    this.stats.backpressure += 1;
    this.logger.warn('agent_backpressure_pending', {
      pending,
      maxPending: this.config.processing.maxPending,
      sleepMs: this.config.processing.backpressureSleepMs,
    });
    await sleep(this.config.processing.backpressureSleepMs);
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.backpressureDelay();
        await this.waitForSlot();
        const messages = await this.bus.readGroup();
        for (const message of messages) {
          await this.waitForSlot();
          if (this.stopped) break;
          this.dispatch(message);
        }
      } catch (error) {
        if (!this.stopped) {
          this.stats.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn('agent_read_failed', { error: this.stats.lastError });
          await sleep(1000);
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
          await this.waitForSlot();
          if (this.stopped) break;
          this.dispatch(message);
        }
        await sleep(Math.max(1000, this.config.redis.minIdleMs / 2));
      } catch (error) {
        if (!this.stopped) {
          this.stats.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn('agent_claim_failed', { error: this.stats.lastError });
          await sleep(2000);
        }
      }
    }
  }

  shouldSkip(score, anomalies, correlations) {
    if (this.config.processing.emitBelowThreshold) return false;
    return score.final < this.config.processing.minInsightScore
      && anomalies.length === 0
      && correlations.length === 0;
  }

  async handleMessage(message) {
    this.stats.consumed += 1;

    try {
      const event = this.bus.decode(message);
      const context = this.state.add(event);
      const anomalies = detectAnomalies(event, context);
      const correlations = correlate(event, context);
      const score = scoreEvent(event, anomalies, correlations);

      if (this.shouldSkip(score, anomalies, correlations)) {
        await this.bus.ack(message.id);
        await this.bus.clearAttempts(message.id);
        this.stats.skipped += 1;
        return;
      }

      const baseInsight = buildInsight(event, message.id, anomalies, correlations, score, this.config);
      const { insight } = await this.ollama.enrich(baseInsight);
      await this.bus.publishInsight(insight);
      await this.bus.ack(message.id);
      await this.bus.clearAttempts(message.id);

      this.stats.processed += 1;
      this.stats.published += 1;
      this.stats.lastProcessedAt = new Date().toISOString();
    } catch (error) {
      await this.handleFailure(message, error);
    }
  }

  async handleFailure(message, error) {
    const reason = error instanceof Error ? error.message : String(error);
    const attempts = await this.bus.attempts(message.id);
    this.stats.failed += 1;
    this.stats.lastError = reason;

    if (attempts > this.config.redis.maxRetries) {
      await this.bus.publishDlq(message, reason, attempts);
      await this.bus.ack(message.id);
      await this.bus.clearAttempts(message.id);
      this.stats.dlq += 1;
      this.logger.error('agent_message_dlq', { streamId: message.id, attempts, reason });
      return;
    }

    this.logger.warn('agent_message_failed_will_retry', {
      streamId: message.id,
      attempts,
      reason,
    });
  }

  health() {
    return {
      ...this.stats,
      inFlight: this.inFlight.size,
      state: this.state.summary(),
      ollama: this.ollama.health(),
    };
  }
}

module.exports = {
  StreamAgent,
};
