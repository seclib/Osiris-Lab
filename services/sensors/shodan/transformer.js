'use strict';

const { createHash, randomUUID } = require('crypto');

const DB_PORTS = new Set([3306, 27017, 27018, 27019, 6379]);
const SSH_PORTS = new Set([22]);
const RTSP_CAMERA_PORTS = new Set([554, 8554]);

const DATABASE_TERMS = [
  'mysql',
  'mariadb',
  'mongodb',
  'mongo db',
  'redis',
];

const CAMERA_TERMS = [
  'rtsp',
  'camera',
  'webcam',
  'ip camera',
  'onvif',
  'hikvision',
  'dahua',
  'axis',
  'mobotix',
  'vivotek',
  'avtech',
];

const OUTDATED_TAGS = new Set([
  'deprecated',
  'eol',
  'end-of-life',
  'outdated',
  'vuln',
  'vulnerable',
]);

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function compactObject(object) {
  const output = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    output[key] = value;
  }
  return output;
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = cleanString(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function uniquePorts(values) {
  return [...new Set(values.map(toNumber).filter((value) => value !== null && value > 0 && value <= 65535))]
    .sort((a, b) => a - b);
}

function intToIpv4(value) {
  const number = toNumber(value);
  if (number === null || number < 0 || number > 0xffffffff) return '';
  return [
    (number >>> 24) & 255,
    (number >>> 16) & 255,
    (number >>> 8) & 255,
    number & 255,
  ].join('.');
}

function ipFrom(record) {
  return cleanString(record?.ip_str) || cleanString(record?.ip) || intToIpv4(record?.ip);
}

function timestampFrom(value) {
  const raw = cleanString(value);
  if (!raw) return '';
  const withZone = /(z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const normalized = withZone.replace(/(\.\d{3})\d+(?=(z|[+-]\d{2}:?\d{2})?$)/i, '$1');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString();
}

function locationFrom(record) {
  const location = record?.location && typeof record.location === 'object' ? record.location : {};
  const lat = toNumber(record?.latitude ?? location.latitude);
  const lon = toNumber(record?.longitude ?? location.longitude);
  const coordinates = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    ? [lon, lat]
    : [];

  return {
    country: cleanString(record?.country_name) || cleanString(location.country_name) || cleanString(record?.country_code) || cleanString(location.country_code),
    city: cleanString(record?.city) || cleanString(location.city),
    coordinates,
  };
}

function serviceNameFrom(banner) {
  return cleanString(banner?._shodan?.module)
    || cleanString(banner?.ssl ? 'ssl' : '')
    || cleanString(banner?.product)
    || cleanString(banner?.transport);
}

function serviceProductFrom(banner) {
  return cleanString(banner?.product)
    || cleanString(banner?.http?.server)
    || cleanString(banner?.ssh?.fingerprint ? 'ssh' : '');
}

function serviceVersionFrom(banner) {
  return cleanString(banner?.version)
    || cleanString(banner?.http?.components?.[serviceProductFrom(banner)]?.versions?.[0])
    || '';
}

function serviceFromBanner(banner) {
  const port = toNumber(banner?.port);
  if (port === null || port <= 0 || port > 65535) return null;

  return compactObject({
    port,
    transport: cleanString(banner?.transport) || 'tcp',
    name: serviceNameFrom(banner),
    product: serviceProductFrom(banner),
    version: serviceVersionFrom(banner),
    timestamp: timestampFrom(banner?.timestamp),
  });
}

function bannerText(banner) {
  return [
    banner?.product,
    banner?.version,
    banner?._shodan?.module,
    banner?.transport,
    banner?.http?.server,
    banner?.http?.title,
    ...asArray(banner?.cpe),
    ...asArray(banner?.tags),
    typeof banner?.data === 'string' ? banner.data.slice(0, 4096) : '',
  ].filter(Boolean).join(' ').toLowerCase();
}

function parseVersion(value) {
  const match = cleanString(value).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

function versionLessThan(value, major, minor = 0) {
  const version = parseVersion(value);
  if (!version) return false;
  if (version.major !== major) return version.major < major;
  return version.minor < minor;
}

function hasOutdatedVersionHeuristic(banner, service) {
  const text = bannerText(banner);
  const product = `${service.product || ''} ${service.name || ''} ${text}`.toLowerCase();
  const version = service.version || text;

  if (product.includes('openssh')) return versionLessThan(version, 7, 6) || /openssh[_/ -]?[0-6]\./i.test(text);
  if (product.includes('apache') || product.includes('httpd')) return versionLessThan(version, 2, 4) || /apache\/2\.[0-3]\./i.test(text);
  if (product.includes('nginx')) return versionLessThan(version, 1, 18) || /nginx\/(0\.|1\.([0-9]|1[0-7])\.)/i.test(text);
  if (product.includes('mysql') || product.includes('mariadb')) return versionLessThan(version, 5, 7);
  if (product.includes('mongodb')) return versionLessThan(version, 4, 4);
  if (product.includes('redis')) return versionLessThan(version, 6, 0);

  return false;
}

function hasVulnMetadata(banner) {
  if (banner?.vulns && typeof banner.vulns === 'object' && Object.keys(banner.vulns).length > 0) return true;
  const tags = asArray(banner?.tags).map((tag) => cleanString(tag).toLowerCase());
  return tags.some((tag) => OUTDATED_TAGS.has(tag));
}

function computeRiskScore(openPorts, services, banners = []) {
  const textByPort = new Map();
  banners.forEach((banner) => {
    const port = toNumber(banner?.port);
    if (port !== null) textByPort.set(port, bannerText(banner));
  });

  const flags = {
    ssh: false,
    database: false,
    camera: false,
    outdated: false,
  };

  for (const service of services) {
    const port = toNumber(service.port);
    const text = [
      service.name,
      service.product,
      service.version,
      textByPort.get(port),
    ].filter(Boolean).join(' ').toLowerCase();

    if (SSH_PORTS.has(port) || text.includes('ssh')) flags.ssh = true;
    if (DB_PORTS.has(port) || DATABASE_TERMS.some((term) => text.includes(term))) flags.database = true;
    if (RTSP_CAMERA_PORTS.has(port) || CAMERA_TERMS.some((term) => text.includes(term))) flags.camera = true;
  }

  for (const [index, banner] of banners.entries()) {
    const service = services[index] || serviceFromBanner(banner) || {};
    if (hasVulnMetadata(banner) || hasOutdatedVersionHeuristic(banner, service)) {
      flags.outdated = true;
      break;
    }
  }

  if (openPorts.some((port) => SSH_PORTS.has(port))) flags.ssh = true;
  if (openPorts.some((port) => DB_PORTS.has(port))) flags.database = true;
  if (openPorts.some((port) => RTSP_CAMERA_PORTS.has(port))) flags.camera = true;

  let score = 0;
  const tags = [];
  if (flags.ssh) {
    score += 30;
    tags.push('ssh_exposed');
  }
  if (flags.database) {
    score += 40;
    tags.push('database_exposed');
  }
  if (flags.camera) {
    score += 50;
    tags.push('camera_stream_exposed');
  }
  if (flags.outdated) {
    score += 20;
    tags.push('possibly_outdated_service');
  }

  return {
    score: Math.min(100, score),
    tags,
    flags,
  };
}

function confidenceFor(record, services, options = {}) {
  let confidence = options.mode === 'ip' ? 0.82 : 0.74;
  if (ipFrom(record)) confidence += 0.05;
  if (services.length > 0) confidence += 0.08;
  if (record?.last_update || services.some((service) => service.timestamp)) confidence += 0.05;
  return Number(Math.min(0.97, confidence).toFixed(2));
}

function validateExposureEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') errors.push('event_must_be_object');
  if (!event.id || typeof event.id !== 'string') errors.push('missing_id');
  if (event.type !== 'internet_exposure_event') errors.push('invalid_type');
  if (event.source !== 'shodan_sensor') errors.push('invalid_source');
  if (!event.timestamp || Number.isNaN(Date.parse(event.timestamp))) errors.push('invalid_timestamp');
  if (!event.geo || typeof event.geo !== 'object') errors.push('invalid_geo');
  if (!event.payload || typeof event.payload !== 'object') errors.push('invalid_payload');
  if (!Number.isInteger(event.risk_score) || event.risk_score < 0 || event.risk_score > 100) errors.push('invalid_risk_score');
  if (typeof event.confidence !== 'number' || event.confidence < 0 || event.confidence > 1) errors.push('invalid_confidence');

  if (event.geo) {
    if (typeof event.geo.country !== 'string') errors.push('invalid_geo_country');
    if (typeof event.geo.city !== 'string') errors.push('invalid_geo_city');
    if (!Array.isArray(event.geo.coordinates)) errors.push('invalid_geo_coordinates');
  }

  if (event.payload) {
    if (typeof event.payload.ip !== 'string') errors.push('invalid_payload_ip');
    if (typeof event.payload.organization !== 'string') errors.push('invalid_payload_organization');
    if (!Array.isArray(event.payload.open_ports)) errors.push('invalid_payload_open_ports');
    if (!Array.isArray(event.payload.services)) errors.push('invalid_payload_services');
    if (typeof event.payload.os !== 'string') errors.push('invalid_payload_os');
    if (!Array.isArray(event.payload.tags)) errors.push('invalid_payload_tags');
  }

  if (errors.length) {
    const error = new Error(`invalid_shodan_exposure_event:${errors.join(',')}`);
    error.errors = errors;
    error.event = event;
    throw error;
  }

  return event;
}

function createEventFromAggregate(record, options = {}) {
  const banners = asArray(record?.data).filter((item) => item && typeof item === 'object');
  const services = banners.map(serviceFromBanner).filter(Boolean);
  const openPorts = uniquePorts([
    ...asArray(record?.ports),
    ...services.map((service) => service.port),
  ]);
  const risk = computeRiskScore(openPorts, services, banners);
  const rawTags = uniqueStrings([
    ...asArray(record?.tags),
    ...banners.flatMap((banner) => asArray(banner.tags)),
    ...risk.tags,
  ]);

  const event = {
    id: randomUUID(),
    type: 'internet_exposure_event',
    source: 'shodan_sensor',
    timestamp: options.now || new Date().toISOString(),
    geo: locationFrom(record),
    payload: {
      ip: ipFrom(record),
      organization: cleanString(record?.org) || cleanString(record?.isp),
      open_ports: openPorts,
      services,
      os: cleanString(record?.os) || cleanString(banners.find((banner) => cleanString(banner.os))?.os),
      tags: rawTags,
    },
    risk_score: risk.score,
    confidence: confidenceFor(record, services, options),
  };

  return validateExposureEvent(event);
}

function transformHostRecord(record, options = {}) {
  if (!record) return [];
  return [createEventFromAggregate(record, { ...options, mode: 'ip' })];
}

function groupSearchMatches(matches) {
  const groups = new Map();

  for (const match of matches) {
    const ip = ipFrom(match);
    if (!ip) continue;

    if (!groups.has(ip)) {
      groups.set(ip, {
        ip_str: ip,
        org: match.org,
        isp: match.isp,
        os: match.os,
        location: match.location,
        tags: [],
        ports: [],
        data: [],
      });
    }

    const group = groups.get(ip);
    group.org ||= match.org;
    group.isp ||= match.isp;
    group.os ||= match.os;
    group.location ||= match.location;
    group.tags.push(...asArray(match.tags));
    group.ports.push(match.port);
    group.data.push(match);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    tags: uniqueStrings(group.tags),
    ports: uniquePorts(group.ports),
  }));
}

function transformSearchResponse(response, options = {}) {
  const matches = Array.isArray(response?.matches) ? response.matches : [];
  return groupSearchMatches(matches)
    .map((record) => createEventFromAggregate(record, { ...options, mode: options.mode || 'search' }));
}

function eventFingerprint(event) {
  const stable = {
    type: event.type,
    source: event.source,
    ip: event.payload.ip,
    organization: event.payload.organization,
    open_ports: event.payload.open_ports,
    services: event.payload.services,
    os: event.payload.os,
    tags: event.payload.tags,
    risk_score: event.risk_score,
  };

  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

module.exports = {
  computeRiskScore,
  eventFingerprint,
  transformHostRecord,
  transformSearchResponse,
  validateExposureEvent,
};
