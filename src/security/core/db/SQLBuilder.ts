/**
 * OSIRIS Security Framework — SQL Builder
 * 
 * Utility for building parameterized SQL queries.
 * Prevents SQL injection by using parameterized queries.
 * 
 * Zero Trust: All SQL queries must be parameterized.
 */

/**
 * SQL Query builder
 * 
 * Builds parameterized SQL queries safely.
 */
export class SQLBuilder {
  private params: unknown[] = [];
  private paramIndex: number = 0;

  /**
   * Reset builder state
   */
  reset(): void {
    this.params = [];
    this.paramIndex = 0;
  }

  /**
   * Add a parameter
   */
  addParam(value: unknown): string {
    const placeholder = `$${this.params.length + 1}`;
    this.params.push(value);
    return placeholder;
  }

  /**
   * Get all parameters
   */
  getParams(): unknown[] {
    return [...this.params];
  }

  /**
   * Build WHERE clause with conditions
   */
  buildWhereClause(conditions: Array<{ field: string; operator: string; value: unknown }>): string {
    if (conditions.length === 0) {
      return '';
    }

    const clauses: string[] = [];

    for (const condition of conditions) {
      const placeholder = this.addParam(condition.value);
      clauses.push(`${condition.field} ${condition.operator} ${placeholder}`);
    }

    return `WHERE ${clauses.join(' AND ')}`;
  }

  /**
   * Build INSERT query
   */
  buildInsert(tableName: string, columns: string[], values: unknown[]): { sql: string; params: unknown[] } {
    this.reset();
    
    const placeholders = columns.map(() => this.addParam(null)).join(', ');
    const columnList = columns.join(', ');

    const sql = `INSERT INTO ${tableName} (${columnList}) VALUES (${placeholders})`;

    // Replace null placeholders with actual values
    let finalSQL = sql;
    const finalParams: unknown[] = [];
    
    for (let i = 0; i < values.length; i++) {
      const placeholder = `$${i + 1}`;
      finalSQL = finalSQL.replace(placeholder, `$${i + 1}`);
      finalParams.push(values[i]);
    }

    return { sql: finalSQL, params: finalParams };
  }

  /**
   * Build batch INSERT query
   */
  buildBatchInsert(
    tableName: string,
    columns: string[],
    valueRows: unknown[][]
  ): { sql: string; params: unknown[] } {
    this.reset();

    const placeholders: string[] = [];
    const params: unknown[] = [];

    for (const values of valueRows) {
      const rowPlaceholders = columns.map(() => {
        const placeholder = `$${params.length + 1}`;
        params.push(values[columns.indexOf(placeholder)]);
        return placeholder;
      }).join(', ');
      
      placeholders.push(`(${rowPlaceholders})`);
    }

    const columnList = columns.join(', ');
    const sql = `INSERT INTO ${tableName} (${columnList}) VALUES ${placeholders.join(', ')}`;

    return { sql, params };
  }

  /**
   * Build SELECT query
   */
  buildSelect(
    tableName: string,
    options: {
      columns?: string[];
      where?: Array<{ field: string; operator: string; value: unknown }>;
      orderBy?: { field: string; direction: 'ASC' | 'DESC' };
      limit?: number;
      offset?: number;
    } = {}
  ): { sql: string; params: unknown[] } {
    this.reset();

    const columns = options.columns || ['*'];
    const selectClause = columns.join(', ');

    let sql = `SELECT ${selectClause} FROM ${tableName}`;
    const params: unknown[] = [];

    // WHERE clause
    if (options.where && options.where.length > 0) {
      const whereClause = this.buildWhereClause(options.where);
      sql += ` ${whereClause}`;
      params.push(...this.getParams());
      this.reset();
    }

    // ORDER BY
    if (options.orderBy) {
      sql += ` ORDER BY ${options.orderBy.field} ${options.orderBy.direction}`;
    }

    // LIMIT
    if (options.limit !== undefined) {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(options.limit);
    }

    // OFFSET
    if (options.offset !== undefined) {
      sql += ` OFFSET $${params.length + 1}`;
      params.push(options.offset);
    }

    return { sql, params };
  }

  /**
   * Build UPDATE query
   */
  buildUpdate(
    tableName: string,
    updates: Record<string, unknown>,
    whereClause: { field: string; operator: string; value: unknown }
  ): { sql: string; params: unknown[] } {
    this.reset();

    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const [field, value] of Object.entries(updates)) {
      const placeholder = this.addParam(value);
      setClauses.push(`${field} = ${placeholder}`);
    }

    const sql = `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${whereClause.field} ${whereClause.operator} $${params.length + 1}`;
    params.push(whereClause.value);

    return { sql, params };
  }

  /**
   * Build DELETE query
   */
  buildDelete(
    tableName: string,
    whereClause: { field: string; operator: string; value: unknown }
  ): { sql: string; params: unknown[] } {
    this.reset();

    const placeholder = this.addParam(whereClause.value);
    const sql = `DELETE FROM ${tableName} WHERE ${whereClause.field} ${whereClause.operator} ${placeholder}`;

    return { sql, params: this.getParams() };
  }

  /**
   * Build COUNT query
   */
  buildCount(tableName: string, whereClause?: { field: string; operator: string; value: unknown }): { sql: string; params: unknown[] } {
    this.reset();

    let sql = `SELECT COUNT(*) as count FROM ${tableName}`;
    const params: unknown[] = [];

    if (whereClause) {
      const placeholder = this.addParam(whereClause.value);
      sql += ` WHERE ${whereClause.field} ${whereClause.operator} ${placeholder}`;
      params.push(...this.getParams());
    }

    return { sql, params };
  }

  /**
   * Escape identifier (table/column names)
   * Note: This should only be used with trusted identifiers, not user input
   */
  static escapeIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  /**
   * Build CREATE TABLE query
   */
  static buildCreateTable(
    tableName: string,
    columns: Array<{
      name: string;
      type: string;
      constraints?: string[];
    }>,
    options: {
      schema?: string;
      temporary?: boolean;
      ifNotExists?: boolean;
    } = {}
  ): string {
    const schema = options.schema ? `${SQLBuilder.escapeIdentifier(options.schema)}.` : '';
    const table = SQLBuilder.escapeIdentifier(tableName);
    const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS ' : '';
    const temporary = options.temporary ? 'TEMPORARY ' : '';

    const columnDefs = columns.map(col => {
      const constraints = col.constraints?.join(' ') || '';
      return `${SQLBuilder.escapeIdentifier(col.name)} ${col.type} ${constraints}`.trim();
    }).join(',\n  ');

    return `CREATE ${temporary}${ifNotExists}TABLE ${schema}${table} (
  ${columnDefs}
)`;
  }

  /**
   * Build CREATE INDEX query
   */
  static buildCreateIndex(
    indexName: string,
    tableName: string,
    columns: string[],
    options: {
      schema?: string;
      unique?: boolean;
      ifNotExists?: boolean;
      concurrently?: boolean;
    } = {}
  ): string {
    const schema = options.schema ? `${SQLBuilder.escapeIdentifier(options.schema)}.` : '';
    const unique = options.unique ? 'UNIQUE ' : '';
    const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS ' : '';
    const concurrently = options.concurrently ? 'CONCURRENTLY ' : '';

    const columnList = columns.map(col => SQLBuilder.escapeIdentifier(col)).join(', ');

    return `CREATE ${unique}${ifNotExists}INDEX ${concurrently}${SQLBuilder.escapeIdentifier(indexName)} ON ${schema}${SQLBuilder.escapeIdentifier(tableName)} (${columnList})`;
  }

  /**
   * Build DROP TABLE query
   */
  static buildDropTable(
    tableName: string,
    options: {
      schema?: string;
      ifExists?: boolean;
      cascade?: boolean;
    } = {}
  ): string {
    const schema = options.schema ? `${SQLBuilder.escapeIdentifier(options.schema)}.` : '';
    const ifExists = options.ifExists ? 'IF EXISTS ' : '';
    const cascade = options.cascade ? ' CASCADE' : '';

    return `DROP TABLE ${ifExists}${schema}${SQLBuilder.escapeIdentifier(tableName)}${cascade}`;
  }

  /**
   * Build ALTER TABLE ADD COLUMN query
   */
  static buildAddColumn(
    tableName: string,
    column: {
      name: string;
      type: string;
      constraints?: string[];
    },
    options: {
      schema?: string;
      ifNotExists?: boolean;
    } = {}
  ): string {
    const schema = options.schema ? `${SQLBuilder.escapeIdentifier(options.schema)}.` : '';
    const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS ' : '';
    const constraints = column.constraints?.join(' ') || '';

    return `ALTER TABLE ${schema}${SQLBuilder.escapeIdentifier(tableName)} ${ifNotExists}ADD COLUMN ${SQLBuilder.escapeIdentifier(column.name)} ${column.type} ${constraints}`.trim();
  }
}

/**
 * Audit log SQL builder
 * 
 * Specialized builder for audit log queries.
 */
export class AuditLogSQLBuilder {
  private builder: SQLBuilder;

  constructor() {
    this.builder = new SQLBuilder();
  }

  /**
   * Build INSERT query for audit log
   */
  buildInsert(entry: {
    id: string;
    timestamp: Date;
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
      action: string;
    };
    context: {
      category: string;
      severity: string;
      reason?: string;
      source: string;
    };
    metadata?: Record<string, unknown>;
  }): { sql: string; params: unknown[] } {
    const columns = [
      'id',
      'timestamp',
      'action',
      'actor_user_id',
      'actor_session_id',
      'actor_ip',
      'actor_user_agent',
      'actor_role',
      'resource_type',
      'resource_id',
      'resource_action',
      'context_category',
      'context_severity',
      'context_reason',
      'context_source',
      'metadata',
      'immutable',
    ];

    const values = [
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
      true,
    ];

    return this.builder.buildInsert('security.audit_logs', columns, values);
  }

  /**
   * Build batch INSERT query for audit logs
   */
  buildBatchInsert(entries: Array<{
    id: string;
    timestamp: Date;
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
      action: string;
    };
    context: {
      category: string;
      severity: string;
      reason?: string;
      source: string;
    };
    metadata?: Record<string, unknown>;
  }>): { sql: string; params: unknown[] } {
    const columns = [
      'id',
      'timestamp',
      'action',
      'actor_user_id',
      'actor_session_id',
      'actor_ip',
      'actor_user_agent',
      'actor_role',
      'resource_type',
      'resource_id',
      'resource_action',
      'context_category',
      'context_severity',
      'context_reason',
      'context_source',
      'metadata',
      'immutable',
    ];

    const valueRows = entries.map(entry => [
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
      true,
    ]);

    return this.builder.buildBatchInsert('security.audit_logs', columns, valueRows);
  }

  /**
   * Build SELECT query for audit logs
   */
  buildQuery(filters: {
    userId?: string;
    resourceType?: string;
    resourceId?: string;
    category?: string;
    severity?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): { countSQL: string; querySQL: string; params: unknown[] } {
    const whereConditions: Array<{ field: string; operator: string; value: unknown }> = [];
    const params: unknown[] = [];

    if (filters.userId) {
      whereConditions.push({ field: 'actor_user_id', operator: '=', value: filters.userId });
    }

    if (filters.resourceType) {
      whereConditions.push({ field: 'resource_type', operator: '=', value: filters.resourceType });
    }

    if (filters.resourceId) {
      whereConditions.push({ field: 'resource_id', operator: '=', value: filters.resourceId });
    }

    if (filters.category) {
      whereConditions.push({ field: 'context_category', operator: '=', value: filters.category });
    }

    if (filters.severity) {
      whereConditions.push({ field: 'context_severity', operator: '=', value: filters.severity });
    }

    if (filters.startDate) {
      whereConditions.push({ field: 'timestamp', operator: '>=', value: filters.startDate });
    }

    if (filters.endDate) {
      whereConditions.push({ field: 'timestamp', operator: '<=', value: filters.endDate });
    }

    const whereClause = whereConditions.length > 0 ? this.builder.buildWhereClause(whereConditions) : '';
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    // Reset and rebuild params for count query
    const countParams = this.builder.getParams();
    const countSQL = `SELECT COUNT(*) as total FROM security.audit_logs ${whereClause}`;

    // Build query SQL
    const querySQL = `
      SELECT * FROM security.audit_logs
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${countParams.length + 1} OFFSET $${countParams.length + 2}
    `;

    const allParams = [...countParams, limit, offset];

    return { countSQL, querySQL, params: allParams };
  }

  /**
   * Build archive query
   */
  buildArchiveQuery(beforeDate: Date, archiveTableName: string): { insertSQL: string; deleteSQL: string } {
    const insertSQL = `
      INSERT INTO security.${archiveTableName}
      SELECT * FROM security.audit_logs
      WHERE timestamp < $1
    `;

    const deleteSQL = `
      DELETE FROM security.audit_logs
      WHERE timestamp < $1
    `;

    return { insertSQL, deleteSQL };
  }
}