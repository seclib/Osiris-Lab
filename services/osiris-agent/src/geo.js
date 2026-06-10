'use strict';

const RISK_ZONES = [
  { id: 'red_sea', name: 'Red Sea / Bab el-Mandeb', risk: 'HIGH', bbox: { west: 32, south: 11, east: 44, north: 30 } },
  { id: 'suez', name: 'Suez Canal Approaches', risk: 'HIGH', bbox: { west: 31, south: 29, east: 33.5, north: 31.8 } },
  { id: 'taiwan_strait', name: 'Taiwan Strait', risk: 'HIGH', bbox: { west: 118, south: 22, east: 122.5, north: 26.5 } },
  { id: 'south_china_sea', name: 'South China Sea', risk: 'MEDIUM', bbox: { west: 105, south: 3, east: 122, north: 23 } },
  { id: 'black_sea', name: 'Black Sea', risk: 'HIGH', bbox: { west: 27, south: 40, east: 42, north: 47.5 } },
  { id: 'persian_gulf', name: 'Persian Gulf / Strait of Hormuz', risk: 'HIGH', bbox: { west: 48, south: 24, east: 57.5, north: 30.8 } },
  { id: 'eastern_mediterranean', name: 'Eastern Mediterranean', risk: 'MEDIUM', bbox: { west: 25, south: 30, east: 37, north: 37 } },
  { id: 'gulf_of_aden', name: 'Gulf of Aden', risk: 'MEDIUM', bbox: { west: 43, south: 10, east: 53.5, north: 15 } },
  { id: 'panama_canal', name: 'Panama Canal Approaches', risk: 'MEDIUM', bbox: { west: -81, south: 7.5, east: -78.5, north: 10.5 } },
];

function toRadians(value) {
  return value * Math.PI / 180;
}

function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const earthKm = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(h));
}

function isInsideBbox(geo, bbox) {
  if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return false;
  const inLat = geo.lat >= bbox.south && geo.lat <= bbox.north;
  if (!inLat) return false;
  if (bbox.west <= bbox.east) return geo.lon >= bbox.west && geo.lon <= bbox.east;
  return geo.lon >= bbox.west || geo.lon <= bbox.east;
}

function zonesFor(geo) {
  return RISK_ZONES
    .filter((zone) => isInsideBbox(geo, zone.bbox))
    .map(({ id, name, risk }) => ({ id, name, risk }));
}

function zoneRiskScore(zones) {
  if (!zones.length) return 0;
  if (zones.some((zone) => zone.risk === 'HIGH')) return 25;
  if (zones.some((zone) => zone.risk === 'MEDIUM')) return 14;
  return 6;
}

module.exports = {
  RISK_ZONES,
  distanceKm,
  zonesFor,
  zoneRiskScore,
};
