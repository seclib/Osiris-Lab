# OSIRIS Tracking Service

Production-oriented Node.js service for ingesting ADS-B aircraft data and AIS maritime data into one normalized real-time tracking model.

## Features

- ADS-B polling for OpenSky-compatible `/states/all` APIs.
- Generic AIS HTTP polling for licensed/public maritime APIs.
- AIS WebSocket ingestion when `AIS_WS_URL` is configured.
- Unified `aircraft` + `vessel` track schema.
- REST API for latest tracks, compatibility dashboard payloads, and MapLibre-ready GeoJSON.
- WebSocket stream at `/stream`.
- Optional Redis cache, pub/sub, and Redis Stream output.
- Retry, timeout, fallback URLs, rate-limit spacing, stale detection, and out-of-order update protection.

## Start Locally

```bash
cd services/tracking-service
npm install
npm start
```

The service starts with ADS-B and AIS disabled by default.

Enable OpenSky-compatible ADS-B polling:

```bash
ADSB_ENABLED=true npm start
```

Enable AIS HTTP polling:

```bash
AIS_ENABLED=true AIS_URL="https://example-maritime-api/vessels" AIS_AUTH_MODE=bearer AIS_API_KEY="..." npm start
```

Enable AIS WebSocket ingestion:

```bash
AIS_ENABLED=true AIS_WS_URL="wss://example-maritime-api/stream" AIS_AUTH_MODE=bearer AIS_API_KEY="..." npm start
```

## REST API

```http
GET /health
GET /ready
GET /sources
GET /tracks
GET /tracks?type=aircraft
GET /tracks?type=vessel&bbox=-10,35,40,70
GET /tracks/:id
GET /tracks.geojson
GET /flights
GET /maritime
GET /metrics
POST /ingest?source=adsb
POST /ingest?source=ais
POST /ingest?source=unified
```

If `TRACK_INGEST_TOKEN` is configured, `POST /ingest` requires:

```http
Authorization: Bearer <TRACK_INGEST_TOKEN>
```

## WebSocket

```text
ws://localhost:4201/stream
ws://localhost:4201/stream?type=aircraft
ws://localhost:4201/stream?type=vessel
```

The server sends:

```json
{ "type": "snapshot", "tracks": [] }
{ "type": "track.update", "track": {} }
```

## Unified Track Schema

```json
{
  "id": "aircraft:abc123",
  "type": "aircraft",
  "latitude": 40.6413,
  "longitude": -73.7781,
  "speed": 221.4,
  "position": {
    "lat": 40.6413,
    "lon": -73.7781,
    "altitude_m": 10363
  },
  "velocity": {
    "speed_mps": 221.4,
    "speed_knots": 430.42,
    "vertical_rate_mps": 0
  },
  "heading": 274,
  "timestamp": "2026-06-10T08:30:00.000Z",
  "source": {
    "provider": "opensky",
    "feed": "states/all",
    "received_at": "2026-06-10T08:30:03.000Z",
    "raw_id": "abc123"
  },
  "quality": {
    "stale": false,
    "confidence": 0.95,
    "errors": [],
    "age_seconds": 3
  },
  "metadata": {
    "callsign": "OSR123",
    "country": "United States"
  }
}
```

Vessel IDs use `vessel:{mmsi}` and aircraft IDs use `aircraft:{icao24}`.

## Redis Output

When `REDIS_URL` is set:

- Latest cache: `osiris:tracks:latest:{id}`
- Pub/sub channel: `osiris:tracks:updates`
- Stream: `osiris:streams:tracks.normalized`
- Central event stream: `osiris.stream` with event types `adsb` and `ais`
- Module health: `osiris:module:adsb:health`, `osiris:module:ais:health`

The central event stream uses the OSIRIS event schema:

```json
{
  "id": "adsb:aircraft:abc123:1781094600000",
  "type": "adsb",
  "timestamp": "2026-06-10T12:30:00.000Z",
  "geo": { "lat": 40.6413, "lon": -73.7781 },
  "payload": { "id": "aircraft:abc123" },
  "metadata": {
    "confidence": 0.95,
    "source": "opensky",
    "schema_version": "1.0"
  }
}
```

## Docker

```bash
docker build -t osiris-tracking-service:latest .
docker run --rm -p 4201:4201 \
  -e ADSB_ENABLED=true \
  osiris-tracking-service:latest
```

## Docker Compose Deployment

`osiris-tracking` is the single ingestion service for ADS-B and AIS. Do not run separate
ADS-B or AIS collectors unless they publish through `POST /ingest`.

```yaml
osiris-tracking:
  build:
    context: ./services/tracking-service
    dockerfile: Dockerfile
  environment:
    PORT: "4201"
    REDIS_URL: "redis://osiris-redis:6379"
    ADSB_ENABLED: "${MODULE_ADSB_ENABLED:-false}"
    AIS_ENABLED: "${MODULE_AIS_ENABLED:-false}"
    AIS_URL: "${AIS_PROVIDER_URL:-}"
    AIS_WS_URL: "${AIS_WS_URL:-}"
  expose:
    - "4201"
```

The Next.js application should consume:

- `TRACKING_URL=http://osiris-tracking:4201`
- `ADSB_URL=http://osiris-tracking:4201/flights`
- `AIS_URL=http://osiris-tracking:4201/maritime`
