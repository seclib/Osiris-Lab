/**
 * OSIRIS Security Framework — Redis Rate Limiter
 * 
 * Rate limiting distribué via Redis.
 * Remplace le store en mémoire pour les environnements multi-instances.
 * 
 * Algorithms: Sliding Window + Token Bucket
 */

/**
 * Rate limit configuration
 */
export interface RedisRateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  algorithm: 'sliding_window' | 'token_bucket';
  bucketCapacity?: number;
  refillRate?: number;
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

/**
 * Default config
 */
const DEFAULT_CONFIG: RedisRateLimitConfig = {
  windowMs: 60000,
  maxRequests: 100,
  keyPrefix: 'osiris:ratelimit:',
  algorithm: 'sliding_window',
};

/**
 * Redis Rate Limiter Interface
 */
export interface IRedisRateLimiter {
  checkLimit(key: string): Promise<RateLimitResult>;
  resetLimit(key: string): Promise<void>;
  getRemaining(key: string): Promise<number>;
}

/**
 * In-memory Redis client interface (for testing)
 */
export interface IRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number; PX?: number }): Promise<string>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
  pipeline(): IRedisPipeline;
}

/**
 * Redis pipeline interface
 */
export interface IRedisPipeline {
  get(key: string): IRedisPipeline;
  set(key: string, value: string, options?: { EX?: number; PX?: number }): IRedisPipeline;
  incr(key: string): IRedisPipeline;
  expire(key: string, seconds: number): IRedisPipeline;
  exec(): Promise<Array<[string, string]>>;
}

/**
 * In-Memory Redis Client (for testing/development)
 */
export class InMemoryRedisClient implements IRedisClient {
  private store: Map<string, { value: string; expiry?: number }> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval to prevent memory leak
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Every minute
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    
    if (entry.expiry && Date.now() > entry.expiry) {
      this.store.delete(key);
      return null;
    }
    
    return entry.value;
  }

  async set(key: string, value: string, options?: { EX?: number; PX?: number }): Promise<string> {
    const expiry = options?.EX 
      ? Date.now() + options.EX * 1000 
      : options?.PX 
        ? Date.now() + options.PX 
        : undefined;
    
    this.store.set(key, { value, expiry });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    const current = entry ? parseInt(entry.value, 10) : 0;
    const newValue = current + 1;
    this.store.set(key, { value: newValue.toString(), expiry: entry?.expiry });
    return newValue;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    
    entry.expiry = Date.now() + seconds * 1000;
    this.store.set(key, entry);
    return 1;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  pipeline(): IRedisPipeline {
    return new InMemoryRedisPipeline(this);
  }

  /**
   * Cleanup expired entries to prevent memory leak
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.store) {
      if (entry.expiry && now > entry.expiry) {
        this.store.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[RedisRateLimiter] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Get store size (for monitoring)
   */
  getStoreSize(): number {
    return this.store.size;
  }

  /**
   * Graceful shutdown
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

/**
 * In-Memory Redis Pipeline
 */
class InMemoryRedisPipeline implements IRedisPipeline {
  private commands: Array<{ command: string; args: unknown[] }> = [];
  private client: InMemoryRedisClient;

  constructor(client: InMemoryRedisClient) {
    this.client = client;
  }

  get(key: string): IRedisPipeline {
    this.commands.push({ command: 'get', args: [key] });
    return this;
  }

  set(key: string, value: string, options?: { EX?: number; PX?: number }): IRedisPipeline {
    this.commands.push({ command: 'set', args: [key, value, options] });
    return this;
  }

  incr(key: string): IRedisPipeline {
    this.commands.push({ command: 'incr', args: [key] });
    return this;
  }

  expire(key: string, seconds: number): IRedisPipeline {
    this.commands.push({ command: 'expire', args: [key, seconds] });
    return this;
  }

  async exec(): Promise<Array<[string, string]>> {
    const results: Array<[string, string]> = [];
    
    for (const cmd of this.commands) {
      switch (cmd.command) {
        case 'get': {
          const value = await this.client.get(cmd.args[0] as string);
          results.push(['OK', value || '']);
          break;
        }
        case 'set': {
          const [key, value, options] = cmd.args as [string, string, { EX?: number; PX?: number } | undefined];
          await this.client.set(key, value, options);
          results.push(['OK', 'OK']);
          break;
        }
        case 'incr': {
          const value = await this.client.incr(cmd.args[0] as string);
          results.push(['OK', value.toString()]);
          break;
        }
        case 'expire': {
          const [key, seconds] = cmd.args as [string, number];
          const result = await this.client.expire(key, seconds);
          results.push(['OK', result.toString()]);
          break;
        }
      }
    }
    
    this.commands = [];
    return results;
  }
}

/**
 * Redis Rate Limiter Implementation
 */
export class RedisRateLimiter implements IRedisRateLimiter {
  private config: RedisRateLimitConfig;
  private redis: IRedisClient;

  constructor(config?: Partial<RedisRateLimitConfig>, redis?: IRedisClient) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.redis = redis || new InMemoryRedisClient();
  }

  /**
   * Check if request is allowed
   */
  async checkLimit(key: string): Promise<RateLimitResult> {
    const fullKey = `${this.config.keyPrefix}${key}`;

    if (this.config.algorithm === 'sliding_window') {
      return this.checkSlidingWindow(fullKey);
    } else {
      return this.checkTokenBucket(fullKey);
    }
  }

  /**
   * Reset rate limit for a key
   */
  async resetLimit(key: string): Promise<void> {
    const fullKey = `${this.config.keyPrefix}${key}`;
    await this.redis.del(fullKey);
  }

  /**
   * Get remaining requests
   */
  async getRemaining(key: string): Promise<number> {
    const fullKey = `${this.config.keyPrefix}${key}`;
    const count = await this.redis.get(fullKey);
    const current = count ? parseInt(count, 10) : 0;
    return Math.max(0, this.config.maxRequests - current);
  }

  /**
   * Sliding Window Algorithm
   */
  private async checkSlidingWindow(fullKey: string): Promise<RateLimitResult> {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.config.windowMs);
    const prevWindow = currentWindow - 1;
    
    const windowKey = `${fullKey}:${currentWindow}`;
    const prevWindowKey = `${fullKey}:${prevWindow}`;

    const pipeline = this.redis.pipeline();
    pipeline.get(windowKey);
    pipeline.get(prevWindowKey);
    pipeline.incr(windowKey);
    pipeline.expire(windowKey, Math.ceil(this.config.windowMs / 1000));

    const results = await pipeline.exec();
    
    const currentCount = results[0][1] ? parseInt(results[0][1] as string, 10) : 0;
    const prevCount = results[1][1] ? parseInt(results[1][1] as string, 10) : 0;
    const newCount = results[2][1] ? parseInt(results[2][1] as string, 10) : 1;

    const windowProgress = (now % this.config.windowMs) / this.config.windowMs;
    const weightedCount = prevCount * (1 - windowProgress) + newCount;

    const allowed = weightedCount <= this.config.maxRequests;
    const remaining = Math.max(0, this.config.maxRequests - Math.ceil(weightedCount));
    const resetTime = now + this.config.windowMs - (now % this.config.windowMs);

    return {
      allowed,
      remaining,
      resetTime,
      retryAfter: allowed ? undefined : Math.ceil((resetTime - now) / 1000),
    };
  }

  /**
   * Token Bucket Algorithm
   */
  private async checkTokenBucket(fullKey: string): Promise<RateLimitResult> {
    const capacity = this.config.bucketCapacity || this.config.maxRequests;
    const refillRate = this.config.refillRate || capacity / (this.config.windowMs / 1000);
    const now = Date.now();

    const bucketKey = `${fullKey}:bucket`;
    const timestampKey = `${fullKey}:timestamp`;

    const [tokensStr, timestampStr] = await Promise.all([
      this.redis.get(bucketKey),
      this.redis.get(timestampKey),
    ]);

    let tokens = tokensStr ? parseFloat(tokensStr) : capacity;
    const lastTimestamp = timestampStr ? parseInt(timestampStr, 10) : now;

    const timeElapsed = (now - lastTimestamp) / 1000;
    const tokensToAdd = timeElapsed * refillRate;
    tokens = Math.min(capacity, tokens + tokensToAdd);

    const allowed = tokens >= 1;
    
    if (allowed) {
      tokens -= 1;
    }

    const pipeline = this.redis.pipeline();
    pipeline.set(bucketKey, tokens.toString());
    pipeline.set(timestampKey, now.toString());
    pipeline.expire(bucketKey, Math.ceil(capacity / refillRate));
    pipeline.expire(timestampKey, Math.ceil(capacity / refillRate));
    await pipeline.exec();

    const remaining = Math.floor(tokens);
    const resetTime = now + Math.ceil((capacity - tokens) / refillRate) * 1000;

    return {
      allowed,
      remaining,
      resetTime,
      retryAfter: allowed ? undefined : Math.ceil((1 - tokens) / refillRate),
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RedisRateLimitConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get Redis client (for cleanup/shutdown)
   */
  getRedisClient(): IRedisClient {
    return this.redis;
  }
}