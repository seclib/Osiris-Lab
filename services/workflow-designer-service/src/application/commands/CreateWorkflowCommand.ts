/**
 * OSIRIS-Lab v2 — Workflow Designer Service
 * 
 * CQRS Command: CreateWorkflow
 * Creates a new workflow aggregate with DAG validation.
 */

import { Result, ok, err, InfrastructureError } from '@osiris/shared/domain/Result';
import { Workflow, WorkflowErrors, WorkflowProps } from '../../domain/entities/Workflow';
import { DAG } from '../../domain/value-objects/DAG';
import { IWorkflowRepository } from '../../infrastructure/repositories/IWorkflowRepository';
import { INATSEventPublisher } from '../../infrastructure/nats/WorkflowEventPublisher';

export interface CreateWorkflowRequest {
  name: string;
  description?: string;
  dag: DAG;
  createdBy: string;
}

export type CreateWorkflowResponse = WorkflowProps;

export class CreateWorkflowCommand {
  constructor(
    private readonly workflowRepository: IWorkflowRepository,
    private readonly eventPublisher: INATSEventPublisher,
    private readonly logger: { info: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void }
  ) {}

  async execute(request: CreateWorkflowRequest): Promise<Result<CreateWorkflowResponse, WorkflowErrors | InfrastructureError>> {
    this.logger.info('Creating workflow', { name: request.name });

    // 1. Create Workflow aggregate (validates name + DAG)
    const workflowResult = Workflow.create({
      id: crypto.randomUUID(),
      name: request.name,
      description: request.description,
      dag: request.dag,
      createdBy: request.createdBy,
    });

    if (workflowResult.isErr()) {
      this.logger.error('Workflow creation validation failed', { errors: workflowResult.error.message });
      return workflowResult;
    }

    const workflow = workflowResult.unwrap();

    // 2. Persist aggregate
    const saveResult = await this.workflowRepository.save(workflow);
    if (saveResult.isErr()) {
      this.logger.error('Failed to persist workflow', { error: saveResult.error.message });
      return err(saveResult.error);
    }

    // 3. Publish domain event to NATS
    try {
      await this.eventPublisher.publish('workflow.created', {
        workflow_id: workflow.id,
        name: workflow.name,
        version: workflow.version,
        dag: workflow.dag,
        created_by: workflow.createdBy,
      });
    } catch (error) {
      this.logger.error('Failed to publish workflow.created event', { error: (error as Error).message });
      return err(new InfrastructureError('NATSEventPublisher', 'publish', error as Error));
    }

    this.logger.info('Workflow created successfully', { workflowId: workflow.id, version: workflow.version });
    return ok(workflow.toJSON());
  }
}