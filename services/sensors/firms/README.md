# OSIRIS NASA FIRMS Sensor

Independent OSIRIS sensor for the official NASA FIRMS Area API.

The service:

- calls the official FIRMS Area API CSV endpoint
- requires a NASA FIRMS `MAP_KEY` when enabled
- normalizes satellite fire and heat anomaly detections
- publishes `environmental_fire_event` records to Redis Stream `osiris.stream`
- exposes `/health`, `/status`, and `/ready`

Default endpoint shape:

```text
https://firms.modaps.eosdis.nasa.gov/api/area/csv/[MAP_KEY]/[SOURCE]/[AREA]/[DAY_RANGE]
```

Output event type:

```json
{
  "type": "environmental_fire_event",
  "source": "nasa-firms",
  "geo": { "lat": -12.34, "lon": 45.67 },
  "payload": {
    "intensity": 18.4,
    "frp_mw": 18.4,
    "detection_confidence": "n",
    "detection_confidence_score": 0.72,
    "satellite": "N",
    "instrument": "VIIRS"
  },
  "confidence": 0.72
}
```

Configuration:

```bash
FIRMS_ENABLED=true
FIRMS_MAP_KEY=...
FIRMS_SOURCE=VIIRS_SNPP_NRT
FIRMS_AREA=-180,-90,180,90
FIRMS_DAY_RANGE=1
FIRMS_POLL_SECONDS=300
```

Use only API access and MAP_KEYs authorized by NASA FIRMS terms.
