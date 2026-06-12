'use strict';

const { OFFICIAL_SHODAN_API_BASE } = require('./config');
const { sleep } = require('./rateLimiter');

const ALLOWED_EXACT_PATHS = new Set([
  '/api-info',
  '/shodan/host/search',
]);

const BLOCKED_PATH_PREFIXES = [
  '/shodan/scan',
  '/scan',
];

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function normalizeParamValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === undefined || value === null) return '';
  return String(value);
}

function isRetryableError(error) {
  if (error?.status === 429) return true;
  if (error?.status >= 500 && error.status <= 599) return true;
  if (error?.name === 'AbortError') return true;
  if (error?.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  return Boolean(error?.networkError);
}

function retryDelay(attempt, baseMs, maxMs, retryAfterMs) {
  if (Number.isFinite(retryAfterMs)) return Math.min(maxMs, retryAfterMs);
  const exponential = Math.min(maxMs, baseMs * (2 ** attempt));
  const jitter = Math.floor(Math.random() * Math.min(250, exponential * 0.1));
  return exponential + jitter;
}

class ShodanApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ShodanApiError';
    this.status = options.status || null;
    this.retryAfterMs = options.retryAfterMs || null;
    this.payload = options.payload || null;
  }
}

class ShodanClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.baseUrl = options.baseUrl || OFFICIAL_SHODAN_API_BASE;
    this.timeoutMs = Number(options.timeoutMs || 15000);
    this.retryCount = Number(options.retryCount ?? 3);
    this.retryBaseMs = Number(options.retryBaseMs || 1000);
    this.retryMaxMs = Number(options.retryMaxMs || 30000);
    this.rateLimiter = options.rateLimiter;
    this.logger = options.logger || console;
    this.userAgent = options.userAgent || 'OSIRIS-Shodan-Sensor/1.0';
    this.stats = {
      requests: 0,
      retries: 0,
      failures: 0,
      lastStatus: null,
      lastError: null,
      lastRequestAt: null,
    };

    this.validateBaseUrl();
  }

  validateBaseUrl() {
    const url = new URL(this.baseUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.shodan.io') {
      throw new Error('shodan_client_requires_official_https_api_base');
    }
  }

  assertReadOnlyPath(path) {
    const pathname = new URL(path, this.baseUrl).pathname;

    if (BLOCKED_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      throw new Error(`blocked_shodan_active_scan_endpoint:${pathname}`);
    }

    if (ALLOWED_EXACT_PATHS.has(pathname)) return;
    if (/^\/shodan\/host\/[^/]+$/.test(pathname)) return;

    throw new Error(`unsupported_shodan_read_only_endpoint:${pathname}`);
  }

  buildUrl(path, params = {}) {
    this.assertReadOnlyPath(path);
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('key', this.apiKey);

    for (const [key, value] of Object.entries(params)) {
      const normalized = normalizeParamValue(value);
      if (normalized !== '') url.searchParams.set(key, normalized);
    }

    return url;
  }

  async request(path, params = {}) {
    const url = this.buildUrl(path, params);
    let lastError = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        return await this.runWithRateLimit(() => this.fetchJson(url));
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt === this.retryCount) break;

        this.stats.retries += 1;
        const delayMs = retryDelay(attempt, this.retryBaseMs, this.retryMaxMs, error.retryAfterMs);
        this.logger.warn('shodan_request_retry', {
          status: error.status,
          attempt: attempt + 1,
          delayMs,
          error: error.message,
        });
        await sleep(delayMs);
      }
    }

    this.stats.failures += 1;
    this.stats.lastError = lastError instanceof Error ? lastError.message : String(lastError);
    throw lastError || new Error('shodan_request_failed');
  }

  async runWithRateLimit(task) {
    if (this.rateLimiter) return this.rateLimiter.schedule(task);
    return task();
  }

  async fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.stats.requests += 1;
    this.stats.lastRequestAt = new Date().toISOString();

    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent,
        },
      });

      this.stats.lastStatus = response.status;
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const message = payload?.error || payload?.message || `shodan_http_${response.status}`;
        throw new ShodanApiError(message, {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          payload,
        });
      }

      return payload;
    } catch (error) {
      if (error instanceof ShodanApiError) throw error;
      if (error.name === 'AbortError') throw error;

      const wrapped = new Error(error instanceof Error ? error.message : String(error));
      wrapped.networkError = true;
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
  }

  async host(ip, options = {}) {
    try {
      return await this.request(`/shodan/host/${encodeURIComponent(ip)}`, {
        history: Boolean(options.history),
        minify: Boolean(options.minify),
      });
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async search(query, options = {}) {
    return this.request('/shodan/host/search', {
      query,
      page: options.page || 1,
      minify: Boolean(options.minify),
      facets: options.facets || '',
      fields: options.fields || '',
    });
  }

  async asn(asn, options = {}) {
    return this.search(`asn:${asn}`, options);
  }

  async apiInfo() {
    return this.request('/api-info');
  }

  health() {
    return { ...this.stats };
  }
}

module.exports = {
  ShodanApiError,
  ShodanClient,
};
