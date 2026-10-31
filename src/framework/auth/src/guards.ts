/**
 * Guards.
 *
 * A guard answers `Principal | null`, and `@tsir/http` turns `null` into a `401`. That is the whole
 * contract, and it enforces the rule this file is built around: **a guard never explains itself to
 * the caller**. No `?error=token_expired`, no `WWW-Authenticate: Bearer error="invalid_token"` unless
 * the project asks for it — a client that can tell "expired" from "wrong" is a client being helped,
 * and so is an attacker probing.
 *
 * The three shipped guards cover the three ways a principal arrives:
 *
 * · `sessionGuard` — a cookie, verified against a session row.
 * · `bearerGuard` — an `Authorization: Bearer` token, verified by whatever the project supplies.
 * · `apiKeyGuard` — `X-API-Key` (or a bearer token that looks like one), verified by `ApiKeys`.
 *
 * `composeGuards` tries them in order and takes the first answer. Order matters and is the caller's:
 * a project that puts the API-key guard first lets a machine authenticate without a cookie, and a
 * project that puts the session guard first gets the cheaper check for a browser.
 *
 * The request type is **structural** (`{ request: Request }`), so this module imports nothing from
 * `@tsir/http` and a queue worker can build the same shape.
 */

import { type ApiKeys, type ApiKeyRecord } from './keys.ts';
import type { Sessions, SessionRecord } from './session.ts';
import { parseApiKey } from './token.ts';

/** Structurally `@tsir/http`'s `Principal`: it passes straight through. */
export interface Principal<P = unknown> {
  readonly subject: string;
  readonly data: P;
}

/** What a guard needs from a request. `RequestContext` satisfies it. */
export interface GuardRequest {
  readonly request: Request;
}

export type Guard<P = unknown> = (
  context: GuardRequest,
) => Promise<Principal<P> | null> | Principal<P> | null;

export interface AuthSessionData {
  /** The session id (a hash) — useful for "log out this device" and for an audit record. */
  readonly sessionId: string;
  readonly data: unknown;
  readonly expiresAt: number;
}

/**
 * A cookie session. On success, `data` carries the session, so a route can rotate or revoke it.
 *
 * Two overloads rather than one union: with a `principal` mapper the data is **exactly** `P`, and
 * without one it is the session envelope. A single `Guard<P | AuthSessionData>` would force every
 * route that mapped its own principal to narrow a branch it can never receive.
 */
export function sessionGuard<P>(options: {
  readonly sessions: Sessions;
  /** Map the stored session data to the principal's payload. */
  readonly principal: (session: SessionRecord) => Principal<P>;
}): Guard<P> & { readonly reads: 'cookie' };
export function sessionGuard(options: {
  readonly sessions: Sessions;
  readonly principal?: undefined;
}): Guard<AuthSessionData> & { readonly reads: 'cookie' };
export function sessionGuard<P = unknown>(options: {
  readonly sessions: Sessions;
  /** Map the stored session data to the principal's payload. */
  readonly principal?: ((session: SessionRecord) => Principal<P>) | undefined;
}): Guard<unknown> & { readonly reads: 'cookie' } {
  const guard = async (context: GuardRequest): Promise<Principal<unknown> | null> => {
    const token = options.sessions.tokenOf(context.request);
    if (token === undefined) return null;
    const session = await options.sessions.read(token);
    if (session === undefined) return null;

    if (options.principal !== undefined) return options.principal(session.record);
    return {
      subject: session.record.subject,
      data: {
        sessionId: session.record.id,
        data: session.record.data,
        expiresAt: session.record.expiresAt,
      },
    };
  };
  return Object.assign(guard, { reads: 'cookie' as const });
}

/** `Authorization: Bearer <token>`, verified by the project. */
export function bearerGuard<P = unknown>(options: {
  readonly verify: (token: string) => Promise<Principal<P> | null>;
  /** Default `Authorization`. */
  readonly header?: string | undefined;
}): Guard<P> & { readonly reads: 'bearer' } {
  const header = options.header ?? 'authorization';
  const guard = async (context: GuardRequest): Promise<Principal<P> | null> => {
    const value = context.request.headers.get(header);
    if (value === null) return null;
    const match = /^Bearer +(.+)$/iu.exec(value.trim());
    if (match === null) return null;
    const token = match[1]?.trim() ?? '';
    if (token === '') return null;
    return options.verify(token);
  };
  return Object.assign(guard, { reads: 'bearer' as const });
}

export interface ApiKeyPrincipal extends Principal<{ readonly key: ApiKeyRecord }> {
  readonly scopes: readonly string[];
}

/**
 * `X-API-Key: tsk_…`, or a bearer token that parses as one.
 *
 * The second header exists because machine clients are inconsistent about which one they send and
 * refusing the wrong one is a support ticket, not a security improvement: the key is opaque either
 * way, and both paths go through the same verification.
 */
export function apiKeyGuard(options: {
  readonly keys: ApiKeys;
  /** Default `x-api-key`. */
  readonly header?: string | undefined;
}): Guard<{ readonly key: ApiKeyRecord }> & { readonly reads: 'api-key' } {
  const header = options.header ?? 'x-api-key';

  const guard = async (
    context: GuardRequest,
  ): Promise<Principal<{ readonly key: ApiKeyRecord }> | null> => {
    const direct = context.request.headers.get(header);
    const authorization = context.request.headers.get('authorization');
    const bearer = authorization === null ? undefined : /^Bearer +(.+)$/iu.exec(authorization)?.[1];

    const candidate =
      direct ?? (bearer !== undefined && parseApiKey(bearer) !== undefined ? bearer : undefined);
    if (candidate === null || candidate === undefined) return null;

    const record = await options.keys.verify(candidate.trim());
    if (record === undefined) return null;

    return { subject: record.subject, data: { key: record } };
  };

  return Object.assign(guard, { reads: 'api-key' as const });
}

/**
 * The first guard that produces a principal wins; `null` moves to the next one.
 *
 * A guard that **throws** stops the chain. That is deliberate: a session store that is down must be
 * a 500, not a fall-through to "maybe the API key works" — an outage that silently downgrades
 * authentication is worse than an outage.
 */
export function composeGuards(...guards: readonly Guard<unknown>[]): Guard<unknown> {
  return async (context) => {
    for (const guard of guards) {
      const principal = await guard(context);
      if (principal !== null) return principal;
    }
    return null;
  };
}
