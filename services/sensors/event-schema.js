'use strict';

const { createHash, randomUUID } = require('crypto');

const GEO_KEYS = ['lat', 'latitude'];
const LON_KEYS = ['lon', 'lng', 'longitude'];

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstNumber(record, keys) {
  if (!record || typeof record !== 'object') return null;
  for (const key of keys) {
    const value = toNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function parseTimestamp(value, fallback = new Date().toISOString()) {
  if (value === undefined || value === null || value === '') return fallback;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }

  const millis = Date.parse(String(value));
  return Number.isNaN(millis) ? fallback : new Date(millis).toISOString();
}

function confidenceNumber(value) {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, normalized));
}

function stableId(parts) {
  const material = parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join('|');

  if (!material) return randomUUID();

  return createHash('sha1').update(material).digest('hex').slice(0, 20);
}

function normalizeGeo(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object') throw new Error('geo_must_be_object');

  const lat = firstNumber(input, GEO_KEYS);
  const lon = firstNumber(input, LON_KEYS);

  if (lat === null && lon === null) return null;
  if (lat === null || lon === null) throw new Error('geo_requires_lat_lon');
  if (lat < -90 || lat > 90) throw new Error('geo_lat_out_of_range');
  if (lon < -180 || lon > 180) throw new Error('geo_lon_out_of_range');

  return { lat, lon };
}

function normalizePayload(payload) {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload_must_be_object');
  return payload;
}

function createEvent(input) {
  const type = String(input.type || '').trim().toLowerCase();
  const source = String(input.source || input.metadata?.source || '').trim();
  const timestamp = parseTimestamp(input.timestamp);
  const geo = normalizeGeo(input.geo);
  const payload = normalizePayload(input.payload);
  const confidence = confidenceNumber(input.confidence ?? input.metadata?.confidence);

  const event = {
    id: String(input.id || `${type}:${stableId([type, source, timestamp, geo, payload])}`),
    type,
    source,
    timestamp,
    geo,
    payload,
    confidence,
    metadata: {
      schema_version: 'sensor-event/v1',
      source,
      confidence,
      received_at: input.metadata?.received_at || new Date().toISOString(),
      sensor_id: input.metadata?.sensor_id || '',
      raw_id: input.metadata?.raw_id || input.id || '',
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    },
  };

  const errors = validateEvent(event);
  if (errors.length) {
    const error = new Error(`invalid_sensor_event:${errors.join(',')}`);
    error.errors = errors;
    error.event = event;
    throw error;
  }

  return event;
}

function validateEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object') return ['event_must_be_object'];
  if (!event.id || typeof event.id !== 'string') errors.push('missing_id');
  if (!event.type || typeof event.type !== 'string') errors.push('missing_type');
  if (!event.source || typeof event.source !== 'string') errors.push('missing_source');
  if (!event.timestamp || Number.isNaN(Date.parse(event.timestamp))) errors.push('invalid_timestamp');
  if (event.geo !== null) {
    if (!event.geo || typeof event.geo !== 'object') errors.push('invalid_geo');
    else {
      const lat = toNumber(event.geo.lat);
      const lon = toNumber(event.geo.lon);
      if (lat === null || lat < -90 || lat > 90) errors.push('invalid_geo_lat');
      if (lon === null || lon < -180 || lon > 180) errors.push('invalid_geo_lon');
    }
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) errors.push('invalid_payload');
  if (typeof event.confidence !== 'number' || event.confidence < 0 || event.confidence > 1) errors.push('invalid_confidence');

  return errors;
}

function eventToStreamFields(event) {
  return {
    id: event.id,
    type: event.type,
    source: event.source,
    timestamp: event.timestamp,
    geo: event.geo ? JSON.stringify(event.geo) : '',
    payload: JSON.stringify(event.payload),
    confidence: String(event.confidence),
    metadata: JSON.stringify(event.metadata || {}),
    event: JSON.stringify(event),
  };
}

function fieldsToObject(fields) {
  if (Array.isArray(fields)) {
    const object = {};
    for (let i = 0; i < fields.length; i += 2) object[String(fields[i])] = fields[i + 1];
    return object;
  }
  return fields || {};
}

function eventFromStreamFields(fields) {
  const object = fieldsToObject(fields);
  if (object.event) return JSON.parse(object.event);

  return createEvent({
    id: object.id,
    type: object.type,
    source: object.source,
    timestamp: object.timestamp,
    geo: object.geo ? JSON.parse(object.geo) : null,
    payload: JSON.parse(object.payload || '{}'),
    confidence: object.confidence,
    metadata: JSON.parse(object.metadata || '{}'),
  });
}

module.exports = {
  createEvent,
  eventFromStreamFields,
  eventToStreamFields,
  fieldsToObject,
  normalizeGeo,
  parseTimestamp,
  stableId,
  toNumber,
  validateEvent,
};
