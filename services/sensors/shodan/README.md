# OSIRIS Shodan Sensor

Production Node.js sensor for OSINT Internet Exposure Intelligence using Shodan's read-only REST API.

This service does not scan, probe, brute force, log in to, or exploit any host. It only calls:

- `GET /shodan/host/{ip}`
- `GET /shodan/host/search`

Redis output:

```text
XADD osiris.stream * event <JSON>
```

## Environment

Required:

- `SHODAN_API_KEY`
- `REDIS_URL`

Common settings:

- `SHODAN_MODE=ip|search|asn`
- `SHODAN_IP=8.8.8.8`
- `SHODAN_QUERY=product:nginx country:US`
- `SHODAN_ASN=AS15169`
- `OSIRIS_STREAM_KEY=osiris.stream`
- `SHODAN_POLL_SECONDS=900`
- `SHODAN_RATE_LIMIT_REQUESTS_PER_MINUTE=30`
- `SHODAN_SEARCH_MAX_PAGES=1`
- `PORT=4705`

## Local Usage

```bash
cd services/sensors
npm install
SHODAN_API_KEY=... REDIS_URL=redis://127.0.0.1:6379 SHODAN_MODE=ip SHODAN_IP=8.8.8.8 node shodan/index.js
```

Keyword search:

```bash
SHODAN_API_KEY=... REDIS_URL=redis://127.0.0.1:6379 SHODAN_MODE=search SHODAN_QUERY='product:nginx country:US' node shodan/index.js
```

ASN lookup:

```bash
SHODAN_API_KEY=... REDIS_URL=redis://127.0.0.1:6379 SHODAN_MODE=asn SHODAN_ASN=AS15169 node shodan/index.js
```

Docker build from the `services/sensors` directory as the build context:

```bash
docker build -f shodan/Dockerfile -t osiris-shodan-sensor .
docker run --rm \
  -e SHODAN_API_KEY=... \
  -e REDIS_URL=redis://redis:6379 \
  -e SHODAN_MODE=ip \
  -e SHODAN_IP=8.8.8.8 \
  osiris-shodan-sensor
```

## Sample Event

```json
{
  "id": "367fa41f-1a0a-4d25-91c6-59e67a8194c0",
  "type": "internet_exposure_event",
  "source": "shodan_sensor",
  "timestamp": "2026-06-12T08:30:00.000Z",
  "geo": {
    "country": "United States",
    "city": "",
    "coordinates": [-97.822, 37.751]
  },
  "payload": {
    "ip": "8.8.8.8",
    "organization": "Google",
    "open_ports": [53],
    "services": [
      {
        "port": 53,
        "transport": "udp",
        "name": "dns-udp",
        "timestamp": "2021-01-22T08:49:35.190Z"
      }
    ],
    "os": "",
    "tags": []
  },
  "risk_score": 0,
  "confidence": 0.97
}
```
