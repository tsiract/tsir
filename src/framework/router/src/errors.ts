/**
 * Route error codes.
 *
 * `RTR_*` failures happen at build or boot, never per request: they describe a
 * broken route *declaration*, which is a programming error, not bad input.
 */

import { TsirError } from '@tsir/container';

export type RouterErrorCode =
  | 'RTR_DUPLICATE'
  | 'RTR_AMBIGUOUS'
  | 'RTR_BAD_PATH'
  | 'RTR_BAD_STATUS'
  | 'RTR_BAD_HANDLER'
  | 'RTR_EMPTY_CONTROLLER'
  | 'RTR_PRINCIPAL_WITHOUT_GUARD'
  | 'RTR_NOT_COMPILED';

/** Two routes claim the same method and the same path shape. */
export function duplicateRoute(
  method: string,
  path: string,
  first: string,
  second: string,
): TsirError {
  return new TsirError('RTR_DUPLICATE', `${method} ${path} is declared twice`, {
    kind: 'http',
    hint: `${first} and ${second} both resolve to this path. Two handlers cannot answer one request — rename the path or the method.`,
    context: { method, path },
  });
}

/**
 * Two routes are distinct strings but the same shape (`/users/:id` vs
 * `/users/:slug`). Whichever matched would be decided by memory layout, so it is
 * rejected rather than "resolved".
 */
export function ambiguousRoute(
  method: string,
  shape: string,
  first: string,
  second: string,
): TsirError {
  return new TsirError('RTR_AMBIGUOUS', `${method} ${shape} is ambiguous`, {
    kind: 'http',
    hint: `${first} and ${second} match the same requests because parameter names do not affect matching. Rename one path so the shapes differ.`,
    context: { method, shape },
  });
}

/**
 * A handler that binds `principal` but declares no guard.
 *
 * Nothing would ever set it, so the handler type promises a value that is
 * `undefined` at runtime. That is exactly the kind of lie the compiler exists to
 * refuse.
 */
export function principalWithoutGuard(method: string, path: string): TsirError {
  return new TsirError(
    'RTR_PRINCIPAL_WITHOUT_GUARD',
    `${method} ${path} binds \`principal\` but declares no guard`,
    {
      kind: 'http',
      hint: "add a guard (`@Get('/x', { guards: ['auth'], principal: true })`) or drop `principal: true`",
      context: { method, path },
    },
  );
}

export function badPath(path: string, reason: string): TsirError {
  return new TsirError('RTR_BAD_PATH', `Invalid route path "${path}": ${reason}`, {
    kind: 'http',
    hint: "paths must start with '/', use ':name' for one segment and '*' only as the final segment",
    context: { path },
  });
}

export function badStatus(status: number, path: string): TsirError {
  return new TsirError('RTR_BAD_STATUS', `Status ${status} is not allowed on ${path}`, {
    kind: 'http',
    hint: 'declare one of the RouteStatus literals; 204 and 304 cannot carry a body',
    context: { status, path },
  });
}

export function badHandler(controller: string, handler: string, reason: string): TsirError {
  return new TsirError(
    'RTR_BAD_HANDLER',
    `${controller}.${handler} cannot be a route handler: ${reason}`,
    {
      kind: 'http',
      hint: 'a route handler is a method on the controller prototype that returns a body or a ResponsePlan',
      context: { controller, handler },
    },
  );
}

export function emptyController(name: string): TsirError {
  return new TsirError('RTR_EMPTY_CONTROLLER', `${name} declares no routes`, {
    kind: 'http',
    hint: 'a @Controller with no @Route method is almost always a forgotten decorator; remove the class from the route roots or annotate its methods',
    context: { controller: name },
  });
}

/** Asking a matcher for routes before `compileRoutes` has run. */
export function notCompiled(): TsirError {
  return new TsirError('RTR_NOT_COMPILED', 'The route table was never compiled', {
    kind: 'http',
    hint: 'call compileRoutes(registry.entries()) at boot and pass the result to the matcher',
  });
}
