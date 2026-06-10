# OSIRIS Brain Bridge

`osiris-brain` is a sidecar-style overlay service. It does not import or modify existing OSIRIS modules. Instead, it polls their published HTTP outputs, normalizes records into the OSIRIS event schema, and appends them to Redis Streams.

Default stream:

```text
osiris.stream
```

Default internal feeds:

- `http://osiris-tracking:4201/tracks?limit=10000&stale=false`
- `http://osiris:3000/api/earthquakes`
- `http://osiris:3000/api/fires`
- `http://osiris:3000/api/weather`

Override feeds with `OSIRIS_BRAIN_FEEDS_JSON`:

```json
[
  {
    "id": "tracking",
    "type": "tracking",
    "url": "http://osiris-tracking:4201/tracks?limit=10000&stale=false",
    "pollSeconds": 15,
    "enabled": true
  }
]
```

Supported feed types: `tracking`, `flights`, `maritime`, `quake`, `wildfire`, `weather`.
