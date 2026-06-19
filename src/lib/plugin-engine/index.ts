/**
 * Plugin Engine — Public API
 *
 * Barrel file exporting all public types and the main engine factory.
 * Use this as the single entry point for consumers.
 */

export { PluginEngine, createPluginEngine, ENGINE_VERSION } from './engine';
export { PluginSandbox } from './sandbox';
export { PluginLoader, type LoaderOptions, type PluginLoadResult, type PluginLoadError } from './loader';
export { PluginWatcher, type WatchEvent, type WatchEventType, type WatchEventHandler } from './watcher';
export { DefaultContainer, createContainer, LIFECYCLE } from './container';
export { validateManifest, checkDependencies, type ManifestValidation } from './manifest';

export type {
  // Manifest
  PluginManifest,
  PluginAuthor,
  PluginUIMetadata,

  // Capabilities & ACL
  PluginCapability,
  SandboxPolicy,

  // Lifecycle
  PluginHook,
  PluginHooks,

  // Plugin instance
  PluginContext,
  PluginLogger,
  PluginEventBus,
  PluginAPI,
  PluginStorage,

  // Status & metadata
  PluginStatus,
  PluginMetadata,
  PluginDiagnostics,

  // Events
  EngineEvent,
  EngineEventListener,

  // Config
  PluginEngineConfig,

  // DI
  ServiceIdentifier,
  ServiceDescriptor,
  Container,

  // Factory
  PluginFactory,
} from './types';