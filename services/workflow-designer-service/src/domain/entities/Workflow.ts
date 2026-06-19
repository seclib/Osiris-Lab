/**
 * OSIRIS-Lab v2 — Workflow Designer Service
 * 
 * DDD Aggregate Root: Workflow
 * Encapsulates DAG-based workflow state machine with Result pattern.
 * 
 * State Machine:
 *   draft ──activate──▶ active ──pause──▶ paused ──activate──▶ active
 *     │                   │                  │
 *     └───archive─────────┴───archive────────┴───archive──▶ archived
 */

import { Result, ok, err, ValidationError, ConflictError } from '@osiris/shared/domain/Result';
import { DAG, DAGValidator, WorkflowStatus } from '../value-objects/DAG';
import { WorkflowCreatedEvent, WorkflowUpdatedEvent } from '../events/WorkflowEvents';

export interface WorkflowProps {
  id: string;
  name: string;
  description?: string;
  dag: DAG;
  version: number;
  status: WorkflowStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkflowErrors = ValidationError | ConflictError;

export class Workflow {
  private readonly props: WorkflowProps;

  private constructor(props: WorkflowProps) {
    this.props = Object.freeze({ ...props });
  }

  /**
   * Factory method: creates a new Workflow aggregate.
   * Validates the DAG before creation.
   */
  static create(props: {
    id: string;
    name: string;
    description?: string;
    dag: DAG;
    createdBy: string;
  }): Result<Workflow, ValidationError> {
    if (!props.name || props.name.trim().length === 0) {
      return err(new ValidationError('Workflow', 'Name is required'));
    }
    if (props.name.length > 500) {
      return err(new ValidationError('Workflow', 'Name must be 500 characters or less'));
    }

    const dagValidation = DAGValidator.validate(props.dag);
    if (!dagValidation.valid) {
      return err(new ValidationError('Workflow', `Invalid DAG: ${dagValidation.errors.join(', ')}`, { errors: dagValidation.errors }));
    }

    return ok(new Workflow({
      ...props,
      version: 1,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  }

  static restore(props: WorkflowProps): Workflow {
    return new Workflow(props);
  }

  // ─── Getters ────────────────────────────────────────────────────────────

  get id(): string { return this.props.id; }
  get name(): string { return this.props.name; }
  get description(): string | undefined { return this.props.description; }
  get dag(): DAG { return this.props.dag; }
  get version(): number { return this.props.version; }
  get status(): WorkflowStatus { return this.props.status; }
  get createdBy(): string { return this.props.createdBy; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  // ─── Behaviors (State Machine) ──────────────────────────────────────────

  /**
   * Update the workflow DAG and metadata.
   */
  update(dag: DAG, updatedBy: string): Result<{ workflow: Workflow; event: WorkflowUpdatedEvent }, WorkflowErrors> {
    if (this.props.status === 'archived') {
      return err(new ConflictError('Workflow', 'Cannot update an archived workflow'));
    }

    const dagValidation = DAGValidator.validate(dag);
    if (!dagValidation.valid) {
      return err(new ValidationError('Workflow', `Invalid DAG: ${dagValidation.errors.join(', ')}`, { errors: dagValidation.errors }));
    }

    const updated = new Workflow({
      ...this.props,
      dag,
      version: this.props.version + 1,
      updatedAt: new Date(),
    });

    const event: WorkflowUpdatedEvent = {
      _tag: 'WorkflowUpdatedEvent',
      aggregateId: this.props.id,
      version: updated.version,
      changes: ['dag_modified'],
      updatedBy,
      occurredAt: updated.updatedAt,
    };

    return ok({ workflow: updated, event });
  }

  /**
   * Activate the workflow (draft/paused → active).
   */
  activate(): Result<Workflow, ConflictError> {
    if (this.props.status !== 'draft' && this.props.status !== 'paused') {
      return err(new ConflictError('Workflow', `Cannot activate workflow in status: ${this.props.status}`));
    }
    return ok(new Workflow({ ...this.props, status: 'active', updatedAt: new Date() }));
  }

  /**
   * Pause the workflow (active → paused).
   */
  pause(): Result<Workflow, ConflictError> {
    if (this.props.status !== 'active') {
      return err(new ConflictError('Workflow', `Cannot pause workflow in status: ${this.props.status}`));
    }
    return ok(new Workflow({ ...this.props, status: 'paused', updatedAt: new Date() }));
  }

  /**
   * Archive the workflow (terminal state).
   */
  archive(): Workflow {
    return new Workflow({ ...this.props, status: 'archived', updatedAt: new Date() });
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  toJSON(): WorkflowProps {
    return { ...this.props };
  }
}