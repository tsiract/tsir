import { describe, expect, test } from 'bun:test';

import { apiKeyGuard, bearerGuard, composeGuards, sessionGuard, type Principal } from './guards.ts';
import { createApiKeys } from './keys.ts';
import { createSessions } from './session.ts';
import { memoryApiKeyStore, memorySessionStore } from './drivers/memory.ts';

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/things', { headers });
}

/** Await a guard that is allowed to be synchronous, and hand back whatever it threw. */
async function failure(
  value: Principal<unknown> | Promise<Principal<unknown> | null> | null,
): Promise<unknown> {
  try {
    await value;
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe('sessionGuard', () => {
  test('a live cookie becomes a principal carrying the session', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    const { token } = await sessions.start({ subject: 'user_1', data: { role: 'admin' } });
    const guard = sessionGuard({ sessions });

    const principal = await guard({ request: request({ cookie: `__Host-tsir_session=${token}` }) });
    expect(principal?.subject).toBe('user_1');
    expect(principal?.data).toMatchObject({ data: { role: 'admin' } });
    // `reads` is how `@tsir/http` documents what a route needs; it is on the function itself.
    expect(guard.reads).toBe('cookie');
  });

  test('no cookie, an unknown cookie and a revoked cookie are all `null` — quietly', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    const guard = sessionGuard({ sessions });

    expect(await guard({ request: request() })).toBeNull();
    expect(await guard({ request: request({ cookie: 'other=1' }) })).toBeNull();
    expect(
      await guard({ request: request({ cookie: `__Host-tsir_session=${'z'.repeat(43)}` }) }),
    ).toBeNull();
  });

  test('`principal` maps the record to whatever the application wants', async () => {
    const sessions = createSessions({ store: memorySessionStore() });
    const { token, record } = await sessions.start({ subject: 'user_1', data: { plan: 'pro' } });
    const guard = sessionGuard<{ readonly plan: string }>({
      sessions,
      principal: (session) => ({
        subject: session.subject,
        data: { plan: (session.data as { plan: string }).plan },
      }),
    });

    const principal = await guard({ request: request({ cookie: `__Host-tsir_session=${token}` }) });
    expect(principal).toEqual({ subject: 'user_1', data: { plan: 'pro' } });
    expect(record.id).toBeDefined();
  });

  test('a store failure throws rather than answering "anonymous"', async () => {
    const broken = createSessions({
      store: {
        put: () => Promise.reject(new Error('x')),
        get: () => Promise.reject(new Error('connection refused')),
        delete: () => Promise.reject(new Error('x')),
        deleteSubject: () => Promise.reject(new Error('x')),
        touch: () => Promise.reject(new Error('x')),
      },
    });
    const guard = sessionGuard({ sessions: broken });
    const error = await failure(
      guard({ request: request({ cookie: `__Host-tsir_session=${'a'.repeat(43)}` }) }),
    );
    expect((error as { code?: string }).code).toBe('AUTH_SESSION_STORE_FAILED');
  });
});

describe('bearerGuard', () => {
  const verify = (token: string): Promise<Principal<null> | null> =>
    Promise.resolve(token === 'good' ? { subject: 'svc', data: null } : null);

  test('`Authorization: Bearer` is parsed case-insensitively, with slack for spaces', async () => {
    const guard = bearerGuard({ verify });
    expect(guard.reads).toBe('bearer');

    for (const value of ['Bearer good', 'bearer good', 'BEARER good', ' Bearer good ']) {
      expect(await guard({ request: request({ authorization: value }) })).toEqual({
        subject: 'svc',
        data: null,
      });
    }
  });

  test('a rejected token is `null`, and so is every malformed header', async () => {
    const guard = bearerGuard({ verify });
    for (const headers of [
      {},
      { authorization: '' },
      { authorization: 'good' }, // no scheme
      { authorization: 'Basic good' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer ' },
      { authorization: 'Bearer bad' },
    ]) {
      expect(await guard({ request: request(headers) })).toBeNull();
    }
  });

  test('the header name is configurable for a non-standard gateway', async () => {
    const guard = bearerGuard({ verify, header: 'x-authorization' });
    expect(await guard({ request: request({ 'x-authorization': 'Bearer good' }) })).toEqual({
      subject: 'svc',
      data: null,
    });
    expect(await guard({ request: request({ authorization: 'Bearer good' }) })).toBeNull();
  });

  test('a verifying guard may throw, and the throw is a 500 not a 401', async () => {
    const guard = bearerGuard({
      verify: () => Promise.reject(new Error('introspection endpoint down')),
    });
    const error = await failure(guard({ request: request({ authorization: 'Bearer any' }) }));
    expect((error as Error).message).toBe('introspection endpoint down');
  });
});

describe('apiKeyGuard', () => {
  test('the `x-api-key` header becomes a principal with the key record', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const { key } = await keys.issue({ subject: 'svc_1', name: 'ci', scopes: ['deploy:write'] });
    const guard = apiKeyGuard({ keys });
    expect(guard.reads).toBe('api-key');

    const principal = await guard({ request: request({ 'x-api-key': key }) });
    expect(principal?.subject).toBe('svc_1');
    expect(principal?.data.key.name).toBe('ci');
    expect(principal?.data.key.scopes).toEqual(['deploy:write']);
  });

  test('a bearer token that parses as a key is accepted too — same verification', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const { key } = await keys.issue({ subject: 'svc_1', name: 'ci' });
    const guard = apiKeyGuard({ keys });

    expect(await guard({ request: request({ authorization: `Bearer ${key}` }) })).not.toBeNull();
    // A bearer that is *not* key-shaped is left alone, so a JWT can go to `bearerGuard` next.
    expect(
      await guard({ request: request({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' }) }),
    ).toBeNull();
    expect(await guard({ request: request({}) })).toBeNull();
  });

  test('an unknown, revoked or malformed key is `null`', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const { key, record } = await keys.issue({ subject: 'svc_1', name: 'ci' });
    const guard = apiKeyGuard({ keys });

    await keys.revoke(record.id);
    expect(await guard({ request: request({ 'x-api-key': key }) })).toBeNull();
    expect(await guard({ request: request({ 'x-api-key': 'nonsense' }) })).toBeNull();
    expect(await guard({ request: request({ 'x-api-key': '' }) })).toBeNull();
  });

  test('the header name is configurable', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const { key } = await keys.issue({ subject: 'svc_1', name: 'ci' });
    const guard = apiKeyGuard({ keys, header: 'x-tsir-key' });

    expect(await guard({ request: request({ 'x-tsir-key': key }) })).not.toBeNull();
    expect(await guard({ request: request({ 'x-api-key': key }) })).toBeNull();
  });
});

describe('composeGuards', () => {
  test('the first guard that answers wins, and the order is the caller’s', async () => {
    const keys = createApiKeys({ store: memoryApiKeyStore() });
    const sessions = createSessions({ store: memorySessionStore() });
    const { key } = await keys.issue({ subject: 'svc_1', name: 'ci' });
    const { token } = await sessions.start({ subject: 'user_1' });

    const composed = composeGuards(apiKeyGuard({ keys }), sessionGuard({ sessions }));

    expect((await composed({ request: request({ 'x-api-key': key }) }))?.subject).toBe('svc_1');
    expect(
      (await composed({ request: request({ cookie: `__Host-tsir_session=${token}` }) }))?.subject,
    ).toBe('user_1');
    expect(await composed({ request: request({}) })).toBeNull();
  });

  test('a null from the first guard falls through to the second', async () => {
    const order: string[] = [];
    const composed = composeGuards(
      () => {
        order.push('first');
        return null;
      },
      () => {
        order.push('second');
        return { subject: 'second', data: null };
      },
      () => {
        order.push('third');
        return { subject: 'third', data: null };
      },
    );

    expect((await composed({ request: request() }))?.subject).toBe('second');
    expect(order).toEqual(['first', 'second']); // never reached the third
  });

  test('a guard that throws stops the chain — an outage never downgrades', async () => {
    let reached = false;
    const composed = composeGuards(
      () => Promise.reject(new Error('session store down')),
      () => {
        reached = true;
        return { subject: 'fallback', data: null };
      },
    );

    const error = await failure(composed({ request: request() }));
    expect((error as Error).message).toBe('session store down');
    expect(reached).toBe(false);
  });

  test('no guards at all is `null`, not a crash', async () => {
    expect(await composeGuards()({ request: request() })).toBeNull();
  });
});
