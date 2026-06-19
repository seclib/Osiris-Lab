/**
 * OSIRIS-Lab v2 — Workflow Designer Service
 * Infrastructure: PostgreSQL Repositories with Result pattern + optimistic locking.
 * 
 * Références:
 * - docs/ARCHITECTURE.md §4.1 (Workflow model)
 * - docs/BACKEND_ARCHITECTURE.md §8.1 (Node.js service example)
 */

import { Result, ok, err, NotFoundError, InfrastructureError, ConflictError } from '../../../../libs/shared/src/domain/Result';
import { Workflow } from '../../domain/entities/Workflow';
import { WorkflowExecution } from '../../domain/entities/WorkflowExecution';
import { WorkflowStep } from '../../domain/entities/WorkflowStep';
import { DAG } from '../../domain/value-objects/DAG';

// ─── Interfaces ───────────────────────────────────────────────────────────

export interface IWorkflowRepository {
  findById(id: string): Promise<Result<Workflow, NotFoundError>>;
  findAll(status?: string, limit?: number, offset?: number): Promise<Result<{ workflows: Workflow[]; total: number }, never>>;
  save(workflow: Workflow): Promise<Result<void, InfrastructureError | ConflictError>>;
  delete(id: string): Promise<Result<void, NotFoundError | InfrastructureError>>;
}

export interface IWorkflowExecutionRepository {
  findById(id: string): Promise<Result<WorkflowExecution, NotFoundError>>;
  findByWorkflowId(workflowId: string, limit?: number): Promise<Result<WorkflowExecution[], never>>;
  save(execution: WorkflowExecution): Promise<Result<void, InfrastructureError>>;
}

export interface IWorkflowStepRepository {
  findByExecutionId(executionId: string): Promise<Result<WorkflowStep[], never>>;
  save(step: WorkflowStep): Promise<Result<void, InfrastructureError>>;
}

// ─── Type helper for DB adapter ────────────────────────────────────────────

interface DBAdapter {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

// ─── Base repository (DRY) ────────────────────────────────────────────────

abstract class BasePostgresRepository {
  constructor(protected readonly db: DBAdapter) {}

  protected async findById<T>(table: string, id: string, mapper: (row: unknown) => T): Promise<Result<T, NotFoundError>> {
    try {
      const result = await this.db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (result.rows.length === 0) return err(new NotFoundError(table, id));
      return ok(mapper(result.rows[0]));
    } catch (e) {
      return err(new InfrastructureError(`Postgres.${table}`, 'findById', e as Error));
    }
  }
}

// ─── Workflow Repository ──────────────────────────────────────────────────

export class PostgresWorkflowRepository extends BasePostgresRepository implements IWorkflowRepository {
  constructor(db: DBAdapter) { super(db); }

  async findById(id: string): Promise<Result<Workflow, NotFoundError>> {
    return super.findById('workflows', id, this.mapToWorkflow.bind(this));
  }

  async findAll(status?: string, limit = 50, offset = 0): Promise<Result<{ workflows: Workflow[]; total: number }, never>> {
    try {
      const where = status ? ' WHERE status = $1' : '';
      const params: unknown[] = status ? [status] : [];
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;

      const [rows, countRows] = await Promise.all([
        this.db.query(`SELECT * FROM workflows${where} ORDER BY updated_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, [...params, limit, offset]),
        this.db.query(`SELECT COUNT(*) as count FROM workflows${where}`, params),
      ]);
      return ok({
        workflows: rows.rows.map(r => this.mapToWorkflow(r)),
        total: parseInt((countRows.rows[0] as { count: string }).count, 10),
      });
    } catch (e) {
      return ok({ workflows: [], total: 0 }); // degrade gracefully
    }
  }

  async save(workflow: Workflow): Promise<Result<void, InfrastructureError | ConflictError>> {
    const j = workflow.toJSON();
    try {
      // Optimistic locking: WHERE version = $3 ensures version conflict detection
      const result = await this.db.query(
        `INSERT INTO workflows (id, name, description, dag, version, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description,
           dag = EXCLUDED.dag, version = EXCLUDED.version,
           status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
         WHERE workflows.version = $10`,
        [j.id, j.name, j.description, JSON.stringify(j.dag), j.version, j.status,
         j.createdBy, j.createdAt, j.updatedAt, j.version - 1]
      );
      if (result.rowCount === 0) {
        return err(new ConflictError('Workflow', `Optimistic lock failed: version ${j.version - 1} is stale`));
      }
      return ok(undefined);
    } catch (e) {
      return err(new InfrastructureError('Postgres.workflows', 'save', e as Error));
    }
  }

  async delete(id: string): Promise<Result<void, NotFoundError | InfrastructureError>> {
    try {
      const result = await this.db.query('DELETE FROM workflows WHERE id = $1', [id]);
      if (result.rowCount === 0) return err(new NotFoundError('Workflow', id));
      return ok(undefined);
    } catch (e) {
      return err(new InfrastructureError('Postgres.workflows', 'delete', e as Error));
    }
  }

  private mapToWorkflow(row: unknown): Workflow {
    const r = row as Record<string, unknown>;
    return Workflow.restore({
      id: r.id as string, name: r.name as string,
      description: r.description as string | undefined, dag: r.dag as DAG,
      version: r.version as number, status: r.status as Workflow['status'],
      createdBy: r.created_by as string, createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
    });
  }
}

// ─── Execution Repository ─────────────────────────────────────────────────

export class PostgresWorkflowExecutionRepository extends BasePostgresRepository implements IWorkflowExecutionRepository {
  constructor(db: DBAdapter) { super(db); }

  async findById(id: string): Promise<Result<WorkflowExecution, NotFoundError>> {
    return super.findById('workflow_executions', id, this.mapToExecution.bind(this));
  }

  async findByWorkflowId(workflowId: string, limit = 10): Promise<Result<WorkflowExecution[], never>> {
    try {
      const res = await this.db.query(
        'SELECT * FROM workflow_executions WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT $2',
        [workflowId, limit]
      );
      return ok(res.rows.map(r => this.mapToExecution(r)));
    } catch { return ok([]); }
  }

  async save(execution: WorkflowExecution): Promise<Result<void, InfrastructureError>> {
    const j = execution.toJSON();
    try {
      await this.db.query(
        `INSERT INTO workflow_executions (id, workflow_id, version, status, input, output, started_at, completed_at, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, output = EXCLUDED.output, completed_at = EXCLUDED.completed_at`,
        [j.id, j.workflowId, j.version, j.status,
         j.input ? JSON.stringify(j.input) : null, j.output ? JSON.stringify(j.output) : null,
         j.startedAt, j.completedAt, j.createdAt]
      );
      return ok(undefined);
    } catch (e) {
      return err(new InfrastructureError('Postgres.workflow_executions', 'save', e as Error));
    }
  }

  private mapToExecution(row: unknown): WorkflowExecution {
    const r = row as Record<string, unknown>;
    return WorkflowExecution.restore({
      id: r.id as string, workflowId: r.workflow_id as string, version: r.version as number,
      status: r.status as WorkflowExecution['status'],
      input: r.input as Record<string, unknown> | undefined,
      output: r.output as Record<string, unknown> | undefined,
      startedAt: r.started_at ? new Date(r.started_at as string) : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at as string) : undefined,
      createdAt: new Date(r.created_at as string),
    });
  }
}

// ─── Step Repository ──────────────────────────────────────────────────────

export class PostgresWorkflowStepRepository extends BasePostgresRepository implements IWorkflowStepRepository {
  constructor(db: DBAdapter) { super(db); }

  async findByExecutionId(executionId: string): Promise<Result<WorkflowStep[], never>> {
    try {
      const res = await this.db.query(
        'SELECT * FROM workflow_steps WHERE execution_id = $1 ORDER BY started_at ASC',
        [executionId]
      );
      return ok(res.rows.map(r => this.mapToStep(r)));
    } catch { return ok([]); }
  }

  async save(step: WorkflowStep): Promise<Result<void, InfrastructureError>> {
    const j = step.toJSON();
    try {
      await this.db.query(
        `INSERT INTO workflow_steps (id, execution_id, node_id, node_type, status, input, output, error, started_at, completed_at, duration_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, output = EXCLUDED.output, error = EXCLUDED.error,
           completed_at = EXCLUDED.completed_at, duration_ms = EXCLUDED.duration_ms`,
        [j.id, j.executionId, j.nodeId, j.nodeType, j.status,
         j.input ? JSON.stringify(j.input) : null, j.output ? JSON.stringify(j.output) : null,
         j.error, j.startedAt, j.completedAt, j.durationMs, j.createdAt]
      );
      return ok(undefined);
    } catch (e) {
      return err(new InfrastructureError('Postgres.workflow_steps', 'save', e as Error));
    }
  }

  private mapToStep(row: unknown): WorkflowStep {
    const r = row as Record<string, unknown>;
    return WorkflowStep.restore({
      id: r.id as string, executionId: r.execution_id as string,
      nodeId: r.node_id as string, nodeType: r.node_type as string,
      status: r.status as WorkflowStep['status'],
      input: r.input as Record<string, unknown> | undefined,
      output: r.output as Record<string, unknown> | undefined,
      error: r.error as string | undefined,
      startedAt: r.started_at ? new Date(r.started_at as string) : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at as string) : undefined,
      durationMs: r.duration_ms as number | undefined,
      createdAt: new Date(r.created_at as string),
    });
  }
}