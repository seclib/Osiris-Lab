/**
 * Plugin Engine — File Watcher (Hot Reload)
 *
 * Monitors the plugins directory for changes and triggers reloads.
 * Uses Node's built-in `fs.watch` with debouncing.
 *
 * SOLID: Single Responsibility — only concerned with file change detection and notification.
 */

import { watch, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginLogger } from './types';

/* ------------------------------------------------------------------ */
/*  Watcher events                                                     */
/* ------------------------------------------------------------------ */

export type WatchEventType = 'add' | 'change' | 'unlink';

export interface WatchEvent {
  type: WatchEventType;
  manifestPath: string;
  pluginId: string;
  timestamp: number;
}

export type WatchEventHandler = (event: WatchEvent) => void;

/* ------------------------------------------------------------------ */
/*  Default configuration                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MANIFEST_FILENAMES = ['plugin.json', 'manifest.json', '.plugin.json'];

/* ------------------------------------------------------------------ */
/*  PluginWatcher class                                                */
/* ------------------------------------------------------------------ */

export class PluginWatcher {
  private readonly _pluginsDir: string;
  private readonly _debounceMs: number;
  private readonly _logger: PluginLogger;
  private _watcher: ReturnType<typeof watch> | null = null;
  private _handlers: WatchEventHandler[] = [];
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _watching = false;

  constructor(
    pluginsDir: string,
    options?: {
      debounceMs?: number;
      logger?: PluginLogger;
    },
  ) {
    this._pluginsDir = resolve(pluginsDir);
    this._debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this._logger = options?.logger ?? console;
  }

  /* ------------------------------------------------------------------ */
  /*  Start watching                                                     */
  /* ------------------------------------------------------------------ */

  start(handler?: WatchEventHandler): void {
    if (this._watching) return;

    if (!existsSync(this._pluginsDir)) {
      this._logger.warn(
        `[PluginWatcher] Cannot watch non-existent directory: ${this._pluginsDir}`,
      );
      return;
    }

    if (handler) {
      this._handlers.push(handler);
    }

    try {
      this._watcher = watch(
        this._pluginsDir,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;
          this._handleFileChange(eventType, filename.toString());
        },
      );

      this._watching = true;
      this._logger.info(
        `[PluginWatcher] Watching ${this._pluginsDir} for plugin changes...`,
      );
    } catch (err) {
      this._logger.error(`[PluginWatcher] Failed to start watcher: ${err}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Stop watching                                                      */
  /* ------------------------------------------------------------------ */

  stop(): void {
    if (!this._watching || !this._watcher) return;

    this._watcher.close();
    this._watcher = null;
    this._watching = false;

    // Clear all pending debounce timers
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    this._logger.info('[PluginWatcher] Stopped.');
  }

  /* ------------------------------------------------------------------ */
  /*  Event handler management                                           */
  /* ------------------------------------------------------------------ */

  onEvent(handler: WatchEventHandler): () => void {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter((h) => h !== handler);
    };
  }

  removeAllHandlers(): void {
    this._handlers = [];
  }

  /* ------------------------------------------------------------------ */
  /*  Status                                                             */
  /* ------------------------------------------------------------------ */

  isWatching(): boolean {
    return this._watching;
  }

  /* ------------------------------------------------------------------ */
  /*  Private: handle file change                                        */
  /* ------------------------------------------------------------------ */

  private _handleFileChange(eventType: string, filename: string): void {
    // Only watch manifest files
    const isManifest = MANIFEST_FILENAMES.some(
      (mf) => filename === mf || filename.endsWith(`/${mf}`),
    );

    if (!isManifest) {
      // Also watch .js entry files for changes
      if (!filename.endsWith('.js') && !filename.endsWith('.mjs') && !filename.endsWith('.cjs')) {
        return;
      }
    }

    // Extract plugin ID from path structure: <pluginDir>/<pluginId>/manifest.json
    const parts = filename.split('/');
    const pluginId = parts.length >= 2 ? parts[0] : filename.replace(/\.(plugin\.json|json|js|mjs|cjs)$/, '');

    if (!pluginId) return;

    // Map fs.watch event types to our domain types
    const mappedType = this._mapEventType(eventType, filename);

    // Debounce per plugin
    const existingTimer = this._debounceTimers.get(pluginId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this._debounceTimers.delete(pluginId);

      const manifestPath = this._resolveManifestPath(filename);

      const event: WatchEvent = {
        type: mappedType,
        manifestPath,
        pluginId,
        timestamp: Date.now(),
      };

      this._logger.info(
        `[PluginWatcher] ${mappedType.toUpperCase()} ${pluginId} (${filename})`,
      );

      for (const handler of this._handlers) {
        try {
          handler(event);
        } catch (err) {
          this._logger.error(
            `[PluginWatcher] Handler error for ${pluginId}: ${err}`,
          );
        }
      }
    }, this._debounceMs);

    this._debounceTimers.set(pluginId, timer);
  }

  /* ------------------------------------------------------------------ */
  /*  Private: map fs event type                                         */
  /* ------------------------------------------------------------------ */

  private _mapEventType(eventType: string, filename: string): WatchEventType {
    if (eventType === 'rename') {
      // rename can mean either add or remove
      const fullPath = resolve(this._pluginsDir, filename);
      if (existsSync(fullPath)) return 'add';
      return 'unlink';
    }
    return 'change';
  }

  /* ------------------------------------------------------------------ */
  /*  Private: resolve manifest path from filename                       */
  /* ------------------------------------------------------------------ */

  private _resolveManifestPath(filename: string): string {
    // If the file itself is a manifest, return it directly
    const isManifest = MANIFEST_FILENAMES.some(
      (mf) => filename === mf || filename.endsWith(`/${mf}`),
    );

    if (isManifest) {
      return resolve(this._pluginsDir, filename);
    }

    // Otherwise, assume the file is an entry point and look for a manifest
    const parts = filename.split('/');
    const pluginDir = parts[0];

    for (const mf of MANIFEST_FILENAMES) {
      const candidatePath = resolve(this._pluginsDir, pluginDir, mf);
      if (existsSync(candidatePath)) return candidatePath;
    }

    return resolve(this._pluginsDir, pluginDir, 'plugin.json');
  }
}