/**
 * OSIRIS Security Framework — JWT Verifier Service
 * 
 * Service layer pour JWTVerifier.
 * Sépare la logique métier de l'implémentation technique.
 */

import { JWTVerifier } from '../JWTVerifier';
import type { JWTVerificationResult, JWTVerifierConfig } from '../JWTVerifier';
import { BaseService } from './BaseService';
import type { ServiceMetadata } from './BaseService';
import type { SecurityContext } from '../types';

/**
 * JWT Verifier Service
 * 
 * Encapsule la logique métier pour la vérification JWT.
 */
export class JWTVerifierService extends BaseService {
  private verifier: JWTVerifier;

  constructor(config?: Partial<JWTVerifierConfig>) {
    const metadata: ServiceMetadata = {
      name: 'JWTVerifierService',
      version: '1.0.0',
      description: 'JWT token verification service',
    };

    super(metadata);

    this.verifier = new JWTVerifier(config);
  }

  /**
   * Verify JWT token
   */
  async verifyToken(token: string): Promise<JWTVerificationResult> {
    try {
      this.validateInput(token);
      
      const result = await this.verifier.verify(token);
      
      if (result.valid) {
        this.recordSuccess();
      } else {
        this.recordError(new Error(result.error || 'Verification failed'));
      }

      return result;
    } catch (error) {
      this.recordError(error instanceof Error ? error : new Error('Unknown error'));
      throw error;
    }
  }

  /**
   * Verify token and return security context
   */
  async verifyAndGetContext(token: string): Promise<SecurityContext | null> {
    const result = await this.verifyToken(token);
    
    if (result.valid && result.securityContext) {
      return result.securityContext;
    }

    return null;
  }

  /**
   * Check if token is valid
   */
  async isTokenValid(token: string): Promise<boolean> {
    const result = await this.verifyToken(token);
    return result.valid;
  }

  /**
   * Get user ID from token
   */
  async getUserIdFromToken(token: string): Promise<string | null> {
    const context = await this.verifyAndGetContext(token);
    return context?.userId || null;
  }

  /**
   * Get permissions from token
   */
  async getPermissionsFromToken(token: string): Promise<string[]> {
    const context = await this.verifyAndGetContext(token);
    return context?.permissions || [];
  }

  /**
   * Check if token has specific permission
   */
  async hasPermissionFromToken(token: string, permission: string): Promise<boolean> {
    const permissions = await this.getPermissionsFromToken(token);
    return permissions.includes(permission);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<JWTVerifierConfig>): void {
    this.verifier.updateConfig(config);
  }

  /**
   * Clear key cache
   */
  clearCache(): void {
    this.verifier.clearCache();
  }

  /**
   * Validate input
   */
  private validateInput(token: string): void {
    if (!token || typeof token !== 'string') {
      throw new Error('Token is required and must be a string');
    }

    if (token.length === 0) {
      throw new Error('Token cannot be empty');
    }

    if (token.length > 10000) {
      throw new Error('Token is too long');
    }
  }
}