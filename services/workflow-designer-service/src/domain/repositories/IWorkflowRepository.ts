import { Workflow, WorkflowStatus } from '../entities/Workflow';

export interface IWorkflowRepository {
  save(workflow: Workflow): Promise<Workflow>;
  findById(id: string): Promise<Workflow | null>;
  findByName(name: string): Promise<Workflow | null>;
  findByStatus(status: WorkflowStatus): Promise<Workflow[]>;
  findByCreatedBy(userId: string): Promise<Workflow[]>;
  findAll(limit?: number, offset?: number): Promise<Workflow[]>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  countByStatus(status: WorkflowStatus): Promise<number>;
}