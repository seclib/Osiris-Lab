import { NextResponse } from 'next/server';
import WebSocket from 'ws';
import { disabledModulePayload, getModuleState } from '@/lib/module-registry';

/**
 * OSIRIS — Maritime Intelligence
 * Real-time AIS vessel tracking via aisstream.io + Static global ports.
 */

const PORTS = [
  // ── Top Container Ports ──
  { name: 'Shanghai', country: 'CN', lat: 31.23, lng: 121.47, type: 'container', volume: '47.3M TEU', rank: 1 },
  { name: 'Singapore', country: 'SG', lat: 1.26, lng: 103.84, type: 'container', volume: '37.2M TEU', rank: 2 },
  { name: 'Ningbo-Zhoushan', country: 'CN', lat: 29.87, lng: 121.55, type: 'container', volume: '33.3M TEU', rank: 3 },
  { name: 'Shenzhen', country: 'CN', lat: 22.54, lng: 114.05, type: 'container', volume: '30.0M TEU', rank: 4 },
  { name: 'Guangzhou', country: 'CN', lat: 23.08, lng: 113.32, type: 'container', volume: '24.2M TEU', rank: 5 },
  { name: 'Busan', country: 'KR', lat: 35.10, lng: 129.04, type: 'container', volume: '22.7M TEU', rank: 6 },
  { name: 'Qingdao', country: 'CN', lat: 36.07, lng: 120.38, type: 'container', volume: '22.0M TEU', rank: 7 },
  { name: 'Rotterdam', country: 'NL', lat: 51.90, lng: 4.50, type: 'container', volume: '14.5M TEU', rank: 8 },
  { name: 'Tokyo', country: 'JP', lat: 35.61, lng: 139.79, type: 'container', volume: '4.5M TEU' },
  { name: 'Yokohama', country: 'JP', lat: 35.45, lng: 139.66, type: 'container', volume: '2.9M TEU' },
  { name: 'Kobe', country: 'JP', lat: 34.67, lng: 135.21, type: 'container', volume: '2.8M TEU' },
  { name: 'Nagoya', country: 'JP', lat: 35.08, lng: 136.87, type: 'container', volume: '2.6M TEU' },
  { name: 'Osaka', country: 'JP', lat: 34.63, lng: 135.41, type: 'container', volume: '2.1M TEU' },
  { name: 'Hakata (Fukuoka)', country: 'JP', lat: 33.60, lng: 130.40, type: 'container', volume: '0.9M TEU' },
  { name: 'Kitakyushu', country: 'JP', lat: 33.91, lng: 130.93, type: 'container', volume: '0.5M TEU' },
  { name: 'Shimizu', country: 'JP', lat: 35.00, lng: 138.50, type: 'container', volume: '0.5M TEU' },
  { name: 'Tomakomai', country: 'JP', lat: 42.63, lng: 141.63, type: 'container', volume: '0.4M TEU' },
  { name: 'Niigata', country: 'JP', lat: 37.95, lng: 139.06, type: 'container', volume: '0.2M TEU' },
  { name: 'Sendai', country: 'JP', lat: 38.27, lng: 141.02, type: 'container', volume: '0.2M TEU' },
  { name: 'Mizushima', country: 'JP', lat: 34.50, lng: 133.72, type: 'energy', volume: 'Industrial' },
  { name: 'Yokkaichi', country: 'JP', lat: 34.95, lng: 136.65, type: 'energy', volume: 'Industrial' },
  { name: 'Dubai (Jebel Ali)', country: 'AE', lat: 25.01, lng: 55.06, type: 'container', volume: '14.0M TEU', rank: 9 },
  { name: 'Port Klang', country: 'MY', lat: 2.99, lng: 101.39, type: 'container', volume: '13.2M TEU', rank: 10 },
  { name: 'Antwerp', country: 'BE', lat: 51.30, lng: 4.40, type: 'container', volume: '12.0M TEU', rank: 11 },
  { name: 'Xiamen', country: 'CN', lat: 24.48, lng: 118.09, type: 'container', volume: '11.4M TEU', rank: 12 },
  { name: 'Hamburg', country: 'DE', lat: 53.55, lng: 9.97, type: 'container', volume: '8.7M TEU', rank: 14 },
  { name: 'Los Angeles', country: 'US', lat: 33.74, lng: -118.27, type: 'container', volume: '9.9M TEU', rank: 13 },
  { name: 'Long Beach', country: 'US', lat: 33.75, lng: -118.19, type: 'container', volume: '8.0M TEU', rank: 15 },
  { name: 'Tanjung Pelepas', country: 'MY', lat: 1.36, lng: 103.55, type: 'container', volume: '9.8M TEU', rank: 16 },
  { name: 'Savannah', country: 'US', lat: 32.08, lng: -81.09, type: 'container', volume: '5.6M TEU', rank: 20 },
  { name: 'Felixstowe', country: 'GB', lat: 51.96, lng: 1.35, type: 'container', volume: '3.8M TEU', rank: 25 },
  { name: 'Santos', country: 'BR', lat: -23.95, lng: -46.31, type: 'container', volume: '4.2M TEU', rank: 22 },
  { name: 'Colombo', country: 'LK', lat: 6.94, lng: 79.84, type: 'container', volume: '7.2M TEU', rank: 17 },

  // ── Energy/Oil Ports ──
  { name: 'Ras Tanura', country: 'SA', lat: 26.64, lng: 50.16, type: 'energy', volume: '6.5M bpd' },
  { name: 'Fujairah', country: 'AE', lat: 25.14, lng: 56.35, type: 'energy', volume: '3.5M bpd' },
  { name: 'Novorossiysk', country: 'RU', lat: 44.72, lng: 37.77, type: 'energy', volume: '2.8M bpd' },
  { name: 'Houston Ship Channel', country: 'US', lat: 29.73, lng: -95.27, type: 'energy', volume: '2.5M bpd' },
  { name: 'Kharg Island', country: 'IR', lat: 29.24, lng: 50.33, type: 'energy', volume: '2.0M bpd' },
  { name: 'Primorsk', country: 'RU', lat: 60.35, lng: 28.70, type: 'energy', volume: '1.6M bpd' },

  // ── Major Naval Bases ──
  { name: 'Norfolk Naval Station', country: 'US', lat: 36.95, lng: -76.33, type: 'naval', fleet: 'US Atlantic Fleet' },
  { name: 'San Diego Naval Base', country: 'US', lat: 32.69, lng: -117.15, type: 'naval', fleet: 'US Pacific Fleet' },
  { name: 'Pearl Harbor', country: 'US', lat: 21.35, lng: -157.97, type: 'naval', fleet: 'US Pacific Fleet' },
  { name: 'Yokosuka', country: 'JP', lat: 35.28, lng: 139.67, type: 'naval', fleet: 'US 7th Fleet' },
  { name: 'Severomorsk', country: 'RU', lat: 69.07, lng: 33.42, type: 'naval', fleet: 'Russian Northern Fleet' },
  { name: 'Tartus', country: 'SY', lat: 34.89, lng: 35.89, type: 'naval', fleet: 'Russian Mediterranean' },
  { name: 'Zhanjiang', country: 'CN', lat: 21.20, lng: 110.39, type: 'naval', fleet: 'PLA Navy South Sea Fleet' },
  { name: 'Qingdao Naval', country: 'CN', lat: 36.09, lng: 120.43, type: 'naval', fleet: 'PLA Navy North Sea Fleet' },
  { name: 'Portsmouth', country: 'GB', lat: 50.80, lng: -1.11, type: 'naval', fleet: 'Royal Navy' },
  { name: 'Toulon', country: 'FR', lat: 43.12, lng: 5.93, type: 'naval', fleet: 'French Navy Mediterranean' },
  { name: 'Changi Naval Base', country: 'SG', lat: 1.33, lng: 104.01, type: 'naval', fleet: 'Republic of Singapore Navy' },
  { name: 'Visakhapatnam', country: 'IN', lat: 17.69, lng: 83.30, type: 'naval', fleet: 'Indian Navy Eastern Command' },
  { name: 'Mumbai Naval', country: 'IN', lat: 18.93, lng: 72.84, type: 'naval', fleet: 'Indian Navy Western Command' },
];

const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.57, lng: 56.25, traffic: '21M bpd oil', risk: 'HIGH' },
  { name: 'Strait of Malacca', lat: 2.50, lng: 101.50, traffic: '16M bpd oil', risk: 'MODERATE' },
  { name: 'Suez Canal', lat: 30.43, lng: 32.34, traffic: '12% world trade', risk: 'ELEVATED' },
  { name: 'Bab el-Mandeb', lat: 12.58, lng: 43.33, traffic: '6.2M bpd oil', risk: 'CRITICAL' },
  { name: 'Panama Canal', lat: 9.08, lng: -79.68, traffic: '5% world trade', risk: 'LOW' },
  { name: 'Turkish Straits', lat: 41.12, lng: 29.07, traffic: '3M bpd oil', risk: 'MODERATE' },
  { name: 'Danish Straits', lat: 55.70, lng: 12.60, traffic: '3.2M bpd oil', risk: 'LOW' },
  { name: 'Cape of Good Hope', lat: -34.36, lng: 18.47, traffic: 'Alt route Suez', risk: 'LOW' },
  { name: 'Taiwan Strait', lat: 24.00, lng: 119.00, traffic: '88% large ships', risk: 'ELEVATED' },
  { name: 'Lombok Strait', lat: -8.47, lng: 115.72, traffic: 'Alt Malacca', risk: 'LOW' },
];

const TRACKING_URL = (process.env.TRACKING_URL || process.env.OSIRIS_TRACKING_URL || '').replace(/\/$/, '');
const LEGACY_MARITIME_INGEST = process.env.OSIRIS_ENABLE_LEGACY_MARITIME_INGEST === 'true';

// --- Global AIS Stream Client (In-Memory Cache) ---
// Note: In a true serverless environment, this state would reset per invocation.
// For Next.js dev server or Node.js Docker container, this will persist.

type ShipRecord = {
  id: number;
  mmsi: number;
  lat?: number;
  lng?: number;
  speed?: number;
  heading?: number;
  timestamp: number;
  type?: string;
  name?: string;
  destination?: string;
  flag?: string;
};

type PositionedShipRecord = ShipRecord & { lat: number; lng: number };

const globalForAis = globalThis as unknown as {
  shipsCache: Map<number, ShipRecord>;
  isAisConnecting: boolean;
  lastAisConnectedAt?: number;
  lastAisMessageAt?: number;
  lastAisError?: string;
  vesselApiStatus?: string;
  vesselApiLastSuccessAt?: number;
  vesselApiLastError?: string;
};

if (!globalForAis.shipsCache) {
  globalForAis.shipsCache = new Map();
  globalForAis.isAisConnecting = false;
}

const shipsCache = globalForAis.shipsCache;

function connectAisStream() {
  if (globalForAis.isAisConnecting) return;
  const apiKey = process.env.AIS_API_KEY;
  if (!apiKey) return;

  globalForAis.isAisConnecting = true;
  let ws: WebSocket;

  try {
    ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  } catch (e) {
    globalForAis.isAisConnecting = false;
    globalForAis.lastAisError = e instanceof Error ? e.message : String(e);
    return;
  }

  ws.on("open", () => {
    globalForAis.isAisConnecting = false;
    globalForAis.lastAisConnectedAt = Date.now();
    globalForAis.lastAisError = undefined;
    const subscriptionMessage = {
      APIKey: apiKey,
      // Target specific high-value SCM areas to ensure data delivery on free tier
      BoundingBoxes: [
        // Tokyo Bay
        [[34.8, 139.5], [35.7, 140.2]],
        // Hormuz
        [[25.0, 54.0], [27.5, 57.5]],
        // Suez Canal
        [[27.0, 32.0], [32.0, 33.5]],
        // Bab el-Mandeb
        [[12.0, 42.5], [14.0, 44.0]],
        // Panama Canal
        [[8.0, -80.5], [10.0, -79.0]],
        // Malacca / Singapore
        [[1.0, 103.0], [3.0, 104.5]],
        // Taiwan Strait
        [[22.0, 118.0], [26.0, 121.0]],
        // Rotterdam / English Channel
        [[50.0, 0.0], [53.0, 5.0]],
        // US West Coast (LA/LB)
        [[33.0, -119.0], [34.5, -117.0]],
        // Global fallback (often heavily sampled by aisstream)
        [[-90, -180], [90, 180]]
      ],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    };
    ws.send(JSON.stringify(subscriptionMessage));
  });

  // Map AIS ship types to OSIRIS categories
  const getOsirisShipType = (typeCode: number) => {
    if (!typeCode) return 'cargo';
    if (typeCode >= 80 && typeCode <= 89) return 'tanker';
    if (typeCode >= 70 && typeCode <= 79) return 'cargo';
    if (typeCode === 35) return 'military';
    return 'cargo';
  };

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as {
        MetaData?: { MMSI?: number; ShipName?: string };
        MessageType?: string;
        Message?: {
          PositionReport?: { Latitude?: number; Longitude?: number; Sog?: number; TrueHeading?: number; Cog?: number };
          ShipStaticData?: { Name?: string; Destination?: string; Type?: number };
        };
      };
      const mmsi = parsed.MetaData?.MMSI;
      if (!mmsi) return;
      globalForAis.lastAisMessageAt = Date.now();

      const existing = shipsCache.get(mmsi) || {
        id: mmsi, mmsi: mmsi, timestamp: Date.now()
      };

      // Extract Name from MetaData if available (present in most messages)
      if (parsed.MetaData?.ShipName) {
        existing.name = parsed.MetaData.ShipName.trim();
      }

      if (parsed.MessageType === "PositionReport" && parsed.Message?.PositionReport) {
        const report = parsed.Message.PositionReport;
        existing.lat = report.Latitude;
        existing.lng = report.Longitude;
        existing.speed = report.Sog;
        existing.heading = report.TrueHeading || report.Cog;
        existing.timestamp = Date.now();
      } 
      else if (parsed.MessageType === "ShipStaticData" && parsed.Message?.ShipStaticData) {
        const staticData = parsed.Message.ShipStaticData;
        existing.name = staticData.Name ? staticData.Name.trim() : existing.name;
        existing.destination = staticData.Destination ? staticData.Destination.trim() : existing.destination;
        existing.type = getOsirisShipType(staticData.Type ?? 0);
      }

      // Only store if we have coordinates
      if (existing.lat && existing.lng) {
        shipsCache.set(mmsi, existing);
      }

      // Limit cache size to prevent memory leak (allow up to 20,000 ships)
      if (shipsCache.size > 20000) {
        const firstKey = shipsCache.keys().next().value;
        if (firstKey) shipsCache.delete(firstKey);
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    globalForAis.isAisConnecting = false;
    globalForAis.lastAisError = 'aisstream_closed';
    setTimeout(connectAisStream, 5000); // Reconnect
  });

  ws.on("error", (error) => {
    globalForAis.lastAisError = error instanceof Error ? error.message : 'aisstream_error';
    ws.close();
  });
}

// Legacy direct AIS ingestion is retained only as an explicit break-glass fallback.
if (LEGACY_MARITIME_INGEST) {
  connectAisStream();
}

// --- Optional licensed satellite/terrestrial AIS REST fallback ---
let lastVesselApiFetch = 0;

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractVesselRows(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') return [];
  const candidate = payload as Record<string, unknown>;
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (Array.isArray(candidate.vessels)) return candidate.vessels as Record<string, unknown>[];
  if (Array.isArray(candidate.ships)) return candidate.ships as Record<string, unknown>[];
  if (Array.isArray(candidate.data)) return candidate.data as Record<string, unknown>[];
  if (Array.isArray(candidate.results)) return candidate.results as Record<string, unknown>[];
  return [];
}

async function fetchVesselApiFallback() {
  const apiKey = process.env.VESSEL_API_KEY;
  const providerUrl = process.env.VESSEL_API_URL;
  if (!apiKey || !providerUrl) {
    globalForAis.vesselApiStatus = apiKey ? 'missing_vessel_api_url' : 'not_configured';
    return;
  }

  let url: URL;
  try {
    url = new URL(providerUrl);
    if (url.protocol !== 'https:') {
      globalForAis.vesselApiStatus = 'invalid_url';
      globalForAis.vesselApiLastError = 'VESSEL_API_URL must use https';
      return;
    }
  } catch {
    globalForAis.vesselApiStatus = 'invalid_url';
    globalForAis.vesselApiLastError = 'VESSEL_API_URL is not a valid URL';
    return;
  }

  const now = Date.now();
  if (now - lastVesselApiFetch < 60000) return; // Poll every 60s max
  lastVesselApiFetch = now;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'OSIRIS-Maritime/1.0',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      globalForAis.vesselApiStatus = 'degraded';
      globalForAis.vesselApiLastError = `http_${res.status}`;
      return;
    }

    const rows = extractVesselRows(await res.json()).slice(0, 5000);
    let merged = 0;
    for (const row of rows) {
      const mmsi = toNumber(row.mmsi ?? row.MMSI ?? row.id);
      const lat = toNumber(row.lat ?? row.latitude ?? row.Latitude);
      const lng = toNumber(row.lng ?? row.lon ?? row.longitude ?? row.Longitude);
      if (!mmsi || lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;

      shipsCache.set(mmsi, {
        id: mmsi,
        mmsi,
        lat,
        lng,
        speed: toNumber(row.speed ?? row.sog ?? row.Sog) ?? 0,
        heading: toNumber(row.heading ?? row.cog ?? row.TrueHeading ?? row.Cog) ?? 0,
        timestamp: Date.now(),
        type: String(row.type || row.ship_type || 'cargo'),
        name: String(row.name || row.ship_name || row.ShipName || `MMSI ${mmsi}`),
        destination: String(row.destination || row.Destination || 'UNKNOWN'),
        flag: String(row.flag || row.source || 'licensed-ais'),
      });
      merged++;
    }

    globalForAis.vesselApiStatus = merged > 0 ? 'ok' : 'empty_response';
    globalForAis.vesselApiLastSuccessAt = Date.now();
    globalForAis.vesselApiLastError = undefined;
  } catch (e) {
    globalForAis.vesselApiStatus = 'degraded';
    globalForAis.vesselApiLastError = e instanceof Error ? e.message : String(e);
    console.warn("VesselAPI fallback error:", e);
  }
}

function getDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const dx = (lng1 - lng2) * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const dy = lat1 - lat2;
  return Math.sqrt(dx * dx + dy * dy) * 111.32;
}

function buildMaritimePayload(
  ships: PositionedShipRecord[],
  options: {
    source: string;
    degraded?: boolean;
    error?: string;
    upstreamFreshness?: Record<string, unknown> | null;
  }
) {
  const newestShipTimestamp = ships.reduce(
    (latest, ship) => Math.max(latest, Number(ship.timestamp || 0)),
    0
  );

  const dynamicPorts = PORTS.map(port => {
    let nearbyCount = 0;
    let waitingCount = 0;

    for (let i = 0; i < ships.length; i++) {
      if (getDistanceKm(port.lat, port.lng, ships[i].lat, ships[i].lng) < 50) {
        nearbyCount++;
        if ((ships[i].speed ?? 0) < 0.5 && ships[i].type !== 'military') {
          waitingCount++;
        }
      }
    }

    const congestionRatio = nearbyCount > 0 ? waitingCount / nearbyCount : 0;
    let congestionStatus = 'NORMAL';
    let estDwellTime = '1-2 Days';

    if (congestionRatio > 0.6 || waitingCount > 30) {
      congestionStatus = 'SEVERE';
      estDwellTime = '7+ Days';
    } else if (congestionRatio > 0.4 || waitingCount > 15) {
      congestionStatus = 'CONGESTED';
      estDwellTime = '3-5 Days';
    }

    return {
      ...port,
      volume: `${port.volume} | LIVE: ${nearbyCount} (WAITING: ${waitingCount})`,
      congestion: congestionStatus,
      dwell_time: estDwellTime,
    };
  });

  const dynamicChokepoints = CHOKEPOINTS.map(choke => {
    let nearbyCount = 0;
    for (let i = 0; i < ships.length; i++) {
      if (getDistanceKm(choke.lat, choke.lng, ships[i].lat, ships[i].lng) < 100) nearbyCount++;
    }

    let dynamicRisk = choke.risk;
    if (nearbyCount > 50) dynamicRisk = 'CRITICAL';
    else if (nearbyCount > 20 && dynamicRisk !== 'CRITICAL') dynamicRisk = 'HIGH';
    else if (nearbyCount > 5 && dynamicRisk === 'LOW') dynamicRisk = 'ELEVATED';

    return {
      ...choke,
      traffic: `${choke.traffic} | LIVE SHIPS: ${nearbyCount}`,
      risk: dynamicRisk,
    };
  });

  return {
    ports: dynamicPorts,
    chokepoints: dynamicChokepoints,
    ships,
    total_ports: dynamicPorts.length,
    total_chokepoints: dynamicChokepoints.length,
    total_ships: ships.length,
    freshness: {
      newest_ship_at: newestShipTimestamp ? new Date(newestShipTimestamp).toISOString() : null,
      newest_ship_age_seconds: newestShipTimestamp ? Math.round((Date.now() - newestShipTimestamp) / 1000) : null,
      tracking_service: {
        configured: Boolean(TRACKING_URL),
        source: options.source,
        degraded: Boolean(options.degraded),
        last_error: options.error || null,
        upstream: options.upstreamFreshness || null,
      },
      aisstream: {
        configured: LEGACY_MARITIME_INGEST && Boolean(process.env.AIS_API_KEY),
        connecting: LEGACY_MARITIME_INGEST ? globalForAis.isAisConnecting : false,
        last_connected_at: globalForAis.lastAisConnectedAt ? new Date(globalForAis.lastAisConnectedAt).toISOString() : null,
        last_message_at: globalForAis.lastAisMessageAt ? new Date(globalForAis.lastAisMessageAt).toISOString() : null,
        last_error: globalForAis.lastAisError || null,
      },
      vessel_api: {
        configured: LEGACY_MARITIME_INGEST && Boolean(process.env.VESSEL_API_KEY && process.env.VESSEL_API_URL),
        status: LEGACY_MARITIME_INGEST ? (globalForAis.vesselApiStatus || 'not_configured') : 'disabled',
        last_success_at: globalForAis.vesselApiLastSuccessAt ? new Date(globalForAis.vesselApiLastSuccessAt).toISOString() : null,
        last_error: globalForAis.vesselApiLastError || null,
      },
    },
    degraded: Boolean(options.degraded),
    error: options.error,
    source: options.source,
    timestamp: new Date().toISOString(),
  };
}

async function fetchTrackingMaritime() {
  if (!TRACKING_URL) return null;

  try {
    const res = await fetch(`${TRACKING_URL}/maritime?stale=false&limit=10000`, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OSIRIS-UI/1.0',
      },
    });

    if (!res.ok) return null;
    const payload = await res.json() as {
      ships?: ShipRecord[];
      freshness?: Record<string, unknown>;
      source?: string;
    };
    const ships = Array.isArray(payload.ships)
      ? payload.ships.filter((ship): ship is PositionedShipRecord =>
        typeof ship.lat === 'number' && typeof ship.lng === 'number'
      )
      : [];

    return buildMaritimePayload(ships, {
      source: payload.source || 'osiris-tracking',
      upstreamFreshness: payload.freshness || null,
    });
  } catch (error) {
    globalForAis.lastAisError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export async function GET() {
  const moduleState = await getModuleState('ais');
  if (moduleState && !moduleState.enabled) {
    return NextResponse.json(await disabledModulePayload('ais', {
      ports: [],
      chokepoints: [],
      ships: [],
      total_ports: 0,
      total_chokepoints: 0,
      total_ships: 0,
      freshness: {
        newest_ship_at: null,
        newest_ship_age_seconds: null,
        aisstream: { configured: Boolean(process.env.AIS_API_KEY), connecting: false },
        vessel_api: { configured: Boolean(process.env.VESSEL_API_KEY && process.env.VESSEL_API_URL) },
      },
    }), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const trackingPayload = await fetchTrackingMaritime();
  if (trackingPayload) {
    return NextResponse.json(trackingPayload, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  }

  if (!LEGACY_MARITIME_INGEST) {
    return NextResponse.json(buildMaritimePayload([], {
      source: 'osiris-tracking',
      degraded: true,
      error: TRACKING_URL ? 'tracking_service_unavailable' : 'tracking_service_not_configured',
    }), {
      status: 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
  }

  // Trigger Hybrid Fallback
  await fetchVesselApiFallback();

  // Clean up stale ships (older than 10 minutes)
  const now = Date.now();
  for (const [mmsi, ship] of shipsCache.entries()) {
    if (now - ship.timestamp > 10 * 60 * 1000) {
      shipsCache.delete(mmsi);
    }
  }

  const ships = Array.from(shipsCache.values()).filter(
    (ship): ship is ShipRecord & { lat: number; lng: number } =>
      typeof ship.lat === 'number' && typeof ship.lng === 'number'
  );
  const newestShipTimestamp = ships.reduce(
    (latest, ship) => Math.max(latest, Number(ship.timestamp || 0)),
    0
  );

  // Dynamically calculate live traffic (Fast approximation of Haversine)
  const getDistanceKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const dx = (lng1 - lng2) * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    const dy = lat1 - lat2;
    return Math.sqrt(dx * dx + dy * dy) * 111.32;
  };

  const dynamicPorts = PORTS.map(port => {
    let nearbyCount = 0;
    let waitingCount = 0;

    for (let i = 0; i < ships.length; i++) {
      if (getDistanceKm(port.lat, port.lng, ships[i].lat, ships[i].lng) < 50) {
        nearbyCount++;
        // If speed is less than 0.5 knots, consider it anchored/waiting
        if ((ships[i].speed ?? 0) < 0.5 && ships[i].type !== 'military') {
          waitingCount++;
        }
      }
    }

    // Heuristic: More than 40% waiting indicates congestion
    const congestionRatio = nearbyCount > 0 ? waitingCount / nearbyCount : 0;
    let congestionStatus = 'NORMAL';
    let estDwellTime = '1-2 Days';
    
    if (congestionRatio > 0.6 || waitingCount > 30) {
      congestionStatus = 'SEVERE';
      estDwellTime = '7+ Days';
    } else if (congestionRatio > 0.4 || waitingCount > 15) {
      congestionStatus = 'CONGESTED';
      estDwellTime = '3-5 Days';
    }

    return {
      ...port,
      volume: `${port.volume} | LIVE: ${nearbyCount} (WAITING: ${waitingCount})`,
      congestion: congestionStatus,
      dwell_time: estDwellTime
    };
  });

  const dynamicChokepoints = CHOKEPOINTS.map(choke => {
    let nearbyCount = 0;
    for (let i = 0; i < ships.length; i++) {
      if (getDistanceKm(choke.lat, choke.lng, ships[i].lat, ships[i].lng) < 100) nearbyCount++;
    }
    
    // Dynamically adjust risk based on live ship concentration
    let dynamicRisk = choke.risk;
    if (nearbyCount > 50) dynamicRisk = 'CRITICAL';
    else if (nearbyCount > 20 && dynamicRisk !== 'CRITICAL') dynamicRisk = 'HIGH';
    else if (nearbyCount > 5 && dynamicRisk === 'LOW') dynamicRisk = 'ELEVATED';

    return {
      ...choke,
      traffic: `${choke.traffic} | LIVE SHIPS: ${nearbyCount}`,
      risk: dynamicRisk
    };
  });

  return NextResponse.json({
    ports: dynamicPorts,
    chokepoints: dynamicChokepoints,
    ships: ships,
    total_ports: dynamicPorts.length,
    total_chokepoints: dynamicChokepoints.length,
    total_ships: ships.length,
    freshness: {
      newest_ship_at: newestShipTimestamp ? new Date(newestShipTimestamp).toISOString() : null,
      newest_ship_age_seconds: newestShipTimestamp ? Math.round((Date.now() - newestShipTimestamp) / 1000) : null,
      aisstream: {
        configured: Boolean(process.env.AIS_API_KEY),
        connecting: globalForAis.isAisConnecting,
        last_connected_at: globalForAis.lastAisConnectedAt ? new Date(globalForAis.lastAisConnectedAt).toISOString() : null,
        last_message_at: globalForAis.lastAisMessageAt ? new Date(globalForAis.lastAisMessageAt).toISOString() : null,
        last_error: globalForAis.lastAisError || null,
      },
      vessel_api: {
        configured: Boolean(process.env.VESSEL_API_KEY && process.env.VESSEL_API_URL),
        status: globalForAis.vesselApiStatus || 'not_configured',
        last_success_at: globalForAis.vesselApiLastSuccessAt ? new Date(globalForAis.vesselApiLastSuccessAt).toISOString() : null,
        last_error: globalForAis.vesselApiLastError || null,
      },
    },
    timestamp: new Date().toISOString(),
  }, {
    headers: { 
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    },
  });
}
