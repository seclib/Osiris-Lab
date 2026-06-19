import { IWorkflowRepository } from '../../domain/repositories/IWorkflowRepository';
import { Logger } from '../commands/CreateWorkflowCommand';
import { Workflow, WorkflowStatus } from '../../domain/entities/Workflow';
import { WorkflowExecution } from '../../domain/entities/WorkflowExecution';

export interface GetWorkflowQueryInput {
  workflowId: string;
}

export interface GetWorkflowQueryResult {
  workflow?: Workflow;
  found: boolean;
}

export interface ListWorkflowsQueryInput {
  status?: WorkflowStatus;
  createdBy?: string;
  limit?: number;
  offset?: number;
}

export interface ListWorkflowsQueryResult {
  workflows: Workflow[];
  total: number;
}

export interface GetWorkflowGraphQueryInput {
  workflowId: string;
}

export interface GetWorkflowGraphQueryResult {
  graph?: {
    nodes: Array<{
      id: string;
      type: string;
      name: string;
      config: Record<string, unknown>;
      position?: { x: number; y: number };
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      condition?: string;
    }>;
  };
  found: boolean;
}

export interface GetExecutionQueryInput {
  executionId: string;
}

export interface GetExecutionQueryResult {
  execution?: WorkflowExecution;
  found: boolean;
}

export class GetWorkflowQuery {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private logger: Logger
  ) {}

  async execute(input: GetWorkflowQueryInput): Promise<GetWorkflowQueryResult> {
    this.logger.info('Executing GetWorkflowQuery', {
      workflowId: input.workflowId,
    });

    try {
      const workflow = await this.workflowRepository.findById(input.workflowId);
      
      if (!workflow) {
        this.logger.warn('Workflow not found', { workflowId: input.workflowId });
        return { found: false };
      }

      this.logger.info('Workflow retrieved', {
        workflowId: workflow.id,
        name: workflow.name,
      });

      return {
        workflow,
        found: true,
      };
    } catch (error) {
      this.logger.error('Failed to get workflow', {
        error: error instanceof Error ? error.message : 'Unknown error',
        workflowId: input.workflowId,
      });

      return { found: false };
    }
  }
}

export class ListWorkflowsQuery {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private logger: Logger
  ) {}

  async execute(input: ListWorkflowsQueryInput): Promise<ListWorkflowsQueryResult> {
    this.logger.info('Executing ListWorkflowsQuery', {
      status: input.status,
      createdBy: input.createdBy,
    });

    try {
      const limit = input.limit || 50;
      const offset = input.offset || 0;

      let workflows: Workflow[];
      
      if (input.status) {
        workflows = await this.workflowRepository.findByStatus(input.status);
      } else if (input.createdBy) {
        workflows = await this.workflowRepository.findByCreatedBy(input.createdBy);
      } else {
        workflows = await this.workflowRepository.findAll(limit, offset);
      }

      this.logger.info('Workflows listed', {
        count: workflows.length,
      });

      return {
        workflows,
        total: workflows.length,
      };
    } catch (error) {
      this.logger.error('Failed to list workflows', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        workflows: [],
        total: 0,
      };
    }
  }
}

export class GetWorkflowGraphQuery {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private logger: Logger
  ) {}

  async execute(input: GetWorkflowGraphQueryInput): Promise<GetWorkflowGraphQueryResult> {
    this.logger.info('Executing GetWorkflowGraphQuery', {
      workflowId: input.workflowId,
    });

    try {
      const workflow = await this.workflowRepository.findById(input.workflowId);
      
      if (!workflow) {
        this.logger.warn('Workflow not found', { workflowId: input.workflowId });
        return { found: false };
      }

      const graph = {
        nodes: workflow.dag.nodes.map((n: { id: string; type: string; name: string; config: Record<string, unknown>; position?: { x: number; y: number } }) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          config: n.config,
          position: n.position,
        })),
        edges: workflow.dag.edges.map((e: { id: string; from: string; to: string; condition?: string }) => ({
          id: e.id,
          from: e.from,
          to: e.to,
          condition: e.condition,
        })),
      };

      this.logger.info('Workflow graph retrieved', {
        workflowId: workflow.id,
        nodesCount: graph.nodes.length,
        edgesCount: graph.edges.length,
      });

      return {
        graph,
        found: true,
      };
    } catch (error) {
      this.logger.error('Failed to get workflow graph', {
        error: error instanceof Error ? error.message : 'Unknown error',
        workflowId: input.workflowId,
      });

      return { found: false };
    }
  }
}

export class GetExecutionQuery {
  constructor(
    private workflowRepository: IWorkflowRepository,
    private logger: Logger
  ) {}

  async execute(input: GetExecutionQueryInput): Promise<GetExecutionQueryResult> {
    this.logger.info('Executing GetExecutionQuery', {
      executionId: input.executionId,
    });

    try {
      // In a real implementation, we would have a separate execution repository
      // For now, we'll return a mock result
      this.logger.warn('Execution query not fully implemented', {
        executionId: input.executionId,
      });

      return { found: false };
    } catch (error) {
      this.logger.error('Failed to get execution', {
        error: error instanceof Error ? error.message : 'Unknown error',
        executionId: input.executionId,
      });

      return { found: false };
    }
  }
}