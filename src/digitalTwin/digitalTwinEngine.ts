/**
 * Digital Twin Engine
 * -------------------
 * High‑level orchestrator that wires together the four core components
 * defined in the specification:
 *   - SystemStateMirror
 *   - EventReplayEngine
 *   - EntitySimulationLayer (EntityRegistry)
 *   - EnvironmentModeler
 *
 * It exposes the three capabilities mentioned in the specification:
 *   1. Real‑time simulation
 *   2. Impact prediction
 *   3. What‑if analysis
 *
 * The implementation is deliberately lightweight – production‑grade logic
 * (e.g., persistence, distributed event bus integration) would be added by the
 * consuming application.
 */

import { SystemStateMirror, ISystemStateMirror, SystemEvent } from './systemStateMirror';
import { EventReplayEngine } from './eventReplayEngine';
import { EntityRegistry, SimulatedEntity } from './entitySimulationLayer';
import { EnvironmentModeler, EnvironmentModel } from './environmentModeler';

/**
 * Configuration for the Digital Twin Engine.
 */
export interface DigitalTwinConfig {
  /** If true, the engine will replay historic events on start‑up */
  replayOnStart?: boolean;
  /** Optional initial event set used when replayOnStart is true */
  initialEvents?: SystemEvent[];
}

/**
 * Core orchestrator class.
 */
export class DigitalTwinEngine {
  private readonly stateMirror: ISystemStateMirror;
  private readonly replayEngine: EventReplayEngine;
  private readonly entityRegistry: EntityRegistry;
  private readonly envModeler: EnvironmentModeler;

  constructor(
    envModel: EnvironmentModel,
    config: DigitalTwinConfig = {}
  ) {
    this.stateMirror = new SystemStateMirror();
    this.replayEngine = new EventReplayEngine(this.stateMirror);
    this.entityRegistry = new EntityRegistry();
    this.envModeler = new EnvironmentModeler();
    this.envModeler.load(envModel);

    if (config.replayOnStart && config.initialEvents) {
      // Initialise the state mirror with historic events.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.stateMirror.initialise(config.initialEvents);
    }
  }

  /** Register a simulated entity */
  public registerEntity(entity: SimulatedEntity): void {
    this.entityRegistry.register(entity);
  }

  /** Apply a live event coming from the Event Bus */
  public applyLiveEvent(event: SystemEvent): void {
    this.stateMirror.applyEvent(event);
  }

  /**
   * Run a single simulation tick – each entity receives the current global
   * snapshot and may update its own state. After all entities have ticked the
   * system snapshot is refreshed.
   */
  public tick(): void {
    const snapshot = this.stateMirror.getSnapshot().state;
    for (const entity of this.entityRegistry.all()) {
      entity.tick(snapshot);
    }
  }

  /**
   * Real‑time simulation loop – repeatedly calls {@link tick} at the supplied
   * interval (in milliseconds). The caller is responsible for cancelling the
   * returned timer when the simulation should stop.
   */
  public startRealtime(intervalMs: number): NodeJS.Timer {
    return setInterval(() => this.tick(), intervalMs);
  }

  /**
   * Predict the impact of a set of prospective events without mutating the
   * live state. Returns a snapshot representing the state after the events are
   * applied.
   */
  public async predictImpact(events: SystemEvent[]): Promise<Record<string, unknown>> {
    // Clone the current state mirror to avoid side‑effects.
    const clone = new SystemStateMirror();
    // Initialise clone with the current snapshot.
    const current = this.stateMirror.getSnapshot();
    await clone.initialise([
      // Create a synthetic event that sets the whole current state – this keeps
      // the logic simple and avoids exposing internal details of the mirror.
      { id: 'initial', timestamp: current.asOf, payload: current.state },
    ]);
    const tempEngine = new EventReplayEngine(clone);
    await tempEngine.replay(events);
    return clone.getSnapshot().state;
  }

  /**
   * Perform a what‑if analysis by applying a hypothetical event sequence and
   * then running a single simulation tick. The method returns the resulting
   * system snapshot.
   */
  public async whatIfAnalysis(events: SystemEvent[]): Promise<Record<string, unknown>> {
    const predictedState = await this.predictImpact(events);
    // Apply predicted state to a temporary mirror and run one tick.
    const tempMirror = new SystemStateMirror();
    await tempMirror.initialise([
      { id: 'whatIf', timestamp: new Date().toISOString(), payload: predictedState },
    ]);
    // Run a tick on entities using the temporary state.
    const snapshot = tempMirror.getSnapshot().state;
    for (const entity of this.entityRegistry.all()) {
      entity.tick(snapshot);
    }
    return tempMirror.getSnapshot().state;
  }
}
