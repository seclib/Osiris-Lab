/**
 * Plugin Engine — Inversion of Control Container
 *
 * SOLID: Dependency Inversion Principle (DIP)
 * - High-level modules do not depend on low-level modules; both depend on abstractions.
 * - This container wires everything together.
 */

import type { Container, ServiceDescriptor, ServiceIdentifier } from './types';

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

interface RegisteredService<T = unknown> {
  descriptor: ServiceDescriptor<T>;
  instance: T | null;
  resolving: boolean;
}

function isStringOrSymbol(id: ServiceIdentifier): id is string | symbol {
  return typeof id === 'string' || typeof id === 'symbol';
}

/* ------------------------------------------------------------------ */
/*  Token-based lifecycle                                               */
/* ------------------------------------------------------------------ */

export const LIFECYCLE = {
  ENGINE: Symbol('lifecycle:engine'),
  SANDBOX: Symbol('lifecycle:sandbox'),
  LOADER: Symbol('lifecycle:loader'),
  WATCHER: Symbol('lifecycle:watcher'),
  CONFIG: Symbol('lifecycle:config'),
} as const;

/* ------------------------------------------------------------------ */
/*  DefaultContainer implementation                                     */
/* ------------------------------------------------------------------ */

export class DefaultContainer implements Container {
  private readonly _services = new Map<ServiceIdentifier, RegisteredService>();

  /* -- Register a service descriptor --------------------------------- */

  register<T>(descriptor: ServiceDescriptor<T>): void {
    const { identifier } = descriptor;

    if (this._services.has(identifier)) {
      throw new Error(
        `Service "${describeIdentifier(identifier)}" is already registered. ` +
        'Use `has()` to check before registering, or design for override.',
      );
    }

    this._services.set(identifier, {
      descriptor,
      instance: null,
      resolving: false,
    });
  }

  /* -- Resolve a service ---------------------------------------------- */

  resolve<T>(identifier: ServiceIdentifier<T>): T {
    const registered = this._services.get(identifier);

    if (!registered) {
      // If identifier looks like a constructor, try auto-wiring
      if (typeof identifier === 'function' && identifier.prototype) {
        return this._autoWire(identifier as unknown as { new (...args: unknown[]): T });
      }

      throw new Error(
        `Service "${describeIdentifier(identifier)}" is not registered. ` +
        'Register it first with `container.register()`.',
      );
    }

    return this._resolveInstance(registered) as T;
  }

  /* -- Check if service is registered --------------------------------- */

  has(identifier: ServiceIdentifier): boolean {
    return this._services.has(identifier);
  }

  /* -- Dispose all singleton instances --------------------------------- */

  dispose(): void {
    for (const [, registered] of this._services) {
      if (registered.descriptor.singleton !== false && registered.instance !== null) {
        const obj = registered.instance as Record<string, unknown>;
        if (typeof obj.dispose === 'function') {
          (obj as { dispose: () => void }).dispose();
        }
      }
      registered.instance = null;
    }
    this._services.clear();
  }

  /* -- Get all registered identifiers (useful for diagnostics) -------- */

  getIdentifiers(): ServiceIdentifier[] {
    return Array.from(this._services.keys());
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

  private _resolveInstance<T>(registered: RegisteredService<T>): T {
    const { descriptor } = registered;

    // Singleton: return cached instance if exists
    if (descriptor.singleton !== false) {
      if (registered.instance !== null) return registered.instance;
    }

    // Guard against circular dependencies
    if (registered.resolving) {
      throw new Error(
        `Circular dependency detected while resolving "${describeIdentifier(descriptor.identifier)}".`,
      );
    }

    registered.resolving = true;
    try {
      const instance = descriptor.factory(this);
      if (descriptor.singleton !== false) {
        registered.instance = instance;
      }
      return instance;
    } finally {
      registered.resolving = false;
    }
  }

  private _autoWire<T>(ctor: { new (...args: unknown[]): T }): T {
    // Naive auto-wiring: not implemented for production.
    // Real DI containers use reflect-metadata for parameter discovery.
    throw new Error(
      `Auto-wiring is not supported. Register "${ctor.name || 'constructor'}" explicitly via register().`,
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Utility: create a pre-configured container                          */
/* ------------------------------------------------------------------ */

export function createContainer(): Container {
  return new DefaultContainer();
}

/* ------------------------------------------------------------------ */
/*  Utility: describe identifier for error messages                     */
/* ------------------------------------------------------------------ */

function describeIdentifier(id: ServiceIdentifier): string {
  if (typeof id === 'string') return id;
  if (typeof id === 'symbol') return id.description ?? '(symbol)';
  return id.name ?? '(anonymous class)';
}