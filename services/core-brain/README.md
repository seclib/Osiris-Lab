# OSIRIS Core Brain

Real-time event processing engine for OSIRIS. It consumes the Redis Stream
`osiris.stream`, applies routing, anomaly detection, cross-source correlation,
scoring, alerting, and WebSocket broadcasting.

## Folder Structure

```text
services/core-brain/
  Dockerfile
  package.json
  src/
    index.js                 # process bootstrap and graceful shutdown
    config.js                # env-driven runtime config
    logger.js                # structured JSON logger
    brain-bus.js             # Redis Streams, Pub/Sub, DLQ, persistence
    stream-consumer.js       # Redis consumer group worker loop
    event-normalizer.js      # source-independent event normalization
    anomaly-detector.js      # anomaly module facade
    anomaly-engine.js        # movement/hazard anomaly rules
    correlation-engine.js    # cross-domain correlation
    scoring-engine.js        # scoring module facade
    scoring.js               # importance/risk/confidence math
    ai-agent-bridge.js       # deterministic agent output bridge
    insight-agent.js         # analyst summary and geo context
    websocket-gateway.js     # WebSocket module facade
    ws-hub.js                # WebSocket implementation
    state-store.js           # bounded rolling entity/hazard state
    event-codec.js           # Redis field codec and validation
    geo.js                   # distance/grid helpers
    server.js                # health, metrics, recent HTTP API
```

## Node.js Architecture

```text
Redis Stream: osiris.stream
  |
  | XREADGROUP / XAUTOCLAIM
  v
Stream Consumer Workers
  |
  |-- Event normalizer: source-independent schema validation
  |-- Event router: movement vs hazard
  |-- Light state store: rolling entity history + hazards + density cells
  |-- Anomaly engine: speed jumps, heading jumps, density, hazard severity
  |-- Correlation engine: ADS-B/AIS near weather/quake/wildfire
  |-- Scoring engine: importance / risk / confidence
  |-- Insight agent: risk label + analyst summary + geo context
  |
  v
Redis Stream: osiris.intelligence
Redis Stream: osiris.intelligence.alerts
Redis Stream: osiris.insights
Redis Pub/Sub: osiris.intelligence.events
Redis Pub/Sub: osiris.insights.events
WebSocket: ws://core-brain:4400/stream
```

The service is stateless except for bounded in-memory rolling state. Multiple
instances can run safely because Redis consumer groups distribute stream entries.

## Redis Stream Schema

Input stream: `osiris.stream`

```json
{
  "id": "source-stable-id",
  "type": "adsb | ais | weather | quake | wildfire",
  "timestamp": "2026-06-10T12:00:00.000Z",
  "geo": { "lat": 24.5, "lon": 120.4 },
  "payload": {},
  "metadata": {
    "source": "opensky | ais | usgs | nws | eonet",
    "confidence": 0.9
  }
}
```

Redis field layout supports either a single `event` JSON field or split fields:

```text
event=<json>
```

or:

```text
id=<string>
type=<string>
timestamp=<iso8601>
geo=<json>
payload=<json>
metadata=<json>
```

Output streams:

- `osiris.intelligence`: full scored intelligence events.
- `osiris.intelligence.alerts`: deduped critical/high-value alerts.
- `osiris.insights`: deterministic AI-agent insight envelopes.
- `osiris.intelligence.dlq`: poison messages after retry exhaustion.

## Event Processing Loop

```text
1. XREADGROUP from osiris.stream
2. Decode + validate unified event
3. Route event:
   - adsb / ais -> movement route
   - weather / quake / wildfire -> hazard route
4. Update rolling state
5. Detect anomalies
6. Correlate with recent cross-source events
7. Score importance, risk, confidence
8. Generate structured agent insight
9. Publish intelligence event
10. Publish alert if thresholds pass and dedupe allows
11. Publish insight envelope to `osiris.insights`
12. Broadcast to WebSocket clients
13. XACK only after successful processing
```

Failures remain pending, are retried with `XAUTOCLAIM`, and move to
`osiris.intelligence.dlq` after `BRAIN_MAX_RETRIES`.

## Worker and Backpressure Model

- `stream-consumer.js` uses Redis consumer groups with `XREADGROUP`.
- Stuck pending messages are reclaimed with `XAUTOCLAIM`.
- Messages are acknowledged only after intelligence, insight, and WebSocket
  output publication completes.
- `BRAIN_READ_COUNT` controls per-read batch size.
- `BRAIN_BACKPRESSURE_MAX_PENDING` and `BRAIN_BACKPRESSURE_SLEEP_MS` slow new
  reads when pending work exceeds the configured threshold.
- Processing is deterministic and CPU-bounded; batch loops yield with
  `setImmediate` to avoid starving the Node.js event loop.

## Correlation Logic Examples

- `ADS-B + weather`: aircraft track enters severe weather alert radius.
- `AIS + wildfire`: vessel/port traffic near wildfire impact area.
- `AIS + weather`: vessel movement anomaly near severe maritime weather.
- `AIS + density + geopolitical zone`: vessel congestion anomaly in Red Sea,
  Suez, Taiwan Strait, Black Sea, Persian Gulf, or other configured zones.
- `quake + wildfire/weather`: hazards clustered within configurable radius.
- `movement anomaly + hazard`: speed/heading anomaly occurring near active hazard.

## Insight Agent Output

Every processed intelligence event receives an `agent_insight` field and is
also published to `osiris.insights`.

```json
{
  "event_id": "adsb:abc",
  "intelligence_id": "intel:abc",
  "type": "insight",
  "risk": "LOW",
  "summary": "Aircraft ABC123 interacting with nearby weather risk.",
  "reasoning": "risk=72, importance=70, confidence=86, final=75; correlations=track_hazard_proximity->weather; source=opensky",
  "geo_context": {
    "lat": 24.5,
    "lon": 120.4,
    "source_type": "adsb",
    "source_event_id": "adsb:abc",
    "source": "opensky",
    "timestamp": "2026-06-10T12:00:00.000Z",
    "zones": [],
    "anomaly_count": 1,
    "correlation_count": 1,
    "score": 75
  },
  "emitted_at": "2026-06-10T12:00:01.000Z"
}
```

Insight `type` is deterministic:

- `alert`: alert threshold passed and dedupe allowed publication.
- `anomaly`: one or more anomaly rules fired.
- `insight`: no anomaly fired, but the event remained intelligence-worthy.

## Anomaly Detection Rules

Movement events:

- `speed_jump`: speed delta exceeds `BRAIN_SPEED_JUMP_KNOTS`.
- `heading_change`: heading delta exceeds `BRAIN_HEADING_JUMP_DEGREES`.
- `density_anomaly`: rolling grid count exceeds `BRAIN_DENSITY_THRESHOLD`.
- `adsb_near_weather`, `ais_near_weather`, etc. from proximity correlation.

Hazard events:

- `quake_hazard`: magnitude >= 5.
- `weather_hazard`: NWS severity is Moderate/Severe/Extreme.
- `wildfire_hazard`: active wildfire event.

## Scoring Formula

```text
importance = 100 * (
  0.30 * location_value +
  0.25 * anomaly_strength +
  0.20 * correlation_strength +
  0.15 * recency +
  0.10 * source_reliability
)

risk = 100 * (
  0.35 * anomaly_strength +
  0.25 * correlation_strength +
  0.20 * location_value +
  0.10 * recency +
  0.10 * source_reliability
)

confidence = 100 * (
  0.35 * metadata_confidence +
  0.25 * source_reliability +
  0.20 * recency +
  0.10 * anomaly_confirmation +
  0.10 * cross_source_confirmation
)

final = 0.40 * risk + 0.35 * importance + 0.25 * confidence
```

Default alert gate:

```text
final >= 70
risk >= 60
confidence >= 55
```

## WebSocket API

```text
ws://localhost:4400/stream
ws://localhost:4400/stream?severity=HIGH
ws://localhost:4400/stream?type=adsb
```

Messages:

```json
{ "type": "hello", "service": "osiris-core-brain" }
{ "type": "snapshot", "events": [] }
{ "type": "intelligence.update", "intelligence": {} }
```

## HTTP API

```http
GET /health
GET /ready
GET /metrics
GET /recent
```

## Docker

```bash
docker compose up -d --build osiris-redis osiris-event-bus osiris-core-brain
```

Scale processors:

```bash
docker compose up -d --scale osiris-core-brain=3
```

When scaling, set unique `BRAIN_CONSUMER_NAME` values for manually launched
instances. Redis consumer groups distribute work across consumers.

## Production Considerations

- Ack only after successful processing.
- No blocking calls inside the event loop; CPU work is bounded and batch loops
  yield with `setImmediate`.
- Rolling state is capped with TTL and max sizes.
- Alerts are deduped in memory to avoid noisy repeats.
- Output stream and alert stream are capped separately.
- DLQ keeps poison events inspectable.
- WebSocket snapshots are bounded to the latest 500 intelligence events.
