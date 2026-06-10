'use strict';

class TrackStore {
  constructor(config) {
    this.config = config;
    this.latest = new Map();
    this.stats = {
      accepted: 0,
      rejected: 0,
      outOfOrder: 0,
      lastAcceptedAt: null,
    };
  }

  staleAfterSeconds(type) {
    return type === 'aircraft'
      ? this.config.freshness.aircraftStaleAfterSeconds
      : this.config.freshness.vesselStaleAfterSeconds;
  }

  withCurrentFreshness(track) {
    const copy = structuredClone(track);
    const observed = Date.parse(copy.timestamp);
    const ageSeconds = Number.isFinite(observed) ? Math.max(0, Math.round((Date.now() - observed) / 1000)) : null;
    const staleAfter = this.staleAfterSeconds(copy.type);
    copy.quality.age_seconds = ageSeconds;
    copy.quality.stale = ageSeconds === null || ageSeconds > staleAfter;
    return copy;
  }

  upsert(track) {
    const current = this.latest.get(track.id);
    if (current && Date.parse(current.timestamp) > Date.parse(track.timestamp)) {
      this.stats.outOfOrder += 1;
      return { accepted: false, reason: 'out_of_order', track };
    }

    this.latest.set(track.id, {
      ...track,
      updated_at: new Date().toISOString(),
    });
    this.stats.accepted += 1;
    this.stats.lastAcceptedAt = new Date().toISOString();
    return { accepted: true, track };
  }

  upsertMany(tracks) {
    const accepted = [];
    const rejected = [];

    for (const track of tracks) {
      const result = this.upsert(track);
      if (result.accepted) {
        accepted.push(result.track);
      } else {
        rejected.push({ id: track.id, reason: result.reason });
      }
    }

    this.stats.rejected += rejected.length;
    return { accepted, rejected };
  }

  get(id) {
    const track = this.latest.get(id);
    return track ? this.withCurrentFreshness(track) : null;
  }

  list(filters = {}) {
    const limit = Math.max(1, Math.min(Number(filters.limit || 1000), 10000));
    const bbox = Array.isArray(filters.bbox) && filters.bbox.length === 4 ? filters.bbox : null;
    const includeStale = filters.includeStale !== false;
    const output = [];

    for (const track of this.latest.values()) {
      const current = this.withCurrentFreshness(track);
      if (filters.type && current.type !== filters.type) continue;
      if (!includeStale && current.quality.stale) continue;
      if (bbox) {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        if (
          current.position.lon < minLon
          || current.position.lon > maxLon
          || current.position.lat < minLat
          || current.position.lat > maxLat
        ) {
          continue;
        }
      }
      output.push(current);
      if (output.length >= limit) break;
    }

    return output;
  }

  pruneExpired() {
    const maxAgeMs = this.config.freshness.hardDeleteAfterSeconds * 1000;
    const now = Date.now();
    let deleted = 0;

    for (const [id, track] of this.latest.entries()) {
      const observed = Date.parse(track.timestamp);
      if (!Number.isFinite(observed) || now - observed > maxAgeMs) {
        this.latest.delete(id);
        deleted += 1;
      }
    }

    return deleted;
  }

  summary() {
    let aircraft = 0;
    let vessels = 0;
    let stale = 0;

    for (const track of this.latest.values()) {
      const current = this.withCurrentFreshness(track);
      if (current.type === 'aircraft') aircraft += 1;
      if (current.type === 'vessel') vessels += 1;
      if (current.quality.stale) stale += 1;
    }

    return {
      total: this.latest.size,
      aircraft,
      vessels,
      stale,
      ...this.stats,
    };
  }
}

module.exports = { TrackStore };
