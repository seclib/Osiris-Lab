'use strict';

const MPS_TO_KNOTS = 1.9438444924406;
const KNOTS_TO_MPS = 0.514444;

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toStringValue(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function pick(record, keys) {
  if (!record || typeof record !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function parseTimestamp(value, fallbackIso) {
  if (value === undefined || value === null || value === '') return fallbackIso;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? fallbackIso : date.toISOString();
  }
  const parsed = Date.parse(String(value));
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return fallbackIso;
}

function normalizeHeading(value) {
  const number = toNumber(value);
  if (number === null) return null;
  const heading = ((number % 360) + 360) % 360;
  return Math.round(heading * 100) / 100;
}

function validLatLon(lat, lon) {
  return lat !== null
    && lon !== null
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180;
}

function confidenceFor(track) {
  let confidence = 1;
  if (!track.timestamp) confidence -= 0.15;
  if (track.heading === null) confidence -= 0.05;
  if (track.velocity.speed_mps === null) confidence -= 0.05;
  if (track.quality.errors.length) confidence -= Math.min(0.4, track.quality.errors.length * 0.1);
  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

function markFreshness(track, staleAfterSeconds) {
  const timestamp = Date.parse(track.timestamp);
  const ageSeconds = Number.isFinite(timestamp) ? (Date.now() - timestamp) / 1000 : Infinity;
  track.latitude = track.position.lat;
  track.longitude = track.position.lon;
  track.speed = track.velocity.speed_mps;
  track.quality.age_seconds = Math.max(0, Math.round(ageSeconds));
  track.quality.stale = ageSeconds > staleAfterSeconds;
  track.quality.confidence = confidenceFor(track);
  return track;
}

function validateTrack(track) {
  const errors = [];
  if (!track.id) errors.push('missing_id');
  if (!validLatLon(track.position.lat, track.position.lon)) errors.push('invalid_position');
  if (!track.timestamp || Number.isNaN(Date.parse(track.timestamp))) errors.push('invalid_timestamp');
  if (track.velocity.speed_mps !== null && track.velocity.speed_mps < 0) errors.push('invalid_speed');
  return errors;
}

function normalizedBase({ id, type, lat, lon, timestamp, receivedAt, source, metadata }) {
  return {
    id,
    type,
    latitude: lat,
    longitude: lon,
    speed: null,
    position: {
      lat,
      lon,
    },
    velocity: {
      speed_mps: null,
    },
    heading: null,
    timestamp,
    source: {
      provider: source.provider,
      feed: source.feed,
      received_at: receivedAt,
      raw_id: source.raw_id,
    },
    quality: {
      stale: false,
      confidence: 1,
      errors: [],
    },
    metadata: metadata || {},
  };
}

function normalizeOpenSkyPayload(payload, options = {}) {
  const receivedAt = options.receivedAt || new Date().toISOString();
  const staleAfterSeconds = options.staleAfterSeconds || 120;
  const states = Array.isArray(payload?.states) ? payload.states : [];
  const tracks = [];
  const rejected = [];

  for (const state of states) {
    if (!Array.isArray(state)) {
      rejected.push({ reason: 'invalid_state_shape' });
      continue;
    }

    const icao24 = toStringValue(state[0]).toLowerCase();
    const callsign = toStringValue(state[1]);
    const originCountry = toStringValue(state[2]);
    const timePosition = toNumber(state[3]);
    const lastContact = toNumber(state[4]);
    const lon = toNumber(state[5]);
    const lat = toNumber(state[6]);
    const baroAltitude = toNumber(state[7]);
    const onGround = Boolean(state[8]);
    const velocityMps = toNumber(state[9]);
    const trueTrack = normalizeHeading(state[10]);
    const verticalRate = toNumber(state[11]);
    const geoAltitude = toNumber(state[13]);
    const squawk = toStringValue(state[14]);
    const positionSource = toNumber(state[16]);
    const category = toNumber(state[17]);

    const track = normalizedBase({
      id: icao24 ? `aircraft:${icao24}` : '',
      type: 'aircraft',
      lat,
      lon,
      timestamp: parseTimestamp(timePosition || lastContact, receivedAt),
      receivedAt,
      source: {
        provider: 'opensky',
        feed: 'states/all',
        raw_id: icao24,
      },
      metadata: {
        icao24,
        callsign,
        country: originCountry,
        on_ground: onGround,
        squawk,
        position_source: positionSource,
        category,
      },
    });

    track.position.altitude_m = baroAltitude ?? geoAltitude ?? undefined;
    track.velocity.speed_mps = velocityMps;
    track.velocity.speed_knots = velocityMps === null ? undefined : Number((velocityMps * MPS_TO_KNOTS).toFixed(2));
    track.velocity.vertical_rate_mps = verticalRate ?? undefined;
    track.heading = trueTrack;
    track.quality.errors = validateTrack(track);

    if (track.quality.errors.length) {
      rejected.push({ id: track.id, reason: track.quality.errors.join(',') });
      continue;
    }

    tracks.push(markFreshness(track, staleAfterSeconds));
  }

  return { tracks, rejected };
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.tracks)) return payload.tracks;
  if (Array.isArray(payload.data?.tracks)) return payload.data.tracks;
  if (Array.isArray(payload.ships)) return payload.ships;
  if (Array.isArray(payload.vessels)) return payload.vessels;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.items)) return payload.items;
  if (payload.type === 'FeatureCollection' && Array.isArray(payload.features)) return payload.features;
  if (payload.type === 'Feature') return [payload];
  return [];
}

function unwrapAisItem(item) {
  if (!item || typeof item !== 'object') return {};
  if (item.type === 'Feature') {
    const coordinates = Array.isArray(item.geometry?.coordinates) ? item.geometry.coordinates : [];
    return {
      ...(item.properties || {}),
      longitude: coordinates[0],
      latitude: coordinates[1],
    };
  }
  return item;
}

function normalizeAisPayload(payload, options = {}) {
  const receivedAt = options.receivedAt || new Date().toISOString();
  const staleAfterSeconds = options.staleAfterSeconds || 600;
  const provider = options.provider || 'ais';
  const feed = options.feed || 'generic';
  const items = extractItems(payload);
  const tracks = [];
  const rejected = [];

  for (const rawItem of items) {
    const item = unwrapAisItem(rawItem);
    const mmsi = toStringValue(pick(item, ['mmsi', 'MMSI', 'ship_mmsi', 'vessel_mmsi', 'id']));
    const lat = toNumber(pick(item, ['lat', 'latitude', 'LAT', 'Latitude', 'y']));
    const lon = toNumber(pick(item, ['lon', 'lng', 'longitude', 'LON', 'Longitude', 'x']));
    const speedKnots = toNumber(pick(item, ['sog', 'speed_knots', 'speedKnots', 'speed', 'SOG']));
    const speedMps = toNumber(pick(item, ['speed_mps', 'speedMps']));
    const heading = normalizeHeading(pick(item, ['heading', 'true_heading', 'course', 'cog', 'COG', 'HDG']));
    const timestamp = parseTimestamp(
      pick(item, ['timestamp', 'time', 'last_seen', 'lastSeen', 'received_at', 'updated_at']),
      receivedAt,
    );

    const track = normalizedBase({
      id: mmsi ? `vessel:${mmsi}` : '',
      type: 'vessel',
      lat,
      lon,
      timestamp,
      receivedAt,
      source: {
        provider,
        feed,
        raw_id: mmsi,
      },
      metadata: {
        mmsi,
        name: toStringValue(pick(item, ['name', 'shipname', 'vessel_name', 'SHIPNAME'])),
        callsign: toStringValue(pick(item, ['callsign', 'call_sign', 'CALLSIGN'])),
        imo: toStringValue(pick(item, ['imo', 'IMO'])),
        destination: toStringValue(pick(item, ['destination', 'DESTINATION'])),
        navigation_status: toStringValue(pick(item, ['status', 'nav_status', 'navigation_status'])),
        vessel_type: toStringValue(pick(item, ['type', 'vessel_type', 'ship_type'])),
      },
    });

    const resolvedSpeedMps = speedMps ?? (speedKnots === null ? null : speedKnots * KNOTS_TO_MPS);
    track.velocity.speed_mps = resolvedSpeedMps === null ? null : Number(resolvedSpeedMps.toFixed(3));
    track.velocity.speed_knots = speedKnots ?? (resolvedSpeedMps === null ? undefined : Number((resolvedSpeedMps * MPS_TO_KNOTS).toFixed(2)));
    track.heading = heading;
    track.quality.errors = validateTrack(track);

    if (track.quality.errors.length) {
      rejected.push({ id: track.id, reason: track.quality.errors.join(',') });
      continue;
    }

    tracks.push(markFreshness(track, staleAfterSeconds));
  }

  return { tracks, rejected };
}

function normalizeUnifiedPayload(payload, options = {}) {
  const items = extractItems(payload);
  const receivedAt = options.receivedAt || new Date().toISOString();
  const tracks = [];
  const rejected = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      rejected.push({ reason: 'invalid_track_shape' });
      continue;
    }

    const id = toStringValue(item.id);
    const type = item.type === 'vessel' || item.type === 'aircraft' ? item.type : '';
    const lat = toNumber(item.position?.lat ?? item.lat);
    const lon = toNumber(item.position?.lon ?? item.lon ?? item.lng);
    const timestamp = parseTimestamp(item.timestamp, receivedAt);
    const speedMps = toNumber(item.velocity?.speed_mps ?? item.speed_mps);

    const track = normalizedBase({
      id,
      type,
      lat,
      lon,
      timestamp,
      receivedAt,
      source: {
        provider: toStringValue(item.source?.provider) || options.provider || 'generic',
        feed: toStringValue(item.source?.feed) || options.feed || 'unified',
        raw_id: toStringValue(item.source?.raw_id),
      },
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    });

    track.position.altitude_m = toNumber(item.position?.altitude_m ?? item.altitude_m) ?? undefined;
    track.velocity.speed_mps = speedMps;
    track.velocity.speed_knots = toNumber(item.velocity?.speed_knots ?? item.speed_knots) ?? undefined;
    track.velocity.vertical_rate_mps = toNumber(item.velocity?.vertical_rate_mps ?? item.vertical_rate_mps) ?? undefined;
    track.heading = normalizeHeading(item.heading);
    track.quality.errors = validateTrack(track);

    if (track.quality.errors.length) {
      rejected.push({ id: track.id, reason: track.quality.errors.join(',') });
      continue;
    }

    const staleAfter = type === 'aircraft'
      ? options.aircraftStaleAfterSeconds || 120
      : options.vesselStaleAfterSeconds || 600;
    tracks.push(markFreshness(track, staleAfter));
  }

  return { tracks, rejected };
}

function toGeoJsonFeature(track) {
  return {
    type: 'Feature',
    id: track.id,
    geometry: {
      type: 'Point',
      coordinates: [
        track.position.lon,
        track.position.lat,
        ...(typeof track.position.altitude_m === 'number' ? [track.position.altitude_m] : []),
      ],
    },
    properties: {
      id: track.id,
      type: track.type,
      heading: track.heading,
      speed_mps: track.velocity.speed_mps,
      speed_knots: track.velocity.speed_knots,
      altitude_m: track.position.altitude_m,
      timestamp: track.timestamp,
      source_provider: track.source.provider,
      source_feed: track.source.feed,
      stale: track.quality.stale,
      confidence: track.quality.confidence,
      ...track.metadata,
    },
  };
}

module.exports = {
  normalizeAisPayload,
  normalizeOpenSkyPayload,
  normalizeUnifiedPayload,
  toGeoJsonFeature,
};
