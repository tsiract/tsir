/**
 * The metadata registry.
 *
 * Controllers *declare* routes; they never resolve them. The decorators write
 * frozen records here at import time, `compileRoutes` reads them once at boot,
 * and nothing consults them again. That is the whole reason Tsir can boot with
 * decorator metadata deleted: the compiled table is the
 * only thing the runtime ever touches.
 *
 * The registry is a class rather than a module-level `Map` so tests can hold
 * their own instance; `routeRegistry` is the process-local default.
 */

import type { ControllerClass, PolicyRef, RouteMeta, TokenRef } from './types.ts';

/** A route as declared on one method, before class-level metadata is merged. */
export interface DeclaredRoute {
  readonly handler: string;
  readonly meta: RouteMeta;
}

/** Everything one `@Controller` class declared. */
export interface ControllerEntry {
  /** The controller class itself. Instantiated per request by the container. */
  readonly controller: ControllerClass;
  readonly name: string;
  /** `''` when the controller declares no prefix. */
  readonly path: string;
  readonly routes: readonly DeclaredRoute[];
  readonly middleware: readonly TokenRef[];
  readonly guards: readonly TokenRef[];
  readonly policies: readonly PolicyRef[];
  /** Default unit for every route in this controller (RTR-011). */
  readonly unit?: string;
}

export class RouteRegistry {
  readonly #entries: ControllerEntry[] = [];

  /**
   * Registers one controller.
   *
   * Re-registering the same class replaces the previous entry rather than
   * appending: module reload in `tsir dev` must not double every route.
   */
  register(entry: ControllerEntry): void {
    const existing = this.#entries.findIndex(
      (candidate) => candidate.controller === entry.controller,
    );
    if (existing === -1) {
      this.#entries.push(entry);
      return;
    }
    this.#entries[existing] = entry;
  }

  /** Declaration order. `compileRoutes` sorts; this does not. */
  entries(): readonly ControllerEntry[] {
    return this.#entries;
  }

  get size(): number {
    return this.#entries.length;
  }

  clear(): void {
    this.#entries.length = 0;
  }
}

/**
 * The process-local registry the decorators write to.
 *
 * A single shared instance is correct here: modules are loaded once per process,
 * and a route declared in a module is declared for the application. Tests that
 * need isolation construct their own `RouteRegistry` and pass it to the
 * decorators' factory form (`controller(registry)(…)`).
 */
export const routeRegistry = new RouteRegistry();
