'use strict';

const crypto = require('crypto');
const { EventNormalizer } = require('./event-normalizer');
const { AnomalyDetector } = require('./anomaly-detector');
const { correlate } = require('./correlation-engine');
const { ScoringEngine } = require('./scoring-engine');
const { AiAgentBridge } = require('./ai-agent-bridge');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableId(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);
}

function routeFor(event) {
  if (event.type === 'adsb' || event.type === 'ais') return 'movement';
  if (event.type === 'weather' || event.type === 'quake' || event.type === 'wildfire') return 'hazard';
  return 'unknown';
}

function buildTitle(event, anomalies, correlations) {
  if (anomalies.length && correlations.length) {
    return `${event.type.toUpperCase()} anomaly correlated with ${correlations[0].target_type || 'nearby event'}`;
  }
  if (anomalies.length) return `${event.type.toUpperCase()} ${anomalies[0].type.replace(/_/g, ' ')}`;
  if (correlations.length) return `${event.type.toUpperCase()} correlated event`;
  return `${event.type.toUpperCase()} observed`;
}

class StreamConsumer {
  constructor(config, logger, bus, state, websocketGateway) {
    this.config = config;
    this.logger = logger;
    this.bus = bus;
    this.state = state;
    this.websocketGateway = websocketGateway;
    this.normalizer = new EventNormalizer(bus);
    this.anomalyDetector = new AnomalyDetector(config, state);
    this.scoringEngine = new ScoringEngine(config);
    this.aiAgent = new AiAgentBridge(logger);
    this.stopped = false;
    this.claimCursor = '0-0';
    this.stats = {
      consumed: 0,
      processed: 0,
      alerted: 0,
      skipped: 0,
      failed: 0,
      dlq: 0,
      backpressure: 0,
      lastProcessedAt: null,
      lastError: null,
    };
  }

  start() {
    this.logger.info('core_brain_stream_consumer_starting', {
      inputStream: this.config.redis.inputStream,
      outputStream: this.config.redis.outputStream,
      group: this.config.redis.group,
      consumer: this.config.redis.consumer,
    });
    this.loop();
    this.claimLoop();
  }

  stop() {
    this.stopped = true;
  }

  async backpressureDelay() {
    const maxPending = this.config.backpressure.maxPending;
    if (!maxPending) return;

    const pending = await this.bus.pendingCount();
    if (pending <= maxPending) return;

    this.stats.backpressure += 1;
    this.logger.warn('core_brain_backpressure_pending', {
      pending,
      maxPending,
      sleepMs: this.config.backpressure.sleepMs,
    });
    await sleep(this.config.backpressure.sleepMs);
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.backpressureDelay();
        const messages = await this.bus.readGroup();
        for (const message of messages) {
          await this.handleMessage(message);
        }
        if (messages.length) await new Promise((resolve) => setImmediate(resolve));
      } catch (error) {
        if (!this.stopped) {
          this.stats.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn('core_brain_read_failed', { error: this.stats.lastError });
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
          await this.handleMessage(message);
        }
        await sleep(Math.max(1000, this.config.redis.minIdleMs / 2));
      } catch (error) {
        if (!this.stopped) {
          this.stats.lastError = error instanceof Error ? error.message : String(error);
          this.logger.warn('core_brain_claim_failed', { error: this.stats.lastError });
          await sleep(2000);
        }
      }
    }
  }

  buildIntelligence(event, message, anomalies, correlations, score) {
    return {
      id: `intel:${stableId([event.id, message.id, anomalies.map((item) => item.type).join(','), correlations.map((item) => item.target_event_id).join(',')])}`,
      type: 'intelligence_event',
      route: routeFor(event),
      title: buildTitle(event, anomalies, correlations),
      timestamp: new Date().toISOString(),
      source_stream_id: message.id,
      source_event: {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        geo: event.geo,
        metadata: event.metadata,
      },
      anomalies,
      correlations,
      score,
      alert: false,
    };
  }

  async publishOutputs(event, intelligence, insight) {
    await this.bus.publishIntelligence(intelligence);
    try {
      await this.bus.publishInsight(insight);
    } catch (error) {
      this.logger.warn('core_brain_insight_publish_failed', {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.websocketGateway.broadcast(intelligence);
  }

  async handleMessage(message) {
    this.stats.consumed += 1;

    try {
      const event = this.normalizer.fromMessage(message);
      const context = this.state.addEvent(event);
      const baseAnomalies = this.anomalyDetector.detect(event, context);
      const correlationResult = correlate(event, baseAnomalies, this.state, this.config);
      const anomalies = [...baseAnomalies, ...correlationResult.derivedAnomalies];
      const correlations = correlationResult.correlations;
      const score = this.scoringEngine.score(event, anomalies, correlations);

      if (score.final < 20 && anomalies.length === 0 && correlations.length === 0) {
        await this.bus.ack(message.id);
        await this.bus.clearAttempts(message.id);
        this.stats.skipped += 1;
        return;
      }

      const intelligence = this.buildIntelligence(event, message, anomalies, correlations, score);
      const insight = this.aiAgent.analyze(event, intelligence);
      intelligence.agent_insight = insight;

      const alertKey = `${event.type}:${event.id}:${anomalies.map((item) => item.type).sort().join(',')}:${correlations.map((item) => item.target_event_id).sort().join(',')}`;
      if (this.scoringEngine.shouldAlert(score) && this.state.shouldPublishAlert(alertKey)) {
        intelligence.alert = true;
        insight.type = 'alert';
        await this.bus.publishAlert(intelligence);
        this.stats.alerted += 1;
      }

      await this.publishOutputs(event, intelligence, insight);
      await this.bus.ack(message.id);
      await this.bus.clearAttempts(message.id);

      this.stats.processed += 1;
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
      this.logger.error('core_brain_message_dlq', { streamId: message.id, attempts, reason });
      return;
    }

    this.logger.warn('core_brain_message_failed_will_retry', {
      streamId: message.id,
      attempts,
      reason,
    });
  }

  health() {
    return { ...this.stats };
  }
}

module.exports = {
  StreamConsumer,
};

