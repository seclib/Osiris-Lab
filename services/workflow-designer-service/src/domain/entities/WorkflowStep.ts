/**
 * OSIRIS-Lab v2 — Workflow Designer Service
 * 
 * DDD Entity: WorkflowStep
 * Tracks individual step execution within a workflow.
 * State machine: pending → running → completed | failed | skipped
 * 
 * Référence: docs/BACKEND_ARCHITECTURE.md §8.1 (Node.js service example)
 */

import { Result, ok, err, ConflictError } from '../../../../libs/shared/src/domain/Result';
import { StepStatus } from '../value-objects/DAG';

export interface WorkflowStepProps {
  id: string;
  executionId: string;
  nodeId: string;
  nodeType: string;
  status: StepStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  createdAt: Date;
}

export class WorkflowStep {
  private readonly props: WorkflowStepProps;

  private constructor(props: WorkflowStepProps) {
    this.props = Object.freeze({ ...props });
  }

  static create(props: Omit<WorkflowStepProps, 'status' | 'createdAt'>): WorkflowStep {
    return new WorkflowStep({ ...props, status: 'pending', createdAt: new Date() });
  }

  static restore(props: WorkflowStepProps): WorkflowStep {
    return new WorkflowStep(props);
  }

  get id(): string { return this.props.id; }
  get executionId(): string { return this.props.executionId; }
  get nodeId(): string { return this.props.nodeId; }
  get nodeType(): string { return this.props.nodeType; }
  get status(): StepStatus { return this.props.status; }
  get input(): Record<string, unknown> | undefined { return this.props.input; }
  get output(): Record<string, unknown> | undefined { return this.props.output; }
  get error(): string | undefined { return this.props.error; }
  get startedAt(): Date | undefined { return this.props.startedAt; }
  get completedAt(): Date | undefined { return this.props.completedAt; }
  get durationMs(): number | undefined { return this.props.durationMs; }
  get createdAt(): Date { return this.props.createdAt; }

  start(): WorkflowStep {
    return new WorkflowStep({ ...this.props, status: 'running', startedAt: new Date() });
  }

  complete(output: Record<string, unknown>): Result<WorkflowStep, ConflictError> {
    if (this.props.status !== 'running' && this.props.status !== 'pending') {
      return err(new ConflictError('WorkflowStep', `Cannot complete in status: ${this.props.status}`));
    }
    const completedAt = new Date();
    const durationMs = this.props.startedAt ? completedAt.getTime() - this.props.startedAt.getTime() : 0;
    return ok(new WorkflowStep({ ...this.props, status: 'completed', output, completedAt, durationMs }));
  }

  fail(errorMsg: string): Result<WorkflowStep, ConflictError> {
    if (this.props.status !== 'running' && this.props.status !== 'pending') {
      return err(new ConflictError('WorkflowStep', `Cannot fail in status: ${this.props.status}`));
    }
    const completedAt = new Date();
    const durationMs = this.props.startedAt ? completedAt.getTime() - this.props.startedAt.getTime() : 0;
    return ok(new WorkflowStep({ ...this.props, status: 'failed', error: errorMsg, completedAt, durationMs }));
  }

  skip(): WorkflowStep {
    return new WorkflowStep({ ...this.props, status: 'skipped', completedAt: new Date() });
  }

  toJSON(): WorkflowStepProps { return { ...this.props }; }
}