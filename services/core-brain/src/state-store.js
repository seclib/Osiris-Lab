'use strict';

const { gridKey } = require('./geo');

function pruneMapByUpdatedAt(map, ttlMs, now) {
  for (const [key, value] of map.entries()) {
    if (now - value.updatedAt > ttlMs) map.delete(key);
  }
}

class BrainStateStore {
  constructor(config) {
    this.config = config;
    this.entities = new Map();
    this.hazards = new Map();
    this.density = new Map();
    this.alertDedupe = new Map();
    this.stats = {
      entityCount: 0,
      hazardCount: 0,
      densityCells: 0,
    };
  }

  entityIdFor(event) {
    if (event.type === 'adsb') return event.payload?.id || event.payload?.icao24 || event.id;
    if (event.type === 'ais') return event.payload?.id || event.payload?.mmsi || event.id;
    return event.id;
  }

  isTrack(event) {
    return event.type === 'adsb' || event.type === 'ais';
  }

  isHazard(event) {
    return event.type === 'weather' || event.type === 'quake' || event.type === 'wildfire';
  }

  addEvent(event) {
    const now = Date.now();
    this.prune(now);

    if (this.isTrack(event)) return this.addTrack(event, now);
    if (this.isHazard(event)) return this.addHazard(event, now);
    return { previous: null, history: [] };
  }

  addTrack(event, now) {
    const entityId = this.entityIdFor(event);
    let entry = this.entities.get(entityId);
    if (!entry) {
      entry = { id: entityId, type: event.type, history: [], updatedAt: now };
      this.entities.set(entityId, entry);
    }

    const previous = entry.history[entry.history.length - 1] || null;
    entry.history.push(event);
    if (entry.history.length > this.config.state.maxEntityHistory) entry.history.shift();
    entry.updatedAt = now;

    const key = gridKey(event.geo, this.config.detection.densityGridKm);
    if (!this.density.has(key)) this.density.set(key, []);
    this.density.get(key).push({ id: entityId, type: event.type, at: now });

    return { previous, history: entry.history.slice(0, -1), entityId };
  }

  addHazard(event, now) {
    this.hazards.set(event.id, { event, updatedAt: now });
    return { previous: null, history: [] };
  }

  nearbyHazards(event, radiusKm) {
    const output = [];
    const now = Date.now();
    for (const [id, record] of this.hazards.entries()) {
      if (now - record.updatedAt > this.config.state.hazardTtlMs) {
        this.hazards.delete(id);
        continue;
      }
      output.push(record.event);
    }
    return output.filter(Boolean);
  }

  densityFor(event) {
    const now = Date.now();
    const key = gridKey(event.geo, this.config.detection.densityGridKm);
    const rows = (this.density.get(key) || [])
      .filter((row) => now - row.at <= this.config.detection.densityWindowMs);
    this.density.set(key, rows);

    const unique = new Set(rows.map((row) => `${row.type}:${row.id}`));
    return {
      key,
      count: unique.size,
      threshold: this.config.detection.densityThreshold,
    };
  }

  shouldPublishAlert(key) {
    const now = Date.now();
    const last = this.alertDedupe.get(key);
    if (last && now - last < this.config.state.dedupeTtlMs) return false;
    this.alertDedupe.set(key, now);
    return true;
  }

  prune(now = Date.now()) {
    pruneMapByUpdatedAt(this.entities, this.config.state.entityTtlMs, now);
    pruneMapByUpdatedAt(this.hazards, this.config.state.hazardTtlMs, now);

    for (const [key, rows] of this.density.entries()) {
      const fresh = rows.filter((row) => now - row.at <= this.config.detection.densityWindowMs);
      if (fresh.length) this.density.set(key, fresh);
      else this.density.delete(key);
    }

    for (const [key, timestamp] of this.alertDedupe.entries()) {
      if (now - timestamp > this.config.state.dedupeTtlMs) this.alertDedupe.delete(key);
    }

    while (this.entities.size > this.config.state.maxEntities) {
      this.entities.delete(this.entities.keys().next().value);
    }
    while (this.hazards.size > this.config.state.maxHazards) {
      this.hazards.delete(this.hazards.keys().next().value);
    }

    this.stats = {
      entityCount: this.entities.size,
      hazardCount: this.hazards.size,
      densityCells: this.density.size,
    };
  }

  summary() {
    this.prune();
    return { ...this.stats };
  }
}

module.exports = { BrainStateStore };
