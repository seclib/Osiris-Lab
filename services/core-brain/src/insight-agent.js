'use strict';

const GEOPOLITICAL_ZONES = [
  { id: 'red_sea', name: 'Red Sea / Bab el-Mandeb', risk: 'HIGH', bbox: { west: 32, south: 11, east: 44, north: 30 } },
  { id: 'suez', name: 'Suez Canal Approaches', risk: 'HIGH', bbox: { west: 31, south: 29, east: 33.5, north: 31.8 } },
  { id: 'taiwan_strait', name: 'Taiwan Strait', risk: 'HIGH', bbox: { west: 118, south: 22, east: 122.5, north: 26.5 } },
  { id: 'south_china_sea', name: 'South China Sea', risk: 'MEDIUM', bbox: { west: 105, south: 3, east: 122, north: 23 } },
  { id: 'black_sea', name: 'Black Sea', risk: 'HIGH', bbox: { west: 27, south: 40, east: 42, north: 47.5 } },
  { id: 'persian_gulf', name: 'Persian Gulf / Strait of Hormuz', risk: 'HIGH', bbox: { west: 48, south: 24, east: 57.5, north: 30.8 } },
  { id: 'eastern_mediterranean', name: 'Eastern Mediterranean', risk: 'MEDIUM', bbox: { west: 25, south: 30, east: 37, north: 37 } },
  { id: 'gulf_of_aden', name: 'Gulf of Aden', risk: 'MEDIUM', bbox: { west: 43, south: 10, east: 53.5, north: 15 } },
  { id: 'panama_canal', name: 'Panama Canal Approaches', risk: 'MEDIUM', bbox: { west: -81, south: 7.5, east: -78.5, north: 10.5 } },
];

function isInsideBbox(geo, bbox) {
  if (!geo || typeof geo.lat !== 'number' || typeof geo.lon !== 'number') return false;
  const inLat = geo.lat >= bbox.south && geo.lat <= bbox.north;
  if (!inLat) return false;
  if (bbox.west <= bbox.east) return geo.lon >= bbox.west && geo.lon <= bbox.east;
  return geo.lon >= bbox.west || geo.lon <= bbox.east;
}

function zonesFor(geo) {
  return GEOPOLITICAL_ZONES
    .filter((zone) => isInsideBbox(geo, zone.bbox))
    .map(({ id, name, risk }) => ({ id, name, risk }));
}

function riskFromScore(score) {
  if (score?.severity) return score.severity;
  const final = Number(score?.final || 0);
  if (final >= 88) return 'CRITICAL';
  if (final >= 75) return 'HIGH';
  if (final >= 55) return 'MEDIUM';
  return 'LOW';
}

function insightType(intelligence) {
  if (intelligence.alert) return 'alert';
  if (intelligence.anomalies?.length) return 'anomaly';
  return 'insight';
}

function normalizeLabel(value) {
  return String(value || '').replace(/_/g, ' ');
}

function primaryEntityLabel(event) {
  const payload = event.payload || {};
  if (event.type === 'adsb') return payload.callsign || payload.icao24 || payload.id || event.id;
  if (event.type === 'ais') return payload.name || payload.mmsi || payload.id || event.id;
  return payload.title || payload.event || payload.name || event.id;
}

function domainName(type) {
  if (type === 'adsb') return 'Aircraft';
  if (type === 'ais') return 'Vessel';
  if (type === 'weather') return 'Weather';
  if (type === 'quake') return 'Earthquake';
  if (type === 'wildfire') return 'Wildfire';
  return 'Event';
}

function buildSummary(event, intelligence, zones) {
  const entity = primaryEntityLabel(event);
  const anomaly = intelligence.anomalies?.[0];
  const correlation = intelligence.correlations?.[0];
  const zone = zones[0]?.name;
  const domain = domainName(event.type);

  if (event.type === 'adsb' && correlation?.target_type === 'weather') {
    return `${domain} ${entity} interacting with nearby weather risk${zone ? ` near ${zone}` : ''}.`;
  }
  if (event.type === 'ais' && anomaly?.type === 'density_anomaly' && zone) {
    return `${domain} congestion anomaly detected in ${zone}.`;
  }
  if (event.type === 'ais' && correlation) {
    return `${domain} ${entity} correlated with nearby ${normalizeLabel(correlation.target_type)} event${zone ? ` near ${zone}` : ''}.`;
  }
  if (event.type === 'quake' || event.type === 'weather' || event.type === 'wildfire') {
    if (correlation) return `${domain} event clustering with nearby ${normalizeLabel(correlation.target_type)} activity${zone ? ` near ${zone}` : ''}.`;
    return `${domain} event requires monitoring${zone ? ` near ${zone}` : ''}.`;
  }
  if (anomaly) return `${domain} ${entity} showing ${normalizeLabel(anomaly.type)}${zone ? ` near ${zone}` : ''}.`;
  return `${domain} ${entity} produced a noteworthy OSIRIS intelligence signal${zone ? ` near ${zone}` : ''}.`;
}

function buildReasoning(event, intelligence, zones) {
  const parts = [];
  const score = intelligence.score || {};

  parts.push(`risk=${score.risk ?? 'n/a'}, importance=${score.importance ?? 'n/a'}, confidence=${score.confidence ?? 'n/a'}, final=${score.final ?? 'n/a'}`);

  if (intelligence.anomalies?.length) {
    parts.push(`anomalies=${intelligence.anomalies.map((item) => `${item.type}:${item.severity}`).join(',')}`);
  }
  if (intelligence.correlations?.length) {
    parts.push(`correlations=${intelligence.correlations.map((item) => `${item.type}->${item.target_type || 'unknown'}`).join(',')}`);
  }
  if (zones.length) {
    parts.push(`geo_context=${zones.map((zone) => `${zone.name}:${zone.risk}`).join(',')}`);
  }
  if (event.metadata?.source) parts.push(`source=${event.metadata.source}`);

  return parts.join('; ');
}

function buildGeoContext(event, intelligence, zones) {
  return {
    lat: event.geo.lat,
    lon: event.geo.lon,
    source_type: event.type,
    source_event_id: event.id,
    source: event.metadata?.source || 'unknown',
    timestamp: event.timestamp,
    zones,
    anomaly_count: intelligence.anomalies?.length || 0,
    correlation_count: intelligence.correlations?.length || 0,
    score: intelligence.score?.final ?? null,
  };
}

function buildInsight(event, intelligence) {
  const zones = zonesFor(event.geo);
  const risk = riskFromScore(intelligence.score);

  return {
    event_id: event.id,
    intelligence_id: intelligence.id,
    type: insightType(intelligence),
    risk,
    summary: buildSummary(event, intelligence, zones),
    reasoning: buildReasoning(event, intelligence, zones),
    geo_context: buildGeoContext(event, intelligence, zones),
    emitted_at: new Date().toISOString(),
  };
}

module.exports = {
  buildInsight,
  zonesFor,
};

