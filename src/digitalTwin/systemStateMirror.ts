/**
 * System State Mirror
 * -------------------
 * Provides a logical copy of the current Osiris system state.
 * The mirror is kept in sync with the Event Bus and can be queried
 * for a point‑in‑time snapshot.
 */

/**
 * Minimal representation of an event that can affect the system state.
 */
export interface SystemEvent {
  /** Unique identifier of the event */
  id: string;
  /** Timestamp of when the event occurred (ISO 8601) */
  timestamp: string;
  /** Arbitrary payload describing the change */
  payload: Record<string, unknown>;
}

/**
 * Snapshot of the entire system state at a given moment.
 */
export interface SystemStateSnapshot {
  /** The moment the snapshot represents */
  asOf: string;
  /** Arbitrary state representation – callers define the shape */
  state: Record<string, unknown>;
}

/**
 * Interface describing the responsibilities of the System State Mirror.
 */
export interface ISystemStateMirror {
  /** Apply an incoming event to the internal state */
  applyEvent(event: SystemEvent): void;
  /** Retrieve a snapshot of the current state */
  getSnapshot(): SystemStateSnapshot;
  /** Initialise the mirror by replaying historic events */
  initialise(initialEvents: SystemEvent[]): Promise<void>;
}

/**
 * Concrete implementation of the System State Mirror.
 * It stores the state in a simple in‑memory map and updates it
 * deterministically based on incoming events.
 */
export class SystemStateMirror implements ISystemStateMirror {
  private state: Record<string, unknown> = {};

  /** Apply an event – the default implementation merges the payload */
  public applyEvent(event: SystemEvent): void {
    // Simple shallow merge; real logic should be defined by the payload schema.
    Object.assign(this.state, event.payload);
  }

  public getSnapshot(): SystemStateSnapshot {
    return {
      asOf: new Date().toISOString(),
      state: { ...this.state },
    };
  }

  public async initialise(initialEvents: SystemEvent[]): Promise<void> {
    for (const ev of initialEvents) {
      this.applyEvent(ev);
    }
  }
}
