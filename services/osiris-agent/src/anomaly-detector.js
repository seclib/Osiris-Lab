'use strict';

const { MOVEMENT_TYPES } = require('./state-store');
const { zonesFor } = require('./geo');

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function headingDelta(a, b) {
  if (a === null || b === null) return null;
  const diff = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return Math.round(diff);
}

function eventAgeSeconds(event) {
  const parsed = Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
}

function anomaly(type, severity, confidence, reason, details = {}) {
  return { type, severity, confidence, reason, details };
}

function detectMovement(event, context) {
  const anomalies = [];
  const payload = event.payload || {};
  const speedKnots = num(payload.speed_knots);
  const heading = num(payload.heading);
  const previous = context.previous;
  const previousHeading = previous ? num(previous.payload?.heading) : null;
  const previousSpeed = previous ? num(previous.payload?.speed_knots) : null;
  const age = eventAgeSeconds(event);

  if (age !== null && age > 900) {
    anomalies.push(anomaly('stale_track', 'MEDIUM', 0.72, `Track is ${age}s old`, { age_seconds: age }));
  }

  if (event.type === 'adsb') {
    if (speedKnots !== null && speedKnots > 620) {
      anomalies.push(anomaly('abnormal_air_speed', 'HIGH', 0.82, `Aircraft speed ${speedKnots}kt exceeds expected envelope`, { speed_knots: speedKnots }));
    }
    if (payload.grounded && speedKnots !== null && speedKnots > 80) {
      anomalies.push(anomaly('ground_state_conflict', 'MEDIUM', 0.74, 'Aircraft marked grounded while moving quickly', { speed_knots: speedKnots }));
    }
  }

  if (event.type === 'ais') {
    if (speedKnots !== null && speedKnots > 45) {
      anomalies.push(anomaly('abnormal_vessel_speed', 'HIGH', 0.84, `Vessel speed ${speedKnots}kt is unusually high`, { speed_knots: speedKnots }));
    }
    const zones = zonesFor(event.geo);
    if (zones.length) {
      anomalies.push(anomaly('movement_in_risk_zone', zones.some((zone) => zone.risk === 'HIGH') ? 'HIGH' : 'MEDIUM', 0.78, `Vessel observed in ${zones[0].name}`, { zones }));
    }
  }

  if (previous && MOVEMENT_TYPES.has(event.type)) {
    const delta = headingDelta(heading, previousHeading);
    if (delta !== null && delta >= 100) {
      anomalies.push(anomaly('abrupt_heading_change', 'MEDIUM', 0.68, `Heading changed ${delta} degrees`, { heading_delta: delta }));
    }
    if (speedKnots !== null && previousSpeed !== null && Math.abs(speedKnots - previousSpeed) >= 180) {
      anomalies.push(anomaly('abrupt_speed_change', 'MEDIUM', 0.66, `Speed changed ${Math.round(Math.abs(speedKnots - previousSpeed))}kt`, { previous_speed_knots: previousSpeed, speed_knots: speedKnots }));
    }
  }

  return anomalies;
}

function detectHazard(event) {
  const anomalies = [];
  const payload = event.payload || {};

  if (event.type === 'quake') {
    const magnitude = num(payload.magnitude);
    if (magnitude !== null && magnitude >= 6.5) {
      anomalies.push(anomaly('major_earthquake', 'CRITICAL', 0.92, `Magnitude ${magnitude} earthquake`, { magnitude }));
    } else if (magnitude !== null && magnitude >= 5) {
      anomalies.push(anomaly('significant_earthquake', 'HIGH', 0.86, `Magnitude ${magnitude} earthquake`, { magnitude }));
    }
    if (payload.tsunami) {
      anomalies.push(anomaly('tsunami_flag', 'CRITICAL', 0.88, 'Earthquake carries tsunami flag', { tsunami: payload.tsunami }));
    }
  }

  if (event.type === 'wildfire') {
    const frp = num(payload.frp);
    if (frp !== null && frp >= 250) {
      anomalies.push(anomaly('high_intensity_fire', 'HIGH', 0.8, `Wildfire FRP ${frp}`, { frp }));
    }
  }

  if (event.type === 'weather') {
    const severity = String(payload.severity || '').toLowerCase();
    if (['high', 'severe', 'extreme'].includes(severity)) {
      anomalies.push(anomaly('severe_weather', severity === 'extreme' ? 'CRITICAL' : 'HIGH', 0.82, `Weather severity ${payload.severity}`, { severity: payload.severity }));
    }
  }

  return anomalies;
}

function detectCluster(event, context) {
  const count = context.sameTypeCluster.length;
  if (count < 5) return [];
  const severity = count >= 15 ? 'HIGH' : 'MEDIUM';
  return [anomaly('localized_event_cluster', severity, 0.7, `${count + 1} ${event.type} events clustered nearby`, { nearby_count: count })];
}

function detectAnomalies(event, context) {
  return [
    ...detectMovement(event, context),
    ...detectHazard(event, context),
    ...detectCluster(event, context),
  ];
}

module.exports = {
  detectAnomalies,
};
