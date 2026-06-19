/**
 * OSIRIS-Lab v2 — Workflow Designer Service
 * 
 * Domain Events for Workflow aggregate.
 * Published when state changes occur within the domain.
 */

/**
 * Base interface for all workflow domain events.
 */
export interface WorkflowDomainEvent {
  aggregateId: string;
  occurredAt: Date;
}

/**
 * Event emitted when a workflow is created.
 */
export interface WorkflowCreatedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowCreatedEvent';
  name: string;
  version: number;
  createdBy: string;
}

/**
 * Event emitted when a workflow is updated (DAG modified).
 */
export interface WorkflowUpdatedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowUpdatedEvent';
  version: number;
  changes: string[];
  updatedBy: string;
}

/**
 * Event emitted when a workflow is deleted.
 */
export interface WorkflowDeletedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowDeletedEvent';
  deletedBy: string;
}

/**
 * Event emitted when a workflow is activated.
 */
export interface WorkflowActivatedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowActivatedEvent';
}

/**
 * Event emitted when a workflow is paused.
 */
export interface WorkflowPausedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowPausedEvent';
}

/**
 * Event emitted when a workflow is archived.
 */
export interface WorkflowArchivedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowArchivedEvent';
}

/**
 * Event emitted when a workflow execution is started.
 */
export interface WorkflowExecutionStartedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowExecutionStartedEvent';
  executionId: string;
  workflowId: string;
  input?: Record<string, unknown>;
}

/**
 * Event emitted when a workflow step is completed.
 */
export interface WorkflowStepCompletedEvent extends WorkflowDomainEvent {
  readonly _tag: 'WorkflowStepCompletedEvent';
  executionId: string;
  stepId: string;
  nodeId: string;
  status: 'completed' | 'failed' | 'skipped';
  output?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

/**
 * Union type of all workflow domain events.
 */
export type WorkflowEvent =
  | WorkflowCreatedEvent
  | WorkflowUpdatedEvent
  | WorkflowDeletedEvent
  | WorkflowActivatedEvent
  | WorkflowPausedEvent
  | WorkflowArchivedEvent
  | WorkflowExecutionStartedEvent
  | WorkflowStepCompletedEvent;