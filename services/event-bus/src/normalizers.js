'use strict';

const { createEvent, stableId, toNumber } = require('./event-schema');

function pointFromCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) return null;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    return { lon: coordinates[0], lat: coordinates[1] };
  }

  const points = [];
  const walk = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      points.push({ lon: value[0], lat: value[1] });
      return;
    }
    for (const item of value) walk(item);
  };
  walk(coordinates);
  if (!points.length) return null;

  const sum = points.reduce((acc, point) => ({
    lat: acc.lat + point.lat,
    lon: acc.lon + point.lon,
  }), { lat: 0, lon: 0 });
  return {
    lat: sum.lat / points.length,
    lon: sum.lon / points.length,
  };
}

function severityConfidence(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'extreme' || normalized === 'observed') return 0.95;
  if (normalized === 'severe' || normalized === 'likely') return 0.85;
  if (normalized === 'moderate' || normalized === 'possible') return 0.7;
  if (normalized === 'minor' || normalized === 'unlikely') return 0.55;
  return 0.65;
}

function normalizeWeatherPayload(payload, feedConfig) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const events = [];
  const rejected = [];

  for (const feature of features) {
    const props = feature?.properties || {};
    const point = pointFromCoordinates(feature?.geometry?.coordinates);
    if (!point) {
      rejected.push({ id: props.id || feature?.id, reason: 'missing_geo' });
      continue;
    }

    try {
      events.push(createEvent({
        id: `weather:${props.id || feature.id || stableId([props.event, props.sent, props.areaDesc])}`,
        type: 'weather',
        timestamp: props.sent || props.effective || props.onset,
        geo: point,
        payload: {
          event: props.event,
          headline: props.headline,
          description: props.description,
          instruction: props.instruction,
          severity: props.severity,
          urgency: props.urgency,
          certainty: props.certainty,
          area: props.areaDesc,
          expires: props.expires,
          status: props.status,
          message_type: props.messageType,
        },
        metadata: {
          confidence: Math.max(severityConfidence(props.severity), severityConfidence(props.certainty)),
          source: feedConfig.source || 'nws',
          feed: feedConfig.url,
          raw_id: props.id || feature.id || '',
        },
      }));
    } catch (error) {
      rejected.push({ id: props.id || feature?.id, reason: error.message });
    }
  }

  return { events, rejected };
}

function normalizeQuakePayload(payload, feedConfig) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const events = [];
  const rejected = [];

  for (const feature of features) {
    const props = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const lon = toNumber(coordinates[0]);
    const lat = toNumber(coordinates[1]);
    const depthKm = toNumber(coordinates[2]);

    try {
      events.push(createEvent({
        id: `quake:${feature.id || props.ids || stableId([props.time, lat, lon, props.mag])}`,
        type: 'quake',
        timestamp: props.time,
        geo: { lat, lon },
        payload: {
          magnitude: toNumber(props.mag),
          place: props.place,
          depth_km: depthKm,
          tsunami: props.tsunami,
          felt: props.felt,
          cdi: props.cdi,
          mmi: props.mmi,
          url: props.url,
          status: props.status,
          alert: props.alert,
          significance: props.sig,
        },
        metadata: {
          confidence: props.status === 'reviewed' ? 0.95 : 0.82,
          source: feedConfig.source || 'usgs',
          feed: feedConfig.url,
          raw_id: feature.id || '',
        },
      }));
    } catch (error) {
      rejected.push({ id: feature?.id, reason: error.message });
    }
  }

  return { events, rejected };
}

function latestGeometry(event) {
  const geometries = Array.isArray(event?.geometry) ? event.geometry : [];
  return geometries
    .filter((item) => item && Array.isArray(item.coordinates))
    .sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0))[0] || null;
}

function normalizeWildfirePayload(payload, feedConfig) {
  const rows = Array.isArray(payload?.events)
    ? payload.events
    : Array.isArray(payload?.features)
      ? payload.features
      : Array.isArray(payload)
        ? payload
        : [];
  const events = [];
  const rejected = [];

  for (const row of rows) {
    const sourceRow = row?.properties ? { ...row.properties, geometry: row.geometry } : row;
    const geometry = latestGeometry(sourceRow) || sourceRow?.geometry || row?.geometry;
    const point = pointFromCoordinates(geometry?.coordinates);

    if (!point) {
      rejected.push({ id: sourceRow?.id || row?.id, reason: 'missing_geo' });
      continue;
    }

    try {
      events.push(createEvent({
        id: `wildfire:${sourceRow.id || row.id || stableId([sourceRow.title, geometry?.date, point.lat, point.lon])}`,
        type: 'wildfire',
        timestamp: geometry?.date || sourceRow.updated || sourceRow.closed || sourceRow.created,
        geo: point,
        payload: {
          title: sourceRow.title || sourceRow.name,
          description: sourceRow.description,
          categories: sourceRow.categories,
          sources: sourceRow.sources,
          closed: sourceRow.closed,
          geometry_type: geometry?.type || row?.geometry?.type,
        },
        metadata: {
          confidence: 0.78,
          source: feedConfig.source || 'eonet',
          feed: feedConfig.url,
          raw_id: sourceRow.id || row.id || '',
        },
      }));
    } catch (error) {
      rejected.push({ id: sourceRow?.id || row?.id, reason: error.message });
    }
  }

  return { events, rejected };
}

function normalizePayload(payload, feedConfig) {
  if (feedConfig.type === 'weather') return normalizeWeatherPayload(payload, feedConfig);
  if (feedConfig.type === 'quake') return normalizeQuakePayload(payload, feedConfig);
  if (feedConfig.type === 'wildfire') return normalizeWildfirePayload(payload, feedConfig);
  return { events: [], rejected: [{ reason: `unsupported_feed_type:${feedConfig.type}` }] };
}

module.exports = {
  normalizePayload,
  normalizeQuakePayload,
  normalizeWeatherPayload,
  normalizeWildfirePayload,
};
