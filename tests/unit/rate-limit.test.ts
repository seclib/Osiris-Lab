import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixedWindowRateLimiter,
  createSlidingWindowRateLimiter,
} from '../../src/lib/rate-limit';

describe('rate limiters', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fixed-window limiter allows the configured number of requests then blocks', () => {
    vi.useFakeTimers();
    const limiter = createFixedWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      cleanupIntervalMs: 0,
    });

    expect(limiter.check('client-a')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check('client-a')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.check('client-a')).toMatchObject({ allowed: false, remaining: 0 });

    vi.advanceTimersByTime(1_001);
    expect(limiter.check('client-a')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('fixed-window limiter bounds stored keys after cleanup', () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 10,
      windowMs: 60_000,
      cleanupIntervalMs: 0,
      maxKeys: 2,
    });

    expect(limiter.check('client-a').allowed).toBe(true);
    expect(limiter.check('client-b').allowed).toBe(true);
    expect(limiter.check('client-c').allowed).toBe(true);

    expect(limiter.check('client-a').remaining).toBe(9);
  });

  it('sliding-window limiter expires only old timestamps', () => {
    vi.useFakeTimers();
    const limiter = createSlidingWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      cleanupIntervalMs: 0,
    });

    expect(limiter.check('client-a').allowed).toBe(true);
    vi.advanceTimersByTime(500);
    expect(limiter.check('client-a').allowed).toBe(true);
    expect(limiter.check('client-a').allowed).toBe(false);

    vi.advanceTimersByTime(501);
    expect(limiter.check('client-a')).toMatchObject({ allowed: true, remaining: 0 });
  });
});
