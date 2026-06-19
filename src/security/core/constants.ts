/**
 * OSIRIS Security Framework — Constants
 * 
 * Centralise toutes les constantes pour éviter les magic numbers.
 * Single source of truth pour les valeurs de configuration.
 */

/**
 * JWT Constants
 */
export const JWT_CONSTANTS = {
  DEFAULT_ISSUER: 'osiris',
  DEFAULT_AUDIENCE: 'osiris-api',
  DEFAULT_ALGORITHMS: ['RS256', 'RS384', 'RS512'] as const,
  DEFAULT_CLOCK_SKEW_MS: 60000, // 1 minute
  KEY_CACHE_TTL_MS: 3600000, // 1 hour
} as const;

/**
 * Rate Limiter Constants
 */
export const RATE_LIMIT_CONSTANTS = {
  DEFAULT_WINDOW_MS: 60000, // 1 minute
  DEFAULT_MAX_REQUESTS: 100,
  DEFAULT_KEY_PREFIX: 'osiris:ratelimit:',
  DEFAULT_ALGORITHM: 'sliding_window' as const,
  CLEANUP_INTERVAL_MS: 60000, // 1 minute
} as const;

/**
 * MFA Constants
 */
export const MFA_CONSTANTS = {
  CHALLENGE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  MAX_ATTEMPTS: 3,
  DEVICE_TRUST_DURATION_MS: 24 * 60 * 60 * 1000, // 24 hours
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
  RATE_LIMIT_MAX_ATTEMPTS: 10,
  BACKUP_CODE_LENGTH: 10,
  TOTP_PERIOD: 30, // seconds
  TOTP_DIGITS: 6,
  CLEANUP_INTERVAL_MS: 60000, // 1 minute
} as const;

/**
 * API Key Manager Constants
 */
export const API_KEY_CONSTANTS = {
  KEY_LENGTH: 32,
  HASH_ALGORITHM: 'sha256' as const,
  DEFAULT_EXPIRATION_MS: 90 * 24 * 60 * 60 * 1000, // 90 days
  MAX_KEYS_PER_USER: 10,
  ROTATION_REMINDER_DAYS: 7,
  MAX_EXPIRATION_MS: 365 * 24 * 60 * 60 * 1000, // 1 year
  MAX_GRACE_PERIOD_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  MAX_NAME_LENGTH: 100,
  MIN_NAME_LENGTH: 3,
  MAX_PERMISSIONS: 50,
  MAX_METADATA_SIZE_BYTES: 10000,
} as const;

/**
 * Vault Constants
 */
export const VAULT_CONSTANTS = {
  DEFAULT_ADDRESS: 'http://localhost:8200',
  DEFAULT_AUTH_METHOD: 'token' as const,
  DEFAULT_MOUNT_PATH: 'secret',
  DEFAULT_TIMEOUT_MS: 5000,
  DEFAULT_RETRY_ATTEMPTS: 3,
  DEFAULT_RETRY_DELAY_MS: 1000,
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_TIMEOUT_MS: 30000, // 30 seconds
  TOKEN_REFRESH_RATIO: 0.8, // Refresh at 80% of lifetime
  CACHE_TTL_MS: 60000, // 1 minute
} as const;

/**
 * PostgreSQL Audit Writer Constants
 */
export const AUDIT_CONSTANTS = {
  DEFAULT_TABLE_NAME: 'audit_logs',
  DEFAULT_SCHEMA_NAME: 'security',
  DEFAULT_BATCH_SIZE: 100,
  DEFAULT_FLUSH_INTERVAL_MS: 5000, // 5 seconds
  DEFAULT_RETRY_ATTEMPTS: 3,
  DEFAULT_RETRY_DELAY_MS: 1000,
  MAX_BUFFER_SIZE: 10000,
  CLEANUP_INTERVAL_MS: 60000, // 1 minute
} as const;

/**
 * Security Headers Constants
 */
export const SECURITY_HEADERS_CONSTANTS = {
  CONTENT_SECURITY_POLICY: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  X_FRAME_OPTIONS: 'DENY',
  X_CONTENT_TYPE_OPTIONS: 'nosniff',
  X_XSS_PROTECTION: '1; mode=block',
  STRICT_TRANSPORT_SECURITY: 'max-age=31536000; includeSubDomains',
  REFERRER_POLICY: 'strict-origin-when-cross-origin',
} as const;

/**
 * Password Constants
 */
export const PASSWORD_CONSTANTS = {
  MIN_LENGTH: 12,
  MAX_LENGTH: 128,
  REQUIRE_UPPERCASE: true,
  REQUIRE_LOWERCASE: true,
  REQUIRE_NUMBERS: true,
  REQUIRE_SPECIAL_CHARS: true,
  SPECIAL_CHARS: '!@#$%^&*()_+-=[]{}|;:,.<>?',
} as const;

/**
 * Session Constants
 */
export const SESSION_CONSTANTS = {
  DEFAULT_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  REFRESH_THRESHOLD_MS: 60 * 60 * 1000, // 1 hour before expiry
  MAX_CONCURRENT_SESSIONS: 5,
  COOKIE_NAME: 'osiris_session',
  CSRF_TOKEN_LENGTH: 32,
} as const;

/**
 * Encryption Constants
 */
export const ENCRYPTION_CONSTANTS = {
  ALGORITHM: 'aes-256-gcm',
  KEY_LENGTH: 32,
  IV_LENGTH: 16,
  TAG_LENGTH: 16,
  SALT_LENGTH: 32,
  ITERATIONS: 100000,
} as const;

/**
 * Time Constants (in milliseconds)
 */
export const TIME_CONSTANTS = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000,
  YEAR: 365 * 24 * 60 * 60 * 1000,
} as const;

/**
 * HTTP Status Codes
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/**
 * Error Codes
 */
export const ERROR_CODES = {
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_FAILED: 'MFA_FAILED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;