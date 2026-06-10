import { lookup } from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIPv4, safeFetch, validateHost } from '../../src/lib/ssrf-guard';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);

describe('ssrf-guard', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts canonical public IPv4 literals and rejects reserved IPv4 literals', async () => {
    await expect(validateHost('8.8.8.8')).resolves.toEqual({
      ok: true,
      resolved: ['8.8.8.8'],
    });

    await expect(validateHost('127.0.0.1')).resolves.toMatchObject({
      ok: false,
      reason: 'IPv4 in reserved range',
    });
    await expect(validateHost('169.254.169.254')).resolves.toMatchObject({
      ok: false,
      reason: 'IPv4 in reserved range',
    });
  });

  it('rejects non-canonical IPv4 parsing forms', () => {
    expect(parseIPv4('2130706433')).toBeNull();
    expect(parseIPv4('0x7f000001')).toBeNull();
    expect(parseIPv4('0177.0.0.1')).toBeNull();
    expect(parseIPv4('127.0.0.1')).toBe('127.0.0.1');
  });

  it('blocks reserved hostname patterns before DNS lookup', async () => {
    await expect(validateHost('localhost')).resolves.toMatchObject({
      ok: false,
      reason: 'hostname matches reserved name pattern',
    });
    await expect(validateHost('metadata.google.internal')).resolves.toMatchObject({
      ok: false,
      reason: 'hostname matches reserved name pattern',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks hostnames that resolve to private or metadata IP ranges', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 as const }] as never);

    await expect(validateHost('internal.example.com')).resolves.toMatchObject({
      ok: false,
      reason: 'hostname resolves to reserved IPv4 10.0.0.5',
    });
  });

  it('allows hostnames only when every DNS answer is public', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
    ] as never);

    await expect(validateHost('example.com')).resolves.toEqual({
      ok: true,
      resolved: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    });
  });

  it('safeFetch follows public redirects but blocks redirects to reserved targets', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 as const }] as never);
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('https://example.com/start')).rejects.toThrow(
      'safeFetch: blocked target',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
