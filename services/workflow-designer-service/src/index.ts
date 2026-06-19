import express from 'express';
import { Pool } from 'pg';
import { connect as natsConnect } from '@osiris/nats-client';
import { Logger } from '@osiris/logger';
import { Metrics } from '@osiris/metrics';

import { PostgresWorkflowRepository, PostgresWorkflowExecutionRepository, PostgresWorkflowStepRepository } from './infrastructure/database/PostgresWorkflowRepository';
import { NATSEventPublisher } from './infrastructure/nats/WorkflowEventPublisher';

import { CreateWorkflowCommand } from './application/commands/CreateWorkflowCommand';
import { UpdateWorkflowCommand } from './application/commands/UpdateWorkflowCommand';
import { DeleteWorkflowCommand } from './application/commands/DeleteWorkflowCommand';
import { GetWorkflowQuery, ListWorkflowsQuery, GetWorkflowGraphQuery, GetExecutionQuery } from './application/queries/GetWorkflowQuery';
import { createWorkflowRouter } from './presentation/routes/workflow.routes';

async function main(): Promise<void> {
  // Configuration
  const port = parseInt(process.env.PORT || '4000', 10);
  const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
  const dbUrl = process.env.DATABASE_URL || 'postgresql://osiris:osiris@localhost:5432/osiris';

  // Initialize logger
  const logger = new Logger('workflow-designer-service');
  
  // Initialize metrics
  const metrics = new Metrics('workflow-designer-service');

  // Connect to PostgreSQL
  const pool = new Pool({ connectionString: dbUrl });
  const db = { query: (text: string, params?: unknown[]) => pool.query(text, params) };

  // Connect to NATS
  const nc = await natsConnect({ servers: natsUrl });
  const nats = {
    publish: (subject: string, data: Buffer) => nc.publish(subject, data),
  };

  // Initialize repositories
  const workflowRepo = new PostgresWorkflowRepository(db);
  const executionRepo = new PostgresWorkflowExecutionRepository(db);
  const stepRepo = new PostgresWorkflowStepRepository(db);

  // Initialize NATS publisher
  const eventPublisher = new NATSEventPublisher(nats, logger, metrics);

  // Application layer
  const createWorkflow = new CreateWorkflowCommand(workflowRepo, eventPublisher, logger);
  const updateWorkflow = new UpdateWorkflowCommand(workflowRepo, eventPublisher, logger);
  const deleteWorkflow = new DeleteWorkflowCommand(workflowRepo, eventPublisher, logger);
  const getWorkflow = new GetWorkflowQuery(workflowRepo, executionRepo, stepRepo, logger);
  const listWorkflows = new ListWorkflowsQuery(workflowRepo, logger);
  const getWorkflowGraph = new GetWorkflowGraphQuery(workflowRepo, logger);
  const getExecution = new GetExecutionQuery(executionRepo, stepRepo, logger);

  // Express app
  const app = express();
  
  app.use(express.json());
  app.use('/health', (_req, res) => res.json({ status: 'healthy', service: 'workflow-designer-service' }));
  app.use('/workflows', createWorkflowRouter(
    createWorkflow, updateWorkflow, deleteWorkflow,
    getWorkflow, listWorkflows, getWorkflowGraph, getExecution
  ));

  // Start server
  app.listen(port, () => {
    logger.info('Workflow Designer Service started', { port, natsUrl });
  });
}

main().catch((error) => {
  console.error('Failed to start workflow-designer-service:', error);
  process.exit(1);
});