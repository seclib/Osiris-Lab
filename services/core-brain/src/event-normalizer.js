'use strict';

const { validateEvent } = require('./event-codec');

const VALID_TYPES = new Set(['adsb', 'ais', 'weather', 'quake', 'wildfire']);

function toIsoTimestamp(value) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date().toISOString();
}

function normalizeGeo(geo = {}) {
  const lat = Number(geo.lat ?? geo.latitude);
  const lon = Number(geo.lon ?? geo.lng ?? geo.longitude);
  return {
    lat,
    lon,
  };
}

function normalizeMetadata(metadata = {}) {
  const confidence = Number(metadata.confidence);
  return {
    ...metadata,
    source: metadata.source || 'unknown',
    confidence: Number.isFinite(confidence) ? confidence : 0.7,
  };
}

function normalizeEvent(raw) {
  const type = String(raw?.type || '').toLowerCase();
  const event = {
    id: raw?.id ? String(raw.id) : '',
    type,
    timestamp: raw?.timestamp ? toIsoTimestamp(raw.timestamp) : '',
    geo: normalizeGeo(raw?.geo),
    payload: raw?.payload && typeof raw.payload === 'object' ? raw.payload : {},
    metadata: normalizeMetadata(raw?.metadata),
  };

  if (!VALID_TYPES.has(event.type)) {
    event.type = type;
  }

  return event;
}

class EventNormalizer {
  constructor(bus) {
    this.bus = bus;
  }

  fromMessage(message) {
    const decoded = this.bus.decode(message);
    const event = normalizeEvent(decoded);
    const errors = validateEvent(event);
    if (errors.length) {
      const error = new Error(`invalid_event:${errors.join(',')}`);
      error.validationErrors = errors;
      throw error;
    }
    return event;
  }
}

module.exports = {
  EventNormalizer,
  normalizeEvent,
};
