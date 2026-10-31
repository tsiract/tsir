import { describe, expect, test } from 'bun:test';

import { Controller, Get, Post, RouteRegistry, compileRoutes } from '@tsir/router';

import { createFetchHandler } from './pipeline.ts';

/**
 * Protocol conformance (HTP-021).
 *
 * ADR-0018 accepts a known risk by owning the router: a mature third-party
 * router has already absorbed years of HTTP edge cases. This file is the answer
 * to that risk — one table of behaviours, each asserted explicitly, so a
 * regression is a red test rather than a bug report from a client team.
 *
 * Every case here is about *matching and framing*, not about business logic.
 */

function table(build: (registry: RouteRegistry) => void): ReturnType<typeof compileRoutes> {
  const registry = new RouteRegistry();
  build(registry);
  return compileRoutes(registry.entries());
}

function handlerOf(): ReturnType<typeof createFetchHandler> {
  return createFetchHandler(
    table((registry) => {
      @Controller(registry, '/users')
      class Users {
        @Get('/')
        list(): unknown {
          return { ok: true };
        }

        @Get('/:id')
        one({ params }: { params: { id: string } }): unknown {
          return { id: params.id };
        }

        @Get('/search')
        search(): unknown {
          return { found: true };
        }

        @Post('/')
        create(): unknown {
          return { created: true };
        }

        @Get('/:id/avatar')
        avatar(): Response {
          return new Response('bytes', { headers: { 'content-type': 'image/png' } });
        }
      }
      void Users;
    }),
  );
}

const handler = handlerOf();

describe('http · conformance: matching', () => {
  test('a static segment beats a parameter regardless of declaration order', async () => {
    // `/users/search` is declared after `/users/:id`, so this only passes if
    // matching ranks static segments above parameters.
    const response = await handler(new Request('http://tsir.test/users/search'));
    expect(await response.json()).toEqual({ found: true });
  });

  test('a wrong method is 405 with an Allow header, never 404', async () => {
    const response = await handler(new Request('http://tsir.test/users', { method: 'DELETE' }));
    expect(response.status).toBe(405);
    // HEAD is advertised because a GET route genuinely answers it (RFC 9110
    // § 9.3.2); an `Allow` that omitted it would be wrong.
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST');

    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('HTP_METHOD_NOT_ALLOWED');
  });

  test('an unknown path is 404, and does not leak whether a sibling exists', async () => {
    const response = await handler(new Request('http://tsir.test/nothing/here'));
    expect(response.status).toBe(404);
    expect(response.headers.get('allow')).toBeNull();
  });

  test('trailing slash is strict by default, and configurable', async () => {
    // Strict means exact: `/users/` and `/users` are different resources, and
    // only one is declared. Both cases are 404 — never 400, because the request
    // is well-formed; the resource simply does not exist under that spelling.
    expect((await handler(new Request('http://tsir.test/users'))).status).toBe(200);
    expect((await handler(new Request('http://tsir.test/users/'))).status).toBe(404);
    expect((await handler(new Request('http://tsir.test/users/42/'))).status).toBe(404);

    const lenient = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/users')
        class Users {
          @Get('/:id')
          one(): unknown {
            return { ok: true };
          }
        }
        void Users;
      }),
      { trailingSlash: 'ignore' },
    );
    expect((await lenient(new Request('http://tsir.test/users/42'))).status).toBe(200);
    expect((await lenient(new Request('http://tsir.test/users/42/'))).status).toBe(200);
  });

  test('an encoded separator is rejected rather than smuggled past the matcher', async () => {
    // `%2F` decoded before matching would let a parameter contain a segment
    // boundary; rejected outright, as a 400.
    const slash = await handler(new Request('http://tsir.test/users/a%2Fb'));
    expect(slash.status).toBe(400);
    expect(((await slash.json()) as { code: string }).code).toBe('HTP_BAD_REQUEST');

    const backslash = await handler(new Request('http://tsir.test/users/a%5Cb'));
    expect(backslash.status).toBe(400);
  });

  test('a path parameter is percent-decoded exactly once', async () => {
    const response = await handler(new Request('http://tsir.test/users/a%20b'));
    expect(await response.json()).toEqual({ id: 'a b' });
  });

  test('an empty segment is malformed, and says so', async () => {
    expect((await handler(new Request('http://tsir.test/users//42'))).status).toBe(400);
  });

  test('repeated query keys arrive as an array, single keys as strings', async () => {
    const seen: unknown[] = [];
    const lenient = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Q {
          @Get('/q')
          q({ query }: { query: unknown }): unknown {
            seen.push(query);
            return { ok: true };
          }
        }
        void Q;
      }),
    );

    await lenient(new Request('http://tsir.test/q?a=1&a=2&b=3'));
    expect(seen[0]).toEqual({ a: ['1', '2'], b: '3' });
  });
});

describe('http · conformance: framing', () => {
  test('HEAD answers GET semantics with no body', async () => {
    const head = await handler(new Request('http://tsir.test/users', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    // Headers a GET would have sent are still there: a HEAD that omits
    // content-type tells a cache nothing about the representation.
    expect(head.headers.get('content-type')).toContain('application/json');
  });

  test('HEAD on a route with no explicit HEAD registration does not 405', async () => {
    const head = await handler(new Request('http://tsir.test/users/42', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('allow')).toBeNull();
  });

  test('every response carries a request id, including errors', async () => {
    for (const path of ['/users', '/users/42', '/nope']) {
      const response = await handler(new Request(`http://tsir.test${path}`));
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test('a handler-returned Response keeps its own content type', async () => {
    const response = await handler(new Request('http://tsir.test/users/1/avatar'));
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(await response.text()).toBe('bytes');
  });

  test('responses are problem+json only when they are problems', async () => {
    const ok = await handler(new Request('http://tsir.test/users'));
    expect(ok.headers.get('content-type')).toContain('application/json');
    expect(ok.headers.get('content-type')).not.toContain('problem');

    const bad = await handler(new Request('http://tsir.test/nope'));
    expect(bad.headers.get('content-type')).toContain('application/problem+json');
  });

  test('an empty body on a POST with no body schema is not a 400', async () => {
    const response = await handler(new Request('http://tsir.test/users', { method: 'POST' }));
    expect(response.status).toBe(200);
  });

  test('an unknown method is answered, not crashed', async () => {
    const response = await handler(new Request('http://tsir.test/users', { method: 'PROPFIND' }));
    expect([404, 405]).toContain(response.status);
  });
});

describe('http · conformance: content negotiation', () => {
  test('406 only when the route declares what it produces', async () => {
    const strict = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Docs {
          @Get('/doc', { produces: ['application/json'] })
          doc(): unknown {
            return { ok: true };
          }
        }
        void Docs;
      }),
    );

    expect((await strict(new Request('http://tsir.test/doc'))).status).toBe(200);
    expect(
      (await strict(new Request('http://tsir.test/doc', { headers: { accept: '*/*' } }))).status,
    ).toBe(200);
    expect(
      (await strict(new Request('http://tsir.test/doc', { headers: { accept: 'text/html' } })))
        .status,
    ).toBe(406);
  });

  test('415 when the body type is declared and does not match', async () => {
    const strict = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Docs {
          @Post('/doc', { consumes: ['application/json'] })
          doc(): unknown {
            return { ok: true };
          }
        }
        void Docs;
      }),
    );

    expect(
      (
        await strict(
          new Request('http://tsir.test/doc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await strict(
          new Request('http://tsir.test/doc', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
          }),
        )
      ).status,
    ).toBe(415);
  });
});
