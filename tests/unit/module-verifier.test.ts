import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyModules } from '../../src/lib/module-verifier';

const NOW = new Date('2026-06-10T10:00:00.000Z');

describe('module verifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('marks a reachable module with valid fresh data as OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      commercial_flights: [{ callsign: 'TEST1', lat: 40, lng: -70 }],
      private_flights: [],
      private_jets: [],
      military_flights: [],
      gps_jamming: [],
      total: 1,
      timestamp: NOW.toISOString(),
    }), { status: 200 })));

    const report = await verifyModules({
      baseUrl: 'http://osiris.test',
      moduleId: 'adsb',
      now: NOW,
      retries: 0,
    });

    expect(report.status).toBe('OK');
    expect(report.summary.ok).toBe(1);
    expect(report.alerts).toEqual([]);
    expect(report.checks[0]).toMatchObject({
      moduleId: 'adsb',
      status: 'OK',
      format: { ok: true },
      counts: {
        commercial_flights: 1,
      },
    });
  });

  it('generates stale-data alerts for old module payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      commercial_flights: [],
      private_flights: [],
      private_jets: [],
      military_flights: [],
      gps_jamming: [],
      total: 0,
      timestamp: '2026-06-10T09:50:00.000Z',
    }), { status: 200 })));

    const report = await verifyModules({
      baseUrl: 'http://osiris.test',
      moduleId: 'adsb',
      now: NOW,
      retries: 0,
    });

    expect(report.status).toBe('DEGRADED');
    expect(report.checks[0].freshness).toMatchObject({
      ok: false,
      ageSeconds: 600,
      maxAgeSeconds: 120,
    });
    expect(report.alerts.some((alert) => alert.type === 'data_stale')).toBe(true);
    expect(report.alerts.some((alert) => alert.type === 'empty_data')).toBe(true);
  });

  it('does not call disabled modules unless they are enabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const report = await verifyModules({
      baseUrl: 'http://osiris.test',
      moduleId: 'shodan',
      includeDisabled: true,
      now: NOW,
      retries: 0,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.checks[0]).toMatchObject({
      moduleId: 'shodan',
      status: 'DISABLED',
      enabled: false,
    });
  });
});
