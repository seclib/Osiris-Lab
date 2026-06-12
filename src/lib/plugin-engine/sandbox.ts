/**
 * Plugin Engine — Sandbox
 *
 * Provides an isolated execution context for plugins using Node's built-in
 * `vm` module with a capability-based ACL (Access Control List).
 *
 * SOLID: Single Responsibility — only concerned with secure execution isolation.
 */

import vm from 'node:vm';
import type {
  PluginCapability,
  PluginContext,
  PluginFactory,
  PluginLogger,
  PluginEventBus,
  PluginAPI,
  PluginStorage,
  SandboxPolicy,
} from './types';

/* ------------------------------------------------------------------ */
/*  Default sandbox policy                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_POLICY: SandboxPolicy = {
  allowedCapabilities: new Set<PluginCapability>([
    'event:emit',
    'event:listen',
    'storage:local',
  ]),
  maxMemoryMB: 128,
  maxCpuMs: 5000,
  allowedOrigins: [],
};

/* ------------------------------------------------------------------ */
/*  Sandbox creation options                                           */
/* ------------------------------------------------------------------ */

export interface SandboxOptions {
  policy?: Partial<SandboxPolicy>;
  contextFactory?: (pluginId: string) => Partial<PluginContext>;
  timeout?: number;
}

/* ------------------------------------------------------------------ */
/*  Sandbox class                                                      */
/* ------------------------------------------------------------------ */

export class PluginSandbox {
  private readonly _policy: SandboxPolicy;
  private readonly _timeout: number;
  private _context: PluginContext | null = null;
  private _contextFactory: ((pluginId: string) => Partial<PluginContext>) | null = null;

  constructor(options: SandboxOptions = {}) {
    this._policy = this._resolvePolicy(options.policy);
    this._timeout = options.timeout ?? options.policy?.maxCpuMs ?? DEFAULT_POLICY.maxCpuMs;
    this._contextFactory = options.contextFactory ?? null;
  }

  /* ------------------------------------------------------------------ */
  /*  Execute plugin code in sandbox                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Execute a plugin module's code string in a sandboxed VM context.
   * Returns the PluginFactory exported by the module.
   */
  async execute(
    code: string,
    filename: string,
    pluginId: string,
  ): Promise<PluginFactory> {
    this._assertCapability('fs:read');

    // Build the sandbox context
    const sandboxGlobals = this._createSandboxGlobals(pluginId);

    const context = vm.createContext(sandboxGlobals, {
      name: `plugin:${pluginId}`,
      origin: 'file:///plugins',
      codeGeneration: {
        strings: false,  // Disable eval() and friends
        wasm: false,     // Disable WebAssembly
      },
    });

    const vmScript = new vm.Script(code, {
      filename,
      lineOffset: 0,
      importModuleDynamically: async (specifier: string) => {
        throw new Error(
          `Dynamic imports are disabled in plugins. ` +
          `Plugin "${pluginId}" attempted to import "${specifier}".`,
        );
      },
    });

    const moduleWrapper = vmScript.runInContext(context, {
      timeout: this._timeout,
      breakOnSigint: true,
    });

    // Depending on module format, the export might be on `module.exports`
    // or returned directly. We normalize to PluginFactory.
    const moduleObj = sandboxGlobals['module'] as { exports: Record<string, unknown> } | undefined;
    const exports = moduleObj?.exports ?? moduleWrapper ?? {};

    if (typeof exports !== 'object' || exports === null) {
      throw new Error(
        `Plugin "${pluginId}" did not export a valid PluginFactory object.`,
      );
    }

    const factory = exports as Partial<PluginFactory>;

    if (!factory.manifest || !factory.hooks) {
      throw new Error(
        `Plugin "${pluginId}" must export { manifest, hooks } at minimum.`,
      );
    }

    return factory as PluginFactory;
  }

  /* ------------------------------------------------------------------ */
  /*  Execute a hook with timeout and error boundary                     */
  /* ------------------------------------------------------------------ */

  async executeHook(
    fn: () => void | Promise<void>,
    hookName: string,
    pluginId: string,
  ): Promise<void> {
    const timer = setTimeout(() => {
      throw new Error(
        `Plugin "${pluginId}" hook "${hookName}" timed out after ${this._timeout}ms.`,
      );
    }, this._timeout);

    try {
      await Promise.resolve(fn());
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Capability checks                                                  */
  /* ------------------------------------------------------------------ */

  assertCapability(capability: PluginCapability): void {
    this._assertCapability(capability);
  }

  hasCapability(capability: PluginCapability): boolean {
    return this._policy.allowedCapabilities.has(capability) ||
           this._policy.allowedCapabilities.has('*' as PluginCapability);
  }

  /* ------------------------------------------------------------------ */
  /*  Policy accessor                                                    */
  /* ------------------------------------------------------------------ */

  getPolicy(): Readonly<SandboxPolicy> {
    return Object.freeze({ ...this._policy, allowedCapabilities: new Set(this._policy.allowedCapabilities) });
  }

  /* ------------------------------------------------------------------ */
  /*  Context factory                                                    */
  /* ------------------------------------------------------------------ */

  setContextFactory(factory: (pluginId: string) => Partial<PluginContext>): void {
    this._contextFactory = factory;
  }

  /* ------------------------------------------------------------------ */
  /*  Private: create sandbox globals                                    */
  /* ------------------------------------------------------------------ */

  private _createSandboxGlobals(pluginId: string): Record<string, unknown> {
    // Track module.exports for extraction after execution
    type SandboxModule = { exports: Record<string, unknown> };
    const moduleObj: SandboxModule = { exports: {} };

    // Start with minimal safe globals
    const sandbox: Record<string, unknown> = {
      module: moduleObj,
      exports: moduleObj.exports,
      // Safe built-ins
      console: this._createSandboxConsole(pluginId),
      setTimeout: unsafeGlobal('setTimeout'),
      clearTimeout: unsafeGlobal('clearTimeout'),
      setInterval: undefined,  // Explicitly disabled
      clearInterval: undefined,
      Promise: unsafeGlobal('Promise'),
      Array: unsafeGlobal('Array'),
      Object: unsafeGlobal('Object'),
      Map: unsafeGlobal('Map'),
      Set: unsafeGlobal('Set'),
      WeakMap: unsafeGlobal('WeakMap'),
      WeakSet: unsafeGlobal('WeakSet'),
      String: unsafeGlobal('String'),
      Number: unsafeGlobal('Number'),
      Boolean: unsafeGlobal('Boolean'),
      Symbol: unsafeGlobal('Symbol'),
      BigInt: unsafeGlobal('BigInt'),
      Date: unsafeGlobal('Date'),
      Math: unsafeGlobal('Math'),
      JSON: unsafeGlobal('JSON'),
      RegExp: unsafeGlobal('RegExp'),
      Error: unsafeGlobal('Error'),
      TypeError: unsafeGlobal('TypeError'),
      RangeError: unsafeGlobal('RangeError'),
      ReferenceError: unsafeGlobal('ReferenceError'),
      SyntaxError: unsafeGlobal('SyntaxError'),
      URIError: unsafeGlobal('URIError'),
      parseInt: unsafeGlobal('parseInt'),
      parseFloat: unsafeGlobal('parseFloat'),
      isNaN: unsafeGlobal('isNaN'),
      isFinite: unsafeGlobal('isFinite'),
      encodeURI: unsafeGlobal('encodeURI'),
      encodeURIComponent: unsafeGlobal('encodeURIComponent'),
      decodeURI: unsafeGlobal('decodeURI'),
      decodeURIComponent: unsafeGlobal('decodeURIComponent'),

      // Plugin context (will be injected)
      __pluginContext__: null as unknown,
    };

    // Deny dangerous globals
    const denied = [
      'eval', 'Function', 'require', 'import',
      'process', 'global', 'globalThis', 'Buffer',
      'performance', 'queueMicrotask',
      'fetch', 'WebAssembly',
      'Reflect', 'Proxy',  // Prevent prototype pollution
    ];
    for (const key of denied) {
      sandbox[key] = undefined;
    }

    if (this.hasCapability('network:fetch')) {
      sandbox.fetch = (url: string, init?: RequestInit) => {
        this._checkOrigin(url);
        return fetch(url, init);
      };
    }

    return sandbox;
  }

  /* ------------------------------------------------------------------ */
  /*  Private: sandboxed console                                         */
  /* ------------------------------------------------------------------ */

  private _createSandboxConsole(pluginId: string): Console {
    const prefix = `[plugin:${pluginId}]`;

    return {
      ...console,
      log: (...args: unknown[]) => console.log(prefix, ...args),
      info: (...args: unknown[]) => console.info(prefix, ...args),
      warn: (...args: unknown[]) => console.warn(prefix, ...args),
      error: (...args: unknown[]) => console.error(prefix, ...args),
      debug: (...args: unknown[]) => console.debug(prefix, ...args),
      trace: (...args: unknown[]) => console.trace(prefix, ...args),
    } as Console;
  }

  /* ------------------------------------------------------------------ */
  /*  Private: origin check                                              */
  /* ------------------------------------------------------------------ */

  private _checkOrigin(url: string): void {
    if (this._policy.allowedOrigins.length === 0) {
      throw new Error(
        `Network access denied: no allowed origins configured.`,
      );
    }

    try {
      const parsed = new URL(url);
      const allowed = this._policy.allowedOrigins.some((origin) =>
        parsed.origin === origin || parsed.origin.endsWith(`.${origin}`),
      );
      if (!allowed) {
        throw new Error(
          `Network access to "${parsed.origin}" denied by sandbox policy. ` +
          `Allowed origins: ${this._policy.allowedOrigins.join(', ')}`,
        );
      }
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error(`Invalid URL: "${url}"`);
      }
      throw err;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: capability assertion                                      */
  /* ------------------------------------------------------------------ */

  private _assertCapability(capability: PluginCapability): void {
    if (!this.hasCapability(capability)) {
      throw new Error(
        `Capability "${capability}" is not granted by the sandbox policy.`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: resolve policy with defaults                              */
  /* ------------------------------------------------------------------ */

  private _resolvePolicy(override?: Partial<SandboxPolicy>): SandboxPolicy {
    return {
      allowedCapabilities: new Set([
        ...DEFAULT_POLICY.allowedCapabilities,
        ...(override?.allowedCapabilities ?? []),
      ]),
      maxMemoryMB: override?.maxMemoryMB ?? DEFAULT_POLICY.maxMemoryMB,
      maxCpuMs: override?.maxCpuMs ?? DEFAULT_POLICY.maxCpuMs,
      allowedOrigins: override?.allowedOrigins ?? DEFAULT_POLICY.allowedOrigins,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Helper: access a global safely                                     */
/* ------------------------------------------------------------------ */

function unsafeGlobal(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name] ?? undefined;
}