'use strict';

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    }
  });
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function fetchJson(url, options = {}) {
  const {
    headers = {},
    timeoutMs = 8000,
    retries = 1,
    retryBaseMs = 500,
    retryMaxMs = 30000,
    logger,
    provider = 'unknown',
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('request_timeout')), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'OSIRIS-Tracking-Service/0.1',
          ...headers,
        },
        signal: controller.signal,
        cache: 'no-store',
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new Error(`upstream_http_${response.status}`);
        error.status = response.status;
        error.latencyMs = latencyMs;

        if (!retryable || attempt === retries) throw error;

        const waitMs = retryAfterMs(response)
          ?? Math.min(retryMaxMs, retryBaseMs * (2 ** attempt));
        logger?.warn('provider_request_retry', { provider, url, attempt, status: response.status, waitMs });
        await sleep(waitMs);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        const error = new Error(`unexpected_content_type:${contentType || 'unknown'}`);
        error.status = response.status;
        error.latencyMs = latencyMs;
        throw error;
      }

      return {
        payload: await response.json(),
        status: response.status,
        latencyMs,
      };
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const waitMs = Math.min(retryMaxMs, retryBaseMs * (2 ** attempt));
      logger?.warn('provider_request_retry', {
        provider,
        url,
        attempt,
        error: error instanceof Error ? error.message : String(error),
        waitMs,
      });
      await sleep(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('request_failed');
}

class SpacedRateLimiter {
  constructor(minSpacingMs) {
    this.minSpacingMs = Math.max(0, minSpacingMs);
    this.nextAllowedAt = 0;
  }

  async wait() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minSpacingMs;
    await sleep(waitMs);
  }
}

module.exports = {
  SpacedRateLimiter,
  fetchJson,
  sleep,
};
