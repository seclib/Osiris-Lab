import { Result, NotFoundError, InfrastructureError } from '@osiris/shared/domain/Result';
import { Workflow } from '../../domain/entities/Workflow';
import { WorkflowExecution } from '../../domain/entities/WorkflowExecution';
import { WorkflowStep } from '../../domain/entities/WorkflowStep';

export interface IWorkflowRepository {
  findById(id: string): Promise<Result<Workflow, NotFoundError>>;
  findAll(status?: string, limit?: number, offset?: number): Promise<Result<{ workflows: Workflow[]; total: number }, never>>;
  save(workflow: Workflow): Promise<Result<void, InfrastructureError>>;
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