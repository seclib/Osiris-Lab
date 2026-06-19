import { WorkflowExecution, ExecutionStatus, StepStatus, WorkflowStep } from '../../domain/entities/WorkflowExecution';
import { IWorkflowRepository } from '../../domain/repositories/IWorkflowRepository';
import { Workflow, WorkflowNodeType } from '../../domain/entities/Workflow';
import { WorkflowDomainService } from '../../domain/services/WorkflowDomainService';

// Local Logger interface
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface ExecuteWorkflowCommandInput {
  workflowId: string;
  input: Record<string, unknown>;
  triggeredBy: string;
}

export interface ExecuteWorkflowCommandResult {
  success: boolean;
  execution?: WorkflowExecution;
  error?: string;
}

export class ExecuteWorkflowCommand {
  private temporalClient: unknown; // Temporal client

  constructor(
    private workflowRepository: IWorkflowRepository,
    private domainService: WorkflowDomainService,
    private logger: Logger,
    private natsPublisher?: {
      publish: (subject: string, data: string) => Promise<void>;
    }
  ) {
    // Initialize Temporal client
    // this.temporalClient = await Temporal.connect();
  }

  async execute(input: ExecuteWorkflowCommandInput): Promise<ExecuteWorkflowCommandResult> {
    this.logger.info('Executing ExecuteWorkflowCommand', {
      workflowId: input.workflowId,
      triggeredBy: input.triggeredBy,
    });

    try {
      // Find workflow
      const workflow = await this.workflowRepository.findById(input.workflowId);
      if (!workflow) {
        this.logger.warn('Workflow not found', { workflowId: input.workflowId });
        return {
          success: false,
          error: 'Workflow not found',
        };
      }

      // Check if workflow can be executed
      const canExecute = this.domainService.canExecute(workflow);
      if (!canExecute.canExecute) {
        this.logger.warn('Workflow cannot be executed', {
          workflowId: input.workflowId,
          reason: canExecute.reason,
        });
        return {
          success: false,
          error: canExecute.reason,
        };
      }

      // Create execution entity
      const execution = new WorkflowExecution({
        workflowId: input.workflowId,
        workflowVersion: workflow.version,
        input: input.input,
        triggeredBy: input.triggeredBy,
      });

      // Start execution
      execution.start();

      // Get execution order
      const executionOrder = this.domainService.getExecutionOrder(workflow);
      this.logger.info('Workflow execution order determined', {
        executionId: execution.id,
        order: executionOrder,
      });

      // Publish workflow.execution.started event
      if (this.natsPublisher) {
        await this.natsPublisher.publish('workflow.execution.started', JSON.stringify({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'workflow.execution.started',
          source: 'workflow-designer-service',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          payload: {
            execution_id: execution.id,
            workflow_id: input.workflowId,
            workflow_version: workflow.version,
            input: input.input,
            started_at: execution.startedAt!.toISOString(),
          },
          metadata: {
            user_id: input.triggeredBy,
          },
        }));
      }

      // Execute workflow via Temporal
      // In production, this would start a Temporal workflow
      // For now, we'll simulate execution
      const result = await this.executeWorkflowSteps(workflow, execution, executionOrder);

      this.logger.info('Workflow execution completed', {
        executionId: execution.id,
        status: execution.status,
        duration: execution.getDuration(),
      });

      return {
        success: true,
        execution,
      };
    } catch (error) {
      this.logger.error('Failed to execute workflow', {
        error: error instanceof Error ? error.message : 'Unknown error',
        workflowId: input.workflowId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async executeWorkflowSteps(
    workflow: Workflow,
    execution: WorkflowExecution,
    executionOrder: string[]
  ): Promise<void> {
    // Simulate step execution
    // In production, this would be handled by Temporal.io workers
    
    for (const nodeId of executionOrder) {
      const node = workflow.dag.nodes.find(n => n.id === nodeId);
      if (!node) continue;

      // Create step
      const stepId = `step_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const startedAt = new Date();
      
      const step: WorkflowStep = {
        id: stepId,
        executionId: execution.id,
        nodeId: node.id,
        nodeType: node.type,
        status: StepStatus.RUNNING,
        input: node.config,
        output: {},
        startedAt,
      };

      execution.addStep(step);

      // Publish step started event
      if (this.natsPublisher) {
        await this.natsPublisher.publish('workflow.step.started', JSON.stringify({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'workflow.step.started',
          source: 'workflow-designer-service',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          payload: {
            execution_id: execution.id,
            step_id: stepId,
            node_id: node.id,
            node_type: node.type,
            started_at: startedAt.toISOString(),
          },
          metadata: {
            user_id: execution.triggeredBy,
          },
        }));
      }

      // Simulate step execution
      await this.simulateStepExecution(node, step);

      // Update step status
      const completedAt = new Date();
      step.status = StepStatus.COMPLETED;
      step.completedAt = completedAt;
      step.durationMs = completedAt.getTime() - startedAt.getTime();

      // Publish step completed event
      if (this.natsPublisher) {
        await this.natsPublisher.publish('workflow.step.completed', JSON.stringify({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'workflow.step.completed',
          source: 'workflow-designer-service',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          payload: {
            execution_id: execution.id,
            step_id: stepId,
            node_id: node.id,
            status: 'completed',
            output: step.output,
            duration_ms: step.durationMs,
            completed_at: completedAt.toISOString(),
          },
          metadata: {
            user_id: execution.triggeredBy,
          },
        }));
      }
    }

    // Complete execution
    execution.complete({
      message: 'Workflow completed successfully',
      stepsCount: execution.steps.length,
    });

    // Publish execution completed event
    if (this.natsPublisher && execution.completedAt) {
      await this.natsPublisher.publish('workflow.execution.completed', JSON.stringify({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        type: 'workflow.execution.completed',
        source: 'workflow-designer-service',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        payload: {
          execution_id: execution.id,
          workflow_id: workflow.id,
          status: 'completed',
          output: execution.output,
          duration_ms: execution.getDuration() || 0,
          completed_at: execution.completedAt.toISOString(),
        },
        metadata: {
          user_id: execution.triggeredBy,
        },
      }));
    }
  }

  private async simulateStepExecution(
    node: { type: WorkflowNodeType; id: string },
    step: WorkflowStep
  ): Promise<void> {
    // Simulate processing time based on node type
    const processingTime = this.getProcessingTime(node.type);
    
    await this.delay(processingTime);

    // Simulate step output
    step.output = {
      nodeId: node.id,
      nodeType: node.type,
      result: 'success',
      timestamp: new Date().toISOString(),
    };

    this.logger.info('Step executed', {
      stepId: step.id,
      nodeId: node.id,
      nodeType: node.type,
      duration: processingTime,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getProcessingTime(nodeType: string): number {
    switch (nodeType) {
      case 'input':
      case 'output':
        return 100;
      case 'process':
        return 1000;
      case 'ai':
        return 5000;
      case 'condition':
        return 200;
      case 'loop':
        return 10000;
      case 'notification':
        return 500;
      case 'siem':
        return 2000;
      default:
        return 1000;
    }
  }
}