/**
 * OSIRIS Security Framework — Standardized Error Handling
 * 
 * Centralized error handling with standardized format.
 * All security errors use this system for consistency.
 */

/**
 * Error codes
 */
export enum SecurityErrorCode {
  // Authentication errors
  AUTH_FAILED = 'AUTH_FAILED',
  AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_MISSING = 'AUTH_TOKEN_MISSING',
  AUTH_MFA_REQUIRED = 'AUTH_MFA_REQUIRED',
  AUTH_MFA_FAILED = 'AUTH_MFA_FAILED',
  AUTH_API_KEY_INVALID = 'AUTH_API_KEY_INVALID',
  AUTH_API_KEY_EXPIRED = 'AUTH_API_KEY_EXPIRED',
  AUTH_API_KEY_REVOKED = 'AUTH_API_KEY_REVOKED',
  
  // Authorization errors
  AUTH_PERMISSION_DENIED = 'AUTH_PERMISSION_DENIED',
  AUTH_ROLE_DENIED = 'AUTH_ROLE_DENIED',
  AUTH_CONTEXT_MISSING = 'AUTH_CONTEXT_MISSING',
  
  // Rate limiting errors
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  RATE_LIMIT_CONFIG_INVALID = 'RATE_LIMIT_CONFIG_INVALID',
  
  // Vault errors
  VAULT_ERROR = 'VAULT_ERROR',
  VAULT_CONNECTION_FAILED = 'VAULT_CONNECTION_FAILED',
  VAULT_AUTH_FAILED = 'VAULT_AUTH_FAILED',
  VAULT_SECRET_NOT_FOUND = 'VAULT_SECRET_NOT_FOUND',
  VAULT_CIRCUIT_OPEN = 'VAULT_CIRCUIT_OPEN',
  
  // Validation errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  VALIDATION_INVALID_INPUT = 'VALIDATION_INVALID_INPUT',
  VALIDATION_MISSING_FIELD = 'VALIDATION_MISSING_FIELD',
  
  // Audit errors
  AUDIT_WRITE_FAILED = 'AUDIT_WRITE_FAILED',
  AUDIT_STORAGE_ERROR = 'AUDIT_STORAGE_ERROR',
  
  // Generic errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
}

/**
 * Security error details
 */
export interface SecurityErrorDetails {
  field?: string;
  value?: unknown;
  constraint?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Security error
 * 
 * Standardized error format for all security operations.
 */
export class SecurityError extends Error {
  public readonly code: SecurityErrorCode;
  public readonly details?: SecurityErrorDetails;
  public timestamp: number;
  public readonly requestId?: string;

  constructor(
    code: SecurityErrorCode,
    message: string,
    details?: SecurityErrorDetails,
    requestId?: string
  ) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.details = details;
    this.timestamp = Date.now();
    this.requestId = requestId;

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SecurityError);
    }
  }

  /**
   * Convert to JSON-serializable object
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
      requestId: this.requestId,
      stack: this.stack,
    };
  }

  /**
   * Create from JSON
   */
  static fromJSON(json: Record<string, unknown>): SecurityError {
    const error = new SecurityError(
      json.code as SecurityErrorCode,
      json.message as string,
      json.details as SecurityErrorDetails | undefined,
      json.requestId as string | undefined
    );
    error.timestamp = json.timestamp as number;
    return error;
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends SecurityError {
  constructor(message: string, details?: SecurityErrorDetails, requestId?: string) {
    super(SecurityErrorCode.AUTH_FAILED, message, details, requestId);
    this.name = 'AuthenticationError';
  }
}

/**
 * Authorization error
 */
export class AuthorizationError extends SecurityError {
  constructor(message: string, details?: SecurityErrorDetails, requestId?: string) {
    super(SecurityErrorCode.AUTH_PERMISSION_DENIED, message, details, requestId);
    this.name = 'AuthorizationError';
  }
}

/**
 * Validation error
 */
export class ValidationSecurityError extends SecurityError {
  constructor(message: string, details?: SecurityErrorDetails, requestId?: string) {
    super(SecurityErrorCode.VALIDATION_ERROR, message, details, requestId);
    this.name = 'ValidationSecurityError';
  }
}

/**
 * Vault error
 */
export class VaultSecurityError extends SecurityError {
  constructor(message: string, details?: SecurityErrorDetails, requestId?: string) {
    super(SecurityErrorCode.VAULT_ERROR, message, details, requestId);
    this.name = 'VaultSecurityError';
  }
}

/**
 * Rate limit error
 */
export class RateLimitError extends SecurityError {
  constructor(message: string, details?: SecurityErrorDetails, requestId?: string) {
    super(SecurityErrorCode.RATE_LIMIT_EXCEEDED, message, details, requestId);
    this.name = 'RateLimitError';
  }
}

/**
 * Error factory
 * 
 * Centralized error creation for consistency.
 */
export class SecurityErrorFactory {
  /**
   * Create authentication error
   */
  static authFailed(reason: string, requestId?: string): AuthenticationError {
    return new AuthenticationError(
      `Authentication failed: ${reason}`,
      { metadata: { reason } },
      requestId
    );
  }

  /**
   * Create token expired error
   */
  static tokenExpired(requestId?: string): AuthenticationError {
    return new AuthenticationError(
      'Token has expired',
      { metadata: { expiredAt: Date.now() } },
      requestId
    );
  }

  /**
   * Create token invalid error
   */
  static tokenInvalid(reason: string, requestId?: string): AuthenticationError {
    return new AuthenticationError(
      `Invalid token: ${reason}`,
      { metadata: { reason } },
      requestId
    );
  }

  /**
   * Create MFA required error
   */
  static mfaRequired(requestId?: string): AuthenticationError {
    return new AuthenticationError(
      'Multi-factor authentication required',
      undefined,
      requestId
    );
  }

  /**
   * Create permission denied error
   */
  static permissionDenied(
    permission: string,
    resource?: string,
    requestId?: string
  ): AuthorizationError {
    return new AuthorizationError(
      `Permission denied: ${permission}${resource ? ` on ${resource}` : ''}`,
      { 
        field: permission,
        metadata: { resource } 
      },
      requestId
    );
  }

  /**
   * Create validation error
   */
  static validationError(
    field: string,
    constraint: string,
    value?: unknown,
    requestId?: string
  ): ValidationSecurityError {
    return new ValidationSecurityError(
      `Validation failed for ${field}: ${constraint}`,
      { field, constraint, value },
      requestId
    );
  }

  /**
   * Create vault error
   */
  static vaultError(
    operation: string,
    reason: string,
    requestId?: string
  ): VaultSecurityError {
    return new VaultSecurityError(
      `Vault ${operation} failed: ${reason}`,
      { metadata: { operation, reason } },
      requestId
    );
  }

  /**
   * Create rate limit error
   */
  static rateLimitExceeded(
    limit: number,
    windowMs: number,
    requestId?: string
  ): RateLimitError {
    return new RateLimitError(
      `Rate limit exceeded: ${limit} requests per ${windowMs}ms`,
      { 
        metadata: { 
          limit,
          windowMs,
          retryAfter: Math.ceil(windowMs / 1000) 
        } 
      },
      requestId
    );
  }

  /**
   * Create internal error
   */
  static internalError(
    operation: string,
    originalError: Error,
    requestId?: string
  ): SecurityError {
    return new SecurityError(
      SecurityErrorCode.INTERNAL_ERROR,
      `Internal error during ${operation}: ${originalError.message}`,
      { 
        metadata: { 
          operation,
          originalError: originalError.message 
        } 
      },
      requestId
    );
  }
}

/**
 * Error handler utility
 * 
 * Provides consistent error handling across security services.
 */
export class SecurityErrorHandler {
  /**
   * Handle error and return standardized format
   */
  static handle(error: unknown, operation: string, requestId?: string): SecurityError {
    if (error instanceof SecurityError) {
      return error;
    }

    if (error instanceof Error) {
      return SecurityErrorFactory.internalError(operation, error, requestId);
    }

    return new SecurityError(
      SecurityErrorCode.INTERNAL_ERROR,
      `Unknown error during ${operation}`,
      { metadata: { error: String(error) } },
      requestId
    );
  }

  /**
   * Check if error is a specific type
   */
  static isErrorCode(error: unknown, code: SecurityErrorCode): boolean {
    if (error instanceof SecurityError) {
      return error.code === code;
    }
    return false;
  }

  /**
   * Extract error code from error
   */
  static getErrorCode(error: unknown): SecurityErrorCode | undefined {
    if (error instanceof SecurityError) {
      return error.code;
    }
    return undefined;
  }

  /**
   * Log error with context
   */
  static log(error: SecurityError, context?: Record<string, unknown>): void {
    const logData = {
      ...error.toJSON(),
      context,
    };

    // Use appropriate log level based on error code
    switch (error.code) {
      case SecurityErrorCode.AUTH_FAILED:
      case SecurityErrorCode.AUTH_TOKEN_INVALID:
      case SecurityErrorCode.AUTH_API_KEY_INVALID:
        console.warn('Security warning:', logData);
        break;
      
      case SecurityErrorCode.RATE_LIMIT_EXCEEDED:
        console.info('Rate limit triggered:', logData);
        break;
      
      case SecurityErrorCode.VAULT_ERROR:
      case SecurityErrorCode.INTERNAL_ERROR:
        console.error('Security error:', logData);
        break;
      
      default:
        console.debug('Security event:', logData);
    }
  }
}