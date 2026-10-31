/**
 * Route declarations and the compiled route table.
 *
 * The shapes here are the contract between three parties: a controller author
 * (writes `@Route`), the compiler (validates and freezes), and the runtime
 * matcher (reads, never writes). Nothing here imports a runtime.
 */

import type { AnyStandardSchema } from '@tsir/validate';

/**
 * A controller class.
 *
 * `Function` is banned by the lint config for good reason — it accepts anything
 * callable and erases the one thing we rely on (that it can be constructed).
 * `never[]` for the parameter list keeps every constructor signature assignable.
 */
export type ControllerClass = abstract new (...args: never[]) => unknown;

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * Status codes a route may declare.
 *
 * A closed set, not `number`: `@Route({ status: 418 })` should be a type error
 * rather than a runtime surprise, and OpenAPI generation needs the literal.
 */
export type RouteStatus =
  | 200
  | 201
  | 202
  | 204
  | 206
  | 300
  | 301
  | 302
  | 304
  | 400
  | 401
  | 403
  | 404
  | 409
  | 422
  | 429
  | 500
  | 502
  | 503;

/** Statuses that must never carry a body (RFC 9110 § 6.4.1). */
export const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 304]);

export type ContentType =
  | 'application/json'
  | 'text/plain'
  | 'application/octet-stream'
  | 'text/xml'
  | 'multipart/form-data';

/**
 * A stable reference to a guard, policy or middleware registered in the
 * container. A string token, not a function: the route table is data, and data
 * survives serialization into a Workers bundle.
 */
export type TokenRef = string;

export interface PolicyRef {
  readonly resource: string;
  readonly action: string;
  /**
   * Emit an audit event for this decision, allowed or denied (`HTP-011`).
   *
   * Denials are always audited; `audit: true` additionally records *allowed*
   * decisions — the ones a compliance review actually asks about.
   */
  readonly audit?: true;
}

/**
 * Declared shape of one route.
 *
 * Every schema field is a Standard Schema, so Zod 4, Zod mini, Valibot and
 * ArkType are all accepted without an adapter (ADR-0003).
 */
export interface RouteMeta {
  readonly method: HttpMethod;
  /** Must start with `/`. Empty is expressed as `'/'`, never `''`. */
  readonly path: `/${string}`;
  readonly params?: AnyStandardSchema;
  readonly query?: AnyStandardSchema;
  readonly body?: AnyStandardSchema;
  readonly headers?: AnyStandardSchema;
  /** Defaults to 200, or 204 when the handler declares no body schema. */
  readonly status?: RouteStatus;
  readonly guards?: readonly TokenRef[];
  readonly policies?: readonly PolicyRef[];
  readonly middleware?: readonly TokenRef[];
  readonly consumes?: readonly ContentType[];
  /**
   * Limits for `multipart/form-data` (VLD-006). Declared here rather than in the
   * schema because they are enforced *while parsing*, before any validator sees
   * the parts.
   */
  readonly multipart?: {
    readonly maxFileBytes?: number;
    readonly maxFiles?: number;
    /** Reject a part whose bytes disagree with its declared type. Default: true. */
    readonly sniff?: boolean;
  };
  readonly produces?: readonly ContentType[];
  readonly timeoutMs?: number;
  /**
   * Bind `principal` on the handler argument. Requires at least one guard:
   * without one nothing sets it, so the route would advertise a value it never
   * has (`RTR_PRINCIPAL_WITHOUT_GUARD`).
   */
  readonly principal?: true;
  /**
   * Response body schema, checked against what the handler actually returned
   * (`HTP-013`). Serialization is unchanged; this only validates.
   */
  readonly response?: AnyStandardSchema;
  /**
   * Deploy unit this route belongs to (RTR-011), default `'http'`.
   *
   * Routes are attributed per controller, overridable per route. The deploy
   * planner groups routes by unit; nothing at request time reads it.
   */
  readonly unit?: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
}

/** One route after class-level metadata has been merged in. */
export interface RouteEntry {
  readonly method: HttpMethod;
  /** Fully-qualified path, e.g. `/api/users/:id`. */
  readonly path: string;
  readonly segments: readonly string[];
  readonly controller: ControllerClass;
  /** Method name on the controller prototype. */
  readonly handler: string;
  /** Declaration metadata with `unit` resolved to a concrete string. */
  readonly meta: RouteMeta & { readonly unit: string };
  /** Class-level tokens first, then route-level, in declaration order. */
  readonly middleware: readonly TokenRef[];
  readonly guards: readonly TokenRef[];
  readonly policies: readonly PolicyRef[];
}

/**
 * The compiled table. A plain array, sorted deterministically, because a bundle
 * needs a serializable value and a matcher built from it — never a class.
 */
export interface RouteTable {
  readonly routes: readonly RouteEntry[];
}

/** A path shape with every parameter name erased, used for ambiguity checks. */
export type PathShape = string;
