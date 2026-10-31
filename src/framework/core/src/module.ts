/**
 * Modules.
 *
 * A module is the unit of composition: it contributes providers, lifecycle
 * hooks, and (in later phases) routes, listeners, and jobs. Modules are data —
 * `defineModule` freezes a descriptor and returns it. Importing a module never
 * performs IO and never constructs anything.
 */

import type { Provider } from '@tsir/container';

import type { CapabilityRequirement } from './capabilities.ts';

export interface ModuleContext {
  readonly module: string;
  readonly clock: { now(): Date; iso(): string; monotonicMs(): number };
  readonly signal: AbortSignal;
}

export interface ModuleDefinition {
  /** Stable, unique name. Used in diagnostics, manifests, and the unit graph. */
  readonly name: string;
  readonly providers?: readonly Provider<unknown>[];
  readonly requires?: readonly CapabilityRequirement[];
  readonly onStart?: (context: ModuleContext) => void | Promise<void>;
  readonly onReady?: (context: ModuleContext) => void | Promise<void>;
  readonly onStop?: (context: ModuleContext) => void | Promise<void>;
}

export function defineModule(definition: ModuleDefinition): ModuleDefinition {
  if (definition.name.trim() === '') {
    throw new TypeError('defineModule: `name` must not be empty');
  }
  return Object.freeze({
    ...definition,
    providers: Object.freeze([...(definition.providers ?? [])]),
    requires: Object.freeze([...(definition.requires ?? [])]),
  });
}

/** Validates the module set before anything is constructed. */
export function validateModules(modules: readonly ModuleDefinition[]): void {
  if (modules.length === 0) {
    throw new TypeError('bootstrap: at least one module is required');
  }
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.name)) {
      throw new TypeError(`bootstrap: duplicate module "${module.name}"`);
    }
    seen.add(module.name);
  }
}
