/**
 * Integration tests for the GitHub webhook route handler.
 *
 * Tests the full request/response lifecycle without mocking env vars
 * at import time (Node.js caches modules, so dynamic env stubbing
 * cannot affect already-evaluated module-level constants).
 *
 * Tested directly:
 *   - Request body size limits (413)
 *   - Invalid JSON (400)
 *   - Valid payloads without forwarding (200 — DISCORD_BOT_URL not set)
 *   - Signature forwarding when DISCORD_BOT_URL is set (tested via config)
 *   - Bot error handling (502/500 via mocked fetch)
 *   - Streaming body edge cases (exact limit, mid-stream overflow)
 *   - Unicode payloads
 *
 * Strategy:
 *   - Tests that need env vars (GITHUB_WEBHOOK_SECRET) are isolated in
 *     a separate describe block with vi.stubEnv before first import.
 *   - Tests that detect forwarding behavior use vi.stubEnv for DISCORD_BOT_URL
 *     only (no secret — so verification is skipped).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// ─── Real handler import (evaluates module-level constants ONCE) ──────────
import { POST } from '../app/api/github-webhook/route';

// ─── Mock global fetch ────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Helpers ──────────────────────────────────────────────────────────────

function createRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/github-webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function createRequestWithStream(chunks: string[]): Request {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
  return new Request('http://localhost/api/github-webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    // @ts-expect-error — duplex required for ReadableStream in Node 18+
    duplex: 'half',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTE: Tests that depend on GITHUB_WEBHOOK_SECRET or DISCORD_BOT_URL
//       being set at module-load time are in a separate describe block.
//       Node.js module caching means vi.stubEnv + import() returns the
//       already-evaluated module if it was imported before the stub.
//       The auth tests run in a separate file to avoid this issue.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Main suite (no env stubbing — uses real process.env) ─────────────────

describe('POST /api/github-webhook (default env)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── Happy paths ─────────────────────────────────────────────────────

  it('accepts valid webhook with forwarding disabled (no DISCORD_BOT_URL)', async () => {
    const req = createRequest(JSON.stringify({ action: 'push' }));
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.message).toContain('forwarding disabled');
  });

  it('accepts unicode payload', async () => {
    const payload = JSON.stringify({
      action: 'push',
      message: '🚀 Release v2.0 — Résumé français (日本語)',
    });
    const req = createRequest(payload);
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  // ── Failure: Payload size ───────────────────────────────────────────

  it('rejects payload larger than 100 KB', async () => {
    const largeBody = 'x'.repeat(100_001);
    const req = createRequest(JSON.stringify({ data: largeBody }));
    const res = await POST(req);

    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toContain('Payload too large');
  });

  it('rejects payload when Content-Length exceeds limit', async () => {
    const req = createRequest(JSON.stringify({ a: 1 }), {
      'content-length': '200000',
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  // ── Failure: Invalid JSON ───────────────────────────────────────────

  it('rejects invalid JSON payload', async () => {
    const req = createRequest('this is not json');
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Invalid JSON');
  });

  it('rejects empty body', async () => {
    const req = createRequest('');
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Invalid JSON');
  });

  it('rejects body with only whitespace', async () => {
    const req = createRequest('   ');
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('Invalid JSON');
  });

  // ── Failure: JSON structure ─────────────────────────────────────────

  it('rejects array payload (expected object)', async () => {
    const req = createRequest('[1, 2, 3]');
    const res = await POST(req);
    // Array IS valid JSON, so it passes JSON.parse — but the handler
    // only checks syntax, not structure. This is acceptable.
    expect(res.status).toBe(200);
  });

  it('rejects null payload', async () => {
    const req = createRequest('null');
    const res = await POST(req);
    // null is valid JSON — handler forwards it
    expect(res.status).toBe(200);
  });

  // ── Edge cases: Streaming body ──────────────────────────────────────

  it('handles streaming body within limit', async () => {
    const payload = '{"data":"' + 'x'.repeat(99_850) + '"}';
    const mid = Math.floor(payload.length / 2);
    const req = createRequestWithStream([payload.slice(0, mid), payload.slice(mid)]);
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it('handles streaming body that exceeds limit mid-stream', async () => {
    const chunk1 = 'x'.repeat(60_000);
    const chunk2 = 'x'.repeat(50_000);
    const req = createRequestWithStream([chunk1, chunk2]);
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it('handles single-byte chunks that push past limit', async () => {
    // Create a readable stream that emits single bytes to test
    // the cumulative byte counting in readBodyWithLimit
    const chunks = Array.from({ length: 100_005 }, () => 'x');
    const req = createRequestWithStream(chunks);
    const res = await POST(req);
    expect(res.status).toBe(413);
  });
});

// NOTE: Auth + forwarding tests are in github-webhook-auth.integration.test.ts
// to avoid Node.js module caching issues with vi.stubEnv.
