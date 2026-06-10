'use strict';

const { createEvent, stableId, toNumber } = require('./event-schema');

function toStringValue(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function pick(record, keys) {
  if (!record || typeof record !== 'object') return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return undefined;
}

function parseTimestamp(value, fallback = new Date().toISOString()) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function confidence(value, fallback = 0.75) {
  const parsed = toNumber(value);
  if (parsed === null) return fallback;
  return Math.max(0, Math.min(1, parsed > 1 ? parsed / 100 : parsed));
}

function validGeo(lat, lon) {
  return lat !== null
    && lon !== null
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180;
}

function compactPayload(payload, includeRaw, raw) {
  if (!includeRaw) return payload;
  return {
    ...payload,
    raw,
  };
}

function createBridgeEvent({ id, type, timestamp, lat, lon, payload, metadata, raw, options }) {
  if (!validGeo(lat, lon)) throw new Error('invalid_geo');
  return createEvent({
    id,
    type,
    timestamp,
    geo: { lat, lon },
    payload: compactPayload(payload, options.includeRawPayload, raw),
    metadata: {
      confidence: confidence(metadata.confidence),
      source: metadata.source,
      feed: metadata.feed,
      bridge_service: 'osiris-brain',
      bridge_feed_id: metadata.feedId,
      received_at: options.receivedAt,
      raw_id: metadata.rawId || id,
    },
  });
}

function normalizeTrack(track, feed, options) {
  const kind = track.type === 'aircraft' ? 'adsb' : track.type === 'vessel' ? 'ais' : '';
  if (!kind) throw new Error(`unsupported_track_type:${track.type || 'unknown'}`);

  const lat = toNumber(track.position?.lat ?? track.latitude ?? track.lat);
  const lon = toNumber(track.position?.lon ?? track.longitude ?? track.lon ?? track.lng);
  const timestamp = parseTimestamp(track.timestamp ?? track.source?.received_at, options.receivedAt);
  const entityId = toStringValue(track.id) || `${kind}:${stableId([kind, lat, lon, timestamp])}`;
  const metadata = track.metadata || {};
  const velocity = track.velocity || {};

  return createBridgeEvent({
    id: `${kind}:${entityId.replace(/^(aircraft|vessel):/, '')}`,
    type: kind,
    timestamp,
    lat,
    lon,
    raw: track,
    options,
    payload: {
      entity_id: entityId,
      entity_type: track.type,
      speed_mps: toNumber(velocity.speed_mps ?? track.speed),
      speed_knots: toNumber(velocity.speed_knots),
      heading: toNumber(track.heading),
      altitude_m: toNumber(track.position?.altitude_m),
      callsign: metadata.callsign,
      icao24: metadata.icao24,
      mmsi: metadata.mmsi,
      imo: metadata.imo,
      name: metadata.name,
      destination: metadata.destination,
      stale: Boolean(track.quality?.stale),
      age_seconds: toNumber(track.quality?.age_seconds),
    },
    metadata: {
      confidence: track.quality?.confidence,
      source: track.source?.provider || feed.source,
      feed: track.source?.feed || feed.url,
      feedId: feed.id,
      rawId: track.source?.raw_id || entityId,
    },
  });
}

function normalizeTrackingPayload(payload, feed, options) {
  const tracks = Array.isArray(payload?.tracks)
    ? payload.tracks
    : Array.isArray(payload?.data?.tracks)
      ? payload.data.tracks
      : [];
  return normalizeRows(tracks, feed, options, normalizeTrack);
}

function normalizeFlight(row, feed, options) {
  const lat = toNumber(row.lat ?? row.latitude);
  const lon = toNumber(row.lng ?? row.lon ?? row.longitude);
  const timestamp = parseTimestamp(row.timestamp, options.receivedAt);
  const rawId = toStringValue(row.icao24 || row.callsign || row.id) || stableId(['flight', lat, lon]);

  return createBridgeEvent({
    id: `adsb:${rawId}`,
    type: 'adsb',
    timestamp,
    lat,
    lon,
    raw: row,
    options,
    payload: {
      entity_id: `aircraft:${rawId}`,
      callsign: row.callsign,
      icao24: row.icao24,
      registration: row.registration,
      category: row.category || row.aircraft_category,
      model: row.model,
      altitude_m: toNumber(row.alt),
      speed_knots: toNumber(row.speed_knots),
      heading: toNumber(row.heading),
      grounded: Boolean(row.grounded),
    },
    metadata: {
      confidence: row.confidence,
      source: row.source || feed.source,
      feed: feed.url,
      feedId: feed.id,
      rawId,
    },
  });
}

function normalizeFlightsPayload(payload, feed, options) {
  const rows = [
    ...(Array.isArray(payload?.commercial_flights) ? payload.commercial_flights : []),
    ...(Array.isArray(payload?.private_flights) ? payload.private_flights : []),
    ...(Array.isArray(payload?.private_jets) ? payload.private_jets : []),
    ...(Array.isArray(payload?.military_flights) ? payload.military_flights : []),
    ...(Array.isArray(payload?.flights) ? payload.flights : []),
  ];
  return normalizeRows(rows, feed, options, normalizeFlight);
}

function normalizeShip(row, feed, options) {
  const lat = toNumber(row.lat ?? row.latitude);
  const lon = toNumber(row.lng ?? row.lon ?? row.longitude);
  const timestamp = parseTimestamp(row.timestamp, options.receivedAt);
  const rawId = toStringValue(row.mmsi || row.id || row.imo) || stableId(['ship', lat, lon]);

  return createBridgeEvent({
    id: `ais:${rawId}`,
    type: 'ais',
    timestamp,
    lat,
    lon,
    raw: row,
    options,
    payload: {
      entity_id: `vessel:${rawId}`,
      mmsi: row.mmsi,
      imo: row.imo,
      name: row.name,
      destination: row.destination,
      flag: row.flag,
      vessel_type: row.type,
      speed_knots: toNumber(row.speed),
      heading: toNumber(row.heading),
    },
    metadata: {
      confidence: row.confidence,
      source: row.source || feed.source,
      feed: feed.url,
      feedId: feed.id,
      rawId,
    },
  });
}

function normalizeMaritimePayload(payload, feed, options) {
  const rows = Array.isArray(payload?.ships)
    ? payload.ships
    : Array.isArray(payload?.vessels)
      ? payload.vessels
      : Array.isArray(payload)
        ? payload
        : [];
  return normalizeRows(rows, feed, options, normalizeShip);
}

function normalizeQuake(row, feed, options) {
  const source = row.properties ? { ...row.properties, id: row.id, geometry: row.geometry } : row;
  const coordinates = Array.isArray(source.geometry?.coordinates) ? source.geometry.coordinates : [];
  const lat = toNumber(source.lat ?? source.latitude ?? coordinates[1]);
  const lon = toNumber(source.lng ?? source.lon ?? source.longitude ?? coordinates[0]);
  const magnitude = toNumber(source.magnitude ?? source.mag);
  const rawId = toStringValue(source.id) || stableId(['quake', source.time, lat, lon, magnitude]);

  return createBridgeEvent({
    id: `quake:${rawId}`,
    type: 'quake',
    timestamp: parseTimestamp(source.time ?? source.timestamp, options.receivedAt),
    lat,
    lon,
    raw: row,
    options,
    payload: {
      magnitude,
      depth_km: toNumber(source.depth ?? coordinates[2]),
      place: source.place,
      tsunami: source.tsunami,
      felt: source.felt,
      alert: source.alert,
      url: source.url,
    },
    metadata: {
      confidence: source.status === 'reviewed' ? 0.95 : 0.82,
      source: feed.source,
      feed: feed.url,
      feedId: feed.id,
      rawId,
    },
  });
}

function normalizeQuakePayload(payload, feed, options) {
  const rows = Array.isArray(payload?.earthquakes)
    ? payload.earthquakes
    : Array.isArray(payload?.features)
      ? payload.features
      : [];
  return normalizeRows(rows, feed, options, normalizeQuake);
}

function wildfireTimestamp(row, fallback) {
  if (row.timestamp || row.date) {
    const date = String(row.timestamp || row.date);
    const time = String(row.time || '').padStart(4, '0');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}$/.test(time)) {
      return parseTimestamp(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`, fallback);
    }
    return parseTimestamp(date, fallback);
  }
  return fallback;
}

function normalizeWildfire(row, feed, options) {
  const lat = toNumber(row.lat ?? row.latitude);
  const lon = toNumber(row.lng ?? row.lon ?? row.longitude);
  const rawId = toStringValue(row.id) || stableId(['wildfire', row.date, row.time, lat, lon, row.frp]);

  return createBridgeEvent({
    id: `wildfire:${rawId}`,
    type: 'wildfire',
    timestamp: wildfireTimestamp(row, options.receivedAt),
    lat,
    lon,
    raw: row,
    options,
    payload: {
      title: row.title,
      fire_type: row.type,
      brightness: toNumber(row.brightness),
      frp: toNumber(row.frp),
      confidence_label: row.confidence,
    },
    metadata: {
      confidence: row.confidence === 'h' || row.confidence === 'high' ? 0.9 : 0.72,
      source: row.source || feed.source,
      feed: feed.url,
      feedId: feed.id,
      rawId,
    },
  });
}

function normalizeWildfirePayload(payload, feed, options) {
  const rows = Array.isArray(payload?.fires)
    ? payload.fires
    : Array.isArray(payload?.events)
      ? payload.events
      : Array.isArray(payload)
        ? payload
        : [];
  return normalizeRows(rows, feed, options, normalizeWildfire);
}

function severityConfidence(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'high' || normalized === 'extreme' || normalized === 'severe') return 0.9;
  if (normalized === 'medium' || normalized === 'moderate') return 0.75;
  if (normalized === 'low' || normalized === 'minor') return 0.6;
  return 0.7;
}

function normalizeWeather(row, feed, options) {
  const lat = toNumber(row.lat ?? row.latitude);
  const lon = toNumber(row.lng ?? row.lon ?? row.longitude);
  const rawId = toStringValue(row.id) || stableId(['weather', row.title, row.date, lat, lon]);

  return createBridgeEvent({
    id: `weather:${rawId}`,
    type: 'weather',
    timestamp: parseTimestamp(row.date ?? row.effective ?? row.timestamp, options.receivedAt),
    lat,
    lon,
    raw: row,
    options,
    payload: {
      title: row.title,
      category: row.category,
      weather_type: row.type,
      icon: row.icon,
      severity: row.severity,
      expires: row.expires,
      area: row.area,
      provider: row.provider,
    },
    metadata: {
      confidence: severityConfidence(row.severity),
      source: row.source || row.provider || feed.source,
      feed: feed.url,
      feedId: feed.id,
      rawId,
    },
  });
}

function normalizeWeatherPayload(payload, feed, options) {
  const rows = Array.isArray(payload?.events)
    ? payload.events
    : Array.isArray(payload?.weather_events)
      ? payload.weather_events
      : Array.isArray(payload)
        ? payload
        : [];
  return normalizeRows(rows, feed, options, normalizeWeather);
}

function normalizeRows(rows, feed, options, mapper) {
  const events = [];
  const rejected = [];
  const limit = Math.min(rows.length, options.maxEventsPerPoll);

  for (let index = 0; index < limit; index += 1) {
    const row = rows[index];
    try {
      events.push(mapper(row, feed, options));
    } catch (error) {
      rejected.push({
        feed: feed.id,
        index,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (rows.length > limit) {
    rejected.push({
      feed: feed.id,
      reason: `poll_limit_exceeded:${rows.length - limit}`,
    });
  }

  return { events, rejected };
}

function normalizePayload(payload, feed, options = {}) {
  const normalizerOptions = {
    receivedAt: new Date().toISOString(),
    maxEventsPerPoll: 10000,
    includeRawPayload: false,
    ...options,
  };

  if (feed.type === 'tracking') return normalizeTrackingPayload(payload, feed, normalizerOptions);
  if (feed.type === 'flights' || feed.type === 'adsb') return normalizeFlightsPayload(payload, feed, normalizerOptions);
  if (feed.type === 'maritime' || feed.type === 'ais') return normalizeMaritimePayload(payload, feed, normalizerOptions);
  if (feed.type === 'quake' || feed.type === 'earthquake' || feed.type === 'earthquakes') return normalizeQuakePayload(payload, feed, normalizerOptions);
  if (feed.type === 'wildfire' || feed.type === 'wildfires' || feed.type === 'fires') return normalizeWildfirePayload(payload, feed, normalizerOptions);
  if (feed.type === 'weather') return normalizeWeatherPayload(payload, feed, normalizerOptions);

  return {
    events: [],
    rejected: [{ feed: feed.id, reason: `unsupported_feed_type:${feed.type}` }],
  };
}

module.exports = {
  normalizeFlightsPayload,
  normalizeMaritimePayload,
  normalizePayload,
  normalizeQuakePayload,
  normalizeTrackingPayload,
  normalizeWeatherPayload,
  normalizeWildfirePayload,
};
