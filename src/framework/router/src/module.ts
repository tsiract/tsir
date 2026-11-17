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
import type { CapabilityRequirement, ConfigSpec } from '@tsir/core';
import type { Provider } from '@tsir/container';

import { compileRoutes } from './compile.ts';
import { type ControllerEntry, type RouteRegistry, routeRegistry } from './registry.ts';
import type { ControllerClass, DeclaredListener, RouteTable } from './types.ts';

export interface RouteModuleOptions<TConfig extends ConfigSpec = ConfigSpec> {
  /** Unique module name; also what `tsir route:list` prints and boot errors name. */
  readonly name: string;
  /** The module's own registry. Controllers in this module are declared against it. */
  readonly registry: RouteRegistry;
  /** Deploy unit every route in this module belongs to, unless a route overrides it. */
  readonly unit?: string;
  /** Optional config spec extending the application config. Use `moduleConfig(appConfig, {...})`. */
  readonly config?: TConfig;
  readonly providers?: readonly Provider<unknown>[];
  readonly requires?: readonly CapabilityRequirement[];
  readonly onStart?: ModuleDefinition<TConfig>['onStart'];
  readonly onReady?: ModuleDefinition<TConfig>['onReady'];
  readonly onStop?: ModuleDefinition<TConfig>['onStop'];
}

export interface RouteModule<TConfig extends ConfigSpec = ConfigSpec> {
  /** The module to pass to `defineApp({ modules })`. */
  readonly module: ModuleDefinition<TConfig>;
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

export function routeModule<TConfig extends ConfigSpec = ConfigSpec>(
  options: RouteModuleOptions<TConfig>,
): RouteModule<TConfig> {
  const { registry } = options;
  let compiled: RouteTable | undefined;

  const module = defineModule<TConfig>({
    name: options.name,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    ...(options.onStart === undefined ? {} : { onStart: options.onStart }),
    ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
    ...(options.onStop === undefined ? {} : { onStop: options.onStop }),
  });

  const created: RouteModule<TConfig> = {
    module,
    registry,
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    routes: () => {
      compiled ??= compileRoutes(withDefaultUnit(registry.entries(), options.unit));
      return compiled;
    },
  };

  DECLARED.push(created as RouteModule);
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

/** One listener-bearing controller, in the form `@tsir/deploy` compiles into a unit. */
export interface ListenerControllerEntry {
  readonly controller: ControllerClass;
  readonly listeners: readonly DeclaredListener[];
}

/**
 * The listener-bearing controllers **this app declares**, scoped to one module list.
 *
 * This is the deploy build's view, and it deliberately differs from
 * `collectRouteEntries()` in two ways that matter for a bundle:
 *
 * 1. **Scoped, never global.** `deploy:build` runs in a process that imported exactly one
 *    application entry. Reading the process-global `routeRegistry` there would make the
 *    artifact depend on whatever else the build process happened to import — the same
 *    leak `MOD-006` closes for tests.
 * 2. **Only what this module list registered.** A module object does not expose its
 *    registry, so the declarations are read from the process and then *filtered* down to
 *    the classes a matching `routeModule` declared. An app with two `users` modules in one
 *    process therefore gets its own controllers, not both sets (`DPL-026`).
 *
 * A module-less controller — `@Controller(registry)` with no `routeModule` — is included by
 * the second pass only when every declared module's registry has been considered, because
 * there is nothing to scope it to.
 */
export function listenerControllers(
  modules: readonly ModuleDefinition[] = [],
): readonly ListenerControllerEntry[] {
  const declared = routeModules();
  const units = new Set(modules.map((module) => module.name));
  const scoped = declared.filter((module) => units.has(module.module.name));

  // Controllers registered by the modules this app declares. `MOD-006`'s rule, applied to a
  // build: an unlisted module cannot contribute a class to this artifact.
  const owned = new Set<unknown>();
  for (const module of scoped) {
    for (const entry of module.registry.entries()) owned.add(entry.controller);
  }

  const entries: ControllerEntry[] = [];
  const seen = new Set<unknown>();
  for (const entry of collectRouteEntries(scoped)) {
    if (seen.has(entry.controller)) continue;
    // A controller is this app's if a declared module registered it, or if no declared
    // module claims it at all (the module-less registration path).
    if (owned.size > 0 && !owned.has(entry.controller) && claimsController(entry.controller)) {
      continue;
    }
    seen.add(entry.controller);
    entries.push(entry);
  }

  return entries
    .filter((entry) => entry.listeners.length > 0)
    .map((entry) => ({ controller: entry.controller, listeners: entry.listeners }));
}

/** Whether any declared module (in this process) registered this controller. */
function claimsController(controller: ControllerClass): boolean {
  for (const declared of routeModules()) {
    for (const entry of declared.registry.entries()) {
      if (entry.controller === controller) return true;
    }
  }
  return false;
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
