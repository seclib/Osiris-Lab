/**
 * OSIRIS-Lab v2 — Workflow Designer Service
 * 
 * DDD Value Objects for DAG (Directed Acyclic Graph).
 * Immutable by design, validated on construction.
 * 
 * Référence: docs/ARCHITECTURE.md §4.1 (Workflow model)
 */

import { Result, ok, err, ValidationError } from '../../../../libs/shared/src/domain/Result';

// ─── Types ─────────────────────────────────────────────────────────────────

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type NodeType = 'input' | 'process' | 'ai' | 'output' | 'condition' | 'loop' | 'plugin';

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface WorkflowNode {
  id: string;
  type: NodeType;
  name: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface DAG {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

// ─── Validation ────────────────────────────────────────────────────────────

const MAX_NODES = 100;
const MAX_EDGES = 500;

export interface DAGValidationResult {
  valid: boolean;
  errors: string[];
}

export class DAGValidator {
  /**
   * Validates a DAG structure:
   * - At least 1 node
   * - Max 100 nodes, 500 edges (memory protection)
   * - No duplicate IDs
   * - All edge refs exist
   * - No cycles (DFS)
   */
  static validate(dag: DAG): DAGValidationResult {
    const errors: string[] = [];

    if (!dag.nodes || dag.nodes.length === 0) {
      errors.push('DAG must have at least one node');
      return { valid: false, errors };
    }
    if (dag.nodes.length > MAX_NODES) {
      errors.push(`DAG exceeds maximum nodes (${MAX_NODES}): ${dag.nodes.length}`);
    }
    if (dag.edges.length > MAX_EDGES) {
      errors.push(`DAG exceeds maximum edges (${MAX_EDGES}): ${dag.edges.length}`);
    }

    const nodeIds = new Set<string>();
    for (const node of dag.nodes) {
      if (nodeIds.has(node.id)) errors.push(`Duplicate node ID: ${node.id}`);
      nodeIds.add(node.id);
    }

    const adjacency = new Map<string, string[]>();
    for (const node of dag.nodes) adjacency.set(node.id, []);

    for (const edge of dag.edges) {
      if (!nodeIds.has(edge.from)) errors.push(`Edge references non-existent source: ${edge.from}`);
      if (!nodeIds.has(edge.to)) errors.push(`Edge references non-existent target: ${edge.to}`);
      if (edge.from === edge.to) errors.push(`Self-loop detected: ${edge.from}`);
      adjacency.get(edge.from)?.push(edge.to);
    }

    if (this.hasCycle(adjacency)) errors.push('DAG contains a cycle');

    return { valid: errors.length === 0, errors };
  }

  /**
   * Creates a frozen, validated DAG value object.
   */
  static create(dag: DAG): Result<DAG, ValidationError> {
    const v = this.validate(dag);
    if (!v.valid) return err(new ValidationError('DAG', `Invalid DAG: ${v.errors.join(', ')}`, { errors: v.errors }));
    return ok(Object.freeze({
      nodes: dag.nodes.map(n => Object.freeze({ ...n })),
      edges: dag.edges.map(e => Object.freeze({ ...e })),
    }));
  }

  private static hasCycle(adjacency: Map<string, string[]>): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (id: string): boolean => {
      visited.add(id); stack.add(id);
      for (const n of adjacency.get(id) || []) {
        if (!visited.has(n)) { if (dfs(n)) return true; }
        else if (stack.has(n)) return true;
      }
      stack.delete(id);
      return false;
    };

    for (const id of adjacency.keys()) {
      if (!visited.has(id) && dfs(id)) return true;
    }
    return false;
  }
}

export function createDAG(nodes: WorkflowNode[], edges: WorkflowEdge[]): Result<DAG, ValidationError> {
  return DAGValidator.create({ nodes, edges });
}