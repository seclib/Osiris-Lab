/**
 * Event Replay Engine
 * -------------------
 * Consumes a chronological list of {@link SystemEvent} objects and replays
 * them against a {@link ISystemStateMirror}. The engine is deterministic –
 * given the same event sequence the resulting state will always be identical.
 */

import { SystemEvent, ISystemStateMirror } from './systemStateMirror';

/**
 * Configuration for the replay engine.
 */
export interface ReplayEngineConfig {
  /** If true, the engine will stop on the first error */
  failFast?: boolean;
}

/**
 * The Event Replay Engine.
 */
export class EventReplayEngine {
  private readonly mirror: ISystemStateMirror;
  private readonly config: ReplayEngineConfig;

  constructor(mirror: ISystemStateMirror, config: ReplayEngineConfig = {}) {
    this.mirror = mirror;
    this.config = config;
  }

  /**
   * Replay a collection of events in chronological order.
   * The caller is responsible for providing events already sorted by timestamp.
   */
  public async replay(events: SystemEvent[]): Promise<void> {
    for (const ev of events) {
      try {
        this.mirror.applyEvent(ev);
      } catch (err) {
        if (this.config.failFast) {
          throw err;
        }
        // otherwise ignore and continue – production code would log the error.
      }
    }
  }
}
