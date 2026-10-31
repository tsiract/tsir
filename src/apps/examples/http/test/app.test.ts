import { describe, expect, test } from 'bun:test';

import { compileRoutes, type ControllerEntry } from '@tsir/router';

import app, { handler } from '../src/app.ts';
import { media } from '../src/modules/media/index.ts';
import { users } from '../src/modules/users/index.ts';

/**
 * The entries this application declares — taken from its modules, not from the
 * process-global list. `collectRouteEntries()` is what the CLI reads (one app per
 * process there); a test file shares the process with other suites, so it says
 * explicitly which modules it means.
 */
const appEntries = (): readonly ControllerEntry[] => [
  ...users.registry.entries(),
  ...media.registry.entries(),
];

const get = (path: string, init?: RequestInit): Promise<Response> =>
  handler(new Request(`http://tsir.test${path}`, init));

describe('http example', () => {
  test('boots through the same path production uses', async () => {
    const instance = await app.createApp({ mode: 'test', env: { APP_ENV: 'test' } });
    expect(instance.state.kind).toBe('ready');
    await instance.shutdown('manual');
  });

  test('the registry compiles into a table with the declared routes', () => {
    const table = compileRoutes(appEntries());
    expect(table.routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/users/:id',
      'GET /api/users',
      'GET /api/users/:id',
      'GET /api/users/:id/profile',
      'POST /api/uploads',
      'POST /api/users',
    ]);
  });

  test('a parameterised route binds and validates its path parameter', async () => {
    const ok = await get('/api/users/42');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 42 });

    const bad = await get('/api/users/4.2');
    expect(bad.status).toBe(422);
  });

  test('a query schema fills in defaults', async () => {
    const response = await get('/api/users');
    expect(await response.json()).toEqual({ page: 1, perPage: 20, data: [] });
  });

  test('a body is validated and a declared status is honoured', async () => {
    const created = await get('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 1, email: 'ada@example.com', name: 'Ada' });

    const rejected = await get('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', name: '' }),
    });
    expect(rejected.status).toBe(422);
  });

  test('a 204 route returns no body', async () => {
    const removed = await get('/api/users/7', { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
  });

  test('unknown routes and methods are problem+json', async () => {
    expect((await get('/nope')).status).toBe(404);
    const wrongMethod = await get('/api/users', { method: 'PUT' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toContain('GET');
  });
});

describe('http example · guards and response contracts', () => {
  test('a guarded route rejects an unauthenticated request with 401', async () => {
    const response = await get('/api/users/7/profile');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(((await response.json()) as { code: string }).code).toBe('HTP_UNAUTHENTICATED');
  });

  test('a guard sets the principal the handler binds', async () => {
    const response = await get('/api/users/7/profile', {
      headers: { authorization: 'Bearer ada' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 7,
      email: 'ada@example.com',
      displayName: 'ada',
    });
  });

  test('path parameters are still validated before the handler runs', async () => {
    const response = await get('/api/users/not-a-number/profile', {
      headers: { authorization: 'Bearer ada' },
    });
    expect(response.status).toBe(422);
  });
});

describe('http example · multipart upload (VLD-006)', () => {
  function upload(form: FormData): Promise<Response> {
    return handler(new Request('http://tsir.test/api/uploads', { method: 'POST', body: form }));
  }

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  test('a real PNG is accepted and the handler sees a File', async () => {
    const form = new FormData();
    form.set('caption', 'portrait');
    form.set('image', new File([PNG], 'me.png', { type: 'image/png' }));

    const response = await upload(form);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      caption: 'portrait',
      image: { name: 'me.png', size: PNG.length, type: 'image/png' },
    });
  });

  test('a file whose bytes are not a PNG is rejected even if it claims to be', async () => {
    const form = new FormData();
    form.set(
      'image',
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'x.png', { type: 'image/png' }),
    );

    const response = await upload(form);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('HTP_MIME_MISMATCH');
  });
});

describe('http example · modules (MOD-002)', () => {
  test('each module owns exactly its own routes', () => {
    expect(
      users
        .routes()
        .routes.map((route) => `${route.method} ${route.path}`)
        .sort(),
    ).toEqual([
      'DELETE /api/users/:id',
      'GET /api/users',
      'GET /api/users/:id',
      'GET /api/users/:id/profile',
      'POST /api/users',
    ]);
    expect(media.routes().routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /api/uploads',
    ]);
  });

  test('the module unit is applied without the controller repeating it', () => {
    const units = media.routes().routes.map((route) => route.meta.unit);
    expect(units).toEqual(['media']);
    expect(users.routes().routes.every((route) => route.meta.unit === 'http')).toBe(true);
  });

  test('the union of the modules is the table the app serves', () => {
    const union = compileRoutes(appEntries())
      .routes.map((route) => route.path)
      .sort();
    const served = handler;
    expect(served).toBeDefined();
    expect(union).toEqual(
      [
        '/api/uploads',
        '/api/users',
        '/api/users/:id',
        '/api/users/:id/profile',
        '/api/users/:id',
        '/api/users',
      ].sort(),
    );
  });
});

describe('http example · generated route table (RTR-007)', () => {
  test('routes.gen.ts matches a fresh compile of the registry', async () => {
    // The generated file is committed, so it can go stale. Compiling the
    // registry again and comparing structurally is what turns "someone forgot
    // to regenerate" into a red test rather than a production surprise.
    const { routes } = await import('../src/routes.gen.ts');

    const fresh = compileRoutes(appEntries()).routes;
    expect(routes.length).toBe(fresh.length);

    for (const [index, compiled] of fresh.entries()) {
      const generated = routes[index];
      expect(generated).toBeDefined();
      if (generated === undefined) continue;
      expect({
        method: generated.method,
        path: generated.path,
        segments: [...generated.segments],
        controller: generated.controller.name,
        handler: generated.handler,
        status: generated.meta.status,
        guards: [...generated.guards],
        policies: [...generated.policies],
        middleware: [...generated.middleware],
        tags: generated.meta.tags,
        operationId: generated.meta.operationId,
        // Schemas must be the *same objects*, since they cannot be serialized.
        body: generated.meta.body === compiled.meta.body,
        query: generated.meta.query === compiled.meta.query,
        params: generated.meta.params === compiled.meta.params,
      }).toEqual({
        method: compiled.method,
        path: compiled.path,
        segments: [...compiled.segments],
        controller: compiled.controller.name,
        handler: compiled.handler,
        status: compiled.meta.status,
        guards: [...compiled.guards],
        policies: [...compiled.policies],
        middleware: [...compiled.middleware],
        tags: compiled.meta.tags,
        operationId: compiled.meta.operationId,
        body: true,
        query: true,
        params: true,
      });
    }
  });
});
