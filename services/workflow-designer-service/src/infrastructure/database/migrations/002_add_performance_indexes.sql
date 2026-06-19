-- OSIRIS-Lab v2 — Workflow Designer Service
-- Migration 002: Performance indexes
-- Référence: docs/ARCHITECTURE.md §4.1, docs/SCALING_STRATEGY.md §3

-- Index pour ORDER BY updated_at DESC (listing workflows)
CREATE INDEX IF NOT EXISTS idx_workflows_updated_at ON workflows(updated_at DESC);

-- Index composite pour les recherches fréquentes
CREATE INDEX IF NOT EXISTS idx_workflows_status_updated ON workflows(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_status ON workflow_executions(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_execution_status ON workflow_steps(execution_id, status);