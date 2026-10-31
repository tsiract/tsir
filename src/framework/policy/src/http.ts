/**
 * The HTTP adapter.
 *
 * `@tsir/http` runs a policy as `(ctx, ref) => Decision`, and the *route table* names the ref. So
 * the adapter's job is to turn the registry into that record — and to answer for **every ref the
 * roles know about**, not only the ones with a hand-written policy.
 *
 * That last point closes a real hole: `@tsir/http` skips a ref it has no policy for
 * (`if (policy === undefined) continue`), which is correct for an optional extension point and wrong
 * for an authorization check. Building the record from `registry.refs` means a route that declares
 * `post:update` gets a real decision — the role answer — even when nobody wrote a policy for it, and
 * a ref nobody knows is caught at boot by `policy:list` rather than at request time by nobody.
 *
 * The request shape is declared **structurally**, not imported from `@tsir/http`, so this package
 * stays a leaf: `link`, `queue` and a job all produce a principal without pulling an HTTP stack.
 */

import type { Decision } from './decision.ts';
import type { Principal, Registry } from './registry.ts';

/** The slice of `@tsir/http`'s `RequestContext` a policy may read. It satisfies this structurally. */
export interface PolicyRequestContext {
  readonly principal?: Principal | undefined;
  readonly url: URL;
  readonly state: ReadonlyMap<string, unknown>;
}

/** The slice of `@tsir/router`'s `PolicyRef`. */
export interface PolicyRefLike {
  readonly resource: string;
  readonly action: string;
  readonly audit?: true | undefined;
}

export type HttpPolicy = (
  context: PolicyRequestContext,
  ref: PolicyRefLike,
) => Promise<Decision> | Decision;

export interface ToHttpOptions {
  /**
   * What the decision is about — `(ctx) => ctx.state.get('tsir.post')`, a route param, the body.
   * A policy that checks ownership needs the row; everything else can ignore it.
   */
  readonly data?: ((context: PolicyRequestContext) => unknown) | undefined;
}

/** The record `createFetchHandler({ policies })` takes. */
export function toHttpPolicies(
  registry: Registry,
  options: ToHttpOptions = {},
): Readonly<Record<string, HttpPolicy>> {
  const data = options.data;
  const policies: Record<string, HttpPolicy> = {};

  for (const ref of registry.refs) {
    const index = ref.lastIndexOf(':');
    const resource = ref.slice(0, index);
    const action = ref.slice(index + 1);
    const key = `${resource}:${action}`;

    policies[key] = (context) =>
      registry.authorize({
        principal: context.principal,
        resource,
        action,
        ...(data === undefined ? {} : { data: data(context) }),
      });
  }

  return policies;
}

/**
 * The guard-shaped entry point for a service or a job: no request, no response, just a decision that
 * has to be checked. `registry.require` is the one to reach for when forgetting is the risk.
 */
export function authorizeService<P>(
  registry: Registry,
  input: {
    readonly principal: Principal<P> | undefined;
    readonly resource: string;
    readonly action: string;
    readonly data?: unknown;
  },
): Promise<Decision> {
  return registry.authorize(input);
}
