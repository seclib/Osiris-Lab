'use strict';

const SEVERITY_WEIGHT = {
  low: 0.25,
  medium: 0.55,
  high: 0.8,
  critical: 1,
};

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function recency(event) {
  const ageSeconds = Math.max(0, (Date.now() - Date.parse(event.timestamp)) / 1000);
  return clamp(1 - ageSeconds / 3600, 0, 1);
}

function sourceReliability(event) {
  const source = String(event.metadata?.source || '').toLowerCase();
  if (['opensky', 'ais', 'usgs', 'nws', 'eonet'].includes(source)) return 0.9;
  if (source.includes('smoke-test')) return 0.6;
  return 0.72;
}

function anomalyStrength(anomalies) {
  if (!anomalies.length) return 0;
  return Math.max(...anomalies.map((item) => Math.max(item.strength || 0, SEVERITY_WEIGHT[item.severity] || 0)));
}

function correlationStrength(correlations) {
  if (!correlations.length) return 0;
  return Math.max(...correlations.map((item) => item.strength || 0));
}

function locationValue(event, correlations) {
  if (event.type === 'ais' && correlations.some((item) => item.target_type === 'weather' || item.target_type === 'wildfire')) return 0.72;
  if (event.type === 'adsb' && correlations.some((item) => item.target_type === 'weather')) return 0.78;
  if (event.type === 'quake' || event.type === 'wildfire' || event.type === 'weather') return 0.62;
  return 0.45;
}

function scoreEvent(event, anomalies, correlations) {
  const anomaly = anomalyStrength(anomalies);
  const correlation = correlationStrength(correlations);
  const freshness = recency(event);
  const reliability = sourceReliability(event);
  const metadataConfidence = typeof event.metadata?.confidence === 'number' ? event.metadata.confidence : 0.7;

  const importance = clamp(100 * (
    0.30 * locationValue(event, correlations)
    + 0.25 * anomaly
    + 0.20 * correlation
    + 0.15 * freshness
    + 0.10 * reliability
  ));

  const risk = clamp(100 * (
    0.35 * anomaly
    + 0.25 * correlation
    + 0.20 * locationValue(event, correlations)
    + 0.10 * freshness
    + 0.10 * reliability
  ));

  const confidence = clamp(100 * (
    0.35 * metadataConfidence
    + 0.25 * reliability
    + 0.20 * freshness
    + 0.10 * (anomalies.length > 0 ? 0.8 : 0.5)
    + 0.10 * (correlations.length > 0 ? 0.9 : 0.5)
  ));

  const final = clamp(0.40 * risk + 0.35 * importance + 0.25 * confidence);
  const severity = final >= 88 ? 'CRITICAL' : final >= 75 ? 'HIGH' : final >= 55 ? 'MEDIUM' : 'LOW';

  return {
    importance: Math.round(importance),
    risk: Math.round(risk),
    confidence: Math.round(confidence),
    final: Math.round(final),
    severity,
    formula: 'final=0.40*risk+0.35*importance+0.25*confidence',
  };
}

function shouldAlert(score, config) {
  return score.final >= config.alerting.minScore
    && score.risk >= config.alerting.minRisk
    && score.confidence >= config.alerting.minConfidence;
}

module.exports = {
  scoreEvent,
  shouldAlert,
};
