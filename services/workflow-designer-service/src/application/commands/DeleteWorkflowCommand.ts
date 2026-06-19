import { IWorkflowRepository } from '../../infrastructure/database/PostgresWorkflowRepository';

export interface DeleteWorkflowRequest {
  id: string;
  deletedBy: string;
}

export class DeleteWorkflowCommand {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private eventPublisher: { publish: (subject: string, data: unknown) => Promise<void> },
    private logger: { info: (msg: string, data?: unknown) => void; error: (msg: string, data?: unknown) => void }
  ) {}

  async execute(request: DeleteWorkflowRequest): Promise<void> {
    this.logger.info('Deleting workflow', { workflowId: request.id });

    // Check exists
    const existing = await this.workflowRepository.findById(request.id);
    if (!existing) {
      throw new Error(`Workflow not found: ${request.id}`);
    }

    // Delete from database
    await this.workflowRepository.delete(request.id);

    // Publish event
    await this.eventPublisher.publish('workflow.deleted', {
      workflow_id: request.id,
      deleted_by: request.deletedBy,
    });

    this.logger.info('Workflow deleted', { workflowId: request.id });
  }
}