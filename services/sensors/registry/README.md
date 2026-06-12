# OSIRIS Sensor Registry

Standalone supervisor for OSIRIS sensor modules.

The registry:

- dynamically loads sensor modules from config
- starts, stops, and restarts sensors independently
- aggregates sensor health under `/health`, `/ready`, and `/sensors`
- restarts desired sensors after repeated failures
- publishes sensor output only through Redis Streams; it does not call OSIRIS core

Example config:

```json
{
  "sensors": [
    {
      "id": "opensky",
      "enabled": true
    },
    {
      "id": "firms",
      "enabled": true,
      "options": {
        "mapKey": "NASA_FIRMS_MAP_KEY"
      }
    }
  ]
}
```

Environment controls:

```bash
SENSOR_REGISTRY_ENABLED_IDS=opensky,firms
SENSOR_REGISTRY_AUTO_RESTART=true
SENSOR_REGISTRY_FAILURE_THRESHOLD=3
SENSOR_REGISTRY_RESTART_COOLDOWN_MS=15000
SENSOR_REGISTRY_ADMIN_TOKEN=change-me
```

Mutation endpoints are internal-only in Docker Compose. If `SENSOR_REGISTRY_ADMIN_TOKEN` is set, `POST` requests must include `Authorization: Bearer <token>`.
