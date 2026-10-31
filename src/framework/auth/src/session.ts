/**
 * Sessions.
 *
 * A session is a **row keyed by the hash of a token**, and the token is the only thing the client
 * holds. Three controls, each of which is a named threat:
 *
 * · **Fixation** — `rotate` issues a new token and revokes the old one. It is called when a
 * principal logs in, when privileges change, and on a schedule; the old id is dead the moment
 * the new one exists, because the store deletes rather than copies.
 * · **Idle and absolute lifetime** — `expiresAt` bounds the session's life, `lastSeenAt` bounds
 * its inactivity. Both are enforced on read, and a read that fails either **revokes**: a session
 * that is merely "not returned" would come back if the clock moved.
 * · **Cookie attributes** — `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
 * `__Host-` is not decoration: a browser refuses to let a subdomain set a cookie with that
 * prefix, which is what stops a compromised `staging.example.com` from planting a session for
 * `example.com`. It requires `Secure`, `Path=/` and no `Domain` — so those three are fixed, not
 * configurable, and the header is asserted verbatim in a test.
 *
 * The store is a port: `memory` for tests and `database` for production, with the same three facts
 * the other capability packages declare. Nothing here reads a clock it was not given.
 */

import { configInvalid, sessionExpired, sessionRevoked, sessionStoreFailed } from './errors.ts';
import { hashToken, randomToken } from './token.ts';

export interface SessionRecord {
  /** `sha256(token)` — the row key. The token itself is never stored, logged or returned twice. */
  readonly id: string;
  /** The authenticated subject. Opaque to this package. */
  readonly subject: string;
  /** Whatever the guard wants back on the next request. Must be JSON: it travels through a store. */
  readonly data: unknown;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  /** Absolute expiry. A read past this revokes. */
  readonly expiresAt: number;
  readonly revokedAt?: number | undefined;
  /** For a "your active sessions" screen, and for an incident. */
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

export interface SessionStore {
  put(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | undefined>;
  /** A rotation or a logout. */
  delete(id: string): Promise<void>;
  /** Every session of one subject — "log out everywhere". Returns how many were removed. */
  deleteSubject(subject: string): Promise<number>;
  /** Records activity without rewriting the whole row. */
  touch(id: string, lastSeenAt: number): Promise<void>;
}

export interface SessionOptions {
  readonly store: SessionStore;
  /** Cookie name. Default `__Host-tsir_session`. Changing the prefix is how a test proves the rule. */
  readonly cookieName?: string | undefined;
  /** Absolute lifetime. Default 7 days. */
  readonly ttlMs?: number | undefined;
  /** Inactivity limit. Default 12 hours. */
  readonly idleTtlMs?: number | undefined;
  readonly secure?: boolean | undefined;
  readonly sameSite?: 'Lax' | 'Strict' | 'None' | undefined;
  readonly now?: (() => number) | undefined;
  /** Where the token comes from in a request. Default: the `cookie` header, by cookie name. */
  readonly readToken?: ((request: Request) => string | undefined) | undefined;
}

export interface StartedSession {
  /** Give this to the client once. It is not stored anywhere in plaintext. */
  readonly token: string;
  readonly record: SessionRecord;
  /** A ready `Set-Cookie` value. */
  readonly cookie: string;
}

export interface ReadSession {
  readonly record: SessionRecord;
  /** True when `lastSeenAt` was advanced, so a caller that writes nothing still knows it is live. */
  readonly touched: boolean;
}

export interface Sessions {
  readonly cookieName: string;
  start(input: {
    readonly subject: string;
    readonly data?: unknown;
    readonly userAgent?: string | undefined;
    readonly ip?: string | undefined;
  }): Promise<StartedSession>;
  /** `undefined` when there is no such session, it expired, or it was revoked. Never throws for those. */
  read(token: string): Promise<ReadSession | undefined>;
  /** A new token, same subject and data; the old id is deleted. */
  rotate(token: string): Promise<StartedSession>;
  revoke(token: string): Promise<void>;
  revokeSubject(subject: string): Promise<number>;
  /** The `Set-Cookie` that clears it. */
  clearCookie(): string;
  /** Read the token a request carries, or `undefined`. */
  tokenOf(request: Request): string | undefined;
}

export const SESSION_DEFAULTS = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  idleTtlMs: 12 * 60 * 60 * 1000,
} as const;

export function createSessions(options: SessionOptions): Sessions {
  const cookieName = options.cookieName ?? '__Host-tsir_session';
  const ttlMs = options.ttlMs ?? SESSION_DEFAULTS.ttlMs;
  const idleTtlMs = options.idleTtlMs ?? SESSION_DEFAULTS.idleTtlMs;
  const secure = options.secure ?? true;

  // `__Host-` *requires* `Secure`; a browser silently discards a cookie that breaks the rule.
  // The failure mode is the worst kind: `start()` succeeds, the header looks right, and every
  // subsequent request is anonymous. Refuse the combination at construction instead of
  // shipping a login that appears to work.
  if (!secure && cookieName.startsWith('__Host-')) {
    throw configInvalid(
      `cookie "${cookieName}" uses the __Host- prefix with secure: false — a browser rejects a __Host- cookie that is not Secure, so the session would never persist. Set secure: true (TLS), or drop the prefix (e.g. cookieName: 'tsir_session') for plain-HTTP local development.`,
    );
  }
  const sameSite = options.sameSite ?? 'Lax';
  const now = options.now ?? ((): number => Date.now());
  const store = options.store;

  const attributes = (maxAgeSeconds: number): string =>
    [
      `${cookieName}=`,
      'Path=/',
      'HttpOnly',
      ...(secure ? ['Secure'] : []),
      `SameSite=${sameSite}`,
      `Max-Age=${String(maxAgeSeconds)}`,
    ].join('; ');

  const cookieFor = (token: string, expiresAt: number): string => {
    const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
    return attributes(maxAge).replace(`${cookieName}=`, `${cookieName}=${token}`);
  };

  const readToken =
    options.readToken ??
    ((request: Request): string | undefined =>
      cookieFrom(request.headers.get('cookie'), cookieName));

  const sessions: Sessions = {
    cookieName,

    async start(input) {
      const token = randomToken(32);
      const at = now();
      const record: SessionRecord = {
        id: await hashToken(token),
        subject: input.subject,
        data: input.data ?? null,
        createdAt: at,
        lastSeenAt: at,
        expiresAt: at + ttlMs,
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        ...(input.ip === undefined ? {} : { ip: input.ip }),
      };
      await guarded(() => store.put(record));
      return { token, record, cookie: cookieFor(token, record.expiresAt) };
    },

    async read(token) {
      const id = await hashToken(token);
      const record = await guarded(() => store.get(id));
      if (record === undefined) return undefined;

      // Expired or revoked is *deleted*, not merely ignored: a session that stays in the table is a
      // session that comes back when a clock is corrected.
      if (record.revokedAt !== undefined) {
        await guarded(() => store.delete(id));
        return undefined;
      }
      const at = now();
      if (record.expiresAt <= at || at - record.lastSeenAt > idleTtlMs) {
        await guarded(() => store.delete(id));
        return undefined;
      }

      // `touch` at most once a minute: an UPDATE per request is a write amplification nobody needs
      // and an idle timeout of hours does not care about 59 seconds.
      const stale = at - record.lastSeenAt > 60_000;
      if (stale) await guarded(() => store.touch(id, at));
      return { record: stale ? { ...record, lastSeenAt: at } : record, touched: stale };
    },

    async rotate(token) {
      const current = await sessions.read(token);
      if (current === undefined) throw sessionExpired();
      await guarded(() => store.delete(current.record.id));

      const next = await sessions.start({
        subject: current.record.subject,
        data: current.record.data,
        ...(current.record.userAgent === undefined ? {} : { userAgent: current.record.userAgent }),
        ...(current.record.ip === undefined ? {} : { ip: current.record.ip }),
      });
      return next;
    },

    async revoke(token) {
      const id = await hashToken(token);
      await guarded(() => store.delete(id));
    },

    async revokeSubject(subject) {
      return guarded(() => store.deleteSubject(subject));
    },

    clearCookie() {
      return `${attributes(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    },

    tokenOf(request) {
      return readToken(request);
    },
  };

  return sessions;
}

/** A store failure is `AUTH_SESSION_STORE_FAILED`, never "not authenticated". */
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw sessionStoreFailed(error instanceof Error ? error.message : String(error));
  }
}

/** Parse one cookie out of a `cookie` header without pulling a cookie library. */
export function cookieFrom(header: string | null, name: string): string | undefined {
  if (header === null || header === '') return undefined;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return undefined;
}

/** Re-exported so a caller can map a revoked session to a 401 without importing the errors module. */
export const sessionErrors = { sessionExpired, sessionRevoked } as const;
