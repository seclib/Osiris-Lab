export enum WorkflowStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  PAUSED = 'paused',
  ARCHIVED = 'archived',
}

export enum WorkflowNodeType {
  INPUT = 'input',
  OUTPUT = 'output',
  PROCESS = 'process',
  AI = 'ai',
  CONDITION = 'condition',
  LOOP = 'loop',
  NOTIFICATION = 'notification',
  SIEM = 'siem',
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name: string;
  config: Record<string, unknown>;
  position?: {
    x: number;
    y: number;
  };
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
}

export interface WorkflowDAG {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowProps {
  id?: string;
  name: string;
  description?: string;
  dag: WorkflowDAG;
  version?: number;
  status?: WorkflowStatus;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
  lastExecuted?: Date;
}

export class Workflow {
  public readonly id: string;
  public name: string;
  public description: string;
  public dag: WorkflowDAG;
  public version: number;
  public status: WorkflowStatus;
  public readonly createdBy: string;
  public readonly createdAt: Date;
  public updatedAt: Date;
  public lastExecuted?: Date;

  constructor(props: WorkflowProps) {
    this.id = props.id || this.generateId();
    this.name = props.name;
    this.description = props.description || '';
    this.dag = props.dag;
    this.version = props.version || 1;
    this.status = props.status || WorkflowStatus.DRAFT;
    this.createdBy = props.createdBy;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
    this.lastExecuted = props.lastExecuted;
  }

  private generateId(): string {
    return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  public activate(): void {
    if (this.status === WorkflowStatus.DRAFT) {
      this.status = WorkflowStatus.ACTIVE;
      this.updatedAt = new Date();
    }
  }

  public pause(): void {
    if (this.status === WorkflowStatus.ACTIVE) {
      this.status = WorkflowStatus.PAUSED;
      this.updatedAt = new Date();
    }
  }

  public archive(): void {
    this.status = WorkflowStatus.ARCHIVED;
    this.updatedAt = new Date();
  }

  public updateDAG(dag: WorkflowDAG): void {
    this.dag = dag;
    this.version += 1;
    this.updatedAt = new Date();
  }

  public validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Name required
    if (!this.name || this.name.trim().length === 0) {
      errors.push('Workflow name is required');
    }

    // DAG must have at least one node
    if (this.dag.nodes.length === 0) {
      errors.push('Workflow must have at least one node');
    }

    // DAG must have at least one input and one output node
    const inputNodes = this.dag.nodes.filter(n => n.type === WorkflowNodeType.INPUT);
    const outputNodes = this.dag.nodes.filter(n => n.type === WorkflowNodeType.OUTPUT);

    if (inputNodes.length === 0) {
      errors.push('Workflow must have at least one input node');
    }

    if (outputNodes.length === 0) {
      errors.push('Workflow must have at least one output node');
    }

    // Validate edges
    const nodeIds = new Set(this.dag.nodes.map(n => n.id));
    for (const edge of this.dag.edges) {
      if (!nodeIds.has(edge.from)) {
        errors.push(`Invalid edge: source node ${edge.from} not found`);
      }
      if (!nodeIds.has(edge.to)) {
        errors.push(`Invalid edge: target node ${edge.to} not found`);
      }
    }

    // Check for cycles (simple check)
    if (this.hasCycle()) {
      errors.push('Workflow contains a cycle');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private hasCycle(): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const adjacencyList = new Map<string, string[]>();
    for (const node of this.dag.nodes) {
      adjacencyList.set(node.id, []);
    }
    for (const edge of this.dag.edges) {
      adjacencyList.get(edge.from)?.push(edge.to);
    }

    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);

      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (recursionStack.has(neighbor)) {
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    for (const node of this.dag.nodes) {
      if (!visited.has(node.id)) {
        if (dfs(node.id)) return true;
      }
    }

    return false;
  }

  public toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      dag: this.dag,
      version: this.version,
      status: this.status,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastExecuted: this.lastExecuted,
    };
  }
}