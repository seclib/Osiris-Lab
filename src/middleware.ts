import { NextResponse } from 'next/server';
import type { NextRequest, NextFetchEvent } from 'next/server';

// ─── Configuration ─────────────────────────────────────────────────────────
// All externally configurable via environment variables.
// UMAMI_URL must point to the Umami analytics endpoint (e.g. http://umami:3000/api/send)
// UMAMI_WEBSITE_ID defaults to the OSIRIS dashboard ID.
const UMAMI_URL = process.env.UMAMI_URL || '';
const UMAMI_ENABLED = Boolean(UMAMI_URL && process.env.UMAMI_WEBSITE_ID);
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID || 'cd8f216c-fc3f-45f5-ba1a-e10309a61d18';

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Anonymize an IP address by zeroing the last octet (IPv4) or last 80 bits (IPv6).
 * Preserves privacy while retaining geolocation granularity at /24 subnet level.
 */
function anonymizeIp(ip: string): string {
  if (!ip || ip === 'unknown') return '0.0.0.0';
  if (ip.includes(':')) {
    // IPv6 — keep /48 prefix
    const parts = ip.split(':');
    if (parts.length >= 3) {
      return `${parts[0]}:${parts[1]}:${parts[2]}::`;
    }
    return '::';
  }
  // IPv4 — keep /24 prefix
  return ip.replace(/\.\d+$/, '.0');
}

/**
 * Send a single analytics event to Umami with proper timeout and error handling.
 * Aborts after 2 seconds to never block page rendering.
 */
async function sendAnalyticsEvent(
  url: string,
  basePayload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    await fetch(UMAMI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { ...basePayload, ...overrides },
        type: 'event',
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    // Don't let analytics failures affect the response — log and move on.
    if (err instanceof Error && err.name !== 'AbortError') {
      console.warn('[analytics] send failed:', err.message);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Middleware ─────────────────────────────────────────────────────────────

export function middleware(request: NextRequest, event: NextFetchEvent) {
  const url = request.nextUrl.pathname;

  // ── Build base payload once ──────────────────────────────────────────
  const clientIp = anonymizeIp(
    request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      '0.0.0.0',
  );

  const basePayload = {
    hostname: request.nextUrl.hostname,
    language: request.headers.get('accept-language')?.split(',')[0] || 'en-US',
    referrer: request.headers.get('referer') || '',
    screen: '1920x1080',           // approximated; fine for aggregated analytics
    title: 'OSIRIS',
    url,
    website: UMAMI_WEBSITE_ID,
  };

  // ── Fire analytics in background (never block the response) ─────────
  if (UMAMI_ENABLED) {
    event.waitUntil(
      Promise.all([
        sendAnalyticsEvent(UMAMI_URL, basePayload),
        sendAnalyticsEvent(UMAMI_URL, basePayload, {
          name: 'Page View',
          data: { ip: clientIp },
        }),
      ]),
    );
  }

  // ── Add security headers to every response ──────────────────────────
  const response = NextResponse.next();

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );

  return response;
}

// ─── Matcher ───────────────────────────────────────────────────────────────
// Middleware runs on all navigation paths except static assets, API routes,
// and common non-HTML files.
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};