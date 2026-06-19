export const WORKFLOW_EVENTS = {
  CREATED: 'workflow.created',
  UPDATED: 'workflow.updated',
  DELETED: 'workflow.deleted',
  EXECUTION_STARTED: 'workflow.execution.started',
  EXECUTION_COMPLETED: 'workflow.execution.completed',
  EXECUTION_FAILED: 'workflow.execution.failed',
  STEP_STARTED: 'workflow.step.started',
  STEP_COMPLETED: 'workflow.step.completed',
  STEP_FAILED: 'workflow.step.failed',
} as const;

export interface WorkflowCreatedEvent {
  type: typeof WORKFLOW_EVENTS.CREATED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    workflow_id: string;
    name: string;
    version: number;
    dag: {
      nodes: Array<{
        id: string;
        type: string;
        name: string;
        config: Record<string, unknown>;
      }>;
      edges: Array<{
        from: string;
        to: string;
        condition?: string;
      }>;
    };
    created_by: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface WorkflowUpdatedEvent {
  type: typeof WORKFLOW_EVENTS.UPDATED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    workflow_id: string;
    version: number;
    changes: Record<string, unknown>;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface WorkflowDeletedEvent {
  type: typeof WORKFLOW_EVENTS.DELETED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    workflow_id: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface WorkflowExecutionStartedEvent {
  type: typeof WORKFLOW_EVENTS.EXECUTION_STARTED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    execution_id: string;
    workflow_id: string;
    workflow_version: number;
    input: Record<string, unknown>;
    started_at: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface WorkflowExecutionCompletedEvent {
  type: typeof WORKFLOW_EVENTS.EXECUTION_COMPLETED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    execution_id: string;
    workflow_id: string;
    status: 'completed' | 'failed' | 'terminated';
    output: Record<string, unknown>;
    duration_ms: number;
    completed_at: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface WorkflowStepStartedEvent {
  type: typeof WORKFLOW_EVENTS.STEP_STARTED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    execution_id: string;
    step_id: string;
    node_id: string;
    node_type: string;
    started_at: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export interface WorkflowStepCompletedEvent {
  type: typeof WORKFLOW_EVENTS.STEP_COMPLETED;
  source: string;
  timestamp: string;
  version: string;
  correlation_id?: string;
  payload: {
    execution_id: string;
    step_id: string;
    node_id: string;
    status: 'completed' | 'failed' | 'skipped';
    output: Record<string, unknown>;
    duration_ms: number;
    completed_at: string;
    error?: string;
  };
  metadata?: {
    tenant_id?: string;
    user_id?: string;
  };
}

export type WorkflowEvent =
  | WorkflowCreatedEvent
  | WorkflowUpdatedEvent
  | WorkflowDeletedEvent
  | WorkflowExecutionStartedEvent
  | WorkflowExecutionCompletedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepCompletedEvent;