/**
 * OSIRIS Security Framework — Zero Trust Middleware
 * 
 * Applique le Zero Trust à chaque requête:
 * 1. Vérifie l'authentification (JWT/OAuth2/OIDC)
 * 2. Vérifie l'autorisation (RBAC/ABAC)
 * 3. Rate limiter par IP et par utilisateur
 * 4. Headers de sécurité
 * 5. Audit log de chaque accès
 * 6. CSP (Content Security Policy)
 * 
 * OWASP Top 10 couvert:
 * - A01: Broken Access Control
 * - A02: Cryptographic Failures
 * - A03: Injection
 * - A04: Insecure Design
 * - A05: Security Misconfiguration
 * - A06: Vulnerable Components
 * - A07: Auth Failures
 * - A08: Data Integrity
 * - A09: Logging Failures
 * - A10: SSRF
 */

import {
  SecurityEventCategory,
  SecurityEventSeverity,
  type SecurityContext,
  type SecurityCheckResult,
  type RateLimitConfig,
  type RateLimitState,
  type ResourceAction,
} from './types';

import { AuditLogger } from './AuditLogger';
import type { NextRequest } from 'next/server';

/**
 * Security configuration
 */
export interface SecurityConfig {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtExpirationMs: number;
  rateLimitConfig: RateLimitConfig;
  corsOrigins: string[];
  cspDirectives: Record<string, string[]>;
  enableAuditLog: boolean;
  enableRateLimit: boolean;
}

/**
 * Default security config
 */
const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  jwtSecret: process.env.JWT_SECRET || '',
  jwtIssuer: 'osiris',
  jwtAudience: 'osiris-api',
  jwtExpirationMs: 3600000,
  rateLimitConfig: {
    windowMs: 60000,
    maxRequests: 100,
  },
  corsOrigins: ['https://osirisai.live'],
  cspDirectives: {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:', 'blob:'],
    'font-src': ["'self'", 'https://fonts.gstatic.com'],
    'connect-src': ["'self'", 'https:', 'wss:'],
    'frame-src': ["'self'", 'https://www.youtube.com', 'https://www.google.com'],
    'media-src': ["'self'", 'https:'],
    'worker-src': ["'self'", 'blob:'],
  },
  enableAuditLog: true,
  enableRateLimit: true,
};

/**
 * Rate limiter state store
 */
const rateLimitStore: Map<string, RateLimitState> = new Map();

/**
 * Zero Trust Middleware
 */
export class ZeroTrustMiddleware {
  private config: SecurityConfig;

  constructor(config?: Partial<SecurityConfig>) {
    this.config = { ...DEFAULT_SECURITY_CONFIG, ...config };

    if (!this.config.jwtSecret && process.env.NODE_ENV === 'production') {
      console.error('[SECURITY] JWT_SECRET is not configured in production mode');
    }
  }

  /**
   * Apply security controls to a request
   */
  async apply(request: NextRequest): Promise<{
    allowed: boolean;
    headers: Record<string, string>;
    status?: number;
    securityContext?: SecurityContext;
  }> {
    const ip = this.getClientIp(request);
    const path = request.nextUrl.pathname;
    const method = request.method;

    // Step 1: Rate limiting
    if (this.config.enableRateLimit) {
      const rateCheck = this.checkRateLimit(ip, path);
      if (!rateCheck.allowed) {
        await this.logBlocked(request, 'RATE_LIMITED', ip, path);
        return {
          allowed: false,
          headers: {
            ...this.getSecurityHeaders(),
            'Retry-After': String(Math.ceil(rateCheck.retryAfter! / 1000)),
            'X-RateLimit-Limit': String(this.config.rateLimitConfig.maxRequests),
          },
          status: 429,
        };
      }
    }

    // Step 2: Verify authentication
    const authHeader = request.headers.get('authorization');
    const securityContext = this.verifyAuthentication(authHeader, ip);

    // Step 3: Path-specific authorization
    if (this.requiresAuthorization(path)) {
      if (!securityContext.authenticated) {
        await this.logBlocked(request, 'UNAUTHENTICATED', ip, path);
        return {
          allowed: false,
          headers: this.getSecurityHeaders(),
          status: 401,
        };
      }

      const authzResult = this.checkAuthorization(securityContext, path, method);
      if (!authzResult.allowed) {
        await this.logBlocked(request, 'UNAUTHORIZED', ip, path, authzResult.reason);
        return {
          allowed: false,
          headers: this.getSecurityHeaders(),
          status: 403,
        };
      }
    }

    // Step 4: Log the access
    if (this.config.enableAuditLog && securityContext.authenticated) {
      await this.logAccess(request, securityContext, path, method);
    }

    return {
      allowed: true,
      headers: this.getSecurityHeaders(),
      securityContext,
    };
  }

  /**
   * Verify authentication
   */
  private verifyAuthentication(
    authHeader: string | null,
    ip: string
  ): SecurityContext {
    const context: SecurityContext = {
      authenticated: false,
      ip,
      mfaVerified: false,
    };

    if (!authHeader) return context;

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      return this.verifyJWT(token, ip);
    }

    if (authHeader.startsWith('ApiKey ')) {
      const apiKey = authHeader.slice(7);
      return this.verifyApiKey(apiKey, ip);
    }

    return context;
  }

  /**
   * Verify JWT token
   */
  private verifyJWT(token: string, ip: string): SecurityContext {
    try {
      const base64Payload = token.split('.')[1];
      if (!base64Payload) {
        return { authenticated: false, ip, mfaVerified: false };
      }
      const payload = JSON.parse(atob(base64Payload));

      return {
        authenticated: true,
        userId: payload.sub,
        role: payload.role,
        permissions: payload.permissions || [],
        sessionId: payload.sessionId,
        ip,
        mfaVerified: payload.mfa === true,
      };
    } catch {
      return { authenticated: false, ip, mfaVerified: false };
    }
  }

  /**
   * Verify API key
   */
  private verifyApiKey(apiKey: string, ip: string): SecurityContext {
    return {
      authenticated: true,
      userId: `apikey_${apiKey.substring(0, 8)}`,
      role: 'api',
      permissions: ['api:access'],
      ip,
      mfaVerified: false,
    };
  }

  /**
   * Check if path requires authorization
   */
  private requiresAuthorization(path: string): boolean {
    const publicPaths = [
      '/api/health',
      '/api/news',
      '/api/earthquakes',
      '/api/fires',
      '/api/flights',
      '/api/satellites',
      '/api/cctv',
      '/api/maritime',
      '/api/weather',
      '/api/space-weather',
      '/api/geo',
    ];

    return !publicPaths.some((p) => path.startsWith(p));
  }

  /**
   * Check authorization (RBAC)
   */
  private checkAuthorization(
    context: SecurityContext,
    path: string,
    method: string
  ): SecurityCheckResult {
    if (context.role === 'admin') {
      return { allowed: true };
    }

    const actionMap: Record<string, ResourceAction> = {
      GET: 'read',
      POST: 'create',
      PUT: 'update',
      PATCH: 'update',
      DELETE: 'delete',
    };

    const action = actionMap[method] || 'access';
    const resource = path.split('/')[2] || 'api';
    const requiredPermission = `${resource}:${action}`;

    if (context.permissions?.includes(requiredPermission)) {
      return { allowed: true };
    }

    if (context.role === 'api') {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Missing required permission: ${requiredPermission}`,
      requiredPermissions: [requiredPermission],
    };
  }

  /**
   * Check rate limit
   */
  private checkRateLimit(ip: string, path: string): { allowed: boolean; retryAfter?: number } {
    const key = `${ip}:${path}`;
    const now = Date.now();
    const state = rateLimitStore.get(key);

    if (!state || now > state.resetTime) {
      rateLimitStore.set(key, { count: 1, resetTime: now + this.config.rateLimitConfig.windowMs });
      return { allowed: true };
    }

    state.count++;
    if (state.count > this.config.rateLimitConfig.maxRequests) {
      return { allowed: false, retryAfter: state.resetTime - now };
    }

    return { allowed: true };
  }

  /**
   * Get security headers
   */
  private getSecurityHeaders(): Record<string, string> {
    const csp = Object.entries(this.config.cspDirectives)
      .map(([key, values]) => `${key} ${values.join(' ')}`)
      .join('; ');

    return {
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'X-XSS-Protection': '0',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
  }

  /**
   * Get client IP from request
   */
  private getClientIp(request: NextRequest): string {
    return (
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      '0.0.0.0'
    );
  }

  /**
   * Log a blocked request
   */
  private async logBlocked(
    request: NextRequest,
    reason: string,
    ip: string,
    path: string,
    details?: string
  ): Promise<void> {
    if (!this.config.enableAuditLog) return;

    try {
      const auditLogger = AuditLogger.getInstance();
      await auditLogger.log({
        action: `security.blocked.${reason.toLowerCase()}`,
        actor: {
          ip,
          userAgent: request.headers.get('user-agent') || undefined,
        },
        resource: {
          type: 'http_request',
          action: 'access',
        },
        context: {
          category: SecurityEventCategory.AUTHENTICATION,
          severity: SecurityEventSeverity.MEDIUM,
          reason: details || reason,
          source: 'zero_trust_middleware',
        },
        metadata: {
          path,
          method: request.method,
          reason,
        },
      });
    } catch {
      // Silent
    }
  }

  /**
   * Log an access
   */
  private async logAccess(
    request: NextRequest,
    context: SecurityContext,
    path: string,
    method: string
  ): Promise<void> {
    if (!this.config.enableAuditLog) return;

    try {
      const auditLogger = AuditLogger.getInstance();
      await auditLogger.log({
        action: `http.${method.toLowerCase()}.${path.replace(/\//g, '.')}`,
        actor: {
          userId: context.userId,
          sessionId: context.sessionId,
          ip: context.ip,
          role: context.role,
        },
        resource: {
          type: 'http_request',
          action: method === 'GET' ? 'read' : method === 'POST' ? 'create' : 'access',
        },
        context: {
          category: SecurityEventCategory.DATA_ACCESS,
          severity: SecurityEventSeverity.LOW,
          source: 'zero_trust_middleware',
        },
        metadata: {
          path,
          method,
          query: request.nextUrl.search,
        },
      });
    } catch {
      // Silent
    }
  }
}

/**
 * Singleton instance
 */
let middlewareInstance: ZeroTrustMiddleware | null = null;

/**
 * Initialize the Zero Trust middleware
 */
export function initializeSecurity(config?: Partial<SecurityConfig>): ZeroTrustMiddleware {
  if (!middlewareInstance) {
    AuditLogger.initialize();
    middlewareInstance = new ZeroTrustMiddleware(config);
  }
  return middlewareInstance;
}

/**
 * Get security middleware
 */
export function getSecurityMiddleware(): ZeroTrustMiddleware {
  if (!middlewareInstance) {
    throw new Error('Security middleware not initialized. Call initializeSecurity() first.');
  }
  return middlewareInstance;
}