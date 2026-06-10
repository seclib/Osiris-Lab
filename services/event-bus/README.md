# OSIRIS Event Bus

Redis Streams based event system for OSIRIS. It uses `osiris.stream` as the
central Kafka-like event log while keeping the deployment lightweight enough for
Docker Compose.

## Architecture

```text
ADS-B / AIS
  -> osiris-tracking
  -> Redis Stream: osiris.stream

Weather / Earthquakes / Wildfires
  -> osiris-event-bus polling workers
  -> Redis Stream: osiris.stream

osiris-event-bus consumer group
  -> XREADGROUP
  -> validate / process
  -> osiris.stream.processed
  -> Redis latest keys + pub/sub
  -> DLQ after retries
```

`osiris-tracking` owns ADS-B and AIS ingestion. The event bus service owns
weather, earthquake, and wildfire ingestion, then consumes the unified stream.

## Unified Event Schema

Each Redis Stream entry contains these fields:

```json
{
  "id": "quake:us7000abcd",
  "type": "quake",
  "timestamp": "2026-06-10T12:00:00.000Z",
  "geo": { "lat": 34.05, "lon": -118.24 },
  "payload": {
    "magnitude": 4.2,
    "place": "10km S of Example"
  },
  "metadata": {
    "confidence": 0.95,
    "source": "usgs",
    "feed": "https://earthquake.usgs.gov/...",
    "schema_version": "1.0",
    "received_at": "2026-06-10T12:00:03.000Z"
  }
}
```

Allowed `type` values:

- `adsb`
- `ais`
- `weather`
- `quake`
- `wildfire`

## Runtime Modes

```bash
EVENT_BUS_MODE=all      # ingestion + consumer
EVENT_BUS_MODE=ingest   # only feed workers
EVENT_BUS_MODE=consume  # only consumer group worker
```

Horizontal scaling pattern:

```bash
docker compose up -d --scale osiris-event-bus=3
```

For multiple replicas, set distinct `EVENT_CONSUMER_NAME` values when running
outside Compose. Redis consumer groups distribute entries across consumers.

## Important Streams

- Main log: `osiris.stream`
- Processed events: `osiris.stream.processed`
- Dead letter queue: `osiris.stream.dlq`

The main stream is not trimmed by default:

```bash
EVENT_STREAM_MAXLEN=0
```

This avoids silent loss under load. Use disk sizing, Redis AOF, and backpressure
instead of aggressive trimming.

## Backpressure

Workers pause polling when either threshold is exceeded:

```bash
EVENT_STREAM_BACKPRESSURE_LENGTH=500000
EVENT_STREAM_BACKPRESSURE_PENDING=50000
EVENT_BACKPRESSURE_PAUSE_MS=5000
```

This prevents external feed workers from outrunning consumers.

## Retry and DLQ

The consumer:

1. Reads with `XREADGROUP`.
2. Processes and validates the event.
3. Acknowledges only after successful processing.
4. Reclaims idle pending entries with `XAUTOCLAIM`.
5. Moves poison events to `osiris.stream.dlq` after `EVENT_CONSUMER_MAX_RETRIES`.

## Local Run

```bash
cd services/event-bus
npm install
REDIS_URL=redis://127.0.0.1:6379 \
EVENT_EARTHQUAKES_ENABLED=true \
npm start
```

## HTTP API

```http
GET /health
GET /ready
GET /metrics
```

## Compose Deployment

```bash
docker compose up -d --build osiris-redis osiris-tracking osiris-event-bus
```

Enable feeds:

```bash
MODULE_ADSB_ENABLED=true
MODULE_AIS_ENABLED=true
MODULE_WEATHER_ENABLED=true
MODULE_EARTHQUAKES_ENABLED=true
MODULE_WILDFIRES_ENABLED=true
```

Redis is configured with AOF and `noeviction` by default in Compose. Under memory
pressure, writes fail loudly instead of silently evicting stream entries.
