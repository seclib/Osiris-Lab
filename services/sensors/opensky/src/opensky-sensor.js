'use strict';

const { BaseSensor } = require('../../base-sensor');
const { parseTimestamp, stableId, toNumber } = require('../../event-schema');

const MPS_TO_KNOTS = 1.9438444924406;
const M_TO_FEET = 3.280839895;
const DEFAULT_AUTH_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const DEFAULT_API_URL = 'https://opensky-network.org/api/states/all';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampHeading(value) {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  return Number((((parsed % 360) + 360) % 360).toFixed(2));
}

function cleanCallsign(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function retryAfterMs(response) {
  const openskyRetry = response.headers.get('x-rate-limit-retry-after-seconds');
  const retryAfter = response.headers.get('retry-after');
  const numeric = Number(openskyRetry || retryAfter);
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
  const date = Date.parse(retryAfter || '');
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function rateLimitMeta(response) {
  return {
    remaining: response.headers.get('x-rate-limit-remaining') || null,
    retryAfterSeconds: response.headers.get('x-rate-limit-retry-after-seconds') || null,
  };
}

function normalizeBbox(bbox) {
  if (!bbox) return null;
  const lamin = toNumber(bbox.lamin ?? bbox.south);
  const lomin = toNumber(bbox.lomin ?? bbox.west);
  const lamax = toNumber(bbox.lamax ?? bbox.north);
  const lomax = toNumber(bbox.lomax ?? bbox.east);
  if ([lamin, lomin, lamax, lomax].some((value) => value === null)) return null;
  if (lamin < -90 || lamax > 90 || lamin > lamax) throw new Error('invalid_opensky_bbox_latitude');
  if (lomin < -180 || lomax > 180 || lomin > lomax) throw new Error('invalid_opensky_bbox_longitude');
  return { lamin, lomin, lamax, lomax };
}

class OpenSkySensor extends BaseSensor {
  constructor(options = {}) {
    super({
      ...options,
      id: options.id || 'opensky',
      type: 'aviation_tracking',
      source: options.source || 'opensky-network',
    });

    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this.authUrl = options.authUrl || DEFAULT_AUTH_URL;
    this.clientId = options.clientId || '';
    this.clientSecret = options.clientSecret || '';
    this.extended = options.extended !== false;
    this.bbox = normalizeBbox(options.bbox);
    this.icao24 = Array.isArray(options.icao24) ? options.icao24.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : [];
    this.minAltitudeM = toNumber(options.minAltitudeM);
    this.maxAltitudeM = toNumber(options.maxAltitudeM);
    this.includeOnGround = options.includeOnGround !== false;
    this.minVelocityMps = toNumber(options.minVelocityMps);
    this.retryCount = Number.isFinite(Number(options.retryCount)) ? Number(options.retryCount) : 2;
    this.retryBaseMs = Number.isFinite(Number(options.retryBaseMs)) ? Number(options.retryBaseMs) : 1000;
    this.retryMaxMs = Number.isFinite(Number(options.retryMaxMs)) ? Number(options.retryMaxMs) : 60000;
    this.minRequestSpacingMs = Number.isFinite(Number(options.minRequestSpacingMs)) ? Number(options.minRequestSpacingMs) : 10000;
    this.nextAllowedAt = 0;
    this.rateLimitedUntil = 0;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lastRateLimit = null;
  }

  hasAuth() {
    return Boolean(this.clientId && this.clientSecret);
  }

  validateConfiguration() {
    super.validateConfiguration();
    if (this.clientId && !this.clientSecret) throw new Error('opensky_client_secret_required');
    if (this.clientSecret && !this.clientId) throw new Error('opensky_client_id_required');
  }

  async collect() {
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      const error = new Error('opensky_rate_limited');
      error.retryAfterMs = this.rateLimitedUntil - now;
      throw error;
    }

    const startedAt = Date.now();
    const payload = await this.fetchStates();
    const responseTime = parseTimestamp(payload.time, new Date().toISOString());
    const states = Array.isArray(payload.states) ? payload.states : [];

    const records = [];
    for (const [index, state] of states.slice(0, this.maxBatchSize).entries()) {
      try {
        const record = this.stateToRecord(state, responseTime);
        if (record) records.push(record);
      } catch (error) {
        this.stats.rejected += 1;
        this.log('warn', 'opensky_state_rejected', {
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return records.map((record) => ({
        ...record,
        payload: {
          ...record.payload,
          api_latency_ms: Date.now() - startedAt,
          rate_limit: this.lastRateLimit,
        },
      }));
  }

  async fetchStates() {
    let lastError = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      await this.waitForSpacing();
      try {
        const response = await fetch(this.buildUrl(), {
          method: 'GET',
          cache: 'no-store',
          headers: await this.requestHeaders(),
        });

        this.lastRateLimit = rateLimitMeta(response);

        if (response.status === 401 && this.hasAuth() && attempt < this.retryCount) {
          this.token = null;
          this.tokenExpiresAt = 0;
          lastError = new Error('opensky_unauthorized_refreshing_token');
          continue;
        }

        if (response.status === 429) {
          const waitMs = retryAfterMs(response) || this.retryMaxMs;
          this.rateLimitedUntil = Date.now() + waitMs;
          const error = new Error('opensky_rate_limited');
          error.status = 429;
          error.retryAfterMs = waitMs;
          throw error;
        }

        if (!response.ok) {
          const error = new Error(`opensky_http_${response.status}`);
          error.status = response.status;
          if (response.status < 500 || attempt === this.retryCount) throw error;
          lastError = error;
          await sleep(Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** attempt)));
          continue;
        }

        return await response.json();
      } catch (error) {
        lastError = error;
        if (error.status === 429 || attempt === this.retryCount) break;
        await sleep(Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** attempt)));
      }
    }

    throw lastError || new Error('opensky_request_failed');
  }

  buildUrl() {
    const url = new URL(this.apiUrl);
    if (this.extended) url.searchParams.set('extended', '1');
    if (this.bbox) {
      url.searchParams.set('lamin', String(this.bbox.lamin));
      url.searchParams.set('lomin', String(this.bbox.lomin));
      url.searchParams.set('lamax', String(this.bbox.lamax));
      url.searchParams.set('lomax', String(this.bbox.lomax));
    }
    for (const icao24 of this.icao24) url.searchParams.append('icao24', icao24);
    return url.toString();
  }

  async requestHeaders() {
    const headers = {
      accept: 'application/json',
      'user-agent': 'OSIRIS-OpenSky-Sensor/0.1',
    };

    if (this.hasAuth()) headers.authorization = `Bearer ${await this.getAccessToken()}`;
    return headers;
  }

  async getAccessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 30000) return this.token;

    const response = await fetch(this.authUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'OSIRIS-OpenSky-Sensor/0.1',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) throw new Error(`opensky_auth_http_${response.status}`);
    const payload = await response.json();
    if (!payload.access_token) throw new Error('opensky_auth_missing_access_token');

    const expiresIn = Number(payload.expires_in || 1800);
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 30) * 1000;
    return this.token;
  }

  async waitForSpacing() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minRequestSpacingMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  stateToRecord(state, responseTime) {
    if (!Array.isArray(state)) throw new Error('invalid_opensky_state_shape');

    const icao24 = String(state[0] || '').trim().toLowerCase();
    const callsign = cleanCallsign(state[1]);
    const originCountry = typeof state[2] === 'string' ? state[2] : '';
    const timePosition = toNumber(state[3]);
    const lastContact = toNumber(state[4]);
    const lon = toNumber(state[5]);
    const lat = toNumber(state[6]);
    const baroAltitudeM = toNumber(state[7]);
    const onGround = Boolean(state[8]);
    const velocityMps = toNumber(state[9]);
    const trueTrackDeg = clampHeading(state[10]);
    const verticalRateMps = toNumber(state[11]);
    const geoAltitudeM = toNumber(state[13]);
    const squawk = typeof state[14] === 'string' ? state[14] : '';
    const spi = Boolean(state[15]);
    const positionSource = toNumber(state[16]);
    const category = toNumber(state[17]);
    const altitudeM = baroAltitudeM ?? geoAltitudeM;

    if (!icao24) throw new Error('missing_icao24');
    if (!this.includeOnGround && onGround) return null;
    if (this.minAltitudeM !== null && (altitudeM === null || altitudeM < this.minAltitudeM)) return null;
    if (this.maxAltitudeM !== null && (altitudeM === null || altitudeM > this.maxAltitudeM)) return null;
    if (this.minVelocityMps !== null && (velocityMps === null || velocityMps < this.minVelocityMps)) return null;

    const timestamp = parseTimestamp(timePosition || lastContact, responseTime);
    const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 1000));
    const id = `opensky:${icao24}:${lastContact || timePosition || stableId([lat, lon, callsign])}`;
    const confidence = this.confidenceFor({ lat, lon, timestamp, velocityMps, trueTrackDeg, ageSeconds, positionSource });

    return {
      id,
      type: 'aviation_tracking',
      source: 'opensky-network',
      timestamp,
      geo: { lat, lon },
      confidence,
      payload: {
        icao24,
        callsign,
        origin_country: originCountry,
        time_position: timePosition,
        last_contact: lastContact,
        longitude: lon,
        latitude: lat,
        baro_altitude_m: baroAltitudeM,
        geo_altitude_m: geoAltitudeM,
        altitude_m: altitudeM,
        altitude_ft: altitudeM === null ? null : Number((altitudeM * M_TO_FEET).toFixed(0)),
        on_ground: onGround,
        velocity_mps: velocityMps,
        velocity_knots: velocityMps === null ? null : Number((velocityMps * MPS_TO_KNOTS).toFixed(2)),
        true_track_deg: trueTrackDeg,
        vertical_rate_mps: verticalRateMps,
        squawk,
        spi,
        position_source: positionSource,
        category,
        age_seconds: ageSeconds,
      },
      metadata: {
        sensor_id: this.id,
        raw_id: icao24,
        feed: 'states/all',
        auth_mode: this.hasAuth() ? 'oauth2_client_credentials' : 'anonymous',
        api_url: this.apiUrl,
      },
    };
  }

  confidenceFor({ lat, lon, timestamp, velocityMps, trueTrackDeg, ageSeconds, positionSource }) {
    let confidence = 0.9;
    if (toNumber(lat) === null || toNumber(lon) === null) confidence -= 0.5;
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) confidence -= 0.25;
    if (velocityMps === null) confidence -= 0.05;
    if (trueTrackDeg === null) confidence -= 0.05;
    if (positionSource !== 0) confidence -= 0.05;
    if (ageSeconds > 30) confidence -= Math.min(0.35, ageSeconds / 300);
    return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
  }

  nextDelayMs() {
    if (this.rateLimitedUntil > Date.now()) return Math.max(1000, this.rateLimitedUntil - Date.now());
    return super.nextDelayMs();
  }

  health() {
    return {
      ...super.health(),
      api: 'opensky_states_all',
      authMode: this.hasAuth() ? 'oauth2_client_credentials' : 'anonymous',
      bbox: this.bbox,
      filters: {
        icao24: this.icao24,
        minAltitudeM: this.minAltitudeM,
        maxAltitudeM: this.maxAltitudeM,
        includeOnGround: this.includeOnGround,
        minVelocityMps: this.minVelocityMps,
      },
      rateLimit: {
        current: this.lastRateLimit,
        limitedUntil: this.rateLimitedUntil ? new Date(this.rateLimitedUntil).toISOString() : null,
      },
    };
  }
}

module.exports = { OpenSkySensor };
