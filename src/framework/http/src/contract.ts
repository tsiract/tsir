/**
 * Response contract helpers (VLD-009, consumed by HTP-013).
 *
 * A route already declares its request shape with schemas; these helpers let it
 * declare its *response* shape in the same place, so the status and the body
 * schema cannot drift apart:
 *
 * ```ts
 * @Post('/', { ...created(UserSchema), body: CreateUser })
 * ```
 *
 * The helper returns route options rather than a runtime object: there is no
 * second serialization path, and a handler that returns the wrong shape still
 * goes through the same `serialize()` every other response does.
 */

import type { RouteStatus } from '@tsir/router';
import type { AnyStandardSchema } from '@tsir/validate';

/** The subset of route options a response contract sets. */
export interface ResponseContractOptions {
  readonly status: RouteStatus;
  readonly response?: AnyStandardSchema;
}

/**
 * Declares a status and, optionally, the schema of the body that goes with it.
 *
 * Passing a schema is not decoration: with `http.responseValidation` set to
 * `dev` or `always` it is enforced (HTP-013), and `tsir openapi:generate` has a
 * response schema to publish instead of guessing.
 */
export function contract(spec: {
  readonly status: RouteStatus;
  readonly body?: AnyStandardSchema;
}): ResponseContractOptions {
  return {
    status: spec.status,
    ...(spec.body === undefined ? {} : { response: spec.body }),
  };
}

/** `200` with a body schema. */
export function ok<T extends AnyStandardSchema>(body: T): ResponseContractOptions {
  return { status: 200, response: body };
}

/** `201` with the representation of what was created. */
export function created<T extends AnyStandardSchema>(body: T): ResponseContractOptions {
  return { status: 201, response: body };
}

/** `202` — accepted for later processing; the body, if any, is a receipt. */
export function accepted<T extends AnyStandardSchema>(body?: T): ResponseContractOptions {
  return body === undefined ? { status: 202 } : { status: 202, response: body };
}

/**
 * `204` — success with no representation.
 *
 * A body schema here would be contradictory (the status forbids a body), so the
 * type does not accept one; `compileRoutes` rejects the pair at build time too.
 */
export function noContent(): ResponseContractOptions {
  return { status: 204 };
}
