/**
 * Plugin Engine — Orchestrator
 *
 * Enterprise-grade plugin engine that ties together the container, loader,
 * sandbox, manifest validation, and hot-reload watcher into a single
 * lifecycle-managed system.
 *
 * SOLID:
 *   - Single Responsibility: orchestrates the plugin lifecycle
 *   - Open/Closed: extend policies/behaviors via config, not inheritance
 *   - Liskov Substitution: all plugins conform to PluginFactory contract
 *   - Interface Segregation: consumers get focused interfaces (PluginContext, etc.)
 *   - Dependency Inversion: wired via DI container
 */

import type {
  PluginEngineConfig,
  PluginFactory,
  PluginHooks,
  PluginManifest,
  PluginMetadata,
  PluginStatus,
  PluginLogger,
  PluginContext,
  PluginEventBus,
  PluginAPI,
  PluginStorage,
  EngineEvent,
  EngineEventListener,
  SandboxPolicy,
  Container,
} from './types';
import { createContainer, LIFECYCLE } from './container';
import { PluginSandbox } from './sandbox';
import { PluginLoader, type PluginLoadResult } from './loader';
import { PluginWatcher, type WatchEvent } from './watcher';

/* ------------------------------------------------------------------ */
/*  Engine version                                                     */
/* ------------------------------------------------------------------ */

export const ENGINE_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/*  Engine class                                                       */
/* ------------------------------------------------------------------ */

export class PluginEngine {
  private readonly _config: PluginEngineConfig;
  private readonly _container: Container;
  private readonly _logger: PluginLogger;
  private _sandbox: PluginSandbox;
  private _loader: PluginLoader;
  private _watcher: PluginWatcher | null = null;
  private _plugins = new Map<string, PluginInstance>();
  private _eventListeners: EngineEventListener[] = [];
  private _started = false;

  constructor(config: PluginEngineConfig) {
    this._config = this._resolveConfig(config);
    this._logger = this._config.logger ?? console;

    // Create DI container
    this._container = createContainer();

    // Register core services
    this._registerCoreServices();

    // Create sandbox with resolved policies
    this._sandbox = new PluginSandbox({
      policy: this._resolveSandboxPolicy('__default__'),
    });

    // Create loader
    this._loader = new PluginLoader({
      pluginsDir: this._config.pluginsDir,
      manifestPattern: this._config.manifestPattern,
      sandbox: this._sandbox,
      logger: this._logger,
    });

    // Create watcher if hot reload is enabled
    if (this._config.hotReload) {
      this._watcher = new PluginWatcher(this._config.pluginsDir, {
        debounceMs: this._config.hotReloadDebounceMs,
        logger: this._logger,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle: start                                                   */
  /* ------------------------------------------------------------------ */

  async start(): Promise<void> {
    if (this._started) {
      this._logger.warn('[PluginEngine] Already started.');
      return;
    }

    this._logger.info(
      `[PluginEngine] Starting v${ENGINE_VERSION}...`,
    );

    // Load all plugins
    const { loaded, errors } = await this._loader.loadAll(ENGINE_VERSION);

    for (const error of errors) {
      this._emit({ type: 'plugin:error', pluginId: error.pluginId ?? 'unknown', error: error.error });
    }

    // Register and activate each loaded plugin
    for (const result of loaded) {
      await this._registerPlugin(result);
    }

    // Start watcher if hot reload is enabled
    if (this._watcher) {
      this._watcher.onEvent((event) => this._handleWatchEvent(event));
      this._watcher.start();
    }

    this._started = true;
    this._emit({ type: 'engine:started' });
    this._logger.info(
      `[PluginEngine] Started. ${loaded.length} plugin(s) active, ${errors.length} error(s).`,
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle: stop                                                    */
  /* ------------------------------------------------------------------ */

  async stop(): Promise<void> {
    if (!this._started) return;

    this._logger.info('[PluginEngine] Stopping...');

    // Deactivate all plugins in reverse order
    const pluginIds = Array.from(this._plugins.keys()).reverse();
    for (const pluginId of pluginIds) {
      await this.deactivatePlugin(pluginId);
    }

    // Stop watcher
    this._watcher?.stop();

    // Dispose container
    this._container.dispose();

    this._plugins.clear();
    this._started = false;
    this._emit({ type: 'engine:stopped' });
    this._logger.info('[PluginEngine] Stopped.');
  }

  /* ------------------------------------------------------------------ */
  /*  Plugin management                                                  */
  /* ------------------------------------------------------------------ */

  async registerPlugin(manifestPath: string): Promise<PluginMetadata> {
    const result = await this._loader.loadPlugin(manifestPath, ENGINE_VERSION);
    return this._registerPlugin(result);
  }

  async unregisterPlugin(pluginId: string): Promise<void> {
    const instance = this._plugins.get(pluginId);
    if (!instance) {
      throw new Error(`Plugin "${pluginId}" is not registered.`);
    }

    await this.deactivatePlugin(pluginId);
    await this._callHook(instance.factory.hooks, 'onUnload', instance.context);

    this._plugins.delete(pluginId);
    this._emit({ type: 'plugin:unloaded', pluginId });
    this._logger.info(`[PluginEngine] Unregistered plugin "${pluginId}".`);
  }

  async activatePlugin(pluginId: string): Promise<void> {
    const instance = this._plugins.get(pluginId);
    if (!instance) {
      throw new Error(`Plugin "${pluginId}" is not registered.`);
    }

    if (instance.metadata.status === 'active') return;

    instance.metadata.status = 'activating';
    instance.metadata.statusChangedAt = Date.now();

    try {
      await this._callHook(instance.factory.hooks, 'onActivate', instance.context);
      instance.metadata.status = 'active';
      instance.metadata.statusChangedAt = Date.now();
      this._emit({ type: 'plugin:activated', pluginId });
      this._logger.info(`[PluginEngine] Activated plugin "${pluginId}".`);
    } catch (err) {
      instance.metadata.status = 'error';
      instance.metadata.error = String(err);
      instance.metadata.statusChangedAt = Date.now();
      this._emit({ type: 'plugin:error', pluginId, error: String(err) });
      throw err;
    }
  }

  async deactivatePlugin(pluginId: string): Promise<void> {
    const instance = this._plugins.get(pluginId);
    if (!instance) return;

    if (instance.metadata.status === 'inactive' || instance.metadata.status === 'unloaded') return;

    instance.metadata.status = 'deactivating';
    instance.metadata.statusChangedAt = Date.now();

    try {
      await this._callHook(instance.factory.hooks, 'onDeactivate', instance.context);
      instance.metadata.status = 'inactive';
      instance.metadata.statusChangedAt = Date.now();
      this._emit({ type: 'plugin:deactivated', pluginId });
    } catch (err) {
      instance.metadata.status = 'error';
      instance.metadata.error = String(err);
      instance.metadata.statusChangedAt = Date.now();
      this._emit({ type: 'plugin:error', pluginId, error: String(err) });
    }
  }

  async reloadPlugin(pluginId: string): Promise<PluginMetadata> {
    const instance = this._plugins.get(pluginId);
    if (!instance) {
      throw new Error(`Plugin "${pluginId}" is not registered.`);
    }

    // Deactivate old version
    await this.deactivatePlugin(pluginId);

    // Reload from manifest
    const result = await this._loader.reloadPlugin(
      instance.manifestPath,
      ENGINE_VERSION,
    );

    // Replace in registry
    const newInstance = this._createPluginInstance(result);
    this._plugins.set(pluginId, newInstance);

    // Activate new version
    await this.activatePlugin(pluginId);

    return newInstance.metadata;
  }

  /* ------------------------------------------------------------------ */
  /*  Query methods                                                      */
  /* ------------------------------------------------------------------ */

  getPluginMetadata(pluginId: string): PluginMetadata | null {
    return this._plugins.get(pluginId)?.metadata ?? null;
  }

  listPlugins(): PluginMetadata[] {
    return Array.from(this._plugins.values()).map((i) => i.metadata);
  }

  getPluginStatus(pluginId: string): PluginStatus | null {
    return this._plugins.get(pluginId)?.metadata.status ?? null;
  }

  getContainer(): Container {
    return this._container;
  }

  isStarted(): boolean {
    return this._started;
  }

  /* ------------------------------------------------------------------ */
  /*  Event system                                                       */
  /* ------------------------------------------------------------------ */

  onEvent(listener: EngineEventListener): () => void {
    this._eventListeners.push(listener);
    return () => {
      this._eventListeners = this._eventListeners.filter((l) => l !== listener);
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private: register a loaded plugin                                  */
  /* ------------------------------------------------------------------ */

  private async _registerPlugin(result: PluginLoadResult): Promise<PluginMetadata> {
    const { pluginId, manifest, factory, sourceFile, loadTimeMs, warnings } = result;

    // Check for duplicates
    if (this._plugins.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" is already registered. Unregister first.`);
    }

    // Emit registered event
    this._emit({ type: 'plugin:registered', pluginId });

    const instance = this._createPluginInstance(result);

    // Set initial metadata
    instance.metadata.diagnostics.loadTimeMs = loadTimeMs;

    // Call onLoad hook
    instance.metadata.status = 'loading';
    instance.metadata.statusChangedAt = Date.now();
    this._emit({ type: 'plugin:loaded', pluginId, durationMs: loadTimeMs });

    try {
      await this._callHook(factory.hooks, 'onLoad', instance.context);
      instance.metadata.status = 'loaded';
      instance.metadata.statusChangedAt = Date.now();
    } catch (err) {
      instance.metadata.status = 'error';
      instance.metadata.error = String(err);
      instance.metadata.statusChangedAt = Date.now();
      this._emit({ type: 'plugin:error', pluginId, error: String(err) });
      this._logger.error(`[PluginEngine] Plugin "${pluginId}" onLoad failed: ${err}`);
    }

    this._plugins.set(pluginId, instance);

    // Auto-activate if status is 'loaded' (not error)
    if (instance.metadata.status === 'loaded') {
      await this.activatePlugin(pluginId);
    }

    return instance.metadata;
  }

  /* ------------------------------------------------------------------ */
  /*  Private: create plugin instance                                    */
  /* ------------------------------------------------------------------ */

  private _createPluginInstance(result: PluginLoadResult): PluginInstance {
    const { pluginId, manifest, factory, sourceFile } = result;

    const context = this._createPluginContext(pluginId, manifest, factory);

    return {
      pluginId,
      manifest,
      manifestPath: sourceFile,
      factory,
      context,
      metadata: {
        manifest,
        status: 'registered',
        statusChangedAt: Date.now(),
        diagnostics: {
          loadTimeMs: 0,
          memoryEstimateMB: 0,
          hookCount: Object.keys(factory.hooks).length,
        },
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private: create plugin context                                     */
  /* ------------------------------------------------------------------ */

  private _createPluginContext(
    pluginId: string,
    manifest: PluginManifest,
    factory: PluginFactory,
  ): PluginContext {
    const events = this._createPluginEventBus(pluginId);

    return {
      pluginId,
      manifest,
      config: {},
      log: this._createPluginLogger(pluginId),
      events,
      api: {
        fetch: async (url: string, init?: RequestInit) => {
          this._sandbox.assertCapability('network:fetch');
          return fetch(url, init);
        },
        storage: this._createPluginStorage(pluginId),
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private: create plugin logger                                      */
  /* ------------------------------------------------------------------ */

  private _createPluginLogger(pluginId: string): PluginLogger {
    const prefix = `[plugin:${pluginId}]`;
    return {
      trace: (...args) => this._logger.trace?.(prefix, ...args),
      debug: (...args) => this._logger.debug?.(prefix, ...args),
      info: (...args) => this._logger.info(prefix, ...args),
      warn: (...args) => this._logger.warn(prefix, ...args),
      error: (...args) => this._logger.error(prefix, ...args),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private: create plugin event bus                                   */
  /* ------------------------------------------------------------------ */

  private _createPluginEventBus(pluginId: string): PluginEventBus {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();

    return {
      emit: (event: string, payload?: unknown) => {
        const set = handlers.get(event);
        if (set) {
          for (const handler of set) {
            try {
              handler(payload);
            } catch (err) {
              this._logger.error(
                `[PluginEngine] Plugin "${pluginId}" event handler error for "${event}": ${err}`,
              );
            }
          }
        }
      },
      on: (event: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => {
          handlers.get(event)?.delete(handler);
        };
      },
      off: (event: string, handler: (payload: unknown) => void) => {
        handlers.get(event)?.delete(handler);
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private: create plugin storage                                     */
  /* ------------------------------------------------------------------ */

  private _createPluginStorage(pluginId: string): PluginStorage {
    const store = new Map<string, string>();

    return {
      get: async <T>(key: string): Promise<T | null> => {
        const raw = store.get(`plugin:${pluginId}:${key}`);
        if (raw === undefined) return null;
        return JSON.parse(raw) as T;
      },
      set: async <T>(key: string, value: T): Promise<void> => {
        store.set(`plugin:${pluginId}:${key}`, JSON.stringify(value));
      },
      delete: async (key: string): Promise<void> => {
        store.delete(`plugin:${pluginId}:${key}`);
      },
      list: async (prefix?: string): Promise<string[]> => {
        const searchPrefix = `plugin:${pluginId}:${prefix ?? ''}`;
        return Array.from(store.keys())
          .filter((k) => k.startsWith(searchPrefix))
          .map((k) => k.slice(`plugin:${pluginId}:`.length));
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private: call a plugin hook with error boundary                    */
  /* ------------------------------------------------------------------ */

  private async _callHook(
    hooks: PluginHooks,
    hookName: keyof PluginHooks,
    context: PluginContext,
    ...args: unknown[]
  ): Promise<void> {
    const hook = hooks[hookName];
    if (!hook) return;

    try {
      await this._sandbox.executeHook(
        () => (hook as (...a: unknown[]) => void | Promise<void>)(context, ...args),
        hookName,
        context.pluginId,
      );
    } catch (err) {
      this._logger.error(
        `[PluginEngine] Hook "${hookName}" failed for plugin "${context.pluginId}": ${err}`,
      );
      throw err;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: handle watch event (hot reload)                           */
  /* ------------------------------------------------------------------ */

  private async _handleWatchEvent(event: WatchEvent): Promise<void> {
    this._logger.info(
      `[PluginEngine] Hot reload event: ${event.type} ${event.pluginId}`,
    );

    try {
      switch (event.type) {
        case 'add':
        case 'change':
          if (this._plugins.has(event.pluginId)) {
            await this.reloadPlugin(event.pluginId);
          } else {
            await this.registerPlugin(event.manifestPath);
          }
          break;
        case 'unlink':
          if (this._plugins.has(event.pluginId)) {
            await this.unregisterPlugin(event.pluginId);
          }
          break;
      }
    } catch (err) {
      this._logger.error(
        `[PluginEngine] Hot reload failed for "${event.pluginId}": ${err}`,
      );
      this._emit({
        type: 'plugin:error',
        pluginId: event.pluginId,
        error: String(err),
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: emit engine event                                         */
  /* ------------------------------------------------------------------ */

  private _emit(event: EngineEvent): void {
    for (const listener of this._eventListeners) {
      try {
        listener(event);
      } catch (err) {
        this._logger.error(`[PluginEngine] Event listener error: ${err}`);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: resolve sandbox policy for a plugin                       */
  /* ------------------------------------------------------------------ */

  private _resolveSandboxPolicy(pluginId: string): Partial<SandboxPolicy> {
    const defaultPolicy = this._config.defaultSandboxPolicy;
    const override = this._config.sandboxOverrides?.[pluginId];

    if (!defaultPolicy && !override) return {};
    if (defaultPolicy && !override) return defaultPolicy;
    if (!defaultPolicy && override) return override;

    // Merge: override wins
    return {
      ...defaultPolicy,
      ...override,
      allowedCapabilities: new Set([
        ...(defaultPolicy?.allowedCapabilities ?? []),
        ...(override?.allowedCapabilities ?? []),
      ]) as unknown as SandboxPolicy['allowedCapabilities'],
    } as Partial<SandboxPolicy>;
  }

  /* ------------------------------------------------------------------ */
  /*  Private: register core DI services                                 */
  /* ------------------------------------------------------------------ */

  private _registerCoreServices(): void {
    // Register self
    this._container.register({
      identifier: LIFECYCLE.ENGINE,
      factory: () => this,
      singleton: true,
    });

    // Register sandbox factory
    this._container.register({
      identifier: LIFECYCLE.SANDBOX,
      factory: () => this._sandbox,
      singleton: true,
    });

    // Register loader
    this._container.register({
      identifier: LIFECYCLE.LOADER,
      factory: () => this._loader,
      singleton: true,
    });

    // Register config
    this._container.register({
      identifier: LIFECYCLE.CONFIG,
      factory: () => this._config,
      singleton: true,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Private: resolve config with defaults                              */
  /* ------------------------------------------------------------------ */

  private _resolveConfig(config: PluginEngineConfig): PluginEngineConfig {
    return {
      ...config,
      manifestPattern: config.manifestPattern ?? 'plugin.json',
      hotReload: config.hotReload ?? false,
      hotReloadDebounceMs: config.hotReloadDebounceMs ?? 300,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Internal PluginInstance type                                        */
/* ------------------------------------------------------------------ */

interface PluginInstance {
  pluginId: string;
  manifest: PluginManifest;
  manifestPath: string;
  factory: PluginFactory;
  context: PluginContext;
  metadata: PluginMetadata;
}

/* ------------------------------------------------------------------ */
/*  Factory function                                                    */
/* ------------------------------------------------------------------ */

export function createPluginEngine(config: PluginEngineConfig): PluginEngine {
  return new PluginEngine(config);
}