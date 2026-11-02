/**
 * Modules.
 *
 * A module is the unit of composition: it contributes providers, lifecycle
 * hooks, and (in later phases) routes, listeners, and jobs. Modules are data —
 * `defineModule` freezes a descriptor and returns it. Importing a module never
 * performs IO and never constructs anything.
 */

import type { ConfigSpec, InferConfig } from '@tsir/config';
import type { Provider } from '@tsir/container';

import type { CapabilityRequirement } from './capabilities.ts';

export interface ModuleContext<TConfig extends ConfigSpec = ConfigSpec> {
  readonly module: string;
  /** The resolved, validated config for this module.
   *
   * If the module declared a `config` spec via `defineModule({ config })`, this is
   * `InferConfig<that spec>`. Otherwise it is the application config (an empty object
   * `{}` when the application declares no config of its own.
   */
  readonly config: InferConfig<TConfig>;
  readonly clock: { now(): Date; iso(): string; monotonicMs(): number };
  readonly signal: AbortSignal;
}

export interface ModuleDefinition<TConfig extends ConfigSpec = ConfigSpec> {
  /** Stable, unique name. Used in diagnostics, manifests, and the unit graph. */
  readonly name: string;
  /** Optional config spec for this module. Extends the application config spec.
   *
   * Defaults to an empty spec when omitted — `ctx.config` will then equals the application
   * config. Use `moduleConfig(appConfig, { ... })` to override defaults or add
   * module-specific fields.
   */
  readonly config?: TConfig;
  readonly providers?: readonly Provider<unknown>[];
  readonly requires?: readonly CapabilityRequirement[];
  readonly onStart?: (context: ModuleContext<TConfig>) => void | Promise<void>;
  readonly onReady?: (context: ModuleContext<TConfig>) => void | Promise<void>;
  readonly onStop?: (context: ModuleContext<TConfig>) => void | Promise<void>;
}

export function defineModule<TConfig extends ConfigSpec = ConfigSpec>(
  definition: ModuleDefinition<TConfig>,
): ModuleDefinition<TConfig> {
  if (definition.name.trim() === '') {
    throw new TypeError('defineModule: `name` must not be empty');
  }
  return Object.freeze({
    ...definition,
    providers: Object.freeze([...(definition.providers ?? [])]),
    requires: Object.freeze([...(definition.requires ?? [])]),
  }) as ModuleDefinition<TConfig>;
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
