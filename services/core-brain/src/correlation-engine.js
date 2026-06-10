'use strict';

const { distanceKm } = require('./geo');
const { hazardSeverity, proximityAnomaly } = require('./anomaly-engine');

function correlateTrack(event, anomalies, state, config) {
  const correlations = [];
  const derivedAnomalies = [];
  const radius = event.type === 'adsb'
    ? config.detection.aircraftHazardRadiusKm
    : config.detection.vesselHazardRadiusKm;

  for (const hazard of state.nearbyHazards(event, radius)) {
    const distance = distanceKm(event.geo, hazard.geo);
    if (distance > radius) continue;
    const severity = hazardSeverity(hazard);
    correlations.push({
      type: 'track_hazard_proximity',
      source_event_id: event.id,
      target_event_id: hazard.id,
      target_type: hazard.type,
      distance_km: Math.round(distance * 10) / 10,
      strength: Math.max(0.2, severity.strength * (1 - distance / radius)),
      evidence: {
        hazard_payload: hazard.payload,
      },
    });

    const anomaly = proximityAnomaly(event, hazard, config);
    if (anomaly) derivedAnomalies.push(anomaly);
  }

  if (anomalies.length && correlations.length) {
    correlations.push({
      type: 'anomaly_near_hazard',
      source_event_id: event.id,
      target_event_id: correlations[0].target_event_id,
      strength: Math.min(1, 0.45 + anomalies.length * 0.15 + correlations.length * 0.1),
      evidence: {
        anomaly_types: anomalies.map((item) => item.type),
        nearby_hazards: correlations.length,
      },
    });
  }

  return { correlations, derivedAnomalies };
}

function correlateHazard(event, state, config) {
  const correlations = [];
  for (const hazard of state.nearbyHazards(event, config.detection.hazardHazardRadiusKm)) {
    if (hazard.id === event.id) continue;
    const distance = distanceKm(event.geo, hazard.geo);
    if (distance > config.detection.hazardHazardRadiusKm) continue;
    correlations.push({
      type: 'hazard_hazard_cluster',
      source_event_id: event.id,
      target_event_id: hazard.id,
      target_type: hazard.type,
      distance_km: Math.round(distance * 10) / 10,
      strength: Math.max(0.15, 1 - distance / config.detection.hazardHazardRadiusKm),
      evidence: {
        source_type: event.type,
        target_type: hazard.type,
      },
    });
  }
  return { correlations, derivedAnomalies: [] };
}

function correlate(event, anomalies, state, config) {
  if (event.type === 'adsb' || event.type === 'ais') return correlateTrack(event, anomalies, state, config);
  return correlateHazard(event, state, config);
}

module.exports = { correlate };
