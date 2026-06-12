'use strict';

const net = require('net');

const OFFICIAL_SHODAN_API_BASE = 'https://api.shodan.io';
const VALID_INPUT_MODES = new Set(['ip', 'search', 'asn']);

function reader(source) {
  return function env(name, fallback = '') {
    const value = source[name];
    return value === undefined || value === '' ? fallback : String(value);
  };
}

function boolFrom(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function numberFrom(value, fallback, options = {}) {
  const parsed = Number(value);
  let output = Number.isFinite(parsed) ? parsed : fallback;
  if (typeof options.min === 'number') output = Math.max(options.min, output);
  if (typeof options.max === 'number') output = Math.min(options.max, output);
  return output;
}

function cleanString(value) {
  return String(value || '').trim();
}

function normalizeAsn(value) {
  const raw = cleanString(value).toUpperCase();
  if (!raw) return '';
  const digits = raw.startsWith('AS') ? raw.slice(2) : raw;
  if (!/^\d{1,10}$/.test(digits)) throw new Error('invalid_shodan_asn');
  return `AS${digits}`;
}

function ipv4Parts(ip) {
  return ip.split('.').map((part) => Number(part));
}

function isPublicIp(ip) {
  const version = net.isIP(ip);
  if (!version) return false;

  if (version === 4) {
    const [a, b, c] = ipv4Parts(ip);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (normalized.startsWith('fe80:')) return false;
  if (normalized.startsWith('ff')) return false;
  if (normalized.startsWith('2001:db8')) return false;
  return true;
}

function validateOfficialApiBase(value) {
  const url = new URL(value || OFFICIAL_SHODAN_API_BASE);
  if (url.protocol !== 'https:' || url.hostname !== 'api.shodan.io') {
    throw new Error('shodan_api_base_must_be_https_api_shodan_io');
  }
  return OFFICIAL_SHODAN_API_BASE;
}

function resolveInputMode(env, targetIp, searchQuery, targetAsn) {
  const explicitMode = cleanString(env('SHODAN_MODE')).toLowerCase();
  if (explicitMode) return explicitMode;
  if (targetIp) return 'ip';
  if (searchQuery) return 'search';
  if (targetAsn) return 'asn';
  return 'ip';
}

function loadConfig(source = process.env) {
  const env = reader(source);

  const targetIp = cleanString(env('SHODAN_IP', env('SHODAN_TARGET_IP')));
  const searchQuery = cleanString(env('SHODAN_QUERY', env('SHODAN_SEARCH_QUERY', env('SHODAN_KEYWORD'))));
  const targetAsn = cleanString(env('SHODAN_ASN'));
  const inputMode = resolveInputMode(env, targetIp, searchQuery, targetAsn);
  const requestsPerMinute = numberFrom(env('SHODAN_RATE_LIMIT_REQUESTS_PER_MINUTE'), 30, { min: 1, max: 120 });
  const derivedSpacingMs = Math.ceil(60000 / requestsPerMinute);

  return {
    serviceName: 'osiris-sensor-shodan',
    enabled: boolFrom(env('SHODAN_ENABLED', env('SHODAN_SENSOR_ENABLED')), true),
    apiKey: cleanString(env('SHODAN_API_KEY')),
    apiBase: validateOfficialApiBase(env('SHODAN_API_BASE', OFFICIAL_SHODAN_API_BASE)),
    userAgent: cleanString(env('SHODAN_USER_AGENT', 'OSIRIS-Shodan-Sensor/1.0')),
    input: {
      mode: inputMode,
      ip: targetIp,
      query: searchQuery,
      asn: targetAsn ? normalizeAsn(targetAsn) : '',
    },
    redis: {
      url: cleanString(env('REDIS_URL', 'redis://127.0.0.1:6379')),
      streamKey: cleanString(env('OSIRIS_STREAM_KEY', env('EVENT_STREAM_KEY', 'osiris.stream'))),
      streamMaxLen: numberFrom(env('OSIRIS_STREAM_MAXLEN', env('EVENT_STREAM_MAXLEN')), 0, { min: 0 }),
      maxStreamLength: numberFrom(env('SENSOR_MAX_STREAM_LENGTH'), 500000, { min: 1000 }),
    },
    server: {
      host: cleanString(env('HOST', '0.0.0.0')),
      port: numberFrom(env('PORT'), 4705, { min: 1, max: 65535 }),
    },
    pollIntervalMs: numberFrom(env('SHODAN_POLL_SECONDS'), 900, { min: 60 }) * 1000,
    requestTimeoutMs: numberFrom(env('SHODAN_REQUEST_TIMEOUT_MS'), 15000, { min: 1000, max: 120000 }),
    retry: {
      count: numberFrom(env('SHODAN_RETRY_COUNT'), 3, { min: 0, max: 8 }),
      baseMs: numberFrom(env('SHODAN_RETRY_BASE_MS'), 1000, { min: 100, max: 60000 }),
      maxMs: numberFrom(env('SHODAN_RETRY_MAX_MS'), 30000, { min: 1000, max: 300000 }),
    },
    rateLimit: {
      minIntervalMs: numberFrom(env('SHODAN_MIN_REQUEST_SPACING_MS'), derivedSpacingMs, { min: 250 }),
      requestsPerMinute,
    },
    hostLookup: {
      history: boolFrom(env('SHODAN_HISTORY'), false),
      minify: boolFrom(env('SHODAN_HOST_MINIFY'), false),
    },
    search: {
      pageStart: numberFrom(env('SHODAN_SEARCH_PAGE_START'), 1, { min: 1, max: 100 }),
      maxPages: numberFrom(env('SHODAN_SEARCH_MAX_PAGES'), 1, { min: 1, max: 10 }),
      minify: boolFrom(env('SHODAN_SEARCH_MINIFY'), false),
    },
    cache: {
      ttlMs: numberFrom(env('SHODAN_CACHE_TTL_SECONDS'), 600, { min: 0, max: 86400 }) * 1000,
    },
    dedupe: {
      ttlMs: numberFrom(env('SHODAN_DEDUP_TTL_SECONDS'), 3600, { min: 0, max: 86400 }) * 1000,
    },
    maxEventsPerPoll: numberFrom(env('SHODAN_MAX_EVENTS_PER_POLL'), 100, { min: 1, max: 1000 }),
  };
}

function validateConfig(config) {
  const errors = [];

  if (!config.enabled) return;
  if (!config.apiKey) errors.push('SHODAN_API_KEY_required');
  if (!config.redis.url) errors.push('REDIS_URL_required');
  if (!config.redis.streamKey) errors.push('stream_key_required');
  if (!VALID_INPUT_MODES.has(config.input.mode)) errors.push(`invalid_SHODAN_MODE:${config.input.mode}`);

  if (config.input.mode === 'ip') {
    if (!config.input.ip) errors.push('SHODAN_IP_required_for_ip_mode');
    else if (!isPublicIp(config.input.ip)) errors.push('SHODAN_IP_must_be_single_public_ip');
  }

  if (config.input.mode === 'search') {
    if (!config.input.query) errors.push('SHODAN_QUERY_required_for_search_mode');
    if (/[\r\n\t]/.test(config.input.query)) errors.push('SHODAN_QUERY_must_not_contain_control_characters');
    if (config.input.query.length > 512) errors.push('SHODAN_QUERY_too_long');
  }

  if (config.input.mode === 'asn' && !config.input.asn) errors.push('SHODAN_ASN_required_for_asn_mode');

  if (errors.length) {
    const error = new Error(`invalid_shodan_sensor_config:${errors.join(',')}`);
    error.errors = errors;
    throw error;
  }
}

function publicConfig(config) {
  return {
    serviceName: config.serviceName,
    enabled: config.enabled,
    apiBase: config.apiBase,
    input: config.input,
    redis: {
      streamKey: config.redis.streamKey,
      streamMaxLen: config.redis.streamMaxLen,
      maxStreamLength: config.redis.maxStreamLength,
    },
    server: config.server,
    pollIntervalMs: config.pollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    retry: config.retry,
    rateLimit: config.rateLimit,
    hostLookup: config.hostLookup,
    search: config.search,
    cache: config.cache,
    dedupe: config.dedupe,
    maxEventsPerPoll: config.maxEventsPerPoll,
  };
}

module.exports = {
  OFFICIAL_SHODAN_API_BASE,
  VALID_INPUT_MODES,
  isPublicIp,
  loadConfig,
  normalizeAsn,
  publicConfig,
  validateConfig,
};
