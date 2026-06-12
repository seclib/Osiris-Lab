'use strict';

const { BaseSensor } = require('../../base-sensor');
const { stableId, toNumber } = require('../../event-schema');

const DEFAULT_API_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const OFFICIAL_SOURCES = new Set([
  'LANDSAT_NRT',
  'MODIS_NRT',
  'MODIS_SP',
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA20_SP',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
  'VIIRS_SNPP_SP',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === ',' && !quoted) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      continue;
    }

    field += char;
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value !== '')) rows.push(row);
  }

  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] === undefined ? '' : values[index].trim();
    });
    return record;
  });
}

function retryAfterMs(response) {
  const retryAfter = response.headers.get('retry-after');
  const numeric = Number(retryAfter);
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
  const date = Date.parse(retryAfter || '');
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function normalizeArea(value) {
  const area = String(value || 'world').trim();
  if (area === 'world') return area;
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(area)) {
    throw new Error('invalid_firms_area');
  }
  const [west, south, east, north] = area.split(',').map(Number);
  if (west < -180 || east > 180 || west >= east) throw new Error('invalid_firms_area_longitude');
  if (south < -90 || north > 90 || south >= north) throw new Error('invalid_firms_area_latitude');
  return area;
}

function confidenceNumber(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const numeric = toNumber(raw);
  if (numeric !== null) return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric));
  if (raw === 'h' || raw === 'high') return 0.9;
  if (raw === 'n' || raw === 'nominal' || raw === 'medium') return 0.72;
  if (raw === 'l' || raw === 'low') return 0.45;
  return 0.7;
}

function acquisitionTimestamp(row, fallbackIso) {
  if (row.acq_datetime) {
    const parsed = Date.parse(row.acq_datetime);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }

  const date = String(row.acq_date || '').trim();
  const time = String(row.acq_time || '').trim().padStart(4, '0');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}$/.test(time)) {
    return `${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`;
  }

  return fallbackIso;
}

class FirmsSensor extends BaseSensor {
  constructor(options = {}) {
    super({
      ...options,
      id: options.id || 'nasa-firms',
      type: 'environmental_fire_event',
      source: options.source || 'nasa-firms',
    });

    this.apiBase = options.apiBase || DEFAULT_API_BASE;
    this.mapKey = options.mapKey || '';
    this.firmsSource = String(options.firmsSource || 'VIIRS_SNPP_NRT').trim().toUpperCase();
    this.area = normalizeArea(options.area || 'world');
    const parsedDayRange = Number(options.dayRange || 1);
    this.dayRange = Number.isFinite(parsedDayRange) ? Math.max(1, Math.min(5, parsedDayRange)) : 1;
    this.date = options.date || '';
    this.minConfidence = toNumber(options.minConfidence);
    this.minFrp = toNumber(options.minFrp);
    this.retryCount = Number.isFinite(Number(options.retryCount)) ? Number(options.retryCount) : 2;
    this.retryBaseMs = Number.isFinite(Number(options.retryBaseMs)) ? Number(options.retryBaseMs) : 1000;
    this.retryMaxMs = Number.isFinite(Number(options.retryMaxMs)) ? Number(options.retryMaxMs) : 60000;
    this.minRequestSpacingMs = Number.isFinite(Number(options.minRequestSpacingMs)) ? Number(options.minRequestSpacingMs) : 5000;
    this.nextAllowedAt = 0;
    this.rateLimitedUntil = 0;
  }

  validateConfiguration() {
    super.validateConfiguration();
    if (!this.mapKey) throw new Error('firms_map_key_required');
    if (!OFFICIAL_SOURCES.has(this.firmsSource)) throw new Error(`invalid_firms_source:${this.firmsSource}`);
  }

  async collect() {
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      const error = new Error('firms_rate_limited');
      error.retryAfterMs = this.rateLimitedUntil - now;
      throw error;
    }

    const startedAt = Date.now();
    const csv = await this.fetchCsv();
    const rows = parseCsv(csv);
    const fallbackIso = new Date().toISOString();
    const records = [];

    for (const [index, row] of rows.slice(0, this.maxBatchSize).entries()) {
      try {
        const record = this.rowToRecord(row, fallbackIso);
        if (!record) continue;
        records.push({
          ...record,
          payload: {
            ...record.payload,
            api_latency_ms: Date.now() - startedAt,
          },
        });
      } catch (error) {
        this.stats.rejected += 1;
        this.log('warn', 'firms_row_rejected', {
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return records;
  }

  async fetchCsv() {
    let lastError = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      await this.waitForSpacing();
      try {
        const response = await fetch(this.buildUrl(), {
          method: 'GET',
          cache: 'no-store',
          headers: {
            accept: 'text/csv,*/*',
            'user-agent': 'OSIRIS-FIRMS-Sensor/0.1',
          },
        });

        if (response.status === 429) {
          const waitMs = retryAfterMs(response) || this.retryMaxMs;
          this.rateLimitedUntil = Date.now() + waitMs;
          const error = new Error('firms_rate_limited');
          error.status = 429;
          error.retryAfterMs = waitMs;
          throw error;
        }

        if (!response.ok) {
          const error = new Error(`firms_http_${response.status}`);
          error.status = response.status;
          if (response.status < 500 || attempt === this.retryCount) throw error;
          lastError = error;
          await sleep(Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** attempt)));
          continue;
        }

        return await response.text();
      } catch (error) {
        lastError = error;
        if (error.status === 429 || attempt === this.retryCount) break;
        await sleep(Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** attempt)));
      }
    }

    throw lastError || new Error('firms_request_failed');
  }

  buildUrl() {
    const segments = [
      this.apiBase.replace(/\/$/, ''),
      encodeURIComponent(this.mapKey),
      encodeURIComponent(this.firmsSource),
      this.area,
      String(this.dayRange),
    ];
    if (this.date) segments.push(encodeURIComponent(this.date));
    return segments.join('/');
  }

  rowToRecord(row, fallbackIso) {
    const lat = toNumber(row.latitude);
    const lon = toNumber(row.longitude);
    if (lat === null || lon === null) throw new Error('missing_fire_coordinates');

    const timestamp = acquisitionTimestamp(row, fallbackIso);
    const detectionConfidence = confidenceNumber(row.confidence);
    const frp = toNumber(row.frp);
    const brightness = toNumber(row.brightness ?? row.bright_ti4);
    const secondaryBrightness = toNumber(row.bright_t31 ?? row.bright_ti5);

    if (this.minConfidence !== null && detectionConfidence < this.minConfidence) return null;
    if (this.minFrp !== null && (frp === null || frp < this.minFrp)) return null;

    const satellite = String(row.satellite || '').trim();
    const instrument = String(row.instrument || '').trim();
    const rawId = stableId([this.firmsSource, lat, lon, timestamp, satellite, instrument, frp, brightness]);
    const intensity = frp ?? brightness ?? secondaryBrightness;

    return {
      id: `firms:${rawId}`,
      type: 'environmental_fire_event',
      source: 'nasa-firms',
      timestamp,
      geo: { lat, lon },
      confidence: detectionConfidence,
      payload: {
        latitude: lat,
        longitude: lon,
        intensity,
        frp_mw: frp,
        brightness,
        secondary_brightness: secondaryBrightness,
        detection_confidence: row.confidence,
        detection_confidence_score: detectionConfidence,
        scan: toNumber(row.scan),
        track: toNumber(row.track),
        satellite,
        instrument,
        source: this.firmsSource,
        version: row.version || '',
        daynight: row.daynight || '',
        fire_type: row.type || '',
        acq_date: row.acq_date || '',
        acq_time: row.acq_time || '',
      },
      metadata: {
        sensor_id: this.id,
        raw_id: rawId,
        feed: 'firms_area_csv',
        firms_source: this.firmsSource,
        area: this.area,
      },
    };
  }

  async waitForSpacing() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minRequestSpacingMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  nextDelayMs() {
    if (this.rateLimitedUntil > Date.now()) return Math.max(1000, this.rateLimitedUntil - Date.now());
    return super.nextDelayMs();
  }

  health() {
    return {
      ...super.health(),
      api: 'nasa_firms_area_csv',
      firmsSource: this.firmsSource,
      area: this.area,
      dayRange: this.dayRange,
      date: this.date || null,
      filters: {
        minConfidence: this.minConfidence,
        minFrp: this.minFrp,
      },
      rateLimit: {
        limitedUntil: this.rateLimitedUntil ? new Date(this.rateLimitedUntil).toISOString() : null,
      },
    };
  }
}

module.exports = {
  FirmsSensor,
  parseCsv,
};
