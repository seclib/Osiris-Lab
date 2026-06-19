/**
 * OSIRIS Security Framework — Barrel Export
 * 
 * Point d'entrée unique pour toute la sécurité.
 * Zero Trust architecture: verify everything, trust nothing, audit all.
 */

// Core Types
export {
  SecurityEventSeverity,
  SecurityEventCategory,
  type SecurityContext,
  type SecurityCheckResult,
  type AuditLogEntry,
  type JWTTokenPayload,
  type Permission,
  type PermissionCondition,
  type RoleDefinition,
  type RateLimitConfig,
  type RateLimitState,
  type EncryptionConfig,
  type SecurityHeaders,
  type ComplianceViolation,
  type ResourceAction,
} from './core/types';

// Audit Logger
export {
  AuditLogger,
  InMemoryAuditLogWriter,
} from './core/AuditLogger';
export type { AuditLogWriter } from './core/AuditLogger';

// Zero Trust Middleware
export {
  ZeroTrustMiddleware,
  initializeSecurity,
  getSecurityMiddleware,
} from './core/ZeroTrustMiddleware';
export type { SecurityConfig } from './core/ZeroTrustMiddleware';