/**
 * The decorators (ADR-0001: standard ECMAScript decorators, nothing else).
 *
 * Two shapes are supported and compile to identical metadata:
 *
 *   @Route({ method: 'GET', path: '/:id', params: IntParam })   // explicit
 *   @Get('/:id', { params: IntParam })                          // sugar
 *
 * There are no parameter decorators — the standard has none. Argument binding
 * is declared in the route metadata and surfaced to the handler as one typed
 * context object.
 *
 * Method decorators attach their metadata **to the function object** rather than
 * to a shared map keyed by class. A method decorator never receives the class,
 * and relying on `Symbol.metadata` ties the framework to a lib setting; attaching
 * to the function makes collection order-independent and survives subclassing.
 */

import { badPath } from './errors.ts';
import { type DeclaredRoute, routeRegistry, type RouteRegistry } from './registry.ts';
import type { ControllerClass, HttpMethod, PolicyRef, RouteMeta, TokenRef } from './types.ts';

/** Key under which `@Route` stores its metadata on the handler function. */
const ROUTE_META = Symbol.for('tsir.route');
/** Class-level decorators store their tokens here. */
const CLASS_TOKENS = Symbol.for('tsir.class.tokens');

interface ClassTokens {
  readonly middleware: readonly TokenRef[];
  readonly guards: readonly TokenRef[];
  readonly policies: readonly PolicyRef[];
}

const EMPTY_TOKENS: ClassTokens = { middleware: [], guards: [], policies: [] };

/** `''` means "no prefix" — a controller may mount at the root. */
export type RoutePrefix = '' | `/${string}`;

/** Joins a controller prefix and a route path into one normalized path. */
export function joinPath(prefix: string, path: string): `/${string}` {
  const left = prefix === '' || prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const right = path === '/' ? '' : path.replace(/\/+$/, '');
  const joined = `${left}${right}`;
  return (joined === '' ? '/' : joined) as `/${string}`;
}

/**
 * Validates path syntax once, at declaration time.
 *
 * Catching `'users'` (no leading slash) or `'/a/*\/b'` (wildcard not last) when
 * the module loads gives a stack pointing at the decorator, not at boot.
 */
export function assertValidPath(path: string): void {
  if (!path.startsWith('/')) throw badPath(path, 'must start with "/"');
  if (path.length > 1 && path.endsWith('/')) throw badPath(path, 'must not end with "/"');
  if (path.includes('//')) throw badPath(path, 'must not contain "//"');

  const segments = path === '/' ? [] : path.slice(1).split('/');
  segments.forEach((segment, index) => {
    if (segment === '') throw badPath(path, 'empty segment');
    if (segment.startsWith(':')) {
      if (segment.length === 1) throw badPath(path, "a parameter needs a name, e.g. ':id'");
      if (!/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
        throw badPath(path, `invalid parameter name in "${segment}"`);
      }
      return;
    }
    if (segment === '*') {
      if (index !== segments.length - 1)
        throw badPath(path, "'*' is only allowed as the last segment");
      return;
    }
    if (segment.includes('*') || segment.includes(':')) {
      throw badPath(path, `segments must be literal, ':name', or '*' — got "${segment}"`);
    }
  });
}

function readRouteMeta(value: unknown): RouteMeta | undefined {
  if (typeof value !== 'function') return undefined;
  const meta: unknown = Reflect.get(value, ROUTE_META);
  if (typeof meta !== 'object' || meta === null) return undefined;
  return meta as RouteMeta;
}

function mergeClassTokens(target: ControllerClass, next: Partial<ClassTokens>): void {
  const current: ClassTokens =
    (Reflect.get(target, CLASS_TOKENS) as ClassTokens | undefined) ?? EMPTY_TOKENS;
  const merged: ClassTokens = Object.freeze({
    middleware: Object.freeze([...current.middleware, ...(next.middleware ?? [])]),
    guards: Object.freeze([...current.guards, ...(next.guards ?? [])]),
    policies: Object.freeze([...current.policies, ...(next.policies ?? [])]),
  });
  // Configurable: several class decorators stack on one class and each must be
  // able to replace the accumulated tokens.
  Object.defineProperty(target, CLASS_TOKENS, {
    value: merged,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function readClassTokens(target: ControllerClass): ClassTokens {
  const value: unknown = Reflect.get(target, CLASS_TOKENS) as unknown;
  if (typeof value !== 'object' || value === null) return EMPTY_TOKENS;
  return value as ClassTokens;
}

/**
 * Collects annotated methods along the prototype chain.
 *
 * Most-derived first, so a subclass override wins by name; parent routes are
 * inherited deliberately, mirroring how methods themselves are inherited.
 */
function collectRoutes(controller: ControllerClass): DeclaredRoute[] {
  const seen = new Set<string>();
  const routes: DeclaredRoute[] = [];

  let prototype: object | null = controller.prototype as object | null;
  while (prototype !== null && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor' || seen.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const meta = readRouteMeta(descriptor?.value);
      if (meta === undefined) continue;
      seen.add(name);
      routes.push({ handler: name, meta });
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  return routes;
}

function registerController(
  controller: ControllerClass,
  path: string,
  registry: RouteRegistry,
  options: ControllerOptions = {},
): void {
  assertValidPath(path === '' ? '/' : path);
  const tokens = readClassTokens(controller);
  const routes = collectRoutes(controller);

  registry.register({
    controller,
    name: controller.name === '' ? '<anonymous>' : controller.name,
    path: path === '/' ? '' : path,
    routes,
    middleware: tokens.middleware,
    guards: tokens.guards,
    policies: tokens.policies,
    ...(options.unit === undefined ? {} : { unit: options.unit }),
  });
}

export type ControllerDecorator = (value: ControllerClass, context: ClassDecoratorContext) => void;

export interface ControllerOptions {
  /** Default deploy unit for every route here (RTR-011). Defaults to `http`. */
  readonly unit?: string;
}
export type RouteMethodDecorator = (
  value: (...args: never[]) => unknown,
  context: ClassMethodDecoratorContext,
) => void;

/**
 * Marks a class as a controller and registers it.
 *
 * Importing a controller module is the only side effect; the class is never
 * instantiated at import time. The container builds it per request.
 */
export function Controller(path?: RoutePrefix, options?: ControllerOptions): ControllerDecorator;
/** Isolated-registry form, used by tests and the compiler. */
export function Controller(
  registry: RouteRegistry,
  path?: RoutePrefix,
  options?: ControllerOptions,
): ControllerDecorator;
export function Controller(
  first?: RoutePrefix | RouteRegistry,
  second?: RoutePrefix | ControllerOptions,
  third?: ControllerOptions,
): ControllerDecorator {
  const isolated = first !== undefined && typeof first !== 'string';
  const registry = isolated ? first : routeRegistry;
  const path = isolated
    ? typeof second === 'string'
      ? second
      : ''
    : typeof first === 'string'
      ? first
      : '';
  const options: ControllerOptions =
    (typeof second === 'object' ? second : undefined) ?? third ?? {};
  return (value) => {
    registerController(value, path, registry, options);
  };
}

/** Declares one route. The explicit form; `@Get` and friends are sugar. */
export function Route(meta: RouteMeta): RouteMethodDecorator {
  assertValidPath(meta.path);
  const frozen = Object.freeze({ ...meta });
  return (value) => {
    Object.defineProperty(value, ROUTE_META, { value: frozen, enumerable: false });
  };
}

/** Everything except `method` and `path`, all optional. */
export type RouteOptions = Omit<RouteMeta, 'method' | 'path'>;

function methodDecorator(
  method: HttpMethod,
  path: `/${string}`,
  options: RouteOptions,
): RouteMethodDecorator {
  return Route({ ...options, method, path });
}

export const Get = (path: `/${string}`, options: RouteOptions = {}): RouteMethodDecorator =>
  methodDecorator('GET', path, options);
export const Post = (path: `/${string}`, options: RouteOptions = {}): RouteMethodDecorator =>
  methodDecorator('POST', path, options);
export const Put = (path: `/${string}`, options: RouteOptions = {}): RouteMethodDecorator =>
  methodDecorator('PUT', path, options);
export const Patch = (path: `/${string}`, options: RouteOptions = {}): RouteMethodDecorator =>
  methodDecorator('PATCH', path, options);
export const Delete = (path: `/${string}`, options: RouteOptions = {}): RouteMethodDecorator =>
  methodDecorator('DELETE', path, options);
export const Head = (path: `/${string}`, options: RouteOptions = {}): RouteMethodDecorator =>
  methodDecorator('HEAD', path, options);
export const Options = (path: `/${string}`, options: RouteOptions = {}): RouteMethodDecorator =>
  methodDecorator('OPTIONS', path, options);

/**
 * Class-level middleware, guards and policies.
 *
 * Applied **before** the route's own tokens, so a controller-wide guard cannot
 * be silently bypassed by a route that declares none.
 */
export function UseMiddleware(...tokens: readonly TokenRef[]): ControllerDecorator {
  return (value) => {
    mergeClassTokens(value, { middleware: tokens });
  };
}

export function Guards(...tokens: readonly TokenRef[]): ControllerDecorator {
  return (value) => {
    mergeClassTokens(value, { guards: tokens });
  };
}

export function Policies(...policies: readonly PolicyRef[]): ControllerDecorator {
  return (value) => {
    mergeClassTokens(value, { policies });
  };
}
