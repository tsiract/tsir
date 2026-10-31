import { describe, expect, test } from 'bun:test';

import { cookieFrom, createSessions, SESSION_DEFAULTS, sessionErrors } from './session.ts';
import type { SessionRecord, SessionStore } from './session.ts';
import { memorySessionStore } from './drivers/memory.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A clock the test drives, so "twelve hours later" is a statement and not a sleep. */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function requestWith(cookie?: string): Request {
  return new Request('https://example.com/', cookie === undefined ? {} : { headers: { cookie } });
}

describe('session lifecycle', () => {
  test('start returns the token once, and the store holds only its hash', async () => {
    const time = clock();
    const store = memorySessionStore();
    const sessions = createSessions({ store, now: time.now });

    const { token, record, cookie } = await sessions.start({
      subject: 'user_1',
      data: { role: 'admin' },
      userAgent: 'Mozilla/5.0',
      ip: '203.0.113.7',
    });

    expect(token).toHaveLength(43);
    expect(store.size).toBe(1);
    expect(record.id).not.toBe(token);
    expect(record.id).toMatch(/^[0-9a-f]{64}$/u);
    expect(await store.get(token)).toBeUndefined(); // the raw token is not a key

    const stored = await store.get(record.id);
    expect(stored?.subject).toBe('user_1');
    expect(stored?.data).toEqual({ role: 'admin' });
    expect(stored?.userAgent).toBe('Mozilla/5.0');
    expect(stored?.ip).toBe('203.0.113.7');
    expect(stored?.expiresAt).toBe(time.now() + SESSION_DEFAULTS.ttlMs);

    expect(cookie).toBe(
      `__Host-tsir_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(7 * 24 * 60 * 60)}`,
    );
  });

  test('the cookie attributes are the security control, so they are asserted verbatim', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    const { cookie } = await sessions.start({ subject: 'user_1' });

    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(cookie).toContain(attribute);
    }
    // `__Host-` requires Secure, Path=/ and **no** Domain — a Domain attribute would void the prefix.
    expect(cookie).not.toContain('Domain');
    expect(sessions.cookieName.startsWith('__Host-')).toBe(true);

    expect(sessions.clearCookie()).toBe(
      '__Host-tsir_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
  });

  test('the cookie name, secure flag and SameSite are options, and the prefix is not implied', () => {
    const local = createSessions({
      store: memorySessionStore(),
      cookieName: 'tsir_session',
      secure: false,
      sameSite: 'Strict',
    });
    expect(local.clearCookie()).toBe(
      'tsir_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
  });

  test('a __Host- cookie with secure: false is refused, because a browser would drop it', () => {
    // The failure this prevents is silent: `start()` would succeed, the Set-Cookie header would
    // look correct, and every subsequent request would be anonymous. `__Host-` requires
    // `Secure`, so the only honest options are TLS or a different cookie name (CAP-P7 F1).
    expect(() => createSessions({ store: memorySessionStore(), secure: false })).toThrow(
      /__Host-.*secure: false/,
    );
    expect(() =>
      createSessions({ store: memorySessionStore(), cookieName: '__Host-x', secure: false }),
    ).toThrow(/AUTH_CONFIG_INVALID|__Host-/);
    // …and the same name without the prefix is exactly how local HTTP development is meant to work.
    const local = createSessions({
      store: memorySessionStore(),
      cookieName: 'tsir_session',
      secure: false,
    });
    expect(local.cookieName).toBe('tsir_session');
  });

  test('read finds a live session, and does not touch it within the minute', async () => {
    const time = clock();
    const store = memorySessionStore();
    const sessions = createSessions({ store, now: time.now });
    const { token } = await sessions.start({ subject: 'user_1', data: 7 });

    time.advance(30_000);
    const read = await sessions.read(token);
    expect(read?.record.subject).toBe('user_1');
    expect(read?.record.data).toBe(7);
    expect(read?.touched).toBe(false); // under a minute: no write

    time.advance(90_000);
    const touched = await sessions.read(token);
    expect(touched?.touched).toBe(true);
    expect(touched?.record.lastSeenAt).toBe(time.now());
    // The store was advanced too, so the idle clock does not reset on every request.
    expect((await store.get(touched?.record.id ?? ''))?.lastSeenAt).toBe(time.now());
  });

  test('an unknown token is undefined, not an error', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    expect(await sessions.read('a'.repeat(43))).toBeUndefined();
  });

  test('an expired session is deleted on read — a clock correction cannot bring it back', async () => {
    const time = clock();
    const store = memorySessionStore();
    const sessions = createSessions({ store, now: time.now, ttlMs: HOUR });
    const { token } = await sessions.start({ subject: 'user_1' });

    time.advance(HOUR);
    expect(await sessions.read(token)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('an idle session is deleted too, and idling is not the same as being old', async () => {
    const time = clock();
    const store = memorySessionStore();
    const sessions = createSessions({ store, now: time.now, idleTtlMs: HOUR, ttlMs: 100 * HOUR });
    const { token } = await sessions.start({ subject: 'user_1' });

    // Active for four hours: past the idle limit, but never idle for one.
    for (let index = 0; index < 4; index += 1) {
      time.advance(HOUR);
      expect(await sessions.read(token)).toBeDefined();
    }

    time.advance(HOUR + 1);
    expect(await sessions.read(token)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('a revoked row is deleted on read, not merely refused', async () => {
    const time = clock();
    const store = memorySessionStore();
    const sessions = createSessions({ store, now: time.now });
    const { token, record } = await sessions.start({ subject: 'user_1' });

    // A revocation written by another process: the row stays, marked.
    await store.put({ ...record, revokedAt: time.now() });
    expect(await sessions.read(token)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('revoke and revokeSubject kill the session for good', async () => {
    const store = memorySessionStore();
    const sessions = createSessions({ store });
    const first = await sessions.start({ subject: 'user_1' });
    const second = await sessions.start({ subject: 'user_1' });
    const other = await sessions.start({ subject: 'user_2' });

    await sessions.revoke(first.token);
    expect(await sessions.read(first.token)).toBeUndefined();
    expect(await sessions.read(second.token)).toBeDefined();

    expect(await sessions.revokeSubject('user_1')).toBe(1);
    expect(await sessions.read(second.token)).toBeUndefined();
    expect(await sessions.read(other.token)).toBeDefined();
    expect(await sessions.revokeSubject('nobody')).toBe(0);
    // Revoking an unknown token is a no-op: a logout is not an error. A rejection here would fail
    // the test on its own, which is the assertion.
    await sessions.revoke('b'.repeat(43));
  });

  test('rotate issues a new token, keeps subject and data, and kills the old id', async () => {
    const time = clock();
    const store = memorySessionStore();
    const sessions = createSessions({ store, now: time.now });
    const started = await sessions.start({
      subject: 'user_1',
      data: { theme: 'dark' },
      userAgent: 'curl/8',
      ip: '198.51.100.4',
    });

    time.advance(MINUTE);
    const rotated = await sessions.rotate(started.token);

    expect(rotated.token).not.toBe(started.token);
    expect(rotated.record.subject).toBe('user_1');
    expect(rotated.record.data).toEqual({ theme: 'dark' });
    expect(rotated.record.userAgent).toBe('curl/8');
    expect(rotated.record.ip).toBe('198.51.100.4');
    expect(rotated.record.createdAt).toBe(time.now()); // a rotation starts a new lifetime

    expect(await sessions.read(started.token)).toBeUndefined();
    expect(await sessions.read(rotated.token)).toBeDefined();
    expect(store.size).toBe(1);
  });

  test('rotating a dead session throws, because a caller asked for a new one', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    const error = await sessions.rotate('c'.repeat(43)).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('AUTH_SESSION_EXPIRED');
  });

  test('a session without optional facts carries none — no `undefined` keys', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    const { record } = await sessions.start({ subject: 'user_1' });
    expect(Object.keys(record).sort()).toEqual(
      ['createdAt', 'data', 'expiresAt', 'id', 'lastSeenAt', 'subject'].sort(),
    );
    expect(record.data).toBeNull();
  });
});

describe('reading the token off a request', () => {
  test('the cookie is found by name, wherever it sits in the header', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    const { token } = await sessions.start({ subject: 'user_1' });

    for (const header of [
      `__Host-tsir_session=${token}`,
      `other=1; __Host-tsir_session=${token}; another=2`,
      `__Host-tsir_session=${token}; a=b`,
    ]) {
      expect(sessions.tokenOf(requestWith(header))).toBe(token);
    }

    expect(sessions.tokenOf(requestWith())).toBeUndefined();
    expect(sessions.tokenOf(requestWith('other=1'))).toBeUndefined();
    expect(sessions.tokenOf(requestWith('__Host-tsir_session='))).toBe('');
  });

  test('a project may read the token from anywhere, and `read` is then the only path', () => {
    const sessions = createSessions({
      store: memorySessionStore(),
      readToken: (request) => request.headers.get('x-session') ?? undefined,
    });
    expect(sessions.tokenOf(requestWith())).toBeUndefined();
    expect(
      sessions.tokenOf(new Request('https://example.com/', { headers: { 'x-session': 'abc' } })),
    ).toBe('abc');
  });

  test('`cookieFrom` skips segments with no `=`, and matches only the whole name', () => {
    expect(cookieFrom(null, 'a')).toBeUndefined();
    expect(cookieFrom('', 'a')).toBeUndefined();
    expect(cookieFrom('garbage; a=1', 'a')).toBe('1');
    expect(cookieFrom('aa=2', 'a')).toBeUndefined();
    expect(cookieFrom('a=x=y', 'a')).toBe('x=y'); // only the first `=` splits
    expect(cookieFrom('a= untrimmed ', 'a')).toBe('untrimmed');
  });
});

describe('store failures fail closed', () => {
  const broken: SessionStore = {
    put: () => Promise.reject(new Error('connection refused')),
    get: () => Promise.reject(new Error('connection refused')),
    delete: () => Promise.reject(new Error('connection refused')),
    deleteSubject: () => Promise.reject(new Error('connection refused')),
    touch: () => Promise.reject(new Error('connection refused')),
  };

  test('every operation wraps the failure in `AUTH_SESSION_STORE_FAILED`', async () => {
    const sessions = createSessions({ store: broken });
    const code = async (promise: Promise<unknown>): Promise<string | undefined> =>
      ((await promise.catch((error: unknown) => error)) as { code?: string }).code;

    expect(await code(sessions.start({ subject: 'x' }))).toBe('AUTH_SESSION_STORE_FAILED');
    expect(await code(sessions.read('a'.repeat(43)))).toBe('AUTH_SESSION_STORE_FAILED');
    expect(await code(sessions.revoke('a'.repeat(43)))).toBe('AUTH_SESSION_STORE_FAILED');
    expect(await code(sessions.revokeSubject('x'))).toBe('AUTH_SESSION_STORE_FAILED');
    // Not "not authenticated": an outage is a 500, never a 401 that hides it.
  });

  test('a thrown non-Error is still a described failure', async () => {
    const oddball: SessionStore = {
      ...broken,
      // Deliberately not an `Error`: a driver may throw anything, and the wrapper has to survive it.
      get: () => Promise.reject('disk on fire'), // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    };
    const sessions = createSessions({ store: oddball });
    const error = await sessions.read('a'.repeat(43)).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('the session store failed: disk on fire');
  });

  test('a delete that fails after a successful read is still reported', async () => {
    const store = createSessions({ store: memorySessionStore() });
    const { record } = await store.start({ subject: 'x' });
    const halfBroken: SessionStore = {
      ...broken,
      get: () => Promise.resolve({ ...record, revokedAt: 1 } satisfies SessionRecord),
    };
    const sessions = createSessions({ store: halfBroken });
    const error = await sessions.read('a'.repeat(43)).catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('AUTH_SESSION_STORE_FAILED');
  });
});

describe('surface', () => {
  test('the error constructors are re-exported for a caller mapping to a 401', () => {
    expect(sessionErrors.sessionExpired().code).toBe('AUTH_SESSION_EXPIRED');
    expect(sessionErrors.sessionRevoked().code).toBe('AUTH_SESSION_REVOKED');
  });

  test('the defaults are seven days absolute and twelve hours idle', () => {
    expect(SESSION_DEFAULTS.ttlMs).toBe(7 * 24 * HOUR);
    expect(SESSION_DEFAULTS.idleTtlMs).toBe(12 * HOUR);
  });
});
