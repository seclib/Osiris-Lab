interface FixedWindowEntry {
  count: number;
  resetAt: number;
}

interface SlidingWindowEntry {
  timestamps: number[];
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  cleanupIntervalMs?: number;
  maxKeys?: number;
}

interface RateLimitOverride {
  limit?: number;
  windowMs?: number;
}

function startCleanup(cleanup: () => void, cleanupIntervalMs: number): void {
  if (cleanupIntervalMs <= 0) return;

  const timer = setInterval(cleanup, cleanupIntervalMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
}

function pruneMap<T>(
  entries: Map<string, T>,
  isExpired: (entry: T, now: number) => boolean,
  maxKeys: number,
): void {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (isExpired(entry, now)) entries.delete(key);
  }

  while (entries.size > maxKeys) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
}

export function createFixedWindowRateLimiter(options: RateLimiterOptions) {
  const {
    limit,
    windowMs,
    cleanupIntervalMs = 120_000,
    maxKeys = 10_000,
  } = options;
  const entries = new Map<string, FixedWindowEntry>();

  const cleanup = () => {
    pruneMap(entries, (entry, now) => now > entry.resetAt, maxKeys);
  };

  startCleanup(cleanup, cleanupIntervalMs);

  return {
    check(key: string, override: RateLimitOverride = {}): RateLimitResult {
      const activeLimit = override.limit ?? limit;
      const activeWindowMs = override.windowMs ?? windowMs;
      const now = Date.now();
      let entry = entries.get(key);

      if (!entry || now > entry.resetAt) {
        entry = { count: 1, resetAt: now + activeWindowMs };
        entries.set(key, entry);
        cleanup();
        return { allowed: true, remaining: Math.max(activeLimit - 1, 0), resetIn: activeWindowMs };
      }

      if (entry.count >= activeLimit) {
        return { allowed: false, remaining: 0, resetIn: Math.max(entry.resetAt - now, 0) };
      }

      entry.count += 1;
      return {
        allowed: true,
        remaining: Math.max(activeLimit - entry.count, 0),
        resetIn: Math.max(entry.resetAt - now, 0),
      };
    },
  };
}

export function createSlidingWindowRateLimiter(options: RateLimiterOptions) {
  const {
    limit,
    windowMs,
    cleanupIntervalMs = 120_000,
    maxKeys = 10_000,
  } = options;
  const entries = new Map<string, SlidingWindowEntry>();

  const cleanup = () => {
    pruneMap(
      entries,
      (entry, now) => entry.timestamps.every((timestamp) => now - timestamp >= windowMs),
      maxKeys,
    );
  };

  startCleanup(cleanup, cleanupIntervalMs);

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      let entry = entries.get(key);

      if (!entry) {
        entry = { timestamps: [] };
        entries.set(key, entry);
      }

      entry.timestamps = entry.timestamps.filter((timestamp) => now - timestamp < windowMs);

      if (entry.timestamps.length >= limit) {
        const resetIn = Math.max(entry.timestamps[0] + windowMs - now, 0);
        return { allowed: false, remaining: 0, resetIn };
      }

      entry.timestamps.push(now);
      cleanup();

      return {
        allowed: true,
        remaining: Math.max(limit - entry.timestamps.length, 0),
        resetIn: windowMs,
      };
    },
  };
}

const sharedFixedWindowLimiter = createFixedWindowRateLimiter({
  limit: 20,
  windowMs: 60_000,
});

export function isRateLimited(key: string, limit = 20, windowMs = 60_000): boolean {
  return !sharedFixedWindowLimiter.check(key, { limit, windowMs }).allowed;
}
