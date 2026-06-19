import { Workflow } from '../../domain/entities/Workflow';
import { IWorkflowRepository } from '../../infrastructure/database/PostgresWorkflowRepository';
import { IWorkflowExecutionRepository, IWorkflowStepRepository } from '../../infrastructure/database/PostgresWorkflowRepository';
import { WorkflowExecution } from '../../domain/entities/WorkflowExecution';
import { WorkflowStep } from '../../domain/entities/WorkflowStep';

export class GetWorkflowQuery {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private executionRepository: IWorkflowExecutionRepository,
    private stepRepository: IWorkflowStepRepository,
    private logger: { info: (msg: string, data?: unknown) => void }
  ) {}

  async execute(id: string): Promise<{ workflow: Workflow | null; executions: WorkflowExecution[] }> {
    this.logger.info('Fetching workflow', { workflowId: id });

    const workflow = await this.workflowRepository.findById(id);
    if (!workflow) {
      return { workflow: null, executions: [] };
    }

    const executions = await this.executionRepository.findByWorkflowId(id, 5);
    return { workflow, executions };
  }
}

export class ListWorkflowsQuery {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private logger: { info: (msg: string, data?: unknown) => void }
  ) {}

  async execute(status?: string, limit = 50, offset = 0): Promise<{ workflows: Workflow[]; total: number }> {
    this.logger.info('Listing workflows', { status, limit, offset });
    return this.workflowRepository.findAll(status, limit, offset);
  }
}

export class GetWorkflowGraphQuery {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private logger: { info: (msg: string, data?: unknown) => void }
  ) {}

  async execute(id: string): Promise<import('../../domain/value-objects/DAG').DAG | null> {
    this.logger.info('Fetching workflow graph', { workflowId: id });

    const workflow = await this.workflowRepository.findById(id);
    if (!workflow) return null;
    return workflow.dag;
  }
}

export class GetExecutionQuery {
  constructor(
    private executionRepository: IWorkflowExecutionRepository,
    private stepRepository: IWorkflowStepRepository,
    private logger: { info: (msg: string, data?: unknown) => void }
  ) {}

  async execute(executionId: string): Promise<{ execution: WorkflowExecution | null; steps: WorkflowStep[] }> {
    this.logger.info('Fetching execution', { executionId });

    const execution = await this.executionRepository.findById(executionId);
    if (!execution) {
      return { execution: null, steps: [] };
    }

    const steps = await this.stepRepository.findByExecutionId(executionId);
    return { execution, steps };
  }
}