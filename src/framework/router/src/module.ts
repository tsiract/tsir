/**
 * Module-owned routes (`MOD-002`).
 *
 * A controller registers itself into a `RouteRegistry` at import time — that is
 * what makes decorators work without reflection. The *table* is what has to be
 * scoped, and a single process-global registry cannot be scoped to anything.
 *
 * So a module owns a registry:
 *
 * ```ts
 * // modules/users/routes.ts
 * export const registry = new RouteRegistry();
 * export const users = routeModule({ name: 'users', registry, unit: 'http' });
 *
 * // modules/users/users.controller.ts
 * @Controller(registry, '/users')
 * export class UsersController { … }
 * ```
 *
 * `users.module` goes into `defineApp({ modules })` like any other module; the
 * app assembles its handler from `users.routes()`. Nothing about the module is
 * HTTP-specific from `@tsir/core`'s point of view — the module type stays a
 * `ModuleDefinition`, so this file adds a *composition helper*, not a second kind
 * of module.
 *
 * ## Why the module list is also process-local
 *
 * `tsir route:list` and `tsir route:compile` discover routes by importing the
 * application entry; they never see the app object. With per-module registries
 * the global registry is empty, so `collectRouteEntries()` unions the global
 * registry with every declared module — de-duplicated by controller class, so a
 * dev-server reload cannot double every route.
 *
 * Both registries are **declaration-time** state: written during import, read
 * once, then frozen. That is the only global mutable state the framework allows
 * (`16-modularity.md § 4`), and `MOD-004` adds the assertion that it is clean
 * again after a test app is disposed.
 */

import { defineModule, type ModuleDefinition } from '@tsir/core';
import type { CapabilityRequirement } from '@tsir/core';
import type { Provider } from '@tsir/container';

import { compileRoutes } from './compile.ts';
import { type ControllerEntry, type RouteRegistry, routeRegistry } from './registry.ts';
import type { RouteTable } from './types.ts';

export interface RouteModuleOptions {
  /** Unique module name; also what `tsir route:list` prints and boot errors name. */
  readonly name: string;
  /** The module's own registry. Controllers in this module are declared against it. */
  readonly registry: RouteRegistry;
  /** Deploy unit every route in this module belongs to, unless a route overrides it. */
  readonly unit?: string;
  readonly providers?: readonly Provider<unknown>[];
  readonly requires?: readonly CapabilityRequirement[];
  readonly onStart?: ModuleDefinition['onStart'];
  readonly onReady?: ModuleDefinition['onReady'];
  readonly onStop?: ModuleDefinition['onStop'];
}

export interface RouteModule {
  /** The module to pass to `defineApp({ modules })`. */
  readonly module: ModuleDefinition;
  readonly registry: RouteRegistry;
  /** Deploy unit this module's routes belong to, if it declared one. */
  readonly unit?: string;
  /**
   * The compiled, sorted table for **this** module.
   *
   * Compiled on first access and memoised: a controller file imported after this
   * one still registers before boot, and a dev-server reload creates a new
   * module rather than mutating this table.
   */
  routes(): RouteTable;
}

/** Every route module declared in this process, in declaration order. */
const DECLARED: RouteModule[] = [];

export function routeModule(options: RouteModuleOptions): RouteModule {
  const { registry } = options;
  let compiled: RouteTable | undefined;

  const module = defineModule({
    name: options.name,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    ...(options.onStart === undefined ? {} : { onStart: options.onStart }),
    ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
    ...(options.onStop === undefined ? {} : { onStop: options.onStop }),
  });

  const created: RouteModule = {
    module,
    registry,
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    routes: () => {
      compiled ??= compileRoutes(withDefaultUnit(registry.entries(), options.unit));
      return compiled;
    },
  };

  DECLARED.push(created);
  return created;
}

/**
 * Applies the module's unit to controllers that did not declare one.
 *
 * A route-level `unit` always wins: the module is the default, not an override.
 * This is what makes "the media module deploys as `media`" a property of the
 * module rather than something every controller has to remember to repeat.
 */
function withDefaultUnit(
  entries: readonly ControllerEntry[],
  unit: string | undefined,
): readonly ControllerEntry[] {
  if (unit === undefined) return entries;
  return entries.map((entry) => (entry.unit === undefined ? { ...entry, unit } : entry));
}

/** Modules declared in this process. Read by the CLI; never mutated after boot. */
export function routeModules(): readonly RouteModule[] {
  return DECLARED;
}

/**
 * Every declared controller, from the global registry and from every module.
 *
 * Order is deterministic (global first, then modules in declaration order,
 * then registration order) because `compileRoutes` sorts the table anyway and
 * two compilations of the same modules must produce the same file.
 *
 * De-duplication is by **controller class**: registering the same class in two
 * registries is a wiring mistake, not two sets of routes.
 *
 * `scope` narrows which declared modules are read. The CLI reads everything
 * (it is describing the process); the test harness passes only the modules of
 * the app under test, so two fixtures that both declare a `users` module cannot
 * collide in one process (`MOD-006`).
 *
 * A module's `unit` is applied here, not only in `routes()`, so `tsir route:list`
 * and `route:compile` see the same attribution the runtime does. One place
 * decides what a module's unit means; every reader gets that answer.
 */
export function collectRouteEntries(scope?: readonly RouteModule[]): readonly ControllerEntry[] {
  const seen = new Set<unknown>();
  const entries: ControllerEntry[] = [];

  for (const entry of routeRegistry.entries()) {
    if (seen.has(entry.controller)) continue;
    seen.add(entry.controller);
    entries.push(entry);
  }
  for (const declared of scope ?? DECLARED) {
    for (const entry of withDefaultUnit(declared.registry.entries(), declared.unit)) {
      if (seen.has(entry.controller)) continue;
      seen.add(entry.controller);
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Removes one declared module from the process.
 *
 * Test cleanup, and deliberately per-module rather than "clear everything": a
 * test file shares the process with every other test file, so a reset that
 * dropped all modules would silently disarm whichever suite imported a real
 * application first. Undo exactly what you declared.
 */
export function removeRouteModule(routeModule: RouteModule): void {
  const index = DECLARED.indexOf(routeModule);
  if (index !== -1) DECLARED.splice(index, 1);
}
