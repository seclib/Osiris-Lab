/**
 * OSIRIS-Lab v2 — Shared Domain Result Pattern
 * 
 * Implements a functional Result<T, E> type for error handling
 * without exceptions in domain layer.
 * 
 * Usage:
 *   const result = User.create(props);
 *   if (result.isErr()) return result;
 *   const user = result.unwrap();
 */

export type Result<T, E extends DomainError = DomainError> = Ok<T, E> | Err<T, E>;

export class Ok<T, E extends DomainError = DomainError> {
  readonly _tag = 'Ok' as const;
  constructor(readonly value: T) {}
  isOk(): this is Ok<T, E> { return true; }
  isErr(): this is Err<T, E> { return false; }
  unwrap(): T { return this.value; }
  unwrapOr(_default: T): T { return this.value; }
  map<U>(fn: (value: T) => U): Result<U, E> {
    return new Ok(fn(this.value));
  }
  mapErr<F extends DomainError>(_fn: (error: E) => F): Result<T, F> {
    return this as unknown as Result<T, F>;
  }
  andThen<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return fn(this.value);
  }
}

export class Err<T, E extends DomainError = DomainError> {
  readonly _tag = 'Err' as const;
  constructor(readonly error: E) {}
  isOk(): this is Ok<T, E> { return false; }
  isErr(): this is Err<T, E> { return true; }
  unwrap(): never { throw new Error(`Cannot unwrap Err: ${this.error.message}`); }
  unwrapOr(defaultValue: T): T { return defaultValue; }
  map<U>(_fn: (value: T) => U): Result<U, E> {
    return this as unknown as Result<U, E>;
  }
  mapErr<F extends DomainError>(fn: (error: E) => F): Result<T, F> {
    return new Err(fn(this.error));
  }
  andThen<U>(_fn: (value: T) => Result<U, E>): Result<U, E> {
    return this as unknown as Result<U, E>;
  }
}

// Factory functions
export const ok = <T, E extends DomainError = never>(value: T): Result<T, E> => new Ok(value);
export const err = <T, E extends DomainError>(error: E): Result<T, E> => new Err(error);

// Domain Error base class
export abstract class DomainError {
  abstract readonly _tag: string;
  abstract readonly message: string;
  readonly timestamp: Date;

  constructor() {
    this.timestamp = new Date();
  }

  toJSON(): Record<string, unknown> {
    return {
      _tag: this._tag,
      message: this.message,
      timestamp: this.timestamp.toISOString(),
    };
  }
}

// Common Domain Errors
export class NotFoundError extends DomainError {
  readonly _tag = 'NotFoundError';
  constructor(
    readonly entityType: string,
    readonly id: string
  ) {
    super();
  }
  get message(): string { return `${this.entityType} not found: ${this.id}`; }
}

export class ValidationError extends DomainError {
  readonly _tag = 'ValidationError';
  constructor(
    readonly entityType: string,
    readonly reason: string,
    readonly details?: Record<string, unknown>
  ) {
    super();
  }
  get message(): string { return `Validation failed for ${this.entityType}: ${this.reason}`; }
}

export class ConflictError extends DomainError {
  readonly _tag = 'ConflictError';
  constructor(
    readonly entityType: string,
    readonly reason: string
  ) {
    super();
  }
  get message(): string { return `Conflict on ${this.entityType}: ${this.reason}`; }
}

export class UnauthorizedError extends DomainError {
  readonly _tag = 'UnauthorizedError';
  constructor(
    readonly action: string,
    readonly reason?: string
  ) {
    super();
  }
  get message(): string { return `Unauthorized: ${this.action}${this.reason ? ` (${this.reason})` : ''}`; }
}

export class InfrastructureError extends DomainError {
  readonly _tag = 'InfrastructureError';
  constructor(
    readonly component: string,
    readonly operation: string,
    readonly cause?: Error
  ) {
    super();
  }
  get message(): string { 
    return `Infrastructure error in ${this.component}.${this.operation}${this.cause ? `: ${this.cause.message}` : ''}`; 
  }
}