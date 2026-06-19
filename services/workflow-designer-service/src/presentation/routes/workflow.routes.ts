import { Router, Request, Response } from 'express';
import { CreateWorkflowCommand } from '../../application/commands/CreateWorkflowCommand';
import { UpdateWorkflowCommand } from '../../application/commands/UpdateWorkflowCommand';
import { DeleteWorkflowCommand } from '../../application/commands/DeleteWorkflowCommand';
import { GetWorkflowQuery, ListWorkflowsQuery, GetWorkflowGraphQuery, GetExecutionQuery } from '../../application/queries/GetWorkflowQuery';

export function createWorkflowRouter(
  createWorkflow: CreateWorkflowCommand,
  updateWorkflow: UpdateWorkflowCommand,
  deleteWorkflow: DeleteWorkflowCommand,
  getWorkflow: GetWorkflowQuery,
  listWorkflows: ListWorkflowsQuery,
  getWorkflowGraph: GetWorkflowGraphQuery,
  getExecution: GetExecutionQuery
): Router {
  const router = Router();

  // POST /workflows — Create a new workflow
  router.post('/', async (req: Request, res: Response) => {
    try {
      const workflow = await createWorkflow.execute({
        name: req.body.name,
        description: req.body.description,
        dag: req.body.dag,
        createdBy: req.user?.id || req.body.createdBy,
      });
      res.status(201).json(workflow.toJSON());
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('validation failed')) {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // PUT /workflows/:id — Update a workflow
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const workflow = await updateWorkflow.execute({
        id: req.params.id,
        name: req.body.name,
        description: req.body.description,
        dag: req.body.dag,
        updatedBy: req.user?.id || req.body.updatedBy,
      });
      res.json(workflow.toJSON());
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else if (message.includes('validation failed')) {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // DELETE /workflows/:id — Delete a workflow
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      await deleteWorkflow.execute({
        id: req.params.id,
        deletedBy: req.user?.id || req.body.deletedBy,
      });
      res.status(204).send();
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // GET /workflows — List workflows
  router.get('/', async (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await listWorkflows.execute(status, limit, offset);
      res.json({
        workflows: result.workflows.map(w => w.toJSON()),
        total: result.total,
        limit,
        offset,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // GET /workflows/:id — Get workflow details
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const result = await getWorkflow.execute(req.params.id);
      if (!result.workflow) {
        return res.status(404).json({ error: 'Workflow not found' });
      }
      res.json({
        workflow: result.workflow.toJSON(),
        executions: result.executions.map(e => e.toJSON()),
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // GET /workflows/:id/graph — Get workflow DAG
  router.get('/:id/graph', async (req: Request, res: Response) => {
    try {
      const dag = await getWorkflowGraph.execute(req.params.id);
      if (!dag) {
        return res.status(404).json({ error: 'Workflow not found' });
      }
      res.json(dag);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // GET /workflows/executions/:id — Get execution details
  router.get('/executions/:id', async (req: Request, res: Response) => {
    try {
      const result = await getExecution.execute(req.params.id);
      if (!result.execution) {
        return res.status(404).json({ error: 'Execution not found' });
      }
      res.json({
        execution: result.execution.toJSON(),
        steps: result.steps.map(s => s.toJSON()),
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}