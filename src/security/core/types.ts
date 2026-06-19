/**
 * OSIRIS Security Framework — Core Types
 * 
 * Zero Trust architecture types.
 * Toute action est authentifiée, autorisée, auditée.
 */

/**
 * Security event severity
 */
export enum SecurityEventSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * Security event category
 */
export enum SecurityEventCategory {
  AUTHENTICATION = 'authentication',
  AUTHORIZATION = 'authorization',
  DATA_ACCESS = 'data_access',
  DATA_MODIFICATION = 'data_modification',
  CONFIGURATION = 'configuration',
  NETWORK = 'network',
  SYSTEM = 'system',
  COMPLIANCE = 'compliance',
}

/**
 * Resource action type
 */
export type ResourceAction = 'create' | 'read' | 'update' | 'delete' | 'execute' | 'access';

/**
 * Audit log entry
 */
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  action: string;
  actor: {
    userId?: string;
    sessionId?: string;
    ip?: string;
    userAgent?: string;
    role?: string;
  };
  resource: {
    type: string;
    id?: string;
    action: ResourceAction;
  };
  context: {
    category: SecurityEventCategory;
    severity: SecurityEventSeverity;
    reason?: string;
    source: string;
  };
  metadata?: Record<string, unknown>;
  immutable: boolean;
}

/**
 * JWT Token payload
 */
export interface JWTTokenPayload {
  sub: string;
  role: string;
  permissions: string[];
  sessionId: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  jti: string;
}

/**
 * Permission definition
 */
export interface Permission {
  resource: string;
  action: ResourceAction;
  conditions?: PermissionCondition[];
}

/**
 * Permission condition (ABAC)
 */
export interface PermissionCondition {
  field: string;
  operator: 'eq' | 'neq' | 'in' | 'contains' | 'startsWith' | 'gt' | 'lt';
  value: unknown;
}

/**
 * Role definition
 */
export interface RoleDefinition {
  name: string;
  description: string;
  permissions: Permission[];
  parents?: string[];
}

/**
 * Security context for a request
 */
export interface SecurityContext {
  authenticated: boolean;
  userId?: string;
  role?: string;
  permissions?: string[];
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  mfaVerified: boolean;
}

/**
 * Security check result
 */
export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  requiredPermissions?: string[];
  auditEntry?: AuditLogEntry;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
  statusCode?: number;
}

/**
 * Rate limit state
 */
export interface RateLimitState {
  count: number;
  resetTime: number;
}

/**
 * Encryption configuration
 */
export interface EncryptionConfig {
  algorithm: 'aes-256-gcm' | 'aes-256-cbc' | 'chacha20-poly1305';
  keyDerivation: 'pbkdf2' | 'argon2';
  keyRotationDays: number;
}

/**
 * Security headers
 */
export type SecurityHeaders = Record<string, string>;

/**
 * Compliance violation
 */
export interface ComplianceViolation {
  rule: string;
  description: string;
  severity: SecurityEventSeverity;
  timestamp: string;
  actor: string;
  resource: string;
  recommendation: string;
}