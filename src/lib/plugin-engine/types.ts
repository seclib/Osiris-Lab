/**
 * Plugin Engine — Core type definitions
 *
 * SOLID: Interface Segregation — each consumer gets exactly what it needs.
 */

/* ------------------------------------------------------------------ */
/*  1. Manifest                                                        */
/* ------------------------------------------------------------------ */

export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  /** Unique plugin identifier (e.g. `@osiris/geo-fencing`) */
  id: string;
  /** Human-readable name */
  name: string;
  /** SemVer constraint the engine must satisfy */
  engineVersion: string;
  version: string;
  description?: string;
  author?: PluginAuthor;
  license?: string;
  /** Absolute URL or relative path to the entry point */
  entry: string;
  /** Declared capabilities (used by sandbox ACL) */
  capabilities?: PluginCapability[];
  /** Declared dependencies on other plugins */
  dependencies?: Record<string, string>;
  /** Optional frontend-facing metadata */
  ui?: PluginUIMetadata;
  /** Arbitrary custom metadata */
  meta?: Record<string, unknown>;
}

export interface PluginUIMetadata {
  label?: string;
  icon?: string;
  sidebar?: boolean;
  order?: number;
}

/* ------------------------------------------------------------------ */
/*  2. Capabilities & ACL                                              */
/* ------------------------------------------------------------------ */

export type PluginCapability =
  | 'network:fetch'
  | 'network:websocket'
  | 'storage:local'
  | 'storage:redis'
  | 'process:spawn'
  | 'fs:read'
  | 'fs:write'
  | 'event:emit'
  | 'event:listen'
  | 'api:expose';

export interface SandboxPolicy {
  allowedCapabilities: Set<PluginCapability>;
  /** Max memory in MB (0 = unlimited) */
  maxMemoryMB: number;
  /** Max CPU time in ms (0 = unlimited) */
  maxCpuMs: number;
  /** Allowed network origins (empty = all denied unless `network:*` granted) */
  allowedOrigins: string[];
}

/* ------------------------------------------------------------------ */
/*  3. Lifecycle hooks                                                 */
/* ------------------------------------------------------------------ */

export type PluginHook =
  | 'onLoad'
  | 'onUnload'
  | 'onActivate'
  | 'onDeactivate'
  | 'onConfigChange'
  | 'onTick'
  | 'onEvent';

export interface PluginHooks {
  onLoad?: (ctx: PluginContext) => void | Promise<void>;
  onUnload?: (ctx: PluginContext) => void | Promise<void>;
  onActivate?: (ctx: PluginContext) => void | Promise<void>;
  onDeactivate?: (ctx: PluginContext) => void | Promise<void>;
  onConfigChange?: (ctx: PluginContext, config: Record<string, unknown>) => void | Promise<void>;
  onTick?: (ctx: PluginContext) => void | Promise<void>;
  onEvent?: (ctx: PluginContext, event: string, payload: unknown) => void | Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  4. Plugin instance                                                 */
/* ------------------------------------------------------------------ */

export interface PluginContext {
  pluginId: string;
  manifest: PluginManifest;
  config: Record<string, unknown>;
  log: PluginLogger;
  events: PluginEventBus;
  api: PluginAPI;
}

export interface PluginLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PluginEventBus {
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: (payload: unknown) => void): () => void;
  off(event: string, handler: (payload: unknown) => void): void;
}

export interface PluginAPI {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  storage: PluginStorage;
}

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/* ------------------------------------------------------------------ */
/*  5. Plugin status & metadata                                        */
/* ------------------------------------------------------------------ */

export type PluginStatus =
  | 'registered'
  | 'loading'
  | 'loaded'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'inactive'
  | 'error'
  | 'unloaded';

export interface PluginMetadata {
  manifest: PluginManifest;
  status: PluginStatus;
  statusChangedAt: number;
  error?: string;
  diagnostics: PluginDiagnostics;
}

export interface PluginDiagnostics {
  loadTimeMs: number;
  memoryEstimateMB: number;
  hookCount: number;
  lastTickDurationMs?: number;
}

/* ------------------------------------------------------------------ */
/*  6. Engine events                                                   */
/* ------------------------------------------------------------------ */

export type EngineEvent =
  | { type: 'plugin:registered'; pluginId: string }
  | { type: 'plugin:loaded'; pluginId: string; durationMs: number }
  | { type: 'plugin:activated'; pluginId: string }
  | { type: 'plugin:deactivated'; pluginId: string }
  | { type: 'plugin:unloaded'; pluginId: string }
  | { type: 'plugin:error'; pluginId: string; error: string }
  | { type: 'plugin:configChanged'; pluginId: string }
  | { type: 'engine:started' }
  | { type: 'engine:stopped' }
  | { type: 'engine:error'; error: string };

export type EngineEventListener = (event: EngineEvent) => void;

/* ------------------------------------------------------------------ */
/*  7. Configuration                                                   */
/* ------------------------------------------------------------------ */

export interface PluginEngineConfig {
  /** Directory where plugins are stored */
  pluginsDir: string;
  /** Glob patterns for manifest discovery */
  manifestPattern?: string;
  /** Enable hot reload (file watching) */
  hotReload?: boolean;
  /** Debounce delay for hot reload in ms */
  hotReloadDebounceMs?: number;
  /** Default sandbox policy */
  defaultSandboxPolicy?: Partial<SandboxPolicy>;
  /** Per-plugin sandbox policy overrides */
  sandboxOverrides?: Record<string, Partial<SandboxPolicy>>;
  /** Logger instance (defaults to console) */
  logger?: PluginLogger;
}

/* ------------------------------------------------------------------ */
/*  8. DI container types                                              */
/* ------------------------------------------------------------------ */

/** Service identifier — can be a string token or a constructor */
export type ServiceIdentifier<T = unknown> =
  | string
  | symbol
  | { new (...args: unknown[]): T };

export interface ServiceDescriptor<T = unknown> {
  identifier: ServiceIdentifier<T>;
  factory: (container: Container) => T;
  singleton?: boolean;
  lazy?: boolean;
}

export interface Container {
  register<T>(descriptor: ServiceDescriptor<T>): void;
  resolve<T>(identifier: ServiceIdentifier<T>): T;
  has(identifier: ServiceIdentifier): boolean;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/*  9. Plugin factory (what a plugin module exports)                   */
/* ------------------------------------------------------------------ */

export interface PluginFactory {
  manifest: PluginManifest;
  hooks: PluginHooks;
  /** Optional config schema (JSON Schema) for validation */
  configSchema?: Record<string, unknown>;
}