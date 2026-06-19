/**
 * OSIRIS Security Framework — Base Service
 * 
 * Classe de base pour tous les services.
 * Fournit les fonctionnalités communes: logging, metrics, error handling.
 */

import type { SecurityContext } from '../types';

/**
 * Service metadata
 */
export interface ServiceMetadata {
  name: string;
  version: string;
  description: string;
}

/**
 * Service health status
 */
export interface ServiceHealth {
  healthy: boolean;
  lastCheck: number;
  errorCount: number;
  lastError?: string;
}

/**
 * Base Service
 * 
 * Fournit les fonctionnalités de base pour tous les services.
 */
export abstract class BaseService {
  protected metadata: ServiceMetadata;
  protected health: ServiceHealth;
  protected startTime: number;

  constructor(metadata: ServiceMetadata) {
    this.metadata = metadata;
    this.health = {
      healthy: true,
      lastCheck: Date.now(),
      errorCount: 0,
    };
    this.startTime = Date.now();
  }

  /**
   * Get service metadata
   */
  getMetadata(): ServiceMetadata {
    return { ...this.metadata };
  }

  /**
   * Get service health
   */
  getHealth(): ServiceHealth {
    return { ...this.health };
  }

  /**
   * Check if service is healthy
   */
  isHealthy(): boolean {
    return this.health.healthy;
  }

  /**
   * Record error
   */
  protected recordError(error: Error): void {
    this.health.errorCount++;
    this.health.lastError = error.message;
    this.health.lastCheck = Date.now();
    
    // Mark as unhealthy after 5 errors in last minute
    if (this.health.errorCount >= 5) {
      this.health.healthy = false;
    }
  }

  /**
   * Record success
   */
  protected recordSuccess(): void {
    this.health.lastCheck = Date.now();
    this.health.errorCount = 0;
    this.health.healthy = true;
  }

  /**
   * Get uptime in seconds
   */
  getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Validate security context
   */
  protected validateContext(context: SecurityContext): void {
    if (!context) {
      throw new Error('Security context is required');
    }

    if (!context.userId) {
      throw new Error('UserId is required in security context');
    }
  }

  /**
   * Check permission in context
   */
  protected hasPermission(context: SecurityContext, permission: string): boolean {
    return context.permissions?.includes(permission) || false;
  }

  /**
   * Check role in context
   */
  protected hasRole(context: SecurityContext, role: string): boolean {
    return context.role === role;
  }

  /**
   * Reset health status
   */
  resetHealth(): void {
    this.health = {
      healthy: true,
      lastCheck: Date.now(),
      errorCount: 0,
    };
  }
}