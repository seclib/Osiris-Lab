'use strict';

const { HAZARD_TYPES, MOVEMENT_TYPES } = require('./state-store');
const { zonesFor } = require('./geo');

function correlation(type, target, distanceKm, confidence, reason, details = {}) {
  return {
    type,
    target_event_id: target.id,
    target_type: target.type,
    distance_km: Math.round(distanceKm * 10) / 10,
    confidence,
    reason,
    details,
  };
}

function correlate(event, context) {
  const correlations = [];
  const zones = zonesFor(event.geo);

  for (const nearby of context.nearby) {
    const target = nearby.event;
    const distance = nearby.distanceKm;

    if (MOVEMENT_TYPES.has(event.type) && HAZARD_TYPES.has(target.type)) {
      const highSeverity = target.type === 'quake' || target.type === 'wildfire' || String(target.payload?.severity || '').toLowerCase() === 'high';
      correlations.push(correlation(
        'movement_near_hazard',
        target,
        distance,
        highSeverity ? 0.86 : 0.72,
        `${event.type} observed near ${target.type}`,
        { zones },
      ));
    }

    if (HAZARD_TYPES.has(event.type) && MOVEMENT_TYPES.has(target.type)) {
      correlations.push(correlation(
        'hazard_near_movement',
        target,
        distance,
        0.74,
        `${event.type} hazard near ${target.type}`,
        { zones },
      ));
    }

    if (event.type !== target.type && HAZARD_TYPES.has(event.type) && HAZARD_TYPES.has(target.type)) {
      correlations.push(correlation(
        'compound_hazard',
        target,
        distance,
        0.7,
        `${event.type} co-located with ${target.type}`,
        { zones },
      ));
    }
  }

  if (zones.length && MOVEMENT_TYPES.has(event.type)) {
    correlations.push({
      type: 'geopolitical_zone_context',
      target_event_id: zones[0].id,
      target_type: 'risk_zone',
      distance_km: 0,
      confidence: 0.8,
      reason: `${event.type} event is inside ${zones[0].name}`,
      details: { zones },
    });
  }

  return correlations
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12);
}

module.exports = {
  correlate,
};
