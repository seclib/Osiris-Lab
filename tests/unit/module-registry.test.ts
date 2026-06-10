import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getModuleDefinition,
  normalizeModuleId,
  parseBoolean,
  resolveModule,
} from '../../src/lib/module-registry';

describe('module registry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses common module boolean values', () => {
    expect(parseBoolean('true')).toBe(true);
    expect(parseBoolean('ENABLED')).toBe(true);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('disabled')).toBe(false);
    expect(parseBoolean('maybe')).toBeNull();
  });

  it('normalizes ADS-B aliases to the registry id', () => {
    expect(normalizeModuleId('ADS_B')).toBe('adsb');
    expect(normalizeModuleId('ads-b')).toBe('adsb');
  });

  it('resolves default and JSON module configuration', () => {
    const ais = getModuleDefinition('ais');
    expect(ais).not.toBeNull();
    if (!ais) return;

    expect(resolveModule(ais, null, null, {}).enabled).toBe(true);
    expect(resolveModule(ais, null, null, { ais: { enabled: false } })).toMatchObject({
      enabled: false,
      source: 'json',
      state: 'DISABLED',
    });
  });

  it('uses environment configuration as the startup default', () => {
    const adsb = getModuleDefinition('adsb');
    expect(adsb).not.toBeNull();
    if (!adsb) return;

    vi.stubEnv('ADS_B_MODULE', 'false');

    expect(resolveModule(adsb, null, null, {}).enabled).toBe(false);
    expect(resolveModule(adsb, { enabled: true, updatedAt: 'now' }, null, {})).toMatchObject({
      enabled: true,
      source: 'runtime',
    });
  });

  it('lets environment locks reject runtime overrides', () => {
    const ais = getModuleDefinition('ais');
    expect(ais).not.toBeNull();
    if (!ais) return;

    vi.stubEnv('AIS_MODULE', 'false');
    vi.stubEnv('MODULE_AIS_LOCKED', 'true');

    expect(resolveModule(ais, { enabled: true, updatedAt: 'now' }, null, {})).toMatchObject({
      enabled: false,
      locked: true,
      source: 'env',
    });
  });
});
