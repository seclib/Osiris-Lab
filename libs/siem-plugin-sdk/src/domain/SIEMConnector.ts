/**
 * OSIRIS-Lab v2 — SIEM Plugin SDK
 * Base class for SIEM connectors
 */

import { Result, ok, err, DomainError } from '../../../../libs/shared/src/domain/Result';

export class SIEMConnectionError extends DomainError {
  readonly _tag = 'SIEMConnectionError';
  constructor(
    readonly siemType: string,
    readonly operation: string,
    readonly reason: string
  ) { super(); }
  get message(): string { return `${this.siemType} ${this.operation} failed: ${this.reason}`; }
}

export class SIEMAuthError extends DomainError {
  readonly _tag = 'SIEMAuthError';
  constructor(readonly siemType: string) { super(); }
  get message(): string { return `${this.siemType} authentication failed`; }
}

export class SIEMRateLimitError extends DomainError {
  readonly _tag = 'SIEMRateLimitError';
  constructor(
    readonly siemType: string,
    readonly retryAfterMs: number
  ) { super(); }
  get message(): string { return `${this.siemType} rate limit exceeded, retry after ${this.retryAfterMs}ms`; }
}

export type SIEMErrors = SIEMConnectionError | SIEMAuthError | SIEMRateLimitError;

export interface PluginContext {
  logger: { info: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void };
  nats: { subscribe: (subject: string, handler: (data: unknown) => Promise<void>) => Promise<void>; publish: (subject: string, data: unknown) => Promise<void> };
  config: Record<string, unknown>;
}

export abstract class BaseSIEMConnector {
  protected initialized = false;
  protected healthy = false;

  abstract get type(): string;
  abstract get name(): string;

  async init(_context: PluginContext): Promise<Result<void, never>> { this.initialized = true; return ok(undefined); }
  abstract sendAlert(alert: unknown, context: PluginContext): Promise<Result<unknown, SIEMErrors>>;
  abstract pollEvents(context: PluginContext): Promise<Result<unknown[], SIEMErrors>>;
  abstract testConnection(context: PluginContext): Promise<Result<boolean, SIEMErrors>>;

  async healthCheck(_context: PluginContext): Promise<Result<{ status: string; latencyMs: number }, never>> {
    return ok({ status: this.healthy ? 'healthy' : 'disconnected', latencyMs: 0 });
  }

  async stop(_context: PluginContext): Promise<void> { this.initialized = false; this.healthy = false; }

  protected async withRetry<T>(fn: () => Promise<T>, attempts = 3, delay = 1000): Promise<T> {
    let lastError: Error | undefined;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) { lastError = e as Error; if (i < attempts - 1) await new Promise(r => setTimeout(r, delay * Math.pow(2, i))); }
    }
    throw lastError;
  }
}