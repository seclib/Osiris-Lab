/**
 * OSIRIS Security Framework — Audit Logger
 * 
 * Enregistre toutes les actions sensibles dans des logs d'audit immutables.
 * Toute action utilisateur ou système critique produit un AuditLogEntry.
 * 
 * Zero Trust principle: Trust nothing, audit everything.
 */

import type {
  AuditLogEntry,
  SecurityEventCategory,
  SecurityEventSeverity,
  SecurityContext,
} from './types';

/**
 * Audit log writer interface
 * Peut être implémentée par PostgreSQL, file system, NATS, etc.
 */
export interface AuditLogWriter {
  write(entry: AuditLogEntry): Promise<void>;
  find(filter: Partial<AuditLogEntry>): Promise<AuditLogEntry[]>;
  count(filter: Partial<AuditLogEntry>): Promise<number>;
}

/**
 * In-memory audit log writer (dev/testing)
 */
export class InMemoryAuditLogWriter implements AuditLogWriter {
  private logs: AuditLogEntry[] = [];

  async write(entry: AuditLogEntry): Promise<void> {
    this.logs.push(entry);
    // Keep max 10000 entries in memory
    if (this.logs.length > 10000) {
      this.logs = this.logs.slice(-5000);
    }
  }

  async find(filter: Partial<AuditLogEntry>): Promise<AuditLogEntry[]> {
    return this.logs.filter((entry) => {
      return Object.entries(filter).every(([key, value]) => {
        const entryKey = key as keyof AuditLogEntry;
        return entry[entryKey] === value;
      });
    });
  }

  async count(filter: Partial<AuditLogEntry>): Promise<number> {
    const results = await this.find(filter);
    return results.length;
  }
}

/**
 * Audit Logger — singleton pattern
 */
export class AuditLogger {
  private static instance: AuditLogger;
  private writer: AuditLogWriter;
  private enabled: boolean = true;

  private constructor(writer: AuditLogWriter) {
    this.writer = writer;
  }

  /**
   * Initialize the audit logger
   */
  static initialize(writer?: AuditLogWriter): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger(writer || new InMemoryAuditLogWriter());
    }
    return AuditLogger.instance;
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      throw new Error('AuditLogger must be initialized before use');
    }
    return AuditLogger.instance;
  }

  /**
   * Log an audit event
   */
  async log(params: {
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
      action: 'create' | 'read' | 'update' | 'delete' | 'execute' | 'access';
    };
    context: {
      category: SecurityEventCategory;
      severity: SecurityEventSeverity;
      reason?: string;
      source: string;
    };
    metadata?: Record<string, unknown>;
  }): Promise<AuditLogEntry> {
    if (!this.enabled) {
      throw new Error('AuditLogger is disabled');
    }

    const entry: AuditLogEntry = {
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      action: params.action,
      actor: {
        userId: params.actor.userId,
        sessionId: params.actor.sessionId,
        ip: params.actor.ip,
        userAgent: params.actor.userAgent,
        role: params.actor.role,
      },
      resource: {
        type: params.resource.type,
        id: params.resource.id,
        action: params.resource.action,
      },
      context: {
        category: params.context.category,
        severity: params.context.severity,
        reason: params.context.reason,
        source: params.context.source,
      },
      metadata: params.metadata,
      immutable: true,
    };

    await this.writer.write(entry);
    return entry;
  }

  /**
   * Quick log for authentication events
   */
  async logAuth(params: {
    userId: string;
    sessionId: string;
    ip?: string;
    success: boolean;
    method: string;
    reason?: string;
  }): Promise<AuditLogEntry> {
    return this.log({
      action: params.success ? 'auth.login.success' : 'auth.login.failed',
      actor: {
        userId: params.userId,
        sessionId: params.sessionId,
        ip: params.ip,
      },
      resource: {
        type: 'authentication',
        action: 'execute',
      },
      context: {
        category: 'authentication' as SecurityEventCategory,
        severity: params.success ? 'low' as SecurityEventSeverity : 'high' as SecurityEventSeverity,
        reason: params.reason,
        source: 'auth',
      },
      metadata: {
        method: params.method,
        success: params.success,
      },
    });
  }

  /**
   * Quick log for authorization events
   */
  async logAuthz(params: {
    userId: string;
    role: string;
    resource: string;
    action: string;
    allowed: boolean;
    requiredPermissions: string[];
    reason?: string;
  }): Promise<AuditLogEntry> {
    return this.log({
      action: params.allowed ? 'authz.access.allowed' : 'authz.access.denied',
      actor: {
        userId: params.userId,
        role: params.role,
      },
      resource: {
        type: params.resource,
        action: 'access' as const,
      },
      context: {
        category: 'authorization' as SecurityEventCategory,
        severity: params.allowed ? 'low' as SecurityEventSeverity : 'medium' as SecurityEventSeverity,
        reason: params.reason,
        source: 'authz',
      },
      metadata: {
        requiredPermissions: params.requiredPermissions,
        allowed: params.allowed,
      },
    });
  }

  /**
   * Quick log for data access events
   */
  async logDataAccess(params: {
    userId: string;
    resourceType: string;
    resourceId: string;
    action: 'create' | 'read' | 'update' | 'delete';
    success: boolean;
    reason?: string;
  }): Promise<AuditLogEntry> {
    return this.log({
      action: `data.${params.action}.${params.success ? 'success' : 'failed'}`,
      actor: {
        userId: params.userId,
      },
      resource: {
        type: params.resourceType,
        id: params.resourceId,
        action: params.action,
      },
      context: {
        category: params.action === 'read' ? 'data_access' as SecurityEventCategory : 'data_modification' as SecurityEventCategory,
        severity: params.success ? 'low' as SecurityEventSeverity : 'medium' as SecurityEventSeverity,
        reason: params.reason,
        source: 'data',
      },
      metadata: {
        success: params.success,
      },
    });
  }

  /**
   * Query audit logs
   */
  async find(filter: Partial<AuditLogEntry>): Promise<AuditLogEntry[]> {
    return this.writer.find(filter);
  }

  /**
   * Count audit logs
   */
  async count(filter: Partial<AuditLogEntry>): Promise<number> {
    return this.writer.count(filter);
  }

  /**
   * Enable or disable auditing
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Generate a unique audit log ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `audit_${timestamp}_${random}`;
  }
}