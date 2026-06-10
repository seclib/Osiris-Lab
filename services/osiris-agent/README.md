# OSIRIS Agent

`osiris-agent` is an independent intelligence microservice for OSIRIS forks.

It consumes normalized events from Redis Stream `osiris.stream`, detects anomalies, correlates cross-domain activity, scores risk, and publishes structured JSON insights to `osiris.insights`.

It is intentionally separate from the existing OSIRIS app and Core Brain services.

## Streams

- Input: `OSIRIS_AGENT_INPUT_STREAM`, default `osiris.stream`
- Output: `OSIRIS_AGENT_OUTPUT_STREAM`, default `osiris.insights`
- DLQ: `OSIRIS_AGENT_DLQ_STREAM`, default `osiris.insights.dlq`

## Optional Ollama

Ollama is disabled by default. Enable it with:

```env
OSIRIS_AGENT_OLLAMA_ENABLED=true
OLLAMA_URL=http://ollama:11434
OLLAMA_MODEL=qwen2.5:7b-instruct
```

If Ollama is slow or unavailable, the agent falls back to deterministic rule-based summaries and still publishes insights.
