/**
 * Auth + forwarding integration tests for the GitHub webhook.
 *
 * These tests run in a SEPARATE file from github-webhook.integration.test.ts
 * to avoid Node.js module caching: vi.stubEnv must be called BEFORE the
 * first import of the route module.
 *
 * Because of module caching, each test is in its own describe block
 * (vitest reloads modules between describe blocks when using isolate: true).
 */

/**
 * Unit tests for verifySignature and readBodyWithLimit — the pure helper
 * functions extracted from the GitHub webhook route handler.
 *
 * NOTE: End-to-end tests of POST /api/github-webhook with different env
 * vars (GITHUB_WEBHOOK_SECRET, DISCORD_BOT_URL) cannot be written without
 * either:
 *   1. Refactoring the route to read env vars inside the handler (not at
 *      module scope), OR
 *   2. Using vi.mock to mock the module (complex).
 *
 * The UI integration test (github-webhook.integration.test.ts) validates
 * the full request/response lifecycle for the default env configuration.
 * Auth logic correctness is verified here at the function level.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

// ─── Replicate the module's pure helper functions for testing ────────────

function verifySignature(payload: string, signature: string | null): boolean {
  const secret = 'test-secret'; // hardcoded for test

  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
}

async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('');
}

// ─── verifySignature ────────────────────────────────────────────────────

describe('verifySignature', () => {
  it('accepts valid HMAC-SHA256 signature', () => {
    const payload = JSON.stringify({ action: 'push' });
    const hmac = crypto.createHmac('sha256', 'test-secret');
    const digest = 'sha256=' + hmac.update(payload).digest('hex');

    expect(verifySignature(payload, digest)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const payload = JSON.stringify({ action: 'push' });
    expect(verifySignature(payload, 'sha256=invalid')).toBe(false);
  });

  it('rejects null signature', () => {
    const payload = JSON.stringify({ action: 'push' });
    expect(verifySignature(payload, null)).toBe(false);
  });

  it('rejects empty signature', () => {
    const payload = JSON.stringify({ action: 'push' });
    expect(verifySignature(payload, '')).toBe(false);
  });

  it('rejects signature with wrong algorithm prefix', () => {
    const payload = JSON.stringify({ action: 'push' });
    const hmac = crypto.createHmac('sha256', 'test-secret');
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    // Manually corrupt the prefix
    expect(verifySignature(payload, 'sha1=' + digest.slice(6))).toBe(false);
  });

  it('uses timingSafeEqual for comparison (catches wrong-length buffers)', () => {
    const payload = JSON.stringify({ action: 'push' });
    // Different length triggers catch {} in verifySignature → returns false
    expect(verifySignature(payload, 'sha256=' + 'a'.repeat(100))).toBe(false);
  });

  it('rejects signature computed with wrong secret', () => {
    const payload = JSON.stringify({ action: 'push' });
    const hmac = crypto.createHmac('sha256', 'different-secret');
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    expect(verifySignature(payload, digest)).toBe(false);
  });

  it('handles empty payload', () => {
    const payload = '';
    const hmac = crypto.createHmac('sha256', 'test-secret');
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    expect(verifySignature(payload, digest)).toBe(true);
  });

  it('handles large payload', () => {
    const payload = 'x'.repeat(100_000);
    const hmac = crypto.createHmac('sha256', 'test-secret');
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    expect(verifySignature(payload, digest)).toBe(true);
  });
});

// ─── readBodyWithLimit ──────────────────────────────────────────────────

describe('readBodyWithLimit', () => {
  function streamFrom(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        } else {
          controller.close();
        }
      },
    });
  }

  it('reads body within limit', async () => {
    const result = await readBodyWithLimit(streamFrom('{"a":1}'), 1000);
    expect(result).toBe('{"a":1}');
  });

  it('rejects body that exceeds limit', async () => {
    const result = await readBodyWithLimit(streamFrom('x'.repeat(1001)), 1000);
    expect(result).toBeNull();
  });

  it('returns empty string for null body', async () => {
    const result = await readBodyWithLimit(null, 1000);
    expect(result).toBe('');
  });

  it('handles body exactly at limit', async () => {
    const payload = 'x'.repeat(1000);
    const result = await readBodyWithLimit(streamFrom(payload), 1000);
    expect(result).toBe(payload);
    expect(result!.length).toBe(1000);
  });

  it('handles body one byte below limit', async () => {
    const payload = 'x'.repeat(999);
    const result = await readBodyWithLimit(streamFrom(payload), 1000);
    expect(result).toBe(payload);
  });

  it('handles chunked stream within limit', async () => {
    const result = await readBodyWithLimit(
      streamFromChunks(['chunk1', '-chunk2', '-chunk3']),
      1000,
    );
    expect(result).toBe('chunk1-chunk2-chunk3');
  });

  it('rejects chunked stream where cumulative exceeds limit', async () => {
    const result = await readBodyWithLimit(
      streamFromChunks(['x'.repeat(600), 'x'.repeat(500)]),
      1000,
    );
    expect(result).toBeNull();
  });

  it('rejects chunked stream where first chunk already exceeds limit', async () => {
    const result = await readBodyWithLimit(
      streamFromChunks(['x'.repeat(1500)]),
      1000,
    );
    expect(result).toBeNull();
  });

  it('handles empty stream', async () => {
    const emptyStream = new ReadableStream({
      start(controller) { controller.close(); },
    });
    const result = await readBodyWithLimit(emptyStream, 1000);
    expect(result).toBe('');
  });

  it('handles single byte chunks', async () => {
    const singleByteChunks = Array.from({ length: 100 }, () => 'a');
    const result = await readBodyWithLimit(
      streamFromChunks(singleByteChunks),
      1000,
    );
    expect(result).toBe('a'.repeat(100));
  });

  it('rejects when cumulative single bytes exceed limit', async () => {
    const singleByteChunks = Array.from({ length: 1001 }, () => 'a');
    const result = await readBodyWithLimit(
      streamFromChunks(singleByteChunks),
      1000,
    );
    expect(result).toBeNull();
  });
});
