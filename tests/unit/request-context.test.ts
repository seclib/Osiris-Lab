import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClientIp } from '../../src/lib/request-context';

describe('getClientIp', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the first x-forwarded-for address when proxy headers are trusted', () => {
    const request = new Request('https://osiris.test/api', {
      headers: {
        'x-forwarded-for': '203.0.113.10, 10.0.0.5',
        'x-real-ip': '198.51.100.44',
      },
    });

    expect(getClientIp(request)).toBe('203.0.113.10');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const request = new Request('https://osiris.test/api', {
      headers: { 'x-real-ip': '198.51.100.44' },
    });

    expect(getClientIp(request)).toBe('198.51.100.44');
  });

  it('returns the caller-supplied fallback when no identity headers are present', () => {
    const request = new Request('https://osiris.test/api');

    expect(getClientIp(request, '127.0.0.1')).toBe('127.0.0.1');
  });

  it('ignores spoofable proxy headers when TRUST_PROXY_HEADERS=false', () => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'false');
    const request = new Request('https://osiris.test/api', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });

    expect(getClientIp(request, 'unknown-client')).toBe('unknown-client');
  });
});
