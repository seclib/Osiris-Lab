/**
 * OSIRIS-Lab v2 — Workflow Unit Tests
 * 
 * Tests DDD Aggregate: Workflow
 * Tests state machine transitions, validation, and error handling.
 */

import { Workflow } from '../../../src/domain/entities/Workflow';
import { createDAG } from '../../../src/domain/value-objects/DAG';
import { ValidationError, ConflictError } from '../../../../libs/shared/src/domain/Result';

const validDAG = {
  nodes: [
    { id: '1', type: 'input' as const, name: 'Start' },
    { id: '2', type: 'process' as const, name: 'Analyze' },
    { id: '3', type: 'output' as const, name: 'End' },
  ],
  edges: [
    { from: '1', to: '2' },
    { from: '2', to: '3' },
  ],
};

const validProps = {
  id: 'wf-001',
  name: 'Test Workflow',
  description: 'A test workflow',
  dag: validDAG,
  createdBy: 'user-001',
};

describe('Workflow Aggregate', () => {
  // ─── Creation ─────────────────────────────────────────────────────────

  describe('create()', () => {
    it('should create a workflow with valid props', () => {
      const result = Workflow.create(validProps);
      expect(result.isOk()).toBe(true);
      const workflow = result.unwrap();
      expect(workflow.id).toBe('wf-001');
      expect(workflow.name).toBe('Test Workflow');
      expect(workflow.status).toBe('draft');
      expect(workflow.version).toBe(1);
    });

    it('should reject empty name', () => {
      const result = Workflow.create({ ...validProps, name: '' });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('Name is required');
      }
    });

    it('should reject name > 500 chars', () => {
      const result = Workflow.create({ ...validProps, name: 'a'.repeat(501) });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('500 characters');
      }
    });

    it('should reject DAG with cycles', () => {
      const cyclicDAG = {
        nodes: [
          { id: '1', type: 'input' as const, name: 'A' },
          { id: '2', type: 'process' as const, name: 'B' },
        ],
        edges: [
          { from: '1', to: '2' },
          { from: '2', to: '1' }, // Cycle!
        ],
      };
      const result = Workflow.create({ ...validProps, dag: cyclicDAG });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain('Invalid DAG');
        expect(result.error.message).toContain('cycle');
      }
    });

    it('should reject DAG with no nodes', () => {
      const emptyDAG = { nodes: [], edges: [] };
      const result = Workflow.create({ ...validProps, dag: emptyDAG });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain('at least one node');
      }
    });
  });

  // ─── State Machine ─────────────────────────────────────────────────────

  describe('state machine', () => {
    const createWorkflow = () => {
      const result = Workflow.create(validProps);
      return result.unwrap();
    };

    it('should start in draft status', () => {
      const wf = createWorkflow();
      expect(wf.status).toBe('draft');
    });

    it('should activate from draft', () => {
      const wf = createWorkflow();
      const result = wf.activate();
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().status).toBe('active');
    });

    it('should pause from active', () => {
      const wf = createWorkflow();
      const activated = wf.activate().unwrap();
      const result = activated.pause();
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().status).toBe('paused');
    });

    it('should reactivate from paused', () => {
      const wf = createWorkflow();
      const paused = wf.activate().unwrap().pause().unwrap();
      const result = paused.activate();
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().status).toBe('active');
    });

    it('should archive from any status', () => {
      const wf = createWorkflow();
      const archived = wf.archive();
      expect(archived.status).toBe('archived');
    });

    it('should reject activate from active', () => {
      const wf = createWorkflow();
      const active = wf.activate().unwrap();
      const result = active.activate();
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConflictError);
      }
    });

    it('should reject pause from draft', () => {
      const wf = createWorkflow();
      const result = wf.pause();
      expect(result.isErr()).toBe(true);
    });

    it('should reject pause from paused', () => {
      const wf = createWorkflow();
      const paused = wf.activate().unwrap().pause().unwrap();
      const result = paused.pause();
      expect(result.isErr()).toBe(true);
    });
  });

  // ─── Update ───────────────────────────────────────────────────────────

  describe('update()', () => {
    it('should update DAG and increment version', () => {
      const result = Workflow.create(validProps);
      const wf = result.unwrap();
      const newDAG = {
        nodes: [
          { id: '1', type: 'input' as const, name: 'Start' },
          { id: '4', type: 'output' as const, name: 'End' },
        ],
        edges: [{ from: '1', to: '4' }],
      };

      const updateResult = wf.update(newDAG, 'user-002');
      expect(updateResult.isOk()).toBe(true);
      const { workflow: updated } = updateResult.unwrap();
      expect(updated.version).toBe(2);
      expect(updated.dag.nodes).toHaveLength(2);
    });

    it('should reject update on archived workflow', () => {
      const wf = Workflow.create(validProps).unwrap().archive();
      const result = wf.update(validDAG, 'user-002');
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ConflictError);
        expect(result.error.message).toContain('archived');
      }
    });

    it('should return domain event on update', () => {
      const wf = Workflow.create(validProps).unwrap();
      const result = wf.update(validDAG, 'user-002');
      expect(result.isOk()).toBe(true);
      const { event } = result.unwrap();
      expect(event._tag).toBe('WorkflowUpdatedEvent');
      expect(event.changes).toContain('dag_modified');
      expect(event.updatedBy).toBe('user-002');
    });
  });

  // ─── Restore ──────────────────────────────────────────────────────────

  describe('restore()', () => {
    it('should restore from persisted props', () => {
      const wf = Workflow.restore({
        id: 'wf-002',
        name: 'Restored',
        dag: validDAG,
        version: 5,
        status: 'active',
        createdBy: 'user-001',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-06-01'),
      });
      expect(wf.id).toBe('wf-002');
      expect(wf.version).toBe(5);
      expect(wf.status).toBe('active');
    });
  });
});