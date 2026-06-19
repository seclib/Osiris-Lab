/**
 * OSIRIS-Lab v2 — DAG Validator Unit Tests
 * 
 * Tests the DAG (Directed Acyclic Graph) validation logic.
 */

import { DAGValidator } from '../../../src/domain/value-objects/DAG';

const validDAG = {
  nodes: [
    { id: '1', type: 'input' as const, name: 'Start' },
    { id: '2', type: 'process' as const, name: 'Process' },
    { id: '3', type: 'output' as const, name: 'End' },
  ],
  edges: [
    { from: '1', to: '2' },
    { from: '2', to: '3' },
  ],
};

describe('DAGValidator', () => {
  describe('validate()', () => {
    it('should return valid for a correct DAG', () => {
      const result = DAGValidator.validate(validDAG);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject empty nodes', () => {
      const result = DAGValidator.validate({ nodes: [], edges: [] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('DAG must have at least one node');
    });

    it('should reject duplicate node IDs', () => {
      const dag = {
        nodes: [
          { id: '1', type: 'input' as const, name: 'A' },
          { id: '1', type: 'process' as const, name: 'B' },
        ],
        edges: [],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duplicate node ID: 1');
    });

    it('should reject edge referencing non-existent source', () => {
      const dag = {
        nodes: [{ id: '1', type: 'input' as const, name: 'A' }],
        edges: [{ from: '999', to: '1' }],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Edge references non-existent source node: 999');
    });

    it('should reject edge referencing non-existent target', () => {
      const dag = {
        nodes: [{ id: '1', type: 'input' as const, name: 'A' }],
        edges: [{ from: '1', to: '999' }],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Edge references non-existent target node: 999');
    });

    it('should reject self-loops', () => {
      const dag = {
        nodes: [{ id: '1', type: 'input' as const, name: 'A' }],
        edges: [{ from: '1', to: '1' }],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Self-loop detected on node: 1');
    });

    it('should reject direct cycle (A→B→A)', () => {
      const dag = {
        nodes: [
          { id: 'A', type: 'input' as const, name: 'A' },
          { id: 'B', type: 'process' as const, name: 'B' },
        ],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'A' },
        ],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('DAG contains a cycle');
    });

    it('should reject indirect cycle (A→B→C→A)', () => {
      const dag = {
        nodes: [
          { id: 'A', type: 'input' as const, name: 'A' },
          { id: 'B', type: 'process' as const, name: 'B' },
          { id: 'C', type: 'process' as const, name: 'C' },
        ],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
          { from: 'C', to: 'A' },
        ],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('DAG contains a cycle');
    });

    it('should accept a DAG with multiple disconnected subgraphs', () => {
      const dag = {
        nodes: [
          { id: '1', type: 'input' as const, name: 'A' },
          { id: '2', type: 'process' as const, name: 'B' },
          { id: '3', type: 'input' as const, name: 'C' },
          { id: '4', type: 'process' as const, name: 'D' },
        ],
        edges: [
          { from: '1', to: '2' },
          { from: '3', to: '4' },
        ],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(true);
    });

    it('should accept a DAG with a diamond shape (A→B, A→C, B→D, C→D)', () => {
      const dag = {
        nodes: [
          { id: 'A', type: 'input' as const, name: 'A' },
          { id: 'B', type: 'process' as const, name: 'B' },
          { id: 'C', type: 'process' as const, name: 'C' },
          { id: 'D', type: 'output' as const, name: 'D' },
        ],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'C' },
          { from: 'B', to: 'D' },
          { from: 'C', to: 'D' },
        ],
      };
      const result = DAGValidator.validate(dag);
      expect(result.valid).toBe(true);
    });
  });

  describe('create()', () => {
    it('should return Ok for valid DAG', () => {
      const result = DAGValidator.create(validDAG);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const dag = result.unwrap();
        expect(dag.nodes).toHaveLength(3);
        expect(dag.edges).toHaveLength(2);
      }
    });

    it('should return Err for invalid DAG', () => {
      const result = DAGValidator.create({ nodes: [], edges: [] });
      expect(result.isErr()).toBe(true);
    });

    it('should freeze the returned DAG (immutability)', () => {
      const result = DAGValidator.create(validDAG);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const dag = result.unwrap();
        expect(Object.isFrozen(dag)).toBe(true);
        expect(Object.isFrozen(dag.nodes[0])).toBe(true);
        expect(Object.isFrozen(dag.edges[0])).toBe(true);
      }
    });
  });
});