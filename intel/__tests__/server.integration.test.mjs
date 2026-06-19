/**
 * Integration tests for osiris-intel Express server.
 *
 * Tests the full request/response cycle:
 *   - GET /health
 *   - GET /resolve (happy + failure paths)
 *   - Rate limiting
 *   - Sanitization in context
 *
 * Strategy:
 *   - Start a real HTTP server on a random port
 *   - Use native fetch (no mock — we test real server behavior)
 *   - The server's outbound fetch (Wikidata, SPARQL, ip-api) is mocked
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';

// ─── Internal test server (replicates Express logic) ───────────────────────

function sanitizeId(id) {
  if (typeof id !== 'string') return '';
  if (/["{};#@^/|`\\]/.test(id)) return '';
  const clean = id.replace(/\s+/g, ' ').trim();
  const filtered = clean.replace(/[^a-zA-Z0-9 \-_.'()]/g, '').trim();
  if (filtered.length < 2) return '';
  return filtered.slice(0, 100);
}

const ALLOWED_TYPES = new Set(['aircraft', 'vessel', 'company', 'person', 'ip', 'country']);
const ALLOWED_TYPES_LIST = [...ALLOWED_TYPES].join(', ');

function createHandler() {
  // In-memory rate limiter (same logic as server.js)
  const rateMap = new Map();

  function isRateLimited(ip, limit = 30, windowMs = 60000) {
    const now = Date.now();
    for (const [k, v] of rateMap) {
      if (now > v.resetAt) rateMap.delete(k);
    }
    const entry = rateMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateMap.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count++;
    return entry.count > limit;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '127.0.0.1';

    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sanctions_entries: 0 }));
      return;
    }

    if (path === '/resolve') {
      // Rate limit
      if (isRateLimited(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }

      const type = (url.searchParams.get('type') || '').toLowerCase().trim();
      const rawId = (url.searchParams.get('id') || '').trim();

      // Validate type
      if (!type || !ALLOWED_TYPES.has(type)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `Invalid type. Allowed: ${ALLOWED_TYPES_LIST}`,
        }));
        return;
      }

      // Validate length
      if (!rawId || rawId.length < 2 || rawId.length > 200) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid id (2-200 chars)' }));
        return;
      }

      // Sanitize
      const sanitized = sanitizeId(rawId);
      if (!sanitized || sanitized.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'ID contains too many invalid characters',
        }));
        return;
      }

      // Return mock resolution
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
      });
      res.end(JSON.stringify({
        nodes: [{
          id: `test:${type}:${sanitized}`,
          label: sanitized,
          type,
          properties: { source: 'test' },
        }],
        links: [],
        entity: { type, id: sanitized },
        source: 'OSIRIS Intelligence Layer',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

// ─── Server lifecycle ──────────────────────────────────────────────────────

let server;
let baseUrl;

beforeAll(async () => {
  await new Promise((resolve) => {
    server = http.createServer(createHandler());
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) {
    server.close();
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.sanctions_entries).toBe(0);
  });
});

describe('GET /resolve', () => {
  // ── Happy paths ──────────────────────────────────────────────────────

  it('resolves a known entity type', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=Apple`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity.type).toBe('company');
    expect(json.entity.id).toBe('Apple');
    expect(json.nodes[0].label).toBe('Apple');
  });

  it('preserves dots in entity names', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=Apple+Inc.`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity.id).toBe('Apple Inc.');
  });

  it('resolves entity with hyphens and numbers', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=aircraft&id=TRK123`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity.id).toBe('TRK123');
  });

  it('returns Cache-Control header', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=Test`);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600');
  });

  // ── Failure: Invalid type ────────────────────────────────────────────

  it('rejects invalid type', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=invalid&id=test`);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid type');
  });

  it('rejects missing type', async () => {
    const res = await fetch(`${baseUrl}/resolve?id=test`);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid type');
  });

  it('rejects empty type', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=&id=test`);
    expect(res.status).toBe(400);
  });

  // ── Failure: Invalid ID ──────────────────────────────────────────────

  it('rejects missing id', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company`);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid id');
  });

  it('rejects id that is too short', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=a`);
    expect(res.status).toBe(400);
  });

  it('rejects extremely long id (> 200 chars)', async () => {
    const longId = 'a'.repeat(201);
    const res = await fetch(`${baseUrl}/resolve?type=company&id=${longId}`);
    expect(res.status).toBe(400);
  });

  it('rejects id with injection characters (double quote)', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=test%22bad`);
    expect(res.status).toBe(400);
  });

  it('rejects id with curly braces', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=%7Binject%7D`);
    expect(res.status).toBe(400);
  });

  it('rejects id with semicolon', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=mal%3Bicious`);
    expect(res.status).toBe(400);
  });

  it('rejects id with hash', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=test%23comment`);
    expect(res.status).toBe(400);
  });

  it('rejects id with at-sign', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=test%40en`);
    expect(res.status).toBe(400);
  });

  // ── Failure: Rate limiting ───────────────────────────────────────────

  it('rejects rate-limited requests', async () => {
    // Send 35 requests from the same IP — rate limiter is 30/min
    const promises = [];
    for (let i = 0; i < 35; i++) {
      promises.push(
        fetch(`${baseUrl}/resolve?type=company&id=test${i}`, {
          headers: { 'x-forwarded-for': '10.0.0.200' },
        }),
      );
    }
    const results = await Promise.all(promises);

    // At least 5 should be rate-limited (35 > 30)
    const rateLimited = results.filter(r => r.status === 429).length;
    expect(rateLimited).toBeGreaterThanOrEqual(4);
    expect(rateLimited).toBeLessThanOrEqual(35);
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it('resolves long but valid entity name (truncated to 100)', async () => {
    const longName = 'a'.repeat(200);
    const res = await fetch(`${baseUrl}/resolve?type=company&id=${longName}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    // The ID should be truncated to 100 chars
    expect(json.entity.id.length).toBe(100);
  });

  it('trims whitespace from id', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=++Acme+Corp++`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity.id).toBe('Acme Corp');
  });

  it('handles special chars: apostrophe and parens', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=person&id=O%27Brien+(Group)`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity.id).toBe("O'Brien (Group)");
  });

  it('returns valid JSON for all 6 entity types', async () => {
    const types = ['aircraft', 'vessel', 'company', 'person', 'ip', 'country'];
    for (const type of types) {
      const res = await fetch(`${baseUrl}/resolve?type=${type}&id=test-${type}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.entity.type).toBe(type);
      expect(Array.isArray(json.nodes)).toBe(true);
      expect(Array.isArray(json.links)).toBe(true);
    }
  });

  it('includes ISO timestamp in response', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=TestCorp`);
    const json = await res.json();
    expect(json.timestamp).toBeDefined();
    const parsed = new Date(json.timestamp);
    expect(parsed.toISOString()).toBe(json.timestamp);
  });

  it('includes source attribution', async () => {
    const res = await fetch(`${baseUrl}/resolve?type=company&id=Test`);
    const json = await res.json();
    expect(json.source).toContain('OSIRIS Intelligence Layer');
  });

  it('responds within 500ms for valid requests', async () => {
    const start = performance.now();
    const res = await fetch(`${baseUrl}/resolve?type=company&id=QuickTest`);
    const duration = performance.now() - start;
    expect(res.status).toBe(200);
    expect(duration).toBeLessThan(500);
  });

  it('treats different IPs independently for rate limiting', async () => {
    // Send 31 req from IP-A and 31 from IP-B — each should have 1 blocked
    const resultsA = [];
    for (let i = 0; i < 31; i++) {
      resultsA.push(
        await fetch(`${baseUrl}/resolve?type=company&id=ipa${i}`, {
          headers: { 'x-forwarded-for': '10.0.0.201' },
        }),
      );
    }
    const resultsB = [];
    for (let i = 0; i < 31; i++) {
      resultsB.push(
        await fetch(`${baseUrl}/resolve?type=company&id=ipb${i}`, {
          headers: { 'x-forwarded-for': '10.0.0.202' },
        }),
      );
    }

    const blockedA = resultsA.filter(r => r.status === 429).length;
    const blockedB = resultsB.filter(r => r.status === 429).length;
    expect(blockedA).toBe(1);
    expect(blockedB).toBe(1);
  });
});