'use strict';

const WebSocket = require('ws');
const { normalizeAisPayload, normalizeUnifiedPayload } = require('../normalizers');
const { SpacedRateLimiter, fetchJson, sleep } = require('../lib/retry');

class AisProvider {
  constructor(config, logger, publishTracks) {
    this.config = config;
    this.logger = logger;
    this.publishTracks = publishTracks;
    this.limiter = new SpacedRateLimiter(config.ais.minRequestSpacingMs);
    this.timer = null;
    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.status = {
      name: 'ais',
      enabled: config.ais.enabled,
      mode: config.ais.websocketUrl ? 'websocket' : 'polling',
      state: config.ais.enabled ? 'starting' : 'disabled',
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastLatencyMs: null,
      accepted: 0,
      rejected: 0,
    };
  }

  start() {
    if (!this.config.ais.enabled) {
      this.logger.info('ais_provider_disabled');
      return;
    }

    if (this.config.ais.websocketUrl) {
      this.connectWebSocket();
      return;
    }

    if (!this.config.ais.url) {
      this.status.state = 'misconfigured';
      this.status.lastError = 'AIS_URL or AIS_WS_URL is required when AIS_ENABLED=true';
      this.logger.warn('ais_provider_missing_url');
      return;
    }

    this.logger.info('ais_provider_polling_starting', {
      provider: this.config.ais.provider,
      pollSeconds: this.config.ais.pollSeconds,
    });
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ws) this.ws.close();
  }

  schedule(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.poll().catch((error) => {
        this.logger.error('ais_poll_unhandled_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
  }

  async poll() {
    if (this.stopped) return;
    await this.limiter.wait();

    const urls = [this.config.ais.url, ...this.config.ais.fallbackUrls].filter(Boolean);
    let finalError = null;

    for (const url of urls) {
      try {
        const result = await fetchJson(url, {
          headers: this.config.ais.headers,
          timeoutMs: this.config.ingestion.requestTimeoutMs,
          retries: this.config.ingestion.retryCount,
          retryBaseMs: this.config.ingestion.retryBaseMs,
          retryMaxMs: this.config.ingestion.retryMaxMs,
          logger: this.logger,
          provider: 'ais',
        });

        const normalized = this.normalizePayload(result.payload, url);
        const publishResult = await this.publishTracks('ais', normalized.tracks, normalized.rejected);
        this.status = {
          ...this.status,
          state: 'ok',
          lastSuccessAt: new Date().toISOString(),
          lastError: null,
          lastLatencyMs: result.latencyMs,
          accepted: this.status.accepted + publishResult.accepted,
          rejected: this.status.rejected + normalized.rejected.length + publishResult.rejected,
        };
        this.logger.info('ais_poll_ok', {
          url,
          received: normalized.tracks.length,
          rejected: normalized.rejected.length + publishResult.rejected,
          latencyMs: result.latencyMs,
        });
        this.schedule(this.config.ais.pollSeconds * 1000);
        return;
      } catch (error) {
        finalError = error;
        this.logger.warn('ais_poll_url_failed', {
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
    await sleep(Math.min(this.config.ingestion.retryMaxMs, this.config.ais.pollSeconds * 1000));
    this.schedule(this.config.ais.pollSeconds * 1000);
  }

  connectWebSocket() {
    if (this.stopped) return;
    this.logger.info('ais_websocket_connecting', { url: this.config.ais.websocketUrl });

    this.ws = new WebSocket(this.config.ais.websocketUrl, {
      headers: this.config.ais.headers,
      handshakeTimeout: this.config.ingestion.requestTimeoutMs,
    });

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.status.state = 'ok';
      this.status.lastError = null;
      this.logger.info('ais_websocket_connected');
    });

    this.ws.on('message', async (message) => {
      try {
        const payload = JSON.parse(message.toString('utf8'));
        const normalized = this.normalizePayload(payload, this.config.ais.websocketUrl);
        const publishResult = await this.publishTracks('ais', normalized.tracks, normalized.rejected);
        this.status = {
          ...this.status,
          state: 'ok',
          lastSuccessAt: new Date().toISOString(),
          accepted: this.status.accepted + publishResult.accepted,
          rejected: this.status.rejected + normalized.rejected.length + publishResult.rejected,
        };
      } catch (error) {
        this.status = {
          ...this.status,
          state: 'degraded',
          lastFailureAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.logger.warn('ais_websocket_message_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.ws.on('close', () => this.reconnectWebSocket('closed'));
    this.ws.on('error', (error) => this.reconnectWebSocket(error.message));
  }

  reconnectWebSocket(reason) {
    if (this.stopped) return;
    this.status.state = 'degraded';
    this.status.lastFailureAt = new Date().toISOString();
    this.status.lastError = reason;
    this.reconnectAttempt += 1;
    const waitMs = Math.min(60000, 1000 * (2 ** Math.min(this.reconnectAttempt, 6)));
    this.logger.warn('ais_websocket_reconnecting', { reason, waitMs });
    setTimeout(() => this.connectWebSocket(), waitMs);
  }

  normalizePayload(payload, feed) {
    if (Array.isArray(payload?.tracks) || Array.isArray(payload?.data?.tracks)) {
      return normalizeUnifiedPayload(payload, {
        receivedAt: new Date().toISOString(),
        vesselStaleAfterSeconds: this.config.freshness.vesselStaleAfterSeconds,
        provider: 'ais',
        feed,
      });
    }

    return normalizeAisPayload(payload, {
      receivedAt: new Date().toISOString(),
      staleAfterSeconds: this.config.freshness.vesselStaleAfterSeconds,
      provider: this.config.ais.provider || 'ais',
      feed,
    });
  }

  health() {
    return this.status;
  }
}

module.exports = { AisProvider };
