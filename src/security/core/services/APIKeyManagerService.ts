/**
 * OSIRIS Security Framework — API Key Manager Service
 * 
 * Service layer pour APIKeyManager.
 * Sépare la logique métier de l'implémentation technique.
 */

import { APIKeyManager, ValidationError } from '../APIKeyManager';
import type { APIKey, CreateAPIKeyRequest } from '../APIKeyManager';
import { BaseService } from './BaseService';
import type { ServiceMetadata } from './BaseService';
import type { SecurityContext } from '../types';

/**
 * API Key Manager Service
 * 
 * Encapsule la logique métier pour la gestion des clés API.
 */
export class APIKeyManagerService extends BaseService {
  private manager: APIKeyManager;

  constructor() {
    const metadata: ServiceMetadata = {
      name: 'APIKeyManagerService',
      version: '1.0.0',
      description: 'API key management service',
    };

    super(metadata);

    this.manager = new APIKeyManager();
  }

  /**
   * Create new API key
   */
  async createKey(request: CreateAPIKeyRequest): Promise<{ key: Omit<APIKey, 'hash'>; plaintextKey: string }> {
    try {
      this.validateCreateRequest(request);
      
      const result = await this.manager.createKey(request);
      
      this.recordSuccess();
      
      // Return key without hash
      const { hash: _, ...keyWithoutHash } = result.key;
      return { key: keyWithoutHash, plaintextKey: result.plaintextKey };
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Validate API key
   */
  async validateKey(plaintextKey: string): Promise<Omit<APIKey, 'hash'> | null> {
    try {
      // Don't validate input here - let the manager handle it
      const key = await this.manager.validateKey(plaintextKey);
      
      if (key) {
        this.recordSuccess();
        const { hash: _, ...keyWithoutHash } = key;
        return keyWithoutHash;
      } else {
        this.recordError(new Error('Invalid API key'));
        return null;
      }
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      return null;
    }
  }

  /**
   * Revoke API key
   */
  async revokeKey(keyId: string, context: SecurityContext): Promise<void> {
    try {
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Key ID is required');
      }

      await this.manager.revokeKey(keyId, context);
      this.recordSuccess();
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Get API key by ID
   */
  getKey(keyId: string): Omit<APIKey, 'hash'> | null {
    try {
      if (!keyId || typeof keyId !== 'string') {
        return null;
      }

      return this.manager.getKey(keyId);
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * List API keys for a user
   */
  listUserKeys(userId: string): Omit<APIKey, 'hash'>[] {
    try {
      if (!userId || typeof userId !== 'string') {
        return [];
      }

      return this.manager.listUserKeys(userId);
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Rotate API key
   */
  async rotateKey(keyId: string, gracePeriod?: number): Promise<{ newKey: Omit<APIKey, 'hash'>; newPlaintextKey: string }> {
    try {
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Key ID is required');
      }

      const result = await this.manager.rotateKey({ keyId, gracePeriod });
      
      this.recordSuccess();
      
      const { hash: _, ...newKeyWithoutHash } = result.newKey;
      return { newKey: newKeyWithoutHash, newPlaintextKey: result.newPlaintextKey };
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Suspend API key
   */
  async suspendKey(keyId: string, context: SecurityContext): Promise<void> {
    try {
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Key ID is required');
      }

      await this.manager.suspendKey(keyId, context);
      this.recordSuccess();
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Reactivate API key
   */
  async reactivateKey(keyId: string, context: SecurityContext): Promise<void> {
    try {
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Key ID is required');
      }

      await this.manager.reactivateKey(keyId, context);
      this.recordSuccess();
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Delete API key
   */
  async deleteKey(keyId: string, context: SecurityContext): Promise<void> {
    try {
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Key ID is required');
      }

      await this.manager.deleteKey(keyId, context);
      this.recordSuccess();
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Get expiring keys
   */
  getExpiringKeys(days: number = 7): Omit<APIKey, 'hash'>[] {
    try {
      if (days < 1 || days > 365) {
        return [];
      }

      return this.manager.getExpiringKeys(days);
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Cleanup expired keys
   */
  cleanupExpiredKeys(): number {
    try {
      return this.manager.cleanupExpiredKeys();
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Validate create request
   */
  private validateCreateRequest(request: CreateAPIKeyRequest): void {
    if (!request) {
      throw new ValidationError('Request is required');
    }

    if (!request.name || typeof request.name !== 'string') {
      throw new ValidationError('Key name is required');
    }

    if (request.name.length < 3) {
      throw new ValidationError('Key name must be at least 3 characters');
    }

    if (request.name.length > 100) {
      throw new ValidationError('Key name must be less than 100 characters');
    }

    if (!request.userId || typeof request.userId !== 'string') {
      throw new ValidationError('UserId is required');
    }

    if (!request.role || typeof request.role !== 'string') {
      throw new ValidationError('Role is required');
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
      if (typeof request.expiresIn !== 'number') {
        throw new ValidationError('expiresIn must be a number');
      }

      if (request.expiresIn < 1) {
        throw new ValidationError('expiresIn must be at least 1 millisecond');
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
   * Validate key input
   */
  private validateKeyInput(plaintextKey: string): void {
    if (!plaintextKey || typeof plaintextKey !== 'string') {
      throw new Error('Plaintext key is required');
    }

    if (plaintextKey.length < 32) {
      throw new Error('Plaintext key is too short');
    }
  }
}
