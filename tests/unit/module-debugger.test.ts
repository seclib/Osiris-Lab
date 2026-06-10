import { describe, expect, it } from 'vitest';
import { diagnoseModuleReport } from '../../src/lib/module-debugger';
import type { ModuleVerificationCheck, ModuleVerificationReport } from '../../src/lib/module-verifier';

const GENERATED_AT = '2026-06-10T10:00:00.000Z';

function check(overrides: Partial<ModuleVerificationCheck>): ModuleVerificationCheck {
  return {
    moduleId: 'ais',
    name: 'AIS Maritime Tracking',
    kind: 'maritime',
    enabled: true,
    state: 'ENABLED',
    endpoint: '/api/maritime',
    status: 'OK',
    httpStatus: 200,
    latencyMs: 120,
    attempts: 1,
    format: {
      ok: true,
      expected: [],
      observed: [],
    },
    freshness: {
      ok: true,
      ageSeconds: 30,
      maxAgeSeconds: 180,
    },
    counts: {},
    warnings: [],
    errors: [],
    alerts: [],
    ...overrides,
  };
}

function report(checks: ModuleVerificationCheck[]): ModuleVerificationReport {
  return {
    status: checks.some((item) => item.status === 'OFFLINE') ? 'OFFLINE' : checks.some((item) => item.status === 'DEGRADED') ? 'DEGRADED' : 'OK',
    summary: {
      total: checks.length,
      enabled: checks.filter((item) => item.enabled).length,
      disabled: checks.filter((item) => !item.enabled).length,
      ok: checks.filter((item) => item.status === 'OK').length,
      degraded: checks.filter((item) => item.status === 'DEGRADED').length,
      offline: checks.filter((item) => item.status === 'OFFLINE').length,
      alerts: checks.reduce((sum, item) => sum + item.alerts.length, 0),
      latencyP95Ms: 120,
    },
    checks,
    alerts: checks.flatMap((item) => item.alerts),
    generatedAt: GENERATED_AT,
  };
}

describe('module debugger', () => {
  it('classifies missing AIS upstream configuration as configuration failure', () => {
    const diagnosis = diagnoseModuleReport(report([
      check({
        moduleId: 'ais',
        status: 'DEGRADED',
        errors: ['no_ais_upstream_configured'],
      }),
    ]));

    expect(diagnosis.status).toBe('DEGRADED');
    expect(diagnosis.diagnoses[0]).toMatchObject({
      moduleId: 'ais',
      primaryClassification: 'CONFIGURATION',
      status: 'NEEDS_ATTENTION',
    });
    expect(diagnosis.diagnoses[0].fixActions[0].steps.join(' ')).toContain('AIS_API_KEY');
  });

  it('classifies API unreachable alerts as infrastructure failures', () => {
    const diagnosis = diagnoseModuleReport(report([
      check({
        moduleId: 'adsb',
        name: 'ADS-B Aviation Tracking',
        kind: 'aviation',
        endpoint: '/api/flights',
        status: 'OFFLINE',
        httpStatus: 503,
        errors: ['fetch failed'],
        alerts: [{
          id: 'adsb:api_unreachable:CRITICAL',
          moduleId: 'adsb',
          severity: 'CRITICAL',
          type: 'api_unreachable',
          message: 'ADS-B API is unreachable.',
          action: 'Check Docker DNS and service logs.',
          generatedAt: GENERATED_AT,
        }],
      }),
    ]));

    expect(diagnosis.status).toBe('FAILED');
    expect(diagnosis.diagnoses[0]).toMatchObject({
      primaryClassification: 'INFRASTRUCTURE',
      status: 'FAILED',
      severity: 'CRITICAL',
    });
  });

  it('classifies stale weather payloads as freshness issues', () => {
    const diagnosis = diagnoseModuleReport(report([
      check({
        moduleId: 'weather',
        name: 'Weather Events',
        kind: 'weather',
        endpoint: '/api/weather',
        status: 'DEGRADED',
        freshness: {
          ok: false,
          ageSeconds: 1200,
          maxAgeSeconds: 900,
          reason: 'endpoint_timestamp_stale',
        },
        warnings: ['endpoint_timestamp_stale'],
      }),
    ]));

    expect(diagnosis.diagnoses[0]).toMatchObject({
      moduleId: 'weather',
      primaryClassification: 'FRESHNESS',
      status: 'NEEDS_ATTENTION',
    });
  });

  it('treats disabled Shodan as a disabled module, not an infra outage', () => {
    const diagnosis = diagnoseModuleReport(report([
      check({
        moduleId: 'shodan',
        name: 'Shodan Enrichment',
        kind: 'cyber',
        endpoint: '/api/osint/shodan',
        enabled: false,
        state: 'DISABLED',
        status: 'DISABLED',
      }),
    ]));

    expect(diagnosis.status).toBe('STABLE');
    expect(diagnosis.diagnoses[0]).toMatchObject({
      moduleId: 'shodan',
      primaryClassification: 'DISABLED',
      status: 'DISABLED',
    });
  });
});
