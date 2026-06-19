import { createClient, RedisClientType } from 'redis';
import { Logger } from '../../shared/interfaces';

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  prefix?: string;
}

export class RedisCacheService {
  private client: RedisClientType;
  private logger: Logger;
  private prefix: string;

  constructor(redisUrl: string, logger: Logger, prefix: string = 'notification:') {
    this.logger = logger;
    this.prefix = prefix;
    this.client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
      },
    });

    this.client.on('error', (err) => {
      this.logger.error('Redis client error', { error: err.message });
    });

    this.client.on('connect', () => {
      this.logger.info('Redis client connected');
    });

    this.client.connect().catch((err) => {
      this.logger.error('Failed to connect to Redis', { error: err.message });
    });
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const fullKey = this.getFullKey(key);
      const value = await this.client.get(fullKey);
      
      if (!value) {
        return null;
      }

      return JSON.parse(value) as T;
    } catch (error) {
      this.logger.warn('Cache get failed', { key, error });
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set<T>(key: string, value: T, options: CacheOptions = {}): Promise<void> {
    try {
      const fullKey = this.getFullKey(key);
      const ttl = options.ttl || 3600; // Default 1 hour
      
      await this.client.setEx(fullKey, ttl, JSON.stringify(value));
      
      this.logger.debug('Cache set', { key, ttl });
    } catch (error) {
      this.logger.warn('Cache set failed', { key, error });
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string): Promise<void> {
    try {
      const fullKey = this.getFullKey(key);
      await this.client.del(fullKey);
      
      this.logger.debug('Cache delete', { key });
    } catch (error) {
      this.logger.warn('Cache delete failed', { key, error });
    }
  }

  /**
   * Delete multiple keys by pattern
   */
  async deletePattern(pattern: string): Promise<void> {
    try {
      const fullPattern = this.getFullKey(pattern);
      const keys = await this.client.keys(fullPattern);
      
      if (keys.length > 0) {
        await this.client.del(keys);
        this.logger.debug('Cache delete pattern', { pattern, count: keys.length });
      }
    } catch (error) {
      this.logger.warn('Cache delete pattern failed', { pattern, error });
    }
  }

  /**
   * Get or set pattern (cache-aside)
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.get<T>(key);
    if (cached !== null) {
      this.logger.debug('Cache hit', { key });
      return cached;
    }

    // Cache miss - fetch from source
    this.logger.debug('Cache miss', { key });
    const value = await fetchFn();

    // Store in cache
    await this.set(key, value, options);

    return value;
  }

  /**
   * Invalidate cache for user notifications
   */
  async invalidateUserNotifications(userId: string): Promise<void> {
    await this.deletePattern(`user:${userId}:*`);
  }

  /**
   * Invalidate cache for specific notification
   */
  async invalidateNotification(notificationId: string): Promise<void> {
    await this.delete(`notification:${notificationId}`);
  }

  /**
   * Check if Redis is connected
   */
  async isConnected(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close Redis connection
   */
  async disconnect(): Promise<void> {
    try {
      await this.client.quit();
      this.logger.info('Redis client disconnected');
    } catch (error) {
      this.logger.error('Failed to disconnect Redis', { error });
    }
  }

  /**
   * Get full cache key with prefix
   */
  private getFullKey(key: string): string {
    return `${this.prefix}${key}`;
  }
}