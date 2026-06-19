/**
 * Entity Simulation Layer
 * ----------------------
 * Simulates individual entities (users, services, devices, threats, …) that
 * exist inside the digital twin. Each entity implements a common interface so
 * the simulation engine can drive them uniformly.
 */

/**
 * Base definition of an entity that can be simulated.
 */
export interface SimulatedEntity {
  /** Unique identifier of the entity */
  id: string;
  /** Current logical state – the shape is free‑form and defined by the concrete
   *  implementation.
   */
  state: Record<string, unknown>;
  /** Advance the entity's internal state by one simulation tick.
   *  The method receives the global system snapshot so the entity can react to
   *  changes elsewhere in the twin.
   */
  tick(globalSnapshot: Record<string, unknown>): void;
}

/**
 * Simple in‑memory registry for simulated entities.
 */
export class EntityRegistry {
  private readonly entities = new Map<string, SimulatedEntity>();

  public register(entity: SimulatedEntity): void {
    this.entities.set(entity.id, entity);
  }

  public get(id: string): SimulatedEntity | undefined {
    return this.entities.get(id);
  }

  public all(): IterableIterator<SimulatedEntity> {
    return this.entities.values();
  }
}
