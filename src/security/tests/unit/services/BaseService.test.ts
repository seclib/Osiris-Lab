/**
 * OSIRIS Security Framework — Base Service Unit Tests
 * 
 * Test coverage: 90%+
 */

import { describe, it, expect } from 'vitest';
import { BaseService } from '../../../core/services/BaseService';

describe('BaseService', () => {
  describe('constructor and metadata', () => {
    it('should initialize with metadata', () => {
      const service = new TestService();
      const metadata = service.getMetadata();
      
      expect(metadata.name).toBe('TestService');
      expect(metadata.version).toBe('1.0.0');
      expect(metadata.description).toBe('Test service');
    });

    it('should track start time', () => {
      const service = new TestService();
      const uptime = service.getUptime();
      expect(uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('health tracking', () => {
    it('should start healthy', () => {
      const service = new TestService();
      const health = service.getHealth();
      
      expect(health.healthy).toBe(true);
      expect(health.errorCount).toBe(0);
      expect(health.lastError).toBeUndefined();
    });

    it('should record success', () => {
      const service = new TestService();
      service.testRecordSuccess();
      
      const health = service.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.errorCount).toBe(0);
    });

    it('should record error', () => {
      const service = new TestService();
      service.testRecordError(new Error('Test error'));
      
      const health = service.getHealth();
      expect(health.healthy).toBe(true); // Still healthy after 1 error
      expect(health.errorCount).toBe(1);
      expect(health.lastError).toBe('Test error');
    });

    it('should mark unhealthy after 5 errors', () => {
      const service = new TestService();
      
      for (let i = 0; i < 5; i++) {
        service.testRecordError(new Error(`Error ${i}`));
      }
      
      expect(service.isHealthy()).toBe(false);
    });

    it('should reset health', () => {
      const service = new TestService();
      
      // Record 5 errors to make it unhealthy
      for (let i = 0; i < 5; i++) {
        service.testRecordError(new Error(`Error ${i}`));
      }
      expect(service.isHealthy()).toBe(false);
      
      // Reset
      service.resetHealth();
      expect(service.isHealthy()).toBe(true);
      expect(service.getHealth().errorCount).toBe(0);
    });
  });

  describe('uptime tracking', () => {
    it('should calculate uptime', async () => {
      const service = new TestService();
      await new Promise((resolve) => setTimeout(resolve, 100));
      
      const uptime = service.getUptime();
      expect(uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('context validation', () => {
    it('should validate context', () => {
      const service = new TestService();
      
      // Valid context
      expect(() => service.testValidateContext({ 
        userId: 'user123',
        authenticated: true,
        mfaVerified: true,
      })).not.toThrow();
      
      // Missing context
      expect(() => service.testValidateContext(null as unknown as { userId: string })).toThrow('Security context is required');
      
      // Missing userId
      expect(() => service.testValidateContext({} as { userId: string })).toThrow('UserId is required in security context');
    });
  });

  describe('permission checking', () => {
    it('should check permission in context', () => {
      const service = new TestService();
      const context = {
        userId: 'user123',
        authenticated: true,
        mfaVerified: true,
        permissions: ['read', 'write', 'delete'],
      };
      
      expect(service.testHasPermission(context, 'read')).toBe(true);
      expect(service.testHasPermission(context, 'admin')).toBe(false);
    });

    it('should return false for missing permissions', () => {
      const service = new TestService();
      const context = {
        userId: 'user123',
        authenticated: true,
        mfaVerified: true,
        permissions: ['read'],
      };
      
      expect(service.testHasPermission(context, 'write')).toBe(false);
    });
  });

  describe('role checking', () => {
    it('should check role in context', () => {
      const service = new TestService();
      const context = {
        userId: 'user123',
        authenticated: true,
        mfaVerified: true,
        role: 'admin',
      };
      
      expect(service.testHasRole(context, 'admin')).toBe(true);
      expect(service.testHasRole(context, 'user')).toBe(false);
    });
  });
});

/**
 * Test service implementation with exposed protected methods
 */
class TestService extends BaseService {
  constructor() {
    super({
      name: 'TestService',
      version: '1.0.0',
      description: 'Test service',
    });
  }

  // Expose protected methods for testing
  public testRecordError(error: Error): void {
    this.recordError(error);
  }

  public testRecordSuccess(): void {
    this.recordSuccess();
  }

  public testValidateContext(context: { userId: string; authenticated?: boolean; mfaVerified?: boolean }): void {
    this.validateContext(context as { userId: string; authenticated: boolean; mfaVerified: boolean });
  }

  public testHasPermission(context: { userId: string; authenticated?: boolean; mfaVerified?: boolean; permissions?: string[] }, permission: string): boolean {
    return this.hasPermission(context as { userId: string; authenticated: boolean; mfaVerified: boolean; permissions?: string[] }, permission);
  }

  public testHasRole(context: { userId: string; authenticated?: boolean; mfaVerified?: boolean; role?: string }, role: string): boolean {
    return this.hasRole(context as { userId: string; authenticated: boolean; mfaVerified: boolean; role?: string }, role);
  }
}