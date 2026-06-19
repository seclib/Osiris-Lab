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

// JWT Verifier
export {
  JWTVerifier,
} from './core/JWTVerifier';
export type {
  JWTVerificationResult,
  JWTVerifierConfig,
} from './core/JWTVerifier';

// OAuth2/OIDC Provider
export {
  OAuth2Provider,
  OAuth2ProviderRegistry,
} from './core/OAuth2Provider';
export type {
  OAuth2ProviderConfig,
  OAuth2TokenResponse,
  OAuth2UserInfo,
} from './core/OAuth2Provider';

// ABAC Evaluator
export {
  ABACEvaluator,
  DefaultAttributeSource,
} from './core/ABACEvaluator';
export type {
  ABACResult,
  AttributeSource,
} from './core/ABACEvaluator';

// Redis Rate Limiter
export {
  RedisRateLimiter,
  InMemoryRedisClient,
} from './core/RedisRateLimiter';
export type {
  RedisRateLimitConfig,
  RateLimitResult,
  IRedisRateLimiter,
  IRedisClient,
  IRedisPipeline,
} from './core/RedisRateLimiter';

// MFA Enforcer
export {
  MFAEnforcer,
} from './core/MFAEnforcer';
export type {
  MFAMethod,
  MFAChallenge,
  MFAConfig,
  MFAVerificationResult,
} from './core/MFAEnforcer';

// PostgreSQL Audit Writer
export {
  PostgresAuditWriter,
} from './core/PostgresAuditWriter';
export type {
  IPostgresClient,
  PostgresAuditWriterConfig,
} from './core/PostgresAuditWriter';

// HashiCorp Vault Client
export {
  VaultClient,
  VaultSecretManager,
} from './core/VaultClient';
export type {
  VaultAuthMethod,
  VaultConfig,
  VaultSecret,
  VaultDynamicSecret,
} from './core/VaultClient';

// API Key Manager
export {
  APIKeyManager,
  ValidationError,
} from './core/APIKeyManager';
export type {
  APIKey,
  APIKeyStatus,
  CreateAPIKeyRequest,
  RotateAPIKeyRequest,
  APIKeyManagerConfig,
} from './core/APIKeyManager';

// Services
export { BaseService } from './core/services/BaseService';
export { JWTVerifierService } from './core/services/JWTVerifierService';
export { APIKeyManagerService } from './core/services/APIKeyManagerService';
export { VaultClientService } from './core/services/VaultClientService';

// Errors
export {
  SecurityError,
  AuthenticationError,
  AuthorizationError,
  ValidationSecurityError,
  VaultSecurityError,
  RateLimitError,
  SecurityErrorFactory,
  SecurityErrorHandler,
  SecurityErrorCode,
} from './core/errors/SecurityError';
export type { SecurityErrorDetails } from './core/errors/SecurityError';
