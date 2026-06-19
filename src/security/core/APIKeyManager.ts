/**
 * OSIRIS Security Framework — API Key Management
 * 
 * Création, rotation, révocation des API keys.
 * Stockage sécurisé avec hachage.
 * 
 * Zero Trust: API keys are secrets, never expose them.
 */

import crypto from 'crypto';
import type { SecurityContext } from './types';

/**
 * API Key status
 */
export type APIKeyStatus = 'active' | 'revoked' | 'expired' | 'suspended';

/**
 * API Key
 */
export interface APIKey {
  id: string;
  name: string;
  prefix: string;        // First 8 chars for identification
  hash: string;          // SHA-256 hash (never store plaintext)
  userId: string;
  role: string;
  permissions: string[];
  expiresAt?: number;
  lastUsedAt?: number;
  status: APIKeyStatus;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

/**
 * API Key creation request
 */
export interface CreateAPIKeyRequest {
  name: string;
  userId: string;
  role: string;
  permissions: string[];
  expiresIn?: number;    // milliseconds
  metadata?: Record<string, unknown>;
}

/**
 * API Key rotation request
 */
export interface RotateAPIKeyRequest {
  keyId: string;
  gracePeriod?: number;  // milliseconds
}

/**
 * API Key configuration
 */
export interface APIKeyManagerConfig {
  keyLength: number;
  hashAlgorithm: 'sha256' | 'sha512';
  defaultExpiration: number; // milliseconds
  maxKeysPerUser: number;
  rotationReminderDays: number;
}

/**
 * Default config
 */
const DEFAULT_CONFIG: APIKeyManagerConfig = {
  keyLength: 32,
  hashAlgorithm: 'sha256',
  defaultExpiration: 90 * 24 * 60 * 60 * 1000, // 90 days
  maxKeysPerUser: 10,
  rotationReminderDays: 7,
};

/**
 * Validation error
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * API Key Manager
 * 
 * Gère le cycle de vie complet des API keys.
 * - Création avec hachage sécurisé
 * - Validation sans exposition
 * - Rotation avec période de grâce
 * - Révocation immédiate
 */
export class APIKeyManager {
  private config: APIKeyManagerConfig;
  private keys: Map<string, APIKey> = new Map();           // id -> APIKey
  private userKeys: Map<string, Set<string>> = new Map();  // userId -> Set<keyId>
  private prefixIndex: Map<string, string> = new Map();    // prefix -> keyId

  constructor(config?: Partial<APIKeyManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate creation request
   * @throws {ValidationError} If request is invalid
   */
  private validateCreateRequest(request: CreateAPIKeyRequest): void {
    if (!request.name || typeof request.name !== 'string') {
      throw new ValidationError('Name is required and must be a string');
    }

    if (request.name.length < 3) {
      throw new ValidationError('Name must be at least 3 characters');
    }

    if (request.name.length > 100) {
      throw new ValidationError('Name must be less than 100 characters');
    }

    if (!request.userId || typeof request.userId !== 'string') {
      throw new ValidationError('UserId is required and must be a string');
    }

    if (!request.role || typeof request.role !== 'string') {
      throw new ValidationError('Role is required and must be a string');
    }

    if (!Array.isArray(request.permissions)) {
      throw new ValidationError('Permissions must be an array');
    }

    if (request.permissions.length === 0) {
      throw new ValidationError('Permissions array cannot be empty');
    }

    if (request.permissions.length > 50) {
      throw new ValidationError('Permissions array cannot exceed 50 items');
    }

    if (request.expiresIn !== undefined) {
      if (typeof request.expiresIn !== 'number' || request.expiresIn <= 0) {
        throw new ValidationError('expiresIn must be a positive number (milliseconds)');
      }

      const maxExpiration = 365 * 24 * 60 * 60 * 1000; // 1 year
      if (request.expiresIn > maxExpiration) {
        throw new ValidationError('expiresIn cannot exceed 1 year');
      }
    }

    if (request.metadata !== undefined) {
      if (typeof request.metadata !== 'object' || Array.isArray(request.metadata)) {
        throw new ValidationError('Metadata must be an object');
      }

      const metadataSize = JSON.stringify(request.metadata).length;
      if (metadataSize > 10000) {
        throw new ValidationError('Metadata size cannot exceed 10KB');
      }
    }
  }

  /**
   * Create a new API key
   */
  async createKey(request: CreateAPIKeyRequest): Promise<{ key: APIKey; plaintextKey: string }> {
    // Validate input
    this.validateCreateRequest(request);

    // Check max keys per user
    const userKeyIds = this.userKeys.get(request.userId) || new Set();
    if (userKeyIds.size >= this.config.maxKeysPerUser) {
      throw new Error(`Maximum ${this.config.maxKeysPerUser} keys per user`);
    }

    // Generate secure random key
    const plaintextKey = this.generateKey();
    const hash = await this.hashKey(plaintextKey);
    const prefix = plaintextKey.substring(0, 8);

    // Check prefix uniqueness (retry on collision)
    let attempts = 0;
    while (this.prefixIndex.has(prefix) && attempts < 3) {
      const newKey = this.generateKey();
      const newHash = await this.hashKey(newKey);
      const newPrefix = newKey.substring(0, 8);
      
      if (!this.prefixIndex.has(newPrefix)) {
        return this.createKeyWithData(request, newKey, newHash, newPrefix);
      }
      attempts++;
    }

    if (this.prefixIndex.has(prefix)) {
      throw new Error('Key prefix collision after 3 attempts, try again');
    }

    return this.createKeyWithData(request, plaintextKey, hash, prefix);
  }

  /**
   * Helper to create key with validated data
   */
  private async createKeyWithData(
    request: CreateAPIKeyRequest,
    plaintextKey: string,
    hash: string,
    prefix: string
  ): Promise<{ key: APIKey; plaintextKey: string }> {
    const now = Date.now();
    const key: APIKey = {
      id: this.generateKeyId(),
      name: request.name,
      prefix,
      hash,
      userId: request.userId,
      role: request.role,
      permissions: request.permissions,
      expiresAt: request.expiresIn ? now + request.expiresIn : now + this.config.defaultExpiration,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      metadata: request.metadata || {},
    };

    // Store key
    this.keys.set(key.id, key);
    this.prefixIndex.set(prefix, key.id);

    // Update user index
    if (!this.userKeys.has(request.userId)) {
      this.userKeys.set(request.userId, new Set());
    }
    this.userKeys.get(request.userId)!.add(key.id);

    return { key, plaintextKey };
  }

  /**
   * Validate an API key
   */
  async validateKey(plaintextKey: string): Promise<APIKey | null> {
    if (!plaintextKey || typeof plaintextKey !== 'string') {
      return null;
    }

    if (plaintextKey.length < 32) {
      return null;
    }

    const prefix = plaintextKey.substring(0, 8);
    const keyId = this.prefixIndex.get(prefix);

    if (!keyId) {
      return null;
    }

    const key = this.keys.get(keyId);
    if (!key) {
      return null;
    }

    // Check status
    if (key.status !== 'active') {
      return null;
    }

    // Check expiration
    if (key.expiresAt && Date.now() > key.expiresAt) {
      key.status = 'expired';
      this.keys.set(keyId, key);
      return null;
    }

    // Verify hash
    const hash = await this.hashKey(plaintextKey);
    if (hash !== key.hash) {
      return null;
    }

    // Update last used
    key.lastUsedAt = Date.now();
    this.keys.set(keyId, key);

    return key;
  }

  /**
   * Revoke an API key
   */
  async revokeKey(keyId: string, context: SecurityContext): Promise<void> {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('Invalid keyId');
    }

    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    // Check permissions
    if (context.userId !== key.userId && !context.permissions?.includes('admin:api_keys:revoke')) {
      throw new Error('Unauthorized to revoke this key');
    }

    key.status = 'revoked';
    key.updatedAt = Date.now();
    this.keys.set(keyId, key);
  }

  /**
   * Rotate an API key
   */
  async rotateKey(request: RotateAPIKeyRequest): Promise<{ newKey: APIKey; newPlaintextKey: string }> {
    if (!request.keyId || typeof request.keyId !== 'string') {
      throw new Error('Invalid keyId');
    }

    const oldKey = this.keys.get(request.keyId);
    if (!oldKey) {
      throw new Error('Key not found');
    }

    if (oldKey.status !== 'active') {
      throw new Error('Cannot rotate non-active key');
    }

    // Validate grace period
    if (request.gracePeriod !== undefined) {
      if (typeof request.gracePeriod !== 'number' || request.gracePeriod < 0) {
        throw new Error('Grace period must be a non-negative number');
      }

      const maxGracePeriod = 30 * 24 * 60 * 60 * 1000; // 30 days
      if (request.gracePeriod > maxGracePeriod) {
        throw new Error('Grace period cannot exceed 30 days');
      }
    }

    // Create new key
    const newKeyRequest: CreateAPIKeyRequest = {
      name: `${oldKey.name} (rotated)`,
      userId: oldKey.userId,
      role: oldKey.role,
      permissions: oldKey.permissions,
      expiresIn: oldKey.expiresAt ? oldKey.expiresAt - Date.now() : undefined,
      metadata: { ...oldKey.metadata, rotatedFrom: oldKey.id },
    };

    const { key: newKey, plaintextKey: newPlaintextKey } = await this.createKey(newKeyRequest);

    // Mark old key as revoked (or keep active during grace period)
    if (request.gracePeriod) {
      oldKey.status = 'suspended';
      oldKey.metadata.gracePeriodEnds = Date.now() + request.gracePeriod;
    } else {
      oldKey.status = 'revoked';
    }
    oldKey.updatedAt = Date.now();
    this.keys.set(request.keyId, oldKey);

    return { newKey, newPlaintextKey };
  }

  /**
   * Get API key by ID (without hash)
   */
  getKey(keyId: string): Omit<APIKey, 'hash'> | null {
    if (!keyId || typeof keyId !== 'string') {
      return null;
    }

    const key = this.keys.get(keyId);
    if (!key) return null;

    const { hash: _, ...keyWithoutHash } = key;
    return keyWithoutHash;
  }

  /**
   * List API keys for a user
   */
  listUserKeys(userId: string): Omit<APIKey, 'hash'>[] {
    if (!userId || typeof userId !== 'string') {
      return [];
    }

    const keyIds = this.userKeys.get(userId) || new Set();
    return Array.from(keyIds)
      .map((id) => this.keys.get(id))
      .filter((key): key is APIKey => key !== undefined)
      .map(({ hash: _, ...rest }) => rest);
  }

  /**
   * Suspend an API key
   */
  async suspendKey(keyId: string, context: SecurityContext): Promise<void> {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('Invalid keyId');
    }

    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    if (context.userId !== key.userId && !context.permissions?.includes('admin:api_keys:suspend')) {
      throw new Error('Unauthorized');
    }

    key.status = 'suspended';
    key.updatedAt = Date.now();
    this.keys.set(keyId, key);
  }

  /**
   * Reactivate a suspended key
   */
  async reactivateKey(keyId: string, context: SecurityContext): Promise<void> {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('Invalid keyId');
    }

    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    if (!context.permissions?.includes('admin:api_keys:reactivate')) {
      throw new Error('Unauthorized');
    }

    key.status = 'active';
    key.updatedAt = Date.now();
    this.keys.set(keyId, key);
  }

  /**
   * Delete an API key
   */
  async deleteKey(keyId: string, context: SecurityContext): Promise<void> {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('Invalid keyId');
    }

    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    if (context.userId !== key.userId && !context.permissions?.includes('admin:api_keys:delete')) {
      throw new Error('Unauthorized');
    }

    // Remove from all indexes
    this.keys.delete(keyId);
    this.prefixIndex.delete(key.prefix);
    this.userKeys.get(key.userId)?.delete(keyId);
  }

  /**
   * Get keys expiring soon
   */
  getExpiringKeys(days: number = this.config.rotationReminderDays): Omit<APIKey, 'hash'>[] {
    if (days < 1 || days > 365) {
      return [];
    }

    const threshold = Date.now() + days * 24 * 60 * 60 * 1000;
    return Array.from(this.keys.values())
      .filter((key) => key.status === 'active' && key.expiresAt && key.expiresAt <= threshold)
      .map(({ hash: _, ...rest }) => rest);
  }

  /**
   * Cleanup expired keys
   */
  cleanupExpiredKeys(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [keyId, key] of this.keys) {
      if (key.expiresAt && key.expiresAt < now && key.status === 'active') {
        key.status = 'expired';
        this.keys.set(keyId, key);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Generate secure random key using crypto.getRandomValues()
   */
  private generateKey(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(this.config.keyLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => chars[b % chars.length]).join('');
  }

  /**
   * Generate cryptographically secure key ID
   */
  private generateKeyId(): string {
    const timestamp = Date.now().toString(36);
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    const random = Array.from(randomBytes).map((b) => b.toString(36)).join('');
    return `key_${timestamp}_${random}`;
  }

  /**
   * Hash key (never store plaintext)
   */
  private async hashKey(key: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest(this.config.hashAlgorithm, data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<APIKeyManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get configuration
   */
  getConfig(): APIKeyManagerConfig {
    return { ...this.config };
  }
}