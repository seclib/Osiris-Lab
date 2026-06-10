'use strict';

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function buildPrompt(insight) {
  return [
    'You are OSIRIS, a real-time intelligence analysis engine. You are not a chatbot.',
    'Return compact JSON only with keys summary and reasoning. Do not include markdown.',
    'Use sober intelligence language. Do not invent facts beyond the supplied event, anomalies, correlations, score, and geo context.',
    '',
    JSON.stringify({
      event_id: insight.event_id,
      type: insight.type,
      risk: insight.risk,
      score: insight.score,
      source_event: insight.source_event,
      anomalies: insight.anomalies,
      correlations: insight.correlations,
      geo_context: insight.geo_context,
      fallback_summary: insight.summary,
      fallback_reasoning: insight.reasoning,
    }),
  ].join('\n');
}

class OllamaClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.stats = {
      enabled: config.ollama.enabled,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      timedOut: 0,
      lastError: null,
    };
  }

  async enrich(insight) {
    if (!this.config.ollama.enabled || insight.score.final < this.config.ollama.minScore) {
      return { used: false, insight };
    }

    this.stats.attempted += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.ollama.timeoutMs);

    try {
      const response = await fetch(`${this.config.ollama.url}/api/generate`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.ollama.model,
          prompt: buildPrompt(insight),
          stream: false,
          options: {
            temperature: 0.1,
            num_predict: 220,
          },
        }),
      });

      if (!response.ok) throw new Error(`ollama_http_${response.status}`);
      const body = await response.json();
      const jsonText = extractJson(body.response);
      if (!jsonText) throw new Error('ollama_non_json_response');
      const parsed = JSON.parse(jsonText);

      this.stats.succeeded += 1;
      return {
        used: true,
        insight: {
          ...insight,
          summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : insight.summary,
          reasoning: typeof parsed.reasoning === 'string' && parsed.reasoning.trim() ? parsed.reasoning.trim() : insight.reasoning,
          llm: {
            enabled: true,
            used: true,
            provider: 'ollama',
            model: this.config.ollama.model,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stats.failed += 1;
      if (message.includes('aborted')) this.stats.timedOut += 1;
      this.stats.lastError = message;
      this.logger.warn('ollama_enrichment_failed', { eventId: insight.event_id, error: message });
      return {
        used: false,
        insight: {
          ...insight,
          llm: {
            enabled: true,
            used: false,
            provider: 'ollama',
            model: this.config.ollama.model,
            error: message,
          },
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  health() {
    return {
      ...this.stats,
      url: this.config.ollama.url,
      model: this.config.ollama.model,
    };
  }
}

module.exports = {
  OllamaClient,
};
