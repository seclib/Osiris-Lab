import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createFixedWindowRateLimiter,
  createSlidingWindowRateLimiter,
} from '../lib/rate-limit';

// ─── Fixed Window Rate Limiter ─────────────────────────────────────────────

describe('createFixedWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows first request and returns remaining', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 10, windowMs: 60_000 });
    const result = limiter.check('key1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.resetIn).toBeGreaterThan(0);
  });

  it('decrements remaining on each request', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 5, windowMs: 60_000 });
    expect(limiter.check('key').remaining).toBe(4);
    expect(limiter.check('key').remaining).toBe(3);
    expect(limiter.check('key').remaining).toBe(2);
    expect(limiter.check('key').remaining).toBe(1);
    expect(limiter.check('key').remaining).toBe(0);
  });

  it('blocks when limit is exceeded', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.check('key').allowed).toBe(true);
    expect(limiter.check('key').allowed).toBe(true);
    const result = limiter.check('key');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('resets after window expires', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 60_000 });
    limiter.check('key');
    limiter.check('key');
    expect(limiter.check('key').allowed).toBe(false);

    vi.advanceTimersByTime(60_001);

    const result = limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('treats different keys independently', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check('alice').allowed).toBe(true);
    expect(limiter.check('alice').allowed).toBe(false);
    expect(limiter.check('bob').allowed).toBe(true);
    expect(limiter.check('bob').allowed).toBe(false);
    expect(limiter.check('charlie').allowed).toBe(true);
  });

  it('supports per-call override of limit', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 100, windowMs: 60_000 });
    // Override to a stricter limit for this call
    const result = limiter.check('key', { limit: 1 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(limiter.check('key', { limit: 1 }).allowed).toBe(false);
  });

  it('supports per-call override of window', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.check('key', { windowMs: 5_000 });
    expect(limiter.check('key', { windowMs: 5_000 }).allowed).toBe(false);

    vi.advanceTimersByTime(5_001);

    expect(limiter.check('key', { windowMs: 5_000 }).allowed).toBe(true);
  });

  it('handles high concurrency without crashing', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1000, windowMs: 60_000 });
    for (let i = 0; i < 1000; i++) {
      const result = limiter.check(`user-${i}`);
      expect(result.allowed).toBe(true);
    }
  });

  it('enforces maxKeys by evicting oldest', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    limiter.check('a');
    limiter.check('b');
    limiter.check('c');
    // 'a' should be evicted when 'd' is added
    limiter.check('d');
    // 'a' is gone, so it should be allowed again
    expect(limiter.check('a').allowed).toBe(true);
  });
});

// ─── Sliding Window Rate Limiter ───────────────────────────────────────────

describe('createSlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows first request', () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 10, windowMs: 60_000 });
    const result = limiter.check('key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('blocks when limit is exceeded', () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.check('key').allowed).toBe(true);
    expect(limiter.check('key').allowed).toBe(true);
    expect(limiter.check('key').allowed).toBe(true);
    expect(limiter.check('key').allowed).toBe(false);
  });

  it('expires old timestamps from the window', () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 2, windowMs: 10_000 });

    // Request at t=0
    expect(limiter.check('key').allowed).toBe(true);

    // Advance 1ms, request at t=1
    vi.advanceTimersByTime(1);
    expect(limiter.check('key').allowed).toBe(true);

    // Both slots used — blocked
    expect(limiter.check('key').allowed).toBe(false);

    // Advance 5,000ms: now at t=5001.
    // Request at t=0 is still within the 10s window (5001 < 10000)
    // Request at t=1 is still within the 10s window (5000 < 10000)
    vi.advanceTimersByTime(4_999);
    expect(limiter.check('key').allowed).toBe(false);

    // Advance another 5,000ms: now at t=10001.
    // Request at t=0: 10001 - 0 = 10001 >= 10000 → expired
    // Request at t=1: 10001 - 1 = 10000 NOT < 10000 → expired
    vi.advanceTimersByTime(5_000);
    expect(limiter.check('key').allowed).toBe(true);
  });

  it('treats different keys independently', () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check('alice').allowed).toBe(true);
    expect(limiter.check('alice').allowed).toBe(false);
    expect(limiter.check('bob').allowed).toBe(true);
  });

  it('handles burst then silence', () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 5, windowMs: 10_000 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('burst').allowed).toBe(true);
    }
    expect(limiter.check('burst').allowed).toBe(false);

    // Advance past the entire window
    vi.advanceTimersByTime(10_001);

    expect(limiter.check('burst').allowed).toBe(true);
  });

  it('handles high concurrency without crashing', () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 1000, windowMs: 60_000 });
    for (let i = 0; i < 1000; i++) {
      const result = limiter.check(`user-${i}`);
      expect(result.allowed).toBe(true);
    }
  });

  it('enforces maxKeys by evicting oldest', () => {
    const limiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    limiter.check('a');
    limiter.check('b');
    limiter.check('c');
    // 'a' should be evicted when 'd' is added
    limiter.check('d');
    // 'a' is gone, so it should be allowed again
    expect(limiter.check('a').allowed).toBe(true);
  });
});