'use strict';

const { zonesFor, zoneRiskScore } = require('./geo');

const SEVERITY_VALUE = {
  LOW: 10,
  MEDIUM: 28,
  HIGH: 48,
  CRITICAL: 70,
};

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function baseImportance(event) {
  if (event.type === 'quake') return 38;
  if (event.type === 'wildfire') return 34;
  if (event.type === 'weather') return 30;
  if (event.type === 'adsb') return 24;
  if (event.type === 'ais') return 24;
  return 15;
}

function riskLevel(score) {
  if (score >= 88) return 'CRITICAL';
  if (score >= 70) return 'HIGH';
  if (score >= 45) return 'MEDIUM';
  return 'LOW';
}

function scoreEvent(event, anomalies, correlations) {
  const zones = zonesFor(event.geo);
  const anomalyRisk = anomalies.reduce((sum, item) => {
    const severity = String(item.severity || 'LOW').toUpperCase();
    return sum + (SEVERITY_VALUE[severity] || SEVERITY_VALUE.LOW) * (item.confidence || 0.65);
  }, 0);
  const correlationRisk = correlations.reduce((sum, item) => sum + 18 * (item.confidence || 0.65), 0);
  const sourceConfidence = Number(event.metadata?.confidence);
  const confidence = Number.isFinite(sourceConfidence) ? Math.max(0, Math.min(1, sourceConfidence)) : 0.72;

  const importance = clamp(baseImportance(event) + anomalies.length * 8 + correlations.length * 5 + zoneRiskScore(zones));
  const risk = clamp(anomalyRisk + correlationRisk + zoneRiskScore(zones));
  const final = clamp((importance * 0.32) + (risk * 0.48) + (confidence * 100 * 0.2));

  return {
    importance,
    risk,
    confidence: clamp(confidence * 100),
    final,
    level: riskLevel(final),
    zones,
  };
}

module.exports = {
  riskLevel,
  scoreEvent,
};
