'use strict';

const { normalizeOpenSkyPayload, normalizeUnifiedPayload } = require('../normalizers');
const { SpacedRateLimiter, fetchJson, sleep } = require('../lib/retry');

class AdsbProvider {
  constructor(config, logger, publishTracks) {
    this.config = config;
    this.logger = logger;
    this.publishTracks = publishTracks;
    this.limiter = new SpacedRateLimiter(config.adsb.minRequestSpacingMs);
    this.timer = null;
    this.stopped = false;
    this.status = {
      name: 'adsb',
      enabled: config.adsb.enabled,
      state: config.adsb.enabled ? 'starting' : 'disabled',
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastLatencyMs: null,
      accepted: 0,
      rejected: 0,
    };
  }

  start() {
    if (!this.config.adsb.enabled) {
      this.logger.info('adsb_provider_disabled');
      return;
    }

    this.logger.info('adsb_provider_starting', {
      provider: this.config.adsb.provider,
      pollSeconds: this.config.adsb.pollSeconds,
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
        this.logger.error('adsb_poll_unhandled_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
  }

  async poll() {
    if (this.stopped) return;
    await this.limiter.wait();

    const urls = [this.config.adsb.url, ...this.config.adsb.fallbackUrls].filter(Boolean);
    let finalError = null;

    for (const url of urls) {
      try {
        const result = await fetchJson(url, {
          headers: this.config.adsb.headers,
          timeoutMs: this.config.ingestion.requestTimeoutMs,
          retries: this.config.ingestion.retryCount,
          retryBaseMs: this.config.ingestion.retryBaseMs,
          retryMaxMs: this.config.ingestion.retryMaxMs,
          logger: this.logger,
          provider: 'adsb',
        });

        const normalized = Array.isArray(result.payload?.states)
          ? normalizeOpenSkyPayload(result.payload, {
            receivedAt: new Date().toISOString(),
            staleAfterSeconds: this.config.freshness.aircraftStaleAfterSeconds,
          })
          : normalizeUnifiedPayload(result.payload, {
            receivedAt: new Date().toISOString(),
            aircraftStaleAfterSeconds: this.config.freshness.aircraftStaleAfterSeconds,
            provider: 'adsb',
            feed: url,
          });

        const publishResult = await this.publishTracks('adsb', normalized.tracks, normalized.rejected);
        this.status = {
          ...this.status,
          state: 'ok',
          lastSuccessAt: new Date().toISOString(),
          lastError: null,
          lastLatencyMs: result.latencyMs,
          accepted: this.status.accepted + publishResult.accepted,
          rejected: this.status.rejected + normalized.rejected.length + publishResult.rejected,
        };
        this.logger.info('adsb_poll_ok', {
          url,
          received: normalized.tracks.length,
          rejected: normalized.rejected.length + publishResult.rejected,
          latencyMs: result.latencyMs,
        });
        this.schedule(this.config.adsb.pollSeconds * 1000);
        return;
      } catch (error) {
        finalError = error;
        this.logger.warn('adsb_poll_url_failed', {
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
    await sleep(Math.min(this.config.ingestion.retryMaxMs, this.config.adsb.pollSeconds * 1000));
    this.schedule(this.config.adsb.pollSeconds * 1000);
  }

  health() {
    return this.status;
  }
}

module.exports = { AdsbProvider };
