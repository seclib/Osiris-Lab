/**
 * Plugin Engine — Dynamic Loader
 *
 * Discovers, validates, and loads plugins from the filesystem.
 * Supports loading from local directories and remote URLs.
 *
 * SOLID: Open/Closed — extend by adding new loader strategies without modifying this class.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import type { PluginFactory, PluginManifest, PluginLogger } from './types';
import { PluginSandbox } from './sandbox';
import { validateManifest, checkDependencies } from './manifest';

/* ------------------------------------------------------------------ */
/*  Loader options                                                     */
/* ------------------------------------------------------------------ */

export interface LoaderOptions {
  pluginsDir: string;
  manifestPattern?: string;
  sandbox?: PluginSandbox;
  logger?: PluginLogger;
}

/* ------------------------------------------------------------------ */
/*  Load result                                                        */
/* ------------------------------------------------------------------ */

export interface PluginLoadResult {
  pluginId: string;
  manifest: PluginManifest;
  factory: PluginFactory;
  sourceFile: string;
  loadTimeMs: number;
  warnings: string[];
}

export interface PluginLoadError {
  pluginId?: string;
  sourceFile?: string;
  error: string;
}

/* ------------------------------------------------------------------ */
/*  Manifest file discovery                                            */
/* ------------------------------------------------------------------ */

const MANIFEST_FILENAMES = ['plugin.json', 'manifest.json', '.plugin.json'];

/* ------------------------------------------------------------------ */
/*  PluginLoader class                                                 */
/* ------------------------------------------------------------------ */

export class PluginLoader {
  private readonly _pluginsDir: string;
  private readonly _manifestPattern: string;
  private readonly _sandbox: PluginSandbox;
  private readonly _logger: PluginLogger;

  constructor(options: LoaderOptions) {
    this._pluginsDir = resolve(options.pluginsDir);
    this._manifestPattern = options.manifestPattern ?? 'plugin.json';
    this._sandbox = options.sandbox ?? new PluginSandbox({});
    this._logger = options.logger ?? console;
  }

  /* ------------------------------------------------------------------ */
  /*  Discover manifests                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Discover all plugin manifests in the configured directory.
   * Returns a map of plugin ID → manifest path.
   */
  discoverManifests(): Map<string, string> {
    const results = new Map<string, string>();

    if (!existsSync(this._pluginsDir)) {
      this._logger.warn(`[PluginLoader] Plugins directory not found: ${this._pluginsDir}`);
      return results;
    }

    const entries = readdirSync(this._pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = join(this._pluginsDir, entry.name);

      for (const manifestFile of MANIFEST_FILENAMES) {
        const manifestPath = join(pluginDir, manifestFile);
        if (existsSync(manifestPath)) {
          try {
            const manifest = this._readManifest(manifestPath);
            if (manifest) {
              results.set(manifest.id, manifestPath);
            }
          } catch (err) {
            this._logger.error(
              `[PluginLoader] Failed to read manifest at ${manifestPath}: ${err}`,
            );
          }
          break; // Only one manifest per directory
        }
      }
    }

    // Also search for standalone manifest files (non-directory based)
    const standalonePattern = this._manifestPattern;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === standalonePattern || entry.name.endsWith('.plugin.json')) {
        const manifestPath = join(this._pluginsDir, entry.name);
        try {
          const manifest = this._readManifest(manifestPath);
          if (manifest) {
            results.set(manifest.id, manifestPath);
          }
        } catch (err) {
          this._logger.error(
            `[PluginLoader] Failed to read manifest at ${manifestPath}: ${err}`,
          );
        }
      }
    }

    return results;
  }

  /* ------------------------------------------------------------------ */
  /*  Load a single plugin                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Load a single plugin from its manifest path.
   * Validates the manifest, resolves the entry point, and executes in sandbox.
   */
  async loadPlugin(
    manifestPath: string,
    engineVersion?: string,
  ): Promise<PluginLoadResult> {
    const startTime = performance.now();

    // Read and validate manifest
    const rawManifest = this._readManifest(manifestPath);
    if (!rawManifest) {
      throw new Error(`Failed to read manifest from ${manifestPath}`);
    }

    const validation = validateManifest(rawManifest, engineVersion);
    if (!validation.valid) {
      throw new Error(
        `Invalid manifest at ${manifestPath}:\n${validation.errors.join('\n')}`,
      );
    }

    const manifest = rawManifest as PluginManifest;

    // Resolve entry point
    const entryPath = this._resolveEntryPath(manifestPath, manifest.entry);
    if (!existsSync(entryPath)) {
      throw new Error(
        `Entry point not found for plugin "${manifest.id}": ${entryPath}`,
      );
    }

    // Read and execute in sandbox
    const code = readFileSync(entryPath, 'utf-8');
    const entryFilename = entryPath;

    let factory: PluginFactory;
    try {
      factory = await this._sandbox.execute(code, entryFilename, manifest.id);
    } catch (err) {
      throw new Error(
        `Failed to execute plugin "${manifest.id}" in sandbox: ${err}`,
      );
    }

    const loadTimeMs = performance.now() - startTime;

    this._logger.info(
      `[PluginLoader] Loaded plugin "${manifest.id}" ` +
      `v${manifest.version} in ${loadTimeMs.toFixed(1)}ms`,
    );

    return {
      pluginId: manifest.id,
      manifest,
      factory,
      sourceFile: entryPath,
      loadTimeMs,
      warnings: validation.warnings,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Load all discovered plugins                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Discover and load all plugins.
   * Validates dependency graph before loading.
   */
  async loadAll(engineVersion?: string): Promise<{
    loaded: PluginLoadResult[];
    errors: PluginLoadError[];
  }> {
    const manifests = this.discoverManifests();
    const loaded: PluginLoadResult[] = [];
    const errors: PluginLoadError[] = [];

    if (manifests.size === 0) {
      this._logger.info('[PluginLoader] No plugins discovered.');
      return { loaded, errors };
    }

    // Build registry for dependency checking
    const registry = new Map<string, PluginManifest>();

    for (const [id, mPath] of manifests) {
      try {
        const loadedManifest = this._readManifest(mPath);
        if (loadedManifest) {
          registry.set(id, loadedManifest);
        }
      } catch {
        // Will be caught during actual loading
      }
    }

    // Check dependencies for each
    for (const [, mPath] of manifests) {
      try {
        const loadedManifest = this._readManifest(mPath);
        if (!loadedManifest) continue;
        const depErrors = checkDependencies(loadedManifest, registry);
        if (depErrors.length > 0) {
          errors.push({
            pluginId: loadedManifest.id,
            sourceFile: mPath,
            error: `Dependency check failed:\n${depErrors.join('\n')}`,
          });
          continue;
        }

        const result = await this.loadPlugin(mPath, engineVersion);
        loaded.push(result);
      } catch (err) {
        errors.push({
          sourceFile: mPath,
          error: String(err),
        });
      }
    }

    this._logger.info(
      `[PluginLoader] Loaded ${loaded.length} plugin(s), ${errors.length} error(s).`,
    );

    return { loaded, errors };
  }

  /* ------------------------------------------------------------------ */
  /*  Reload a single plugin                                             */
  /* ------------------------------------------------------------------ */

  async reloadPlugin(
    manifestPath: string,
    engineVersion?: string,
  ): Promise<PluginLoadResult> {
    this._logger.info(`[PluginLoader] Reloading plugin at ${manifestPath}`);
    return this.loadPlugin(manifestPath, engineVersion);
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

  private _readManifest(manifestPath: string): PluginManifest | null {
    const content = readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    // Support both root-level and wrapped formats
    const raw = (parsed.manifest && typeof parsed.manifest === 'object')
      ? parsed.manifest as Record<string, unknown>
      : parsed;

    // Validate that required fields exist before returning
    if (
      typeof raw.id === 'string' &&
      typeof raw.name === 'string' &&
      typeof raw.engineVersion === 'string' &&
      typeof raw.version === 'string' &&
      typeof raw.entry === 'string'
    ) {
      return raw as unknown as PluginManifest;
    }

    return null;
  }

  private _resolveEntryPath(manifestPath: string, entry: string): string {
    // If entry is an absolute URL, return as-is
    if (entry.startsWith('http://') || entry.startsWith('https://')) {
      return entry;
    }

    const manifestDir = resolve(manifestPath, '..');
    const resolved = resolve(manifestDir, entry);

    // Try with common extensions if no extension
    if (!extname(resolved)) {
      for (const ext of ['.js', '.mjs', '.cjs', '.ts']) {
        const withExt = resolved + ext;
        if (existsSync(withExt)) return withExt;
      }
    }

    return resolved;
  }
}