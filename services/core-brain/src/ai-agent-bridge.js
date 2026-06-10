'use strict';

const { buildInsight } = require('./insight-agent');

class AiAgentBridge {
  constructor(logger) {
    this.logger = logger;
  }

  analyze(event, intelligence) {
    try {
      return buildInsight(event, intelligence);
    } catch (error) {
      this.logger?.warn?.('ai_agent_bridge_failed', {
        eventId: event?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        event_id: event?.id || 'unknown',
        intelligence_id: intelligence?.id || 'unknown',
        type: 'insight',
        risk: intelligence?.score?.severity || 'LOW',
        summary: `${String(event?.type || 'Event').toUpperCase()} processed by OSIRIS Core Brain.`,
        reasoning: 'fallback insight generated after deterministic bridge failure',
        geo_context: {
          lat: event?.geo?.lat,
          lon: event?.geo?.lon,
          source_type: event?.type,
          source_event_id: event?.id,
          source: event?.metadata?.source || 'unknown',
          timestamp: event?.timestamp,
          zones: [],
          anomaly_count: intelligence?.anomalies?.length || 0,
          correlation_count: intelligence?.correlations?.length || 0,
          score: intelligence?.score?.final ?? null,
        },
        emitted_at: new Date().toISOString(),
      };
    }
  }
}

module.exports = {
  AiAgentBridge,
};

