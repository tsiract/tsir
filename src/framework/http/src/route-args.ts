/**
 * Typing a handler from the route it serves (RTR-004).
 *
 * Standard ECMAScript decorators cannot change a method's signature — a method
 * decorator receives the function and returns a function of the *same* type. So
 * `@Get('/', { body: CreateUser })` can validate `body` at runtime, but cannot
 * make the compiler infer `{ body: z.infer<typeof CreateUser> }` for the
 * parameter. (Parameter decorators would allow it; they are excluded by
 * ADR-0001, and `reflect-metadata` is excluded with them.)
 *
 * The way out is to declare the metadata as a *value* and derive the handler's
 * argument type from it:
 *
 * ```ts
 * const createUser = { body: CreateUser, status: 201 } satisfies RouteOptions;
 *
 * @Post('/', createUser)
 * create(args: RouteArgs<typeof createUser>) {
 *   args.body.email; // typed, and checked by the same schema at runtime
 * }
 * ```
 *
 * One declaration feeds both sides, so they cannot disagree — which is the
 * property RTR-004 actually asks for. `satisfies` keeps the literal type (so the
 * inference works) while still checking the options are valid.
 */

import type { RouteOptions } from '@tsir/router';
import type { AnyStandardSchema, InferOutput } from '@tsir/validate';

import type { Principal, RequestContext } from './context.ts';

/** Output type of a declared schema, or `unknown` when the route declares none. */
type Output<S> = S extends AnyStandardSchema ? InferOutput<S> : unknown;

/** `O['key']`'s schema output if the options object has that key, else `unknown`. */
type FieldOf<O, K extends keyof RouteOptions> = O extends Record<K, infer S> ? Output<S> : unknown;

/**
 * The argument a handler for `O` receives.
 *
 * Fields are **required** in the type even when the route declares no schema —
 * a handler's parameter is one object, and its shape should not change based on
 * which keys a decorator happened to list. The value is `unknown` (not `never`)
 * when there is no schema, because "no schema" means "not validated", not
 * "cannot exist".
 */
export type RouteArgs<O extends RouteOptions, P = Principal> = {
  readonly params: FieldOf<O, 'params'>;
  readonly query: FieldOf<O, 'query'>;
  readonly body: FieldOf<O, 'body'>;
  readonly headers: FieldOf<O, 'headers'>;
  readonly ctx: RequestContext;
} & (O extends { principal: true } ? { readonly principal: P } : Record<never, never>);

/**
 * `true` when a route binds `principal`. Handy for conditional UI in generic
 * helpers; the type-level equivalent is `O extends { principal: true }`.
 */
export function bindsPrincipal(options: RouteOptions): boolean {
  return options.principal === true;
}
