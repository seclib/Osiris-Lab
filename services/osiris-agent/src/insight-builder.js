'use strict';

const crypto = require('crypto');

function stableId(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 18);
}

function label(event) {
  const payload = event.payload || {};
  if (event.type === 'adsb') return payload.callsign || payload.icao24 || payload.entity_id || event.id;
  if (event.type === 'ais') return payload.name || payload.mmsi || payload.entity_id || event.id;
  return payload.title || payload.weather_type || payload.place || event.id;
}

function domain(type) {
  if (type === 'adsb') return 'Aircraft';
  if (type === 'ais') return 'Vessel';
  if (type === 'quake') return 'Earthquake';
  if (type === 'wildfire') return 'Wildfire';
  if (type === 'weather') return 'Weather';
  return 'Event';
}

function normalizeText(value) {
  return String(value || '').replace(/_/g, ' ');
}

function insightType(anomalies, correlations, score, config) {
  if (score.final >= config.processing.alertMinScore) return 'alert';
  if (anomalies.length) return 'anomaly';
  return 'insight';
}

function buildSummary(event, anomalies, correlations, score) {
  const name = label(event);
  const kind = domain(event.type);
  const zone = score.zones?.[0]?.name;
  const anomaly = anomalies[0];
  const correlation = correlations[0];

  if (anomaly && correlation) {
    return `${kind} ${name} shows ${normalizeText(anomaly.type)} with nearby ${normalizeText(correlation.target_type)} context${zone ? ` in ${zone}` : ''}.`;
  }
  if (anomaly) return `${kind} ${name} shows ${normalizeText(anomaly.type)}${zone ? ` in ${zone}` : ''}.`;
  if (correlation) return `${kind} ${name} correlates with nearby ${normalizeText(correlation.target_type)} activity${zone ? ` in ${zone}` : ''}.`;
  return `${kind} ${name} produced a notable intelligence signal${zone ? ` in ${zone}` : ''}.`;
}

function buildReasoning(event, anomalies, correlations, score) {
  const parts = [
    `score=${score.final}`,
    `risk=${score.risk}`,
    `importance=${score.importance}`,
    `confidence=${score.confidence}`,
    `source=${event.metadata?.source || 'unknown'}`,
  ];

  if (anomalies.length) {
    parts.push(`anomalies=${anomalies.map((item) => `${item.type}:${item.severity}`).join(',')}`);
  }
  if (correlations.length) {
    parts.push(`correlations=${correlations.map((item) => `${item.type}:${item.target_type}:${item.distance_km}km`).join(',')}`);
  }
  if (score.zones?.length) {
    parts.push(`zones=${score.zones.map((zone) => `${zone.name}:${zone.risk}`).join(',')}`);
  }

  return parts.join('; ');
}

function buildInsight(event, streamId, anomalies, correlations, score, config) {
  const type = insightType(anomalies, correlations, score, config);
  const now = new Date().toISOString();
  const id = `insight:${stableId([event.id, streamId, type, score.final, anomalies.map((item) => item.type).join(','), correlations.map((item) => item.target_event_id).join(',')])}`;

  return {
    id,
    event_id: event.id,
    source_stream_id: streamId,
    type,
    risk: score.level,
    score,
    summary: buildSummary(event, anomalies, correlations, score),
    reasoning: buildReasoning(event, anomalies, correlations, score),
    anomalies,
    correlations,
    geo_context: {
      lat: event.geo.lat,
      lon: event.geo.lon,
      zones: score.zones || [],
      source_type: event.type,
      source: event.metadata?.source || 'unknown',
      timestamp: event.timestamp,
    },
    source_event: {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      geo: event.geo,
      payload: event.payload,
      metadata: event.metadata,
    },
    llm: {
      enabled: config.ollama.enabled,
      used: false,
      provider: config.ollama.enabled ? 'ollama' : 'none',
      model: config.ollama.enabled ? config.ollama.model : null,
    },
    emitted_at: now,
  };
}

module.exports = {
  buildInsight,
};
