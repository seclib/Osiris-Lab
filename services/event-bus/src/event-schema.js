'use strict';

const { randomUUID, createHash } = require('crypto');

const EVENT_TYPES = new Set(['adsb', 'ais', 'weather', 'quake', 'wildfire']);

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseTimestamp(value, fallback = new Date().toISOString()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
  }
  const millis = Date.parse(String(value));
  return Number.isNaN(millis) ? fallback : new Date(millis).toISOString();
}

function validGeo(geo) {
  return geo
    && typeof geo === 'object'
    && typeof geo.lat === 'number'
    && typeof geo.lon === 'number'
    && geo.lat >= -90
    && geo.lat <= 90
    && geo.lon >= -180
    && geo.lon <= 180;
}

function stableId(parts) {
  const hash = createHash('sha1')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 16);
  return hash || randomUUID();
}

function confidenceNumber(value, fallback = 0.7) {
  const parsed = toNumber(value);
  if (parsed === null) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function createEvent(input) {
  const timestamp = parseTimestamp(input.timestamp);
  const type = String(input.type || '').toLowerCase();
  const geo = {
    lat: toNumber(input.geo?.lat),
    lon: toNumber(input.geo?.lon),
  };

  const event = {
    id: input.id || `${type}:${stableId([type, timestamp, JSON.stringify(input.geo), JSON.stringify(input.payload)])}`,
    type,
    timestamp,
    geo,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    metadata: {
      confidence: confidenceNumber(input.metadata?.confidence),
      source: String(input.metadata?.source || 'unknown'),
      feed: String(input.metadata?.feed || ''),
      schema_version: '1.0',
      received_at: input.metadata?.received_at || new Date().toISOString(),
      raw_id: input.metadata?.raw_id || input.id || '',
      ...input.metadata,
    },
  };

  const errors = validateEvent(event);
  if (errors.length) {
    const error = new Error(`invalid_event:${errors.join(',')}`);
    error.errors = errors;
    error.event = event;
    throw error;
  }

  return event;
}

function validateEvent(event) {
  const errors = [];
  if (!event.id) errors.push('missing_id');
  if (!EVENT_TYPES.has(event.type)) errors.push('invalid_type');
  if (!event.timestamp || Number.isNaN(Date.parse(event.timestamp))) errors.push('invalid_timestamp');
  if (!validGeo(event.geo)) errors.push('invalid_geo');
  if (!event.payload || typeof event.payload !== 'object') errors.push('invalid_payload');
  if (!event.metadata || typeof event.metadata !== 'object') errors.push('invalid_metadata');
  if (event.metadata && typeof event.metadata.confidence !== 'number') errors.push('invalid_confidence');
  return errors;
}

function eventToStreamFields(event) {
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

function fieldsToObject(fields) {
  if (Array.isArray(fields)) {
    const object = {};
    for (let i = 0; i < fields.length; i += 2) {
      object[String(fields[i])] = fields[i + 1];
    }
    return object;
  }
  return fields || {};
}

function eventFromStreamFields(fields) {
  const object = fieldsToObject(fields);
  if (object.event) return JSON.parse(object.event);
  return {
    id: object.id,
    type: object.type,
    timestamp: object.timestamp,
    geo: JSON.parse(object.geo || '{}'),
    payload: JSON.parse(object.payload || '{}'),
    metadata: JSON.parse(object.metadata || '{}'),
  };
}

module.exports = {
  EVENT_TYPES,
  createEvent,
  eventFromStreamFields,
  eventToStreamFields,
  fieldsToObject,
  parseTimestamp,
  stableId,
  toNumber,
  validateEvent,
};
