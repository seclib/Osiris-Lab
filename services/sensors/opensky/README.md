# OSIRIS OpenSky Sensor

Independent OSINT sensor for the official OpenSky Network REST API.

The service:

- calls `GET https://opensky-network.org/api/states/all`
- optionally authenticates with OpenSky OAuth2 client credentials
- normalizes aircraft state vectors into OSIRIS sensor events
- publishes events to Redis Stream `osiris.stream`
- exposes `/health`, `/status`, and `/ready`

Output event type:

```json
{
  "type": "aviation_tracking",
  "source": "opensky-network",
  "geo": { "lat": 48.1, "lon": 11.5 },
  "payload": {
    "icao24": "3c6444",
    "callsign": "DLH123",
    "altitude_m": 11000,
    "velocity_mps": 230,
    "true_track_deg": 91.5
  },
  "confidence": 0.85
}
```

Configuration:

```bash
OPENSKY_ENABLED=true
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
OPENSKY_BBOX=45.8389,5.9962,47.8229,10.5226
OPENSKY_MIN_ALTITUDE_M=1000
OPENSKY_MAX_ALTITUDE_M=13000
OPENSKY_POLL_SECONDS=60
```

If no OAuth credentials are configured, the service uses anonymous OpenSky access and defaults to slower polling to avoid unnecessary rate-limit noise.
