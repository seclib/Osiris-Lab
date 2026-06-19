export enum ExecutionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  TERMINATED = 'terminated',
  CANCELLED = 'cancelled',
}

export enum StepStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export interface WorkflowStep {
  id: string;
  executionId: string;
  nodeId: string;
  nodeType: string;
  status: StepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
}

export interface WorkflowExecutionProps {
  id?: string;
  workflowId: string;
  workflowVersion: number;
  status?: ExecutionStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  steps?: WorkflowStep[];
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  triggeredBy: string;
}

export class WorkflowExecution {
  public readonly id: string;
  public readonly workflowId: string;
  public readonly workflowVersion: number;
  public status: ExecutionStatus;
  public readonly input: Record<string, unknown>;
  public output: Record<string, unknown>;
  public readonly steps: WorkflowStep[];
  public error?: string;
  public startedAt?: Date;
  public completedAt?: Date;
  public readonly createdAt: Date;
  public readonly triggeredBy: string;

  constructor(props: WorkflowExecutionProps) {
    this.id = props.id || this.generateId();
    this.workflowId = props.workflowId;
    this.workflowVersion = props.workflowVersion;
    this.status = props.status || ExecutionStatus.PENDING;
    this.input = props.input;
    this.output = props.output || {};
    this.steps = props.steps || [];
    this.error = props.error;
    this.startedAt = props.startedAt;
    this.completedAt = props.completedAt;
    this.createdAt = props.createdAt || new Date();
    this.triggeredBy = props.triggeredBy;
  }

  private generateId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  public start(): void {
    if (this.status === ExecutionStatus.PENDING) {
      this.status = ExecutionStatus.RUNNING;
      this.startedAt = new Date();
    }
  }

  public complete(output: Record<string, unknown>): void {
    if (this.status === ExecutionStatus.RUNNING) {
      this.status = ExecutionStatus.COMPLETED;
      this.output = output;
      this.completedAt = new Date();
    }
  }

  public fail(error: string): void {
    if (this.status === ExecutionStatus.RUNNING) {
      this.status = ExecutionStatus.FAILED;
      this.error = error;
      this.completedAt = new Date();
    }
  }

  public terminate(reason?: string): void {
    if (this.status === ExecutionStatus.RUNNING || this.status === ExecutionStatus.PENDING) {
      this.status = ExecutionStatus.TERMINATED;
      this.error = reason || 'Terminated by user';
      this.completedAt = new Date();
    }
  }

  public addStep(step: WorkflowStep): void {
    this.steps.push(step);
  }

  public updateStep(stepId: string, updates: Partial<WorkflowStep>): void {
    const step = this.steps.find(s => s.id === stepId);
    if (step) {
      Object.assign(step, updates);
    }
  }

  public getDuration(): number | null {
    if (this.startedAt && this.completedAt) {
      return this.completedAt.getTime() - this.startedAt.getTime();
    }
    return null;
  }

  public isRunning(): boolean {
    return this.status === ExecutionStatus.RUNNING;
  }

  public isCompleted(): boolean {
    return this.status === ExecutionStatus.COMPLETED;
  }

  public toJSON() {
    return {
      id: this.id,
      workflowId: this.workflowId,
      workflowVersion: this.workflowVersion,
      status: this.status,
      input: this.input,
      output: this.output,
      steps: this.steps,
      error: this.error,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      createdAt: this.createdAt,
      triggeredBy: this.triggeredBy,
      duration: this.getDuration(),
    };
  }
}