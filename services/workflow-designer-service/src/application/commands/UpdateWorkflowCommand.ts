import { Workflow } from '../../domain/entities/Workflow';
import { DAG, DAGValidator } from '../../domain/value-objects/DAG';
import { IWorkflowRepository } from '../../infrastructure/database/PostgresWorkflowRepository';

export interface UpdateWorkflowRequest {
  id: string;
  name?: string;
  description?: string;
  dag?: DAG;
  updatedBy: string;
}

export class UpdateWorkflowCommand {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private eventPublisher: { publish: (subject: string, data: unknown) => Promise<void> },
    private logger: { info: (msg: string, data?: unknown) => void; error: (msg: string, data?: unknown) => void }
  ) {}

  async execute(request: UpdateWorkflowRequest): Promise<Workflow> {
    this.logger.info('Updating workflow', { workflowId: request.id });

    // Load existing workflow
    const existing = await this.workflowRepository.findById(request.id);
    if (!existing) {
      throw new Error(`Workflow not found: ${request.id}`);
    }

    // Apply updates
    let updated = existing;
    if (request.dag) {
      // Validate new DAG
      const validation = DAGValidator.validate(request.dag);
      if (!validation.valid) {
        this.logger.error('DAG validation failed', { errors: validation.errors });
        throw new Error(`DAG validation failed: ${validation.errors.join(', ')}`);
      }
      updated = updated.update(request.dag, request.updatedBy);
    }

    // Persist
    await this.workflowRepository.save(updated);

    // Publish event
    await this.eventPublisher.publish('workflow.updated', {
      workflow_id: updated.id,
      version: updated.version,
      changes: request.dag ? ['dag_modified'] : [],
      dag: updated.dag,
      updated_by: request.updatedBy,
    });

    this.logger.info('Workflow updated', { workflowId: updated.id, version: updated.version });
    return updated;
  }
}