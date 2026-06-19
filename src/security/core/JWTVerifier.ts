/**
 * OSIRIS Security Framework — JWT Verifier
 * 
 * Vérification de tokens JWT avec RS256 (asymmetric).
 * Supporte OAuth2/OIDC.
 * 
 * Zero Trust: Never trust, always verify.
 */

import crypto from 'crypto';
import type { JWTTokenPayload, SecurityContext } from './types';

/**
 * JWT Header
 */
interface JWTHeader {
  alg: string;
  typ?: string;
  kid?: string;
}

/**
 * JWT Verification result
 */
export interface JWTVerificationResult {
  valid: boolean;
  payload?: JWTTokenPayload;
  error?: string;
  securityContext?: SecurityContext;
}

/**
 * JWT Verifier configuration
 */
export interface JWTVerifierConfig {
  issuer: string;
  audience: string;
  publicKey?: string;
  publicKeyPath?: string;
  jwksUri?: string;
  algorithms: string[];
  clockSkewMs: number;
}

/**
 * Default config
 */
const DEFAULT_JWT_CONFIG: JWTVerifierConfig = {
  issuer: process.env.JWT_ISSUER || 'osiris',
  audience: process.env.JWT_AUDIENCE || 'osiris-api',
  algorithms: ['RS256', 'RS384', 'RS512'],
  clockSkewMs: 60000,
};

/**
 * JWT Verifier — RS256 asymmetric verification
 */
export class JWTVerifier {
  private config: JWTVerifierConfig;
  private publicKeyCache: Map<string, { key: string; expiresAt: number }> = new Map();

  constructor(config?: Partial<JWTVerifierConfig>) {
    this.config = { ...DEFAULT_JWT_CONFIG, ...config };
  }

  /**
   * Verify a JWT token
   */
  async verify(token: string): Promise<JWTVerificationResult> {
    try {
      const header = this.decodeBase64Url(token.split('.')[0]) as JWTHeader | null;
      if (!header) {
        return { valid: false, error: 'Invalid token header' };
      }

      const { alg, kid } = header;

      if (!alg || !this.config.algorithms.includes(alg)) {
        return { valid: false, error: `Algorithm ${alg} not allowed` };
      }

      const payloadB64 = token.split('.')[1];
      if (!payloadB64) {
        return { valid: false, error: 'Invalid token format' };
      }

      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as JWTTokenPayload;

      const claimsError = this.verifyClaims(payload);
      if (claimsError) {
        return { valid: false, error: claimsError };
      }

      const signatureValid = await this.verifySignature(token, header, payload);
      if (!signatureValid) {
        return { valid: false, error: 'Invalid signature' };
      }

      const securityContext: SecurityContext = {
        authenticated: true,
        userId: payload.sub,
        role: payload.role,
        permissions: payload.permissions || [],
        sessionId: payload.sessionId,
        mfaVerified: payload.mfa === true,
      };

      return {
        valid: true,
        payload,
        securityContext,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Token verification failed',
      };
    }
  }

  /**
   * Verify standard JWT claims
   */
  private verifyClaims(payload: JWTTokenPayload): string | null {
    const now = Math.floor(Date.now() / 1000);

    if (payload.iss !== this.config.issuer) {
      return `Invalid issuer: ${payload.iss}`;
    }

    if (payload.aud !== this.config.audience) {
      return `Invalid audience: ${payload.aud}`;
    }

    if (payload.exp && payload.exp < now - this.config.clockSkewMs / 1000) {
      return 'Token expired';
    }

    if (payload.nbf && payload.nbf > now + this.config.clockSkewMs / 1000) {
      return 'Token not yet valid';
    }

    if (payload.iat && payload.iat > now + this.config.clockSkewMs / 1000) {
      return 'Token issued in the future';
    }

    if (!payload.sub) {
      return 'Token missing subject (sub)';
    }

    return null;
  }

  /**
   * Verify JWT signature
   */
  private async verifySignature(
    token: string,
    header: JWTHeader,
    payload: JWTTokenPayload
  ): Promise<boolean> {
    const message = `${this.encodeBase64Url(header)}.${this.encodeBase64Url(payload)}`;
    const signature = token.split('.')[2];

    if (!signature) return false;

    if (this.config.publicKey) {
      return this.verifyWithKey(message, signature, this.config.publicKey);
    }

    if (this.config.jwksUri) {
      if (!header.kid) return false;

      const publicKey = await this.getKeyFromJWKS(header.kid);
      if (!publicKey) return false;

      return this.verifyWithKey(message, signature, publicKey);
    }

    return false;
  }

  /**
   * Verify signature with a public key (RS256)
   */
  private verifyWithKey(message: string, signature: string, publicKey: string): boolean {
    try {
      const verify = crypto.createVerify('RSA-SHA256');
      verify.update(message);
      verify.end();

      const publicKeyBuffer = Buffer.from(publicKey, 'utf-8');
      return verify.verify(publicKeyBuffer, Buffer.from(signature, 'base64url'));
    } catch {
      return false;
    }
  }

  /**
   * Get public key from JWKS endpoint
   */
  private async getKeyFromJWKS(keyId: string): Promise<string | null> {
    const cached = this.publicKeyCache.get(keyId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.key;
    }

    try {
      const response = await fetch(this.config.jwksUri!);
      if (!response.ok) return null;

      const jwks = await response.json() as { keys: Array<{ kid: string; kty: string; use: string; n: string; e: string }> };
      const key = jwks.keys.find((k) => k.kid === keyId && k.kty === 'RSA' && k.use === 'sig');

      if (!key) return null;

      const publicKey = this.jwkToPem(key);

      this.publicKeyCache.set(keyId, {
        key: publicKey,
        expiresAt: Date.now() + 3600000,
      });

      return publicKey;
    } catch {
      return null;
    }
  }

  /**
   * Convert JWK to PEM format
   */
  private jwkToPem(jwk: { n: string; e: string }): string {
    const key = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: jwk.n,
        e: jwk.e,
      },
      format: 'jwk',
    });

    return key.export({ type: 'spki', format: 'pem' }).toString();
  }

  /**
   * Decode base64url
   */
  private decodeBase64Url(str: string): Record<string, unknown> | null {
    try {
      return JSON.parse(Buffer.from(str, 'base64url').toString('utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Encode to base64url
   */
  private encodeBase64Url(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<JWTVerifierConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Clear key cache
   */
  clearCache(): void {
    this.publicKeyCache.clear();
  }
}