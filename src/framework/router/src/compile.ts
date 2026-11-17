/**
 * Compiling declarations into a route table.
 *
 * This is where a broken declaration becomes a build error instead of a runtime
 * surprise. Everything checked here is a *programming* error — a duplicate path,
 * a status that cannot carry a body, two routes that are the same shape — so all
 * of it fails `tsir build`, never a request.
 */

import { joinPath } from './decorators.ts';
import {
  ambiguousRoute,
  badHandler,
  badStatus,
  duplicateRoute,
  emptyController,
  principalWithoutGuard,
} from './errors.ts';
import type { ControllerEntry } from './registry.ts';
import {
  BODYLESS_STATUSES,
  type ControllerClass,
  type HttpMethod,
  type RouteEntry,
  type RouteMeta,
  type RouteStatus,
  type RouteTable,
} from './types.ts';

/** Methods in a fixed order so generated output and OpenAPI are stable. */
export const METHOD_ORDER: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

const ALLOWED_STATUSES: ReadonlySet<number> = new Set([
  200, 201, 202, 204, 206, 300, 301, 302, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503,
]);

/**
 * Erases parameter names: `/users/:id` and `/users/:userId` are the same shape
 * and therefore the same route.
 */
export function pathShape(path: string): string {
  if (path === '/') return '/';
  return path
    .slice(1)
    .split('/')
    .map((segment) => (segment.startsWith(':') ? ':' : segment))
    .join('/');
}

/** Specificity per segment: static 3, parameter 2, wildcard 1. */
function specificity(path: string): readonly number[] {
  if (path === '/') return [];
  return path
    .slice(1)
    .split('/')
    .map((segment) => {
      if (segment === '*') return 1;
      if (segment.startsWith(':')) return 2;
      return 3;
    });
}

function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return right - left; // more specific first
  }
  return b.length - a.length; // longer (more specific) first
}

/**
 * The default response status is 200, always.
 *
 * An earlier draft defaulted a non-GET route with no *request* body schema to
 * 204. That conflates two different things: whether the handler accepts a body
 * and whether it returns one. `@Post('/jobs')` that returns the created job
 * declares neither, and shipping a 204 there is a silent protocol bug. A route
 * that really wants 204 says so.
 */
function defaultStatus(meta: RouteMeta): RouteStatus {
  return meta.status ?? 200;
}

function mergeRoute(
  entry: ControllerEntry,
  declared: { handler: string; meta: RouteMeta },
): RouteEntry {
  const { meta } = declared;
  const path = joinPath(entry.path, meta.path);
  const status = defaultStatus(meta);

  if (!ALLOWED_STATUSES.has(status)) throw badStatus(status, path);
  if (BODYLESS_STATUSES.has(status)) {
    // A 204 that declares a body schema is contradictory: the schema promises a
    // payload the status forbids. Caught here rather than at serialization.
    if (meta.body !== undefined) throw badStatus(status, `${path} (declares a body schema)`);
  }

  // Checked before the handler lookup so the message names the real problem:
  // binding `principal` with no guard means the value can only be `undefined`.
  if (meta.principal === true && entry.guards.length === 0 && (meta.guards ?? []).length === 0) {
    throw principalWithoutGuard(meta.method, path);
  }

  const descriptor = Object.getOwnPropertyDescriptor(entry.controller.prototype, declared.handler);
  const method: unknown = descriptor?.value ?? findInherited(entry.controller, declared.handler);
  if (typeof method !== 'function') {
    throw badHandler(entry.name, declared.handler, 'no such method on the controller prototype');
  }

  return Object.freeze({
    method: meta.method,
    path,
    segments: path === '/' ? [] : path.slice(1).split('/'),
    controller: entry.controller,
    handler: declared.handler,
    // Route-level beats controller-level beats the default, resolved once here so
    // no consumer has to re-apply the precedence.
    meta: Object.freeze({ ...meta, status, unit: meta.unit ?? entry.unit ?? 'http' }),
    middleware: Object.freeze([...entry.middleware, ...(meta.middleware ?? [])]),
    guards: Object.freeze([...entry.guards, ...(meta.guards ?? [])]),
    policies: Object.freeze([...entry.policies, ...(meta.policies ?? [])]),
  });
}

function findInherited(controller: ControllerClass, name: string): unknown {
  let prototype: object | null = controller.prototype as object | null;
  while (prototype !== null && prototype !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor !== undefined) return descriptor.value as unknown;
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return undefined;
}

/**
 * Compiles registry entries into a table.
 *
 * Throws on the first structural problem, with a message naming both offending
 * controllers — a build report that says "duplicate route" without saying *which
 * two* costs ten minutes per occurrence.
 */
export function compileRoutes(entries: readonly ControllerEntry[]): RouteTable {
  const routes: RouteEntry[] = [];
  const byPath = new Map<string, RouteEntry>();
  const byShape = new Map<string, string>();

  for (const entry of entries) {
    // A controller with **listeners and no routes** is a supported shape (`DPL-026`): an
    // event-only controller is exactly what `@OnSns`/`@OnEventBridge`/`@OnStepTask` are for,
    // and it never appears in a route table. Only a controller with neither is the forgotten
    // decorator this error is about.
    if (entry.routes.length === 0) {
      if (entry.listeners.length > 0) continue;
      throw emptyController(entry.name);
    }

    for (const declared of entry.routes) {
      const route = mergeRoute(entry, declared);

      const key = `${route.method} ${route.path}`;
      const seen = byPath.get(key);
      if (seen !== undefined) {
        throw duplicateRoute(route.method, route.path, describe(seen), describe(route));
      }
      byPath.set(key, route);

      const shapeKey = `${route.method} ${pathShape(route.path)}`;
      const shapeSeen = byShape.get(shapeKey);
      if (shapeSeen !== undefined && shapeSeen !== route.path) {
        throw ambiguousRoute(route.method, pathShape(route.path), shapeSeen, route.path);
      }
      byShape.set(shapeKey, route.path);

      routes.push(route);
    }
  }

  routes.sort((a, b) => {
    const bySpecificity = compareSpecificity(specificity(a.path), specificity(b.path));
    if (bySpecificity !== 0) return bySpecificity;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method);
  });

  return Object.freeze({ routes: Object.freeze(routes) });
}

function describe(route: RouteEntry): string {
  return `${route.controller.name}.${route.handler}`;
}

/**
 * Identity helper for generated route tables (`routes.gen.ts`).
 *
 * Generated code calls it so the emitted file is checked against `RouteEntry`
 * at build time. It is deliberately not a validator: by the time it runs, the
 * compiler has already proven the table.
 */
export function defineRoute(entry: RouteEntry): RouteEntry {
  return entry;
}

/** Convenience for `tsir route:list`. */
export function describeTable(table: RouteTable): readonly string[] {
  return table.routes.map(
    (route) => `${route.method.padEnd(7)} ${route.path.padEnd(40)} ${describe(route)}`,
  );
}
