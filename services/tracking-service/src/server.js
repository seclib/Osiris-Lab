'use strict';

const http = require('http');
const { normalizeAisPayload, normalizeOpenSkyPayload, normalizeUnifiedPayload, toGeoJsonFeature } = require('./normalizers');

function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function corsHeaders(config) {
  return {
    'access-control-allow-origin': config.api.corsOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  };
}

function parseBbox(value) {
  if (!value) return null;
  const parts = value.split(',').map((item) => Number(item.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 || minLon > maxLon || minLat > maxLat) {
    return null;
  }
  return parts;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function toNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeTimestampMillis(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function aircraftCategory(track) {
  const metadata = track.metadata || {};
  const aircraftType = String(metadata.model || metadata.aircraft_type || '').toUpperCase();
  const callsign = String(metadata.callsign || '').trim().toUpperCase();
  const militaryPrefixes = /^(RCH|REACH|KING|DUKE|JAKE|EVAC|CNV|CONVOY)\d*/;
  const privateTypes = new Set([
    'G150', 'G200', 'G280', 'GLEX', 'G500', 'G550', 'G600', 'G650', 'G700',
    'GLF2', 'GLF3', 'GLF4', 'GLF5', 'GLF6', 'C25A', 'C25B', 'C25C', 'C525',
    'C550', 'C560', 'C680', 'C700', 'C750', 'CL30', 'CL35', 'CL60', 'FA7X',
    'FA8X', 'F900', 'LJ35', 'LJ40', 'LJ45', 'LJ60', 'PC12', 'PC24', 'TBM9',
  ]);

  if (metadata.military === true || militaryPrefixes.test(callsign)) return 'military';
  if (privateTypes.has(aircraftType)) return 'jet';
  return 'commercial';
}

function trackToFlight(track) {
  const metadata = track.metadata || {};
  const category = aircraftCategory(track);
  const callsign = String(metadata.callsign || metadata.icao24 || track.id).trim() || track.id;
  const speedKnots = typeof track.velocity?.speed_knots === 'number'
    ? track.velocity.speed_knots
    : typeof track.speed === 'number'
      ? track.speed * 1.9438444924406
      : null;
  const model = metadata.model || metadata.aircraft_type || 'Unknown';

  return {
    callsign,
    lat: Math.round(toNumber(track.latitude ?? track.position?.lat) * 100000) / 100000,
    lng: Math.round(toNumber(track.longitude ?? track.position?.lon) * 100000) / 100000,
    alt: Math.round(toNumber(track.position?.altitude_m)),
    heading: Math.round(toNumber(track.heading)),
    speed_knots: speedKnots === null ? null : Math.round(speedKnots * 10) / 10,
    model,
    icao24: metadata.icao24 || track.id.replace(/^aircraft:/, ''),
    registration: metadata.registration || 'N/A',
    squawk: metadata.squawk || '',
    airline_code: /^[A-Z]{3}/.test(callsign) ? callsign.slice(0, 3) : '',
    aircraft_category: metadata.on_ground ? 'ground' : 'plane',
    category,
    grounded: Boolean(metadata.on_ground),
    type: 'flight',
    timestamp: track.timestamp,
    source: track.source?.provider || 'tracking',
    confidence: track.quality?.confidence,
    stale: Boolean(track.quality?.stale),
  };
}

function trackToShip(track) {
  const metadata = track.metadata || {};
  const mmsi = metadata.mmsi || track.id.replace(/^vessel:/, '');
  const numericMmsi = Number(mmsi);
  const speedKnots = typeof track.velocity?.speed_knots === 'number'
    ? track.velocity.speed_knots
    : typeof track.speed === 'number'
      ? track.speed * 1.9438444924406
      : 0;

  return {
    id: Number.isFinite(numericMmsi) ? numericMmsi : track.id,
    mmsi: Number.isFinite(numericMmsi) ? numericMmsi : mmsi,
    lat: track.latitude ?? track.position?.lat,
    lng: track.longitude ?? track.position?.lon,
    speed: Math.round(speedKnots * 10) / 10,
    heading: Math.round(toNumber(track.heading)),
    timestamp: safeTimestampMillis(track.timestamp),
    type: metadata.vessel_type || metadata.type || 'cargo',
    name: metadata.name || `MMSI ${mmsi}`,
    destination: metadata.destination || 'UNKNOWN',
    flag: metadata.flag || track.source?.provider || 'ais',
    source: track.source?.provider || 'tracking',
    confidence: track.quality?.confidence,
    stale: Boolean(track.quality?.stale),
  };
}

function newestFreshness(tracks) {
  const newest = tracks.reduce((latest, track) => {
    const observed = Date.parse(track.timestamp);
    return Number.isFinite(observed) ? Math.max(latest, observed) : latest;
  }, 0);

  return {
    newest_at: newest ? new Date(newest).toISOString() : null,
    newest_age_seconds: newest ? Math.round((Date.now() - newest) / 1000) : null,
  };
}

function createServer({ config, logger, store, streamHub, cache, providers, publishTracks }) {
  const server = http.createServer(async (req, res) => {
    const headers = corsHeaders(config);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
        const providerHealth = providers.map((provider) => provider.health());
        const unhealthy = providerHealth.filter((provider) => provider.enabled && provider.state !== 'ok');
        const body = {
          status: unhealthy.length ? 'DEGRADED' : 'OK',
          service: config.serviceName,
          redis: cache.health(),
          store: store.summary(),
          stream: streamHub.summary(),
          providers: providerHealth,
          time: new Date().toISOString(),
        };
        return sendJson(res, url.pathname === '/ready' && unhealthy.length ? 503 : 200, body, headers);
      }

      if (req.method === 'GET' && url.pathname === '/sources') {
        return sendJson(res, 200, {
          providers: providers.map((provider) => provider.health()),
          time: new Date().toISOString(),
        }, headers);
      }

      if (req.method === 'GET' && url.pathname === '/flights') {
        const tracks = store.list({
          type: 'aircraft',
          includeStale: url.searchParams.get('stale') !== 'false',
          bbox: parseBbox(url.searchParams.get('bbox')),
          limit: Number(url.searchParams.get('limit') || 5000),
        });
        const commercial = [];
        const privateFlights = [];
        const privateJets = [];
        const military = [];

        for (const track of tracks) {
          const flight = trackToFlight(track);
          switch (flight.category) {
            case 'military':
              military.push(flight);
              break;
            case 'jet':
              privateJets.push(flight);
              break;
            case 'private':
              privateFlights.push(flight);
              break;
            default:
              commercial.push(flight);
          }
        }

        return sendJson(res, 200, {
          commercial_flights: commercial,
          private_flights: privateFlights,
          private_jets: privateJets,
          military_flights: military,
          gps_jamming: [],
          total: tracks.length,
          freshness: newestFreshness(tracks),
          source: 'osiris-tracking',
          timestamp: new Date().toISOString(),
        }, headers);
      }

      if (req.method === 'GET' && url.pathname === '/maritime') {
        const tracks = store.list({
          type: 'vessel',
          includeStale: url.searchParams.get('stale') !== 'false',
          bbox: parseBbox(url.searchParams.get('bbox')),
          limit: Number(url.searchParams.get('limit') || 10000),
        });
        const freshness = newestFreshness(tracks);
        return sendJson(res, 200, {
          ships: tracks.map(trackToShip),
          total_ships: tracks.length,
          freshness: {
            newest_ship_at: freshness.newest_at,
            newest_ship_age_seconds: freshness.newest_age_seconds,
          },
          source: 'osiris-tracking',
          timestamp: new Date().toISOString(),
        }, headers);
      }

      if (req.method === 'GET' && url.pathname === '/tracks') {
        const type = url.searchParams.get('type');
        const includeStale = url.searchParams.get('stale') !== 'false';
        const bbox = parseBbox(url.searchParams.get('bbox'));
        const limit = Number(url.searchParams.get('limit') || 1000);
        return sendJson(res, 200, {
          tracks: store.list({
            type: type === 'aircraft' || type === 'vessel' ? type : null,
            includeStale,
            bbox,
            limit,
          }),
          time: new Date().toISOString(),
        }, headers);
      }

      if (req.method === 'GET' && url.pathname === '/tracks.geojson') {
        const type = url.searchParams.get('type');
        const includeStale = url.searchParams.get('stale') !== 'false';
        const bbox = parseBbox(url.searchParams.get('bbox'));
        const limit = Number(url.searchParams.get('limit') || 10000);
        const tracks = store.list({
          type: type === 'aircraft' || type === 'vessel' ? type : null,
          includeStale,
          bbox,
          limit,
        });
        return sendJson(res, 200, {
          type: 'FeatureCollection',
          features: tracks.map(toGeoJsonFeature),
        }, headers);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/tracks/')) {
        const id = decodeURIComponent(url.pathname.slice('/tracks/'.length));
        const track = store.get(id);
        if (!track) return sendJson(res, 404, { error: 'track_not_found', id }, headers);
        return sendJson(res, 200, { track }, headers);
      }

      if (req.method === 'POST' && url.pathname === '/ingest') {
        if (config.api.ingestToken && bearerToken(req) !== config.api.ingestToken) {
          return sendJson(res, 401, { error: 'unauthorized' }, headers);
        }

        const source = url.searchParams.get('source') || 'unified';
        const body = await readBody(req, config.api.maxBodyBytes);
        const payload = JSON.parse(body || '{}');
        const receivedAt = new Date().toISOString();

        let normalized;
        if (source === 'adsb' || source === 'opensky') {
          normalized = Array.isArray(payload?.states)
            ? normalizeOpenSkyPayload(payload, {
              receivedAt,
              staleAfterSeconds: config.freshness.aircraftStaleAfterSeconds,
            })
            : normalizeUnifiedPayload(payload, {
              receivedAt,
              aircraftStaleAfterSeconds: config.freshness.aircraftStaleAfterSeconds,
              provider: source,
              feed: 'manual-ingest',
            });
        } else if (source === 'ais') {
          normalized = normalizeAisPayload(payload, {
            receivedAt,
            staleAfterSeconds: config.freshness.vesselStaleAfterSeconds,
            provider: 'ais',
            feed: 'manual-ingest',
          });
        } else {
          normalized = normalizeUnifiedPayload(payload, {
            receivedAt,
            aircraftStaleAfterSeconds: config.freshness.aircraftStaleAfterSeconds,
            vesselStaleAfterSeconds: config.freshness.vesselStaleAfterSeconds,
            provider: source,
            feed: 'manual-ingest',
          });
        }

        const result = await publishTracks(source, normalized.tracks, normalized.rejected);
        return sendJson(res, 202, {
          accepted: result.accepted,
          rejected: result.rejected + normalized.rejected.length,
          normalization_rejections: normalized.rejected,
        }, headers);
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        const summary = store.summary();
        const providerLines = providers.map((provider) => {
          const health = provider.health();
          const value = health.state === 'ok' || health.state === 'disabled' ? 1 : 0;
          return `osiris_tracking_provider_up{provider="${health.name}",state="${health.state}"} ${value}`;
        });
        return sendText(res, 200, [
          `osiris_tracking_tracks_total ${summary.total}`,
          `osiris_tracking_aircraft_total ${summary.aircraft}`,
          `osiris_tracking_vessels_total ${summary.vessels}`,
          `osiris_tracking_stale_total ${summary.stale}`,
          `osiris_tracking_ws_clients ${streamHub.summary().clients}`,
          ...providerLines,
          '',
        ].join('\n'), headers);
      }

      return sendJson(res, 404, { error: 'not_found' }, headers);
    } catch (error) {
      logger.error('request_failed', {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return sendJson(res, error.message === 'body_too_large' ? 413 : 500, {
        error: error.message === 'body_too_large' ? 'body_too_large' : 'internal_error',
      }, headers);
    }
  });

  streamHub.attach(server);
  return server;
}

module.exports = { createServer };
