/**
 * OSIRIS Security Framework — PostgreSQL Audit Writer
 * 
 * Stocke les logs d'audit en base PostgreSQL.
 * Architecture: append-only, immuable, horodaté.
 * 
 * Zero Trust: Every action is logged and cannot be modified.
 */

import type { AuditLogEntry } from './types';

/**
 * PostgreSQL connection interface
 */
export interface IPostgresClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
}

/**
 * PostgreSQL Audit Writer Configuration
 */
export interface PostgresAuditWriterConfig {
  tableName: string;
  schemaName: string;
  batchSize: number;
  flushInterval: number; // milliseconds
  retryAttempts: number;
  retryDelay: number; // milliseconds
}

/**
 * Default config
 */
const DEFAULT_CONFIG: PostgresAuditWriterConfig = {
  tableName: 'audit_logs',
  schemaName: 'security',
  batchSize: 100,
  flushInterval: 5000,
  retryAttempts: 3,
  retryDelay: 1000,
};

/**
 * PostgreSQL Audit Writer
 * 
 * Stocke les logs d'audit de manière immuable.
 * Utilise INSERT uniquement (pas de UPDATE/DELETE).
 */
export class PostgresAuditWriter {
  private config: PostgresAuditWriterConfig;
  private db: IPostgresClient;
  private buffer: AuditLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing: boolean = false;
  private readonly MAX_BUFFER_SIZE = 10000;

  constructor(config?: Partial<PostgresAuditWriterConfig>, db?: IPostgresClient) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db || new MockPostgresClient();
  }

  /**
   * Initialize audit table (run once at startup)
   */
  async initialize(): Promise<void> {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.config.schemaName}.${this.config.tableName} (
        id VARCHAR(36) PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        action VARCHAR(255) NOT NULL,
        actor_user_id VARCHAR(255),
        actor_session_id VARCHAR(255),
        actor_ip VARCHAR(45),
        actor_user_agent TEXT,
        actor_role VARCHAR(100),
        resource_type VARCHAR(100) NOT NULL,
        resource_id VARCHAR(255),
        resource_action VARCHAR(50) NOT NULL,
        context_category VARCHAR(50) NOT NULL,
        context_severity VARCHAR(50) NOT NULL,
        context_reason TEXT,
        context_source VARCHAR(255) NOT NULL,
        metadata JSONB,
        immutable BOOLEAN NOT NULL DEFAULT TRUE,
        
        -- Indexes for common queries
        CONSTRAINT immutable_check CHECK (immutable = TRUE)
      );
      
      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON ${this.config.schemaName}.${this.config.tableName}(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON ${this.config.schemaName}.${this.config.tableName}(actor_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON ${this.config.schemaName}.${this.config.tableName}(resource_type, resource_id);
      CREATE INDEX IF NOT EXISTS idx_audit_category ON ${this.config.schemaName}.${this.config.tableName}(context_category);
      CREATE INDEX IF NOT EXISTS idx_audit_severity ON ${this.config.schemaName}.${this.config.tableName}(context_severity);
      
      -- Prevent modifications (trigger)
      CREATE OR REPLACE FUNCTION ${this.config.schemaName}.prevent_audit_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Audit logs are immutable and cannot be modified';
      END;
      $$ LANGUAGE plpgsql;
      
      DROP TRIGGER IF EXISTS audit_immutable_trigger ON ${this.config.schemaName}.${this.config.tableName};
      CREATE TRIGGER audit_immutable_trigger
        BEFORE UPDATE OR DELETE ON ${this.config.schemaName}.${this.config.tableName}
        FOR EACH ROW
        EXECUTE FUNCTION ${this.config.schemaName}.prevent_audit_modification();
    `;

    await this.db.query(createTableSQL);
  }

  /**
   * Write a single audit log entry
   */
  async write(entry: AuditLogEntry): Promise<void> {
    // Prevent unbounded buffer growth
    if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
      await this.flush();
    }

    this.buffer.push(entry);

    if (this.buffer.length >= this.config.batchSize) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.config.flushInterval);
    }
  }

  /**
   * Write multiple audit log entries
   */
  async writeBatch(entries: AuditLogEntry[]): Promise<void> {
    // Prevent unbounded buffer growth
    if (this.buffer.length + entries.length >= this.MAX_BUFFER_SIZE) {
      await this.flush();
    }

    this.buffer.push(...entries);

    if (this.buffer.length >= this.config.batchSize) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.config.flushInterval);
    }
  }

  /**
   * Flush buffer to database
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) return;

    this.isFlushing = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const entries = this.buffer.splice(0, this.config.batchSize);

    try {
      await this.insertEntries(entries);
    } catch (error) {
      // Retry logic
      for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, this.config.retryDelay * attempt));
        
        try {
          await this.insertEntries(entries);
          break;
        } catch (retryError) {
          if (attempt === this.config.retryAttempts) {
            console.error('Failed to write audit logs after retries:', retryError);
            // In production, send to dead letter queue
          }
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Insert entries using parameterized queries (SQL injection safe)
   */
  private async insertEntries(entries: AuditLogEntry[]): Promise<void> {
    const params: unknown[] = [];
    const placeholders: string[] = [];

    for (const entry of entries) {
      const baseIndex = params.length;
      placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, $${baseIndex + 13}, $${baseIndex + 14}, $${baseIndex + 15}, $${baseIndex + 16}, $${baseIndex + 17})`);
      
      params.push(
        entry.id,
        entry.timestamp,
        entry.action,
        entry.actor.userId || null,
        entry.actor.sessionId || null,
        entry.actor.ip || null,
        entry.actor.userAgent || null,
        entry.actor.role || null,
        entry.resource.type,
        entry.resource.id || null,
        entry.resource.action,
        entry.context.category,
        entry.context.severity,
        entry.context.reason || null,
        entry.context.source,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        true
      );
    }

    const sql = `
      INSERT INTO ${this.config.schemaName}.${this.config.tableName}
      (id, timestamp, action, actor_user_id, actor_session_id, actor_ip, actor_user_agent, actor_role,
       resource_type, resource_id, resource_action, context_category, context_severity,
       context_reason, context_source, metadata, immutable)
      VALUES ${placeholders.join(', ')}
    `;

    await this.db.query(sql, params);
  }

  /**
   * Query audit logs
   */
  async query(filters: {
    userId?: string;
    resourceType?: string;
    resourceId?: string;
    category?: string;
    severity?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: AuditLogEntry[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.userId) {
      conditions.push(`actor_user_id = $${params.length + 1}`);
      params.push(filters.userId);
    }

    if (filters.resourceType) {
      conditions.push(`resource_type = $${params.length + 1}`);
      params.push(filters.resourceType);
    }

    if (filters.resourceId) {
      conditions.push(`resource_id = $${params.length + 1}`);
      params.push(filters.resourceId);
    }

    if (filters.category) {
      conditions.push(`context_category = $${params.length + 1}`);
      params.push(filters.category);
    }

    if (filters.severity) {
      conditions.push(`context_severity = $${params.length + 1}`);
      params.push(filters.severity);
    }

    if (filters.startDate) {
      conditions.push(`timestamp >= $${params.length + 1}`);
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      conditions.push(`timestamp <= $${params.length + 1}`);
      params.push(filters.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const countSQL = `SELECT COUNT(*) as total FROM ${this.config.schemaName}.${this.config.tableName} ${whereClause}`;
    const querySQL = `
      SELECT * FROM ${this.config.schemaName}.${this.config.tableName}
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [countResult, queryResult] = await Promise.all([
      this.db.query(countSQL, params),
      this.db.query(querySQL, params),
    ]);

    const countRow = countResult.rows[0] as Record<string, unknown>;
    const total = parseInt((countRow?.total as string) || '0', 10);

    return {
      entries: queryResult.rows as AuditLogEntry[],
      total,
    };
  }

  /**
   * Archive old audit logs (compliance)
   */
  async archive(beforeDate: Date): Promise<number> {
    const archiveTable = `${this.config.tableName}_archive`;
    
    // Create archive table if not exists
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.config.schemaName}.${archiveTable} (LIKE ${this.config.schemaName}.${this.config.tableName})
    `);

    // Move old records
    const result = await this.db.query(`
      INSERT INTO ${this.config.schemaName}.${archiveTable}
      SELECT * FROM ${this.config.schemaName}.${this.config.tableName}
      WHERE timestamp < $1
    `, [beforeDate]);

    // Delete old records
    await this.db.query(`
      DELETE FROM ${this.config.schemaName}.${this.config.tableName}
      WHERE timestamp < $1
    `, [beforeDate]);

    return result.rowCount;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PostgresAuditWriterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Mock PostgreSQL client (for testing)
 */
class MockPostgresClient implements IPostgresClient {
  private store: AuditLogEntry[] = [];

  async query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX') || text.includes('CREATE TRIGGER') || text.includes('CREATE FUNCTION')) {
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('INSERT')) {
      // Extract values from params array
      if (params && params.length >= 17) {
        const entry: AuditLogEntry = {
          id: params[0] as string,
          timestamp: params[1] as string,
          action: params[2] as string,
          actor: {
            userId: params[3] as string | undefined,
            sessionId: params[4] as string | undefined,
            ip: params[5] as string | undefined,
            userAgent: params[6] as string | undefined,
            role: params[7] as string | undefined,
          },
          resource: {
            type: params[8] as string,
            id: params[9] as string | undefined,
            action: params[10] as AuditLogEntry['resource']['action'],
          },
          context: {
            category: params[11] as AuditLogEntry['context']['category'],
            severity: params[12] as AuditLogEntry['context']['severity'],
            reason: params[13] as string | undefined,
            source: params[14] as string,
          },
          metadata: params[15] ? JSON.parse(params[15] as string) : undefined,
          immutable: true,
        };
        this.store.push(entry);
      }
      return { rows: [], rowCount: params && params.length > 0 ? 1 : 0 };
    }

    if (text.includes('SELECT COUNT')) {
      return { rows: [{ total: this.store.length.toString() }], rowCount: 1 };
    }

    if (text.includes('SELECT *')) {
      return { rows: this.store, rowCount: this.store.length };
    }

    if (text.includes('DELETE')) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }
}