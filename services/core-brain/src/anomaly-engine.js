'use strict';

const { distanceKm, headingDelta } = require('./geo');

function speedKnots(event) {
  const payload = event.payload || {};
  if (typeof payload.speed_knots === 'number') return payload.speed_knots;
  if (typeof payload.velocity?.speed_knots === 'number') return payload.velocity.speed_knots;
  if (typeof payload.speed === 'number' && event.type === 'ais') return payload.speed;
  if (typeof payload.speed === 'number') return payload.speed * 1.9438444924406;
  if (typeof payload.velocity?.speed_mps === 'number') return payload.velocity.speed_mps * 1.9438444924406;
  return null;
}

function heading(event) {
  const value = event.payload?.heading ?? event.payload?.track ?? event.payload?.course;
  return typeof value === 'number' ? value : null;
}

function hazardSeverity(event) {
  if (event.type === 'quake') {
    const mag = Number(event.payload?.magnitude || 0);
    if (mag >= 7) return { severity: 'critical', strength: 1 };
    if (mag >= 6) return { severity: 'high', strength: 0.85 };
    if (mag >= 5) return { severity: 'medium', strength: 0.65 };
    return { severity: 'low', strength: 0.35 };
  }

  if (event.type === 'weather') {
    const severity = String(event.payload?.severity || '').toLowerCase();
    if (severity === 'extreme') return { severity: 'critical', strength: 0.95 };
    if (severity === 'severe') return { severity: 'high', strength: 0.82 };
    if (severity === 'moderate') return { severity: 'medium', strength: 0.6 };
    return { severity: 'low', strength: 0.35 };
  }

  if (event.type === 'wildfire') return { severity: 'medium', strength: 0.68 };
  return { severity: 'low', strength: 0.25 };
}

function detectTrackAnomalies(event, context, state, config) {
  const anomalies = [];
  const previous = context.previous;
  const currentSpeed = speedKnots(event);
  const currentHeading = heading(event);

  if (previous) {
    const dtSeconds = Math.max(1, (Date.parse(event.timestamp) - Date.parse(previous.timestamp)) / 1000);
    const prevSpeed = speedKnots(previous);
    const prevHeading = heading(previous);

    if (dtSeconds >= config.detection.minTrackDtSeconds && currentSpeed !== null && prevSpeed !== null) {
      const delta = Math.abs(currentSpeed - prevSpeed);
      if (delta >= config.detection.speedJumpKnots) {
        anomalies.push({
          type: 'speed_jump',
          severity: delta >= config.detection.speedJumpKnots * 2 ? 'high' : 'medium',
          strength: Math.min(1, delta / (config.detection.speedJumpKnots * 2)),
          evidence: { previous_knots: prevSpeed, current_knots: currentSpeed, delta_knots: Math.round(delta), dt_seconds: Math.round(dtSeconds) },
        });
      }
    }

    if (dtSeconds >= config.detection.minTrackDtSeconds && currentHeading !== null && prevHeading !== null && (currentSpeed || 0) > 8) {
      const delta = headingDelta(prevHeading, currentHeading);
      if (delta >= config.detection.headingJumpDegrees) {
        anomalies.push({
          type: 'heading_change',
          severity: delta >= 120 ? 'high' : 'medium',
          strength: Math.min(1, delta / 180),
          evidence: { previous_heading: prevHeading, current_heading: currentHeading, delta_degrees: delta, dt_seconds: Math.round(dtSeconds) },
        });
      }
    }
  }

  const density = state.densityFor(event);
  if (density.count >= density.threshold) {
    anomalies.push({
      type: 'density_anomaly',
      severity: density.count >= density.threshold * 2 ? 'high' : 'medium',
      strength: Math.min(1, density.count / (density.threshold * 2)),
      evidence: density,
    });
  }

  return anomalies;
}

function detectHazardAnomalies(event) {
  const severity = hazardSeverity(event);
  if (severity.strength < 0.6) return [];
  return [{
    type: `${event.type}_hazard`,
    severity: severity.severity,
    strength: severity.strength,
    evidence: {
      source: event.metadata?.source,
      payload: event.payload,
    },
  }];
}

function detectAnomalies(event, context, state, config) {
  if (event.type === 'adsb' || event.type === 'ais') return detectTrackAnomalies(event, context, state, config);
  return detectHazardAnomalies(event);
}

function proximityAnomaly(event, hazard, config) {
  const radius = event.type === 'adsb'
    ? config.detection.aircraftHazardRadiusKm
    : config.detection.vesselHazardRadiusKm;
  const distance = distanceKm(event.geo, hazard.geo);
  if (distance > radius) return null;
  const severity = hazardSeverity(hazard);
  return {
    type: `${event.type}_near_${hazard.type}`,
    severity: severity.strength >= 0.85 ? 'high' : 'medium',
    strength: Math.max(0.35, severity.strength * (1 - distance / Math.max(radius, 1))),
    evidence: {
      hazard_id: hazard.id,
      hazard_type: hazard.type,
      distance_km: Math.round(distance * 10) / 10,
      radius_km: radius,
    },
  };
}

module.exports = {
  detectAnomalies,
  hazardSeverity,
  proximityAnomaly,
  speedKnots,
};
