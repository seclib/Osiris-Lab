import { Workflow, WorkflowStatus, WorkflowDAG } from '../../domain/entities/Workflow';
import { IWorkflowRepository } from '../../domain/repositories/IWorkflowRepository';
import { WorkflowDomainService, WorkflowValidationResult } from '../../domain/services/WorkflowDomainService';

// Local Logger interface
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface CreateWorkflowCommandInput {
  name: string;
  description?: string;
  dag: WorkflowDAG;
  createdBy: string;
}

export interface CreateWorkflowCommandResult {
  success: boolean;
  workflow?: Workflow;
  validation?: WorkflowValidationResult;
  error?: string;
}

export class CreateWorkflowCommand {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private domainService: WorkflowDomainService,
    private logger: Logger,
    private natsPublisher?: {
      publish: (subject: string, data: Buffer) => Promise<void>;
    }
  ) {}

  async execute(input: CreateWorkflowCommandInput): Promise<CreateWorkflowCommandResult> {
    this.logger.info('Executing CreateWorkflowCommand', {
      name: input.name,
      createdBy: input.createdBy,
    });

    try {
      // Create workflow entity
      const workflow = new Workflow({
        name: input.name,
        description: input.description,
        dag: input.dag,
        createdBy: input.createdBy,
        status: WorkflowStatus.DRAFT,
      });

      // Validate workflow
      const validation = this.domainService.validate(workflow);
      if (!validation.valid) {
        this.logger.warn('Workflow validation failed', {
          errors: validation.errors,
          warnings: validation.warnings,
        });
        return {
          success: false,
          validation,
          error: `Validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // Save to database
      const savedWorkflow = await this.workflowRepository.save(workflow);

      // Publish workflow.created event
      if (this.natsPublisher) {
        const eventData = JSON.stringify({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'workflow.created',
          source: 'workflow-designer-service',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          payload: {
            workflow_id: savedWorkflow.id,
            name: savedWorkflow.name,
            version: savedWorkflow.version,
            dag: {
              nodes: savedWorkflow.dag.nodes.map(n => ({
                id: n.id,
                type: n.type,
                name: n.name,
                config: n.config,
              })),
              edges: savedWorkflow.dag.edges.map(e => ({
                from: e.from,
                to: e.to,
                condition: e.condition,
              })),
            },
            created_by: savedWorkflow.createdBy,
          },
          metadata: {
            user_id: input.createdBy,
          },
        });
        
        await this.natsPublisher.publish('workflow.created', eventData as unknown as Buffer);
      }

      this.logger.info('Workflow created successfully', {
        workflowId: savedWorkflow.id,
        name: savedWorkflow.name,
      });

      return {
        success: true,
        workflow: savedWorkflow,
        validation,
      };
    } catch (error) {
      this.logger.error('Failed to create workflow', {
        error: error instanceof Error ? error.message : 'Unknown error',
        name: input.name,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}