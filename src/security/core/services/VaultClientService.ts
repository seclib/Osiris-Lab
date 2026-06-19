/**
 * OSIRIS Security Framework — Vault Client Service
 * 
 * Service layer pour VaultClient.
 * Sépare la logique métier de l'implémentation technique.
 */

import { VaultClient } from '../VaultClient';
import type { VaultConfig, VaultSecret } from '../VaultClient';
import { BaseService } from './BaseService';
import type { ServiceMetadata, SecurityContext } from './BaseService';

/**
 * Circuit breaker error
 */
class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Vault Client Service
 * 
 * Encapsule la logique métier pour les opérations Vault.
 */
export class VaultClientService extends BaseService {
  private client: VaultClient;
  private circuitBreaker: {
    failures: number;
    lastFailure: number;
    state: 'closed' | 'open' | 'half-open';
  };

  constructor(config: VaultConfig) {
    const metadata: ServiceMetadata = {
      name: 'VaultClientService',
      version: '1.0.0',
      description: 'HashiCorp Vault client service',
    };

    super(metadata);

    this.client = new VaultClient(config);
    this.circuitBreaker = {
      failures: 0,
      lastFailure: 0,
      state: 'closed',
    };
  }

  /**
   * Read secret from Vault
   */
  async readSecret(path: string): Promise<VaultSecret> {
    try {
      this.validatePath(path);
      
      // Check circuit breaker
      this.checkCircuitBreaker();
      
      const secret = await this.client.getSecret(path);
      
      this.recordSuccess();
      this.resetCircuitBreaker();
      
      return secret;
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      this.recordCircuitBreakerFailure();
      throw error;
    }
  }

  /**
   * Write secret to Vault
   */
  async writeSecret(path: string, data: Record<string, unknown>): Promise<void> {
    try {
      this.validatePath(path);
      this.validateData(data);
      
      // Check circuit breaker
      this.checkCircuitBreaker();
      
      await this.client.writeSecret(path, data);
      
      this.recordSuccess();
      this.resetCircuitBreaker();
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      this.recordCircuitBreakerFailure();
      throw error;
    }
  }

  /**
   * Delete secret from Vault
   */
  async deleteSecret(path: string): Promise<void> {
    try {
      this.validatePath(path);
      
      // Check circuit breaker
      this.checkCircuitBreaker();
      
      await this.client.deleteSecret(path);
      
      this.recordSuccess();
      this.resetCircuitBreaker();
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      this.recordCircuitBreakerFailure();
      throw error;
    }
  }

  /**
   * List secrets at path
   */
  async listSecrets(path: string): Promise<string[]> {
    try {
      this.validatePath(path);
      
      // Check circuit breaker
      this.checkCircuitBreaker();
      
      const secrets = await this.client.listSecrets(path);
      
      this.recordSuccess();
      this.resetCircuitBreaker();
      
      return secrets;
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      this.recordCircuitBreakerFailure();
      throw error;
    }
  }

  /**
   * Check if Vault is healthy
   */
  async isVaultHealthy(): Promise<boolean> {
    try {
      const secret = await this.client.getSecret('health');
      
      if (secret) {
        this.recordSuccess();
        return true;
      } else {
        this.recordError(new Error('Vault health check failed'));
        return false;
      }
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      return false;
    }
  }

  /**
   * Get service health including circuit breaker status
   */
  getServiceHealth(): ServiceMetadata & {
    healthy: boolean;
    circuitBreaker: {
      state: string;
      failures: number;
      lastFailure: number;
    };
  } {
    return {
      ...this.getMetadata(),
      healthy: this.isHealthy(),
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failures: this.circuitBreaker.failures,
        lastFailure: this.circuitBreaker.lastFailure,
      },
    };
  }

  /**
   * Check circuit breaker state
   */
  private checkCircuitBreaker(): void {
    if (this.circuitBreaker.state === 'open') {
      const timeSinceFailure = Date.now() - this.circuitBreaker.lastFailure;
      const cooldownPeriod = 60000; // 1 minute

      if (timeSinceFailure > cooldownPeriod) {
        // Transition to half-open
        this.circuitBreaker.state = 'half-open';
      } else {
        throw new CircuitBreakerError('Circuit breaker is open, Vault is unavailable');
      }
    }
  }

  /**
   * Record circuit breaker failure
   */
  private recordCircuitBreakerFailure(): void {
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();

    if (this.circuitBreaker.failures >= 5) {
      this.circuitBreaker.state = 'open';
    } else if (this.circuitBreaker.state === 'half-open') {
      // Back to open on failure in half-open state
      this.circuitBreaker.state = 'open';
    }
  }

  /**
   * Reset circuit breaker
   */
  private resetCircuitBreaker(): void {
    this.circuitBreaker.failures = 0;
    this.circuitBreaker.state = 'closed';
  }

  /**
   * Validate path
   */
  private validatePath(path: string): void {
    if (!path || typeof path !== 'string') {
      throw new Error('Path is required');
    }

    if (path.length === 0) {
      throw new Error('Path cannot be empty');
    }

    if (path.length > 1000) {
      throw new Error('Path is too long');
    }
  }

  /**
   * Validate data
   */
  private validateData(data: Record<string, unknown>): void {
    if (!data || typeof data !== 'object') {
      throw new Error('Data is required');
    }

    const dataSize = JSON.stringify(data).length;
    if (dataSize > 100000) {
      throw new Error('Data size cannot exceed 100KB');
    }
  }
}