'use strict';

const EARTH_RADIUS_KM = 6371;

function toRadians(value) {
  return value * Math.PI / 180;
}

function distanceKm(a, b) {
  if (!a || !b) return Infinity;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function headingDelta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return 0;
  const delta = Math.abs((((b - a) % 360) + 540) % 360 - 180);
  return Math.round(delta * 100) / 100;
}

function gridKey(geo, gridKm) {
  const latDegrees = gridKm / 111.32;
  const lonDegrees = gridKm / (111.32 * Math.max(0.2, Math.cos(toRadians(geo.lat))));
  return `${Math.floor(geo.lat / latDegrees)}:${Math.floor(geo.lon / lonDegrees)}`;
}

function validGeo(geo) {
  return geo
    && typeof geo.lat === 'number'
    && typeof geo.lon === 'number'
    && geo.lat >= -90
    && geo.lat <= 90
    && geo.lon >= -180
    && geo.lon <= 180;
}

module.exports = {
  distanceKm,
  gridKey,
  headingDelta,
  validGeo,
};
