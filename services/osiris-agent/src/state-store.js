'use strict';

const { distanceKm } = require('./geo');

const MOVEMENT_TYPES = new Set(['adsb', 'ais']);
const HAZARD_TYPES = new Set(['weather', 'quake', 'wildfire']);

function eventTime(event) {
  const parsed = Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function entityKey(event) {
  if (!MOVEMENT_TYPES.has(event.type)) return event.id;
  const payload = event.payload || {};
  if (event.type === 'adsb') return `adsb:${payload.icao24 || payload.callsign || payload.entity_id || event.id}`;
  if (event.type === 'ais') return `ais:${payload.mmsi || payload.imo || payload.entity_id || event.id}`;
  return event.id;
}

class StateStore {
  constructor(config) {
    this.config = config;
    this.events = [];
    this.lastByEntity = new Map();
  }

  add(event) {
    const previous = this.lastByEntity.get(entityKey(event)) || null;
    const enriched = {
      ...event,
      observed_at_ms: eventTime(event),
      entity_key: entityKey(event),
    };

    this.events.push(enriched);
    if (MOVEMENT_TYPES.has(event.type)) this.lastByEntity.set(entityKey(event), enriched);

    this.prune();
    return {
      event: enriched,
      previous,
      nearby: this.nearby(enriched, {
        radiusKm: this.config.state.correlationRadiusKm,
        windowMs: this.config.state.correlationWindowMs,
      }),
      sameTypeCluster: this.nearby(enriched, {
        radiusKm: this.config.state.clusterRadiusKm,
        windowMs: this.config.state.clusterWindowMs,
        type: enriched.type,
      }),
    };
  }

  nearby(event, options = {}) {
    const radiusKm = options.radiusKm || this.config.state.correlationRadiusKm;
    const windowMs = options.windowMs || this.config.state.correlationWindowMs;
    const time = event.observed_at_ms || eventTime(event);

    return this.events
      .filter((candidate) => candidate.id !== event.id)
      .filter((candidate) => !options.type || candidate.type === options.type)
      .filter((candidate) => Math.abs((candidate.observed_at_ms || eventTime(candidate)) - time) <= windowMs)
      .map((candidate) => ({ event: candidate, distanceKm: distanceKm(event.geo, candidate.geo) }))
      .filter((candidate) => candidate.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 25);
  }

  prune() {
    const now = Date.now();
    const maxAge = Math.max(this.config.state.entityTtlMs, this.config.state.hazardTtlMs);
    this.events = this.events
      .filter((event) => now - (event.observed_at_ms || eventTime(event)) <= maxAge)
      .slice(-this.config.state.maxEvents);

    for (const [key, event] of this.lastByEntity.entries()) {
      if (now - (event.observed_at_ms || eventTime(event)) > this.config.state.entityTtlMs) {
        this.lastByEntity.delete(key);
      }
    }
  }

  summary() {
    const byType = {};
    for (const event of this.events) byType[event.type] = (byType[event.type] || 0) + 1;
    return {
      events: this.events.length,
      entities: this.lastByEntity.size,
      byType,
    };
  }
}

module.exports = {
  HAZARD_TYPES,
  MOVEMENT_TYPES,
  StateStore,
  entityKey,
  eventTime,
};
