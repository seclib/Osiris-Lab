/**
 * OSIRIS-Lab v2 — Workflow Designer Service
 * 
 * DDD Entity: WorkflowExecution
 * Tracks the execution lifecycle of a workflow.
 * State machine: running → completed | failed | cancelled
 * 
 * Référence: docs/ARCHITECTURE.md §4.1 (Workflow model)
 */

import { Result, ok, err, ConflictError } from '../../../../libs/shared/src/domain/Result';
import { ExecutionStatus } from '../value-objects/DAG';

export interface WorkflowExecutionProps {
  id: string;
  workflowId: string;
  version: number;
  status: ExecutionStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

export class WorkflowExecution {
  private readonly props: WorkflowExecutionProps;

  private constructor(props: WorkflowExecutionProps) {
    this.props = Object.freeze({ ...props });
  }

  static create(props: Omit<WorkflowExecutionProps, 'status' | 'createdAt'>): WorkflowExecution {
    return new WorkflowExecution({ ...props, status: 'running', createdAt: new Date() });
  }

  static restore(props: WorkflowExecutionProps): WorkflowExecution {
    return new WorkflowExecution(props);
  }

  // ─── Getters ──────────────────────────────────────────────────────────

  get id(): string { return this.props.id; }
  get workflowId(): string { return this.props.workflowId; }
  get version(): number { return this.props.version; }
  get status(): ExecutionStatus { return this.props.status; }
  get input(): Record<string, unknown> | undefined { return this.props.input; }
  get output(): Record<string, unknown> | undefined { return this.props.output; }
  get startedAt(): Date | undefined { return this.props.startedAt; }
  get completedAt(): Date | undefined { return this.props.completedAt; }
  get createdAt(): Date { return this.props.createdAt; }

  // ─── State Machine ─────────────────────────────────────────────────────

  start(): WorkflowExecution {
    return new WorkflowExecution({ ...this.props, status: 'running', startedAt: new Date() });
  }

  complete(output: Record<string, unknown>): Result<WorkflowExecution, ConflictError> {
    if (this.props.status !== 'running') {
      return err(new ConflictError('WorkflowExecution', `Cannot complete in status: ${this.props.status}`));
    }
    return ok(new WorkflowExecution({ ...this.props, status: 'completed', output, completedAt: new Date() }));
  }

  fail(error: Record<string, unknown>): Result<WorkflowExecution, ConflictError> {
    if (this.props.status !== 'running') {
      return err(new ConflictError('WorkflowExecution', `Cannot fail in status: ${this.props.status}`));
    }
    return ok(new WorkflowExecution({ ...this.props, status: 'failed', output: error, completedAt: new Date() }));
  }

  cancel(): Result<WorkflowExecution, ConflictError> {
    if (this.props.status !== 'running') {
      return err(new ConflictError('WorkflowExecution', `Cannot cancel in status: ${this.props.status}`));
    }
    return ok(new WorkflowExecution({ ...this.props, status: 'cancelled', completedAt: new Date() }));
  }

  toJSON(): WorkflowExecutionProps {
    return { ...this.props };
  }
}