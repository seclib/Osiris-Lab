'use strict';

const { createClient } = require('redis');

function trackEventType(track) {
  if (track.type === 'aircraft') return 'adsb';
  if (track.type === 'vessel') return 'ais';
  return track.type || 'unknown';
}

function trackToEvent(track) {
  const type = trackEventType(track);
  return {
    id: `${type}:${track.id}:${Date.parse(track.timestamp) || Date.now()}`,
    type,
    timestamp: track.timestamp,
    geo: {
      lat: track.latitude ?? track.position?.lat,
      lon: track.longitude ?? track.position?.lon,
    },
    payload: track,
    metadata: {
      confidence: typeof track.quality?.confidence === 'number' ? track.quality.confidence : 0.75,
      source: track.source?.provider || type,
      feed: track.source?.feed || '',
      raw_id: track.source?.raw_id || track.id,
      schema_version: '1.0',
      received_at: track.source?.received_at || new Date().toISOString(),
    },
  };
}

function eventToFields(event) {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    geo: JSON.stringify(event.geo),
    payload: JSON.stringify(event.payload),
    metadata: JSON.stringify(event.metadata),
    event: JSON.stringify(event),
  };
}

class RedisCache {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    if (!this.config.redis.enabled || !this.config.redis.url) {
      this.logger.info('redis_cache_disabled');
      return;
    }

    this.client = createClient({ url: this.config.redis.url });
    this.client.on('error', (error) => {
      this.connected = false;
      this.logger.warn('redis_cache_error', { error: error.message });
    });
    this.client.on('ready', () => {
      this.connected = true;
      this.logger.info('redis_cache_ready');
    });
    await this.client.connect();
  }

  async close() {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
  }

  async writeTrack(track) {
    if (!this.client?.isOpen) return;

    const payload = JSON.stringify(track);
    const key = `${this.config.redis.keyPrefix}:latest:${track.id}`;

    try {
      const transaction = this.client.multi()
        .setEx(key, this.config.redis.ttlSeconds, payload)
        .publish(this.config.redis.publishChannel, payload)
        .xAdd(this.config.redis.streamKey, '*', {
          id: track.id,
          type: track.type,
          payload,
        }, { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100000 } });

      if (this.config.redis.eventStreamEnabled && this.config.redis.eventStreamKey) {
        const eventFields = eventToFields(trackToEvent(track));
        if (this.config.redis.eventStreamMaxLen > 0) {
          transaction.xAdd(this.config.redis.eventStreamKey, '*', eventFields, {
            TRIM: {
              strategy: 'MAXLEN',
              strategyModifier: '~',
              threshold: this.config.redis.eventStreamMaxLen,
            },
          });
        } else {
          transaction.xAdd(this.config.redis.eventStreamKey, '*', eventFields);
        }
      }

      await transaction.exec();
    } catch (error) {
      this.logger.warn('redis_write_failed', {
        id: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async writeModuleHealth(moduleId, health) {
    if (!this.client?.isOpen) return;

    const status = health.enabled === false
      ? 'OFFLINE'
      : health.state === 'ok' || health.state === 'disabled'
        ? 'OK'
        : 'DEGRADED';
    const reason = health.state === 'ok'
      ? 'provider_ok'
      : health.lastError || health.state || 'unknown';
    const payload = JSON.stringify({
      moduleId,
      enabled: Boolean(health.enabled),
      status,
      reason,
      raw: health,
      updatedAt: new Date().toISOString(),
    });

    try {
      await this.client.setEx(`osiris:module:${moduleId}:health`, this.config.redis.ttlSeconds, payload);
    } catch (error) {
      this.logger.warn('redis_module_health_write_failed', {
        moduleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  health() {
    return {
      enabled: this.config.redis.enabled,
      connected: Boolean(this.client?.isOpen && this.connected),
    };
  }
}

module.exports = { RedisCache };
