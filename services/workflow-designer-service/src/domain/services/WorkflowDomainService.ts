import { Workflow, WorkflowNodeType, WorkflowStatus } from '../entities/Workflow';

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface WorkflowExecutionInput {
  workflowId: string;
  input: Record<string, unknown>;
  triggeredBy: string;
}

export class WorkflowDomainService {
  /**
   * Validate workflow business rules
   */
  validate(workflow: Workflow): WorkflowValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic validation from entity
    const basicValidation = workflow.validate();
    if (!basicValidation.valid) {
      errors.push(...basicValidation.errors);
    }

    // Additional business rules
    if (workflow.status === WorkflowStatus.ACTIVE) {
      // Check if workflow has executable nodes
      const executableNodes = workflow.dag.nodes.filter(
        n => n.type === WorkflowNodeType.PROCESS || 
             n.type === WorkflowNodeType.AI ||
             n.type === WorkflowNodeType.NOTIFICATION ||
             n.type === WorkflowNodeType.SIEM
      );

      if (executableNodes.length === 0) {
        warnings.push('Active workflow has no executable nodes');
      }
    }

    // Check node configurations
    for (const node of workflow.dag.nodes) {
      if (!node.config || Object.keys(node.config).length === 0) {
        warnings.push(`Node ${node.id} (${node.name}) has no configuration`);
      }
    }

    // Check for disconnected nodes
    const connectedNodes = new Set<string>();
    for (const edge of workflow.dag.edges) {
      connectedNodes.add(edge.from);
      connectedNodes.add(edge.to);
    }

    for (const node of workflow.dag.nodes) {
      if (!connectedNodes.has(node.id) && workflow.dag.nodes.length > 1) {
        warnings.push(`Node ${node.id} (${node.name}) is disconnected`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Check if workflow can be executed
   */
  canExecute(workflow: Workflow): { canExecute: boolean; reason?: string } {
    if (workflow.status !== WorkflowStatus.ACTIVE) {
      return {
        canExecute: false,
        reason: `Workflow is ${workflow.status}, must be ACTIVE to execute`,
      };
    }

    const validation = this.validate(workflow);
    if (!validation.valid) {
      return {
        canExecute: false,
        reason: `Workflow validation failed: ${validation.errors.join(', ')}`,
      };
    }

    return { canExecute: true };
  }

  /**
   * Get execution order of nodes (topological sort)
   */
  getExecutionOrder(workflow: Workflow): string[] {
    const adjacencyList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    // Initialize
    for (const node of workflow.dag.nodes) {
      adjacencyList.set(node.id, []);
      inDegree.set(node.id, 0);
    }

    // Build graph
    for (const edge of workflow.dag.edges) {
      adjacencyList.get(edge.from)?.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }

    // Topological sort (Kahn's algorithm)
    const queue: string[] = [];
    const result: string[] = [];

    // Find nodes with no incoming edges
    for (const [nodeId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(nodeId);
      }
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      result.push(nodeId);

      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newDegree);

        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    if (result.length !== workflow.dag.nodes.length) {
      throw new Error('Workflow contains a cycle');
    }

    return result;
  }

  /**
   * Get parallel execution groups
   */
  getExecutionGroups(workflow: Workflow): string[][] {
    const executionOrder = this.getExecutionOrder(workflow);
    const groups: string[][] = [];
    const nodeLevels = new Map<string, number>();

    // Calculate level for each node (longest path from input)
    const adjacencyList = new Map<string, string[]>();
    for (const node of workflow.dag.nodes) {
      adjacencyList.set(node.id, []);
    }
    for (const edge of workflow.dag.edges) {
      adjacencyList.get(edge.from)?.push(edge.to);
    }

    const calculateLevel = (nodeId: string): number => {
      if (nodeLevels.has(nodeId)) {
        return nodeLevels.get(nodeId)!;
      }

      const predecessors = workflow.dag.edges
        .filter(e => e.to === nodeId)
        .map(e => e.from);

      if (predecessors.length === 0) {
        nodeLevels.set(nodeId, 0);
        return 0;
      }

      const maxPredecessorLevel = Math.max(...predecessors.map(p => calculateLevel(p)));
      const level = maxPredecessorLevel + 1;
      nodeLevels.set(nodeId, level);
      return level;
    };

    // Calculate levels for all nodes
    for (const nodeId of executionOrder) {
      calculateLevel(nodeId);
    }

    // Group by level
    const levelGroups = new Map<number, string[]>();
    for (const [nodeId, level] of nodeLevels.entries()) {
      const group = levelGroups.get(level) || [];
      group.push(nodeId);
      levelGroups.set(level, group);
    }

    // Convert to array
    for (const [level, nodes] of Array.from(levelGroups.entries()).sort((a, b) => a[0] - b[0])) {
      groups.push(nodes);
    }

    return groups;
  }

  /**
   * Estimate workflow execution duration
   */
  estimateDuration(workflow: Workflow): { estimatedMs: number; confidence: 'low' | 'medium' | 'high' } {
    let totalMs = 0;
    let nodeCount = 0;

    for (const node of workflow.dag.nodes) {
      // Estimate based on node type
      switch (node.type) {
        case WorkflowNodeType.INPUT:
        case WorkflowNodeType.OUTPUT:
          // Minimal duration
          totalMs += 100;
          break;
        case WorkflowNodeType.PROCESS:
          // Average processing time
          totalMs += 1000;
          break;
        case WorkflowNodeType.AI:
          // AI tasks take longer
          totalMs += 5000;
          break;
        case WorkflowNodeType.CONDITION:
          // Quick evaluation
          totalMs += 200;
          break;
        case WorkflowNodeType.LOOP:
          // Variable, estimate 10 iterations
          totalMs += 10000;
          break;
        case WorkflowNodeType.NOTIFICATION:
          // External call
          totalMs += 500;
          break;
        case WorkflowNodeType.SIEM:
          // External API call
          totalMs += 2000;
          break;
      }
      nodeCount++;
    }

    // Adjust confidence based on workflow complexity
    let confidence: 'low' | 'medium' | 'high' = 'high';
    if (nodeCount > 10) {
      confidence = 'medium';
    }
    if (nodeCount > 20) {
      confidence = 'low';
    }

    return {
      estimatedMs: totalMs,
      confidence,
    };
  }
}