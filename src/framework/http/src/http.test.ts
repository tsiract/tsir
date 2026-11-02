import { describe, expect, test } from 'bun:test';

import { Controller, compileRoutes, Get, Post, Route, RouteRegistry } from '@tsir/router';
import { z } from '@tsir/validate';
import { IntParam, PageQuery, SortQuery, UuidParam } from '@tsir/validate/http';

import { createFetchHandler, type HttpOptions } from './pipeline.ts';

function build(routes: (registry: RouteRegistry) => void, options: HttpOptions = {}) {
  const registry = new RouteRegistry();
  routes(registry);
  return createFetchHandler(compileRoutes(registry.entries()), options);
}

function json(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  path = '/',
  init: RequestInit = {},
) {
  return handler(
    new Request(`http://tsir.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify(body),
      ...init,
    }),
  );
}

describe('routing outcomes', () => {
  const handler = build((registry) => {
    @Controller(registry, '/api/users')
    class Users {
      @Get('/') list(): { ok: true } {
        return { ok: true };
      }

      @Post('/') create(): { id: number } {
        return { id: 1 };
      }
    }
    // declared for its decorator side effect
    void Users;
  });

  test('unknown path is a 404 problem with a code', async () => {
    const response = await handler(new Request('http://tsir.test/nope'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = (await response.json()) as { code: string; type: string };
    expect(body.code).toBe('HTP_ROUTE_NOT_FOUND');
    expect(body.type).toBe('https://tsir.dev/errors/not-found');
  });

  test('known path, wrong method is a 405 with Allow', async () => {
    const response = await handler(new Request('http://tsir.test/api/users', { method: 'DELETE' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST');
  });

  test('every response carries a request id', async () => {
    const response = await handler(new Request('http://tsir.test/api/users'));
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('an incoming X-Request-Id is propagated on the response', async () => {
    const response = await handler(
      new Request('http://tsir.test/api/users', { headers: { 'x-request-id': 'caller-abc-123' } }),
    );
    expect(response.headers.get('x-request-id')).toBe('caller-abc-123');
  });

  test('a generated request id is used when no incoming header is present', async () => {
    const response = await handler(new Request('http://tsir.test/api/users'));
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('an incoming X-Request-Id with control characters is sanitized', async () => {
    // Tab (U+0009) passes through the Web Request constructor but is a
    // control character; the sanitizer strips it to prevent log injection.
    const response = await handler(
      new Request('http://tsir.test/api/users', {
        headers: { 'x-request-id': 'safe-id\tinjected' },
      }),
    );
    expect(response.headers.get('x-request-id')).toBe('safe-idinjected');
  });

  test('an incoming X-Request-Id that is empty after sanitization is replaced', async () => {
    const response = await handler(
      new Request('http://tsir.test/api/users', { headers: { 'x-request-id': '   ' } }),
    );
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('an incoming X-Request-Id over the length limit is replaced', async () => {
    const long = 'a'.repeat(300);
    const response = await handler(
      new Request('http://tsir.test/api/users', { headers: { 'x-request-id': long } }),
    );
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the propagated request id reaches the problem body on errors', async () => {
    const response = await handler(
      new Request('http://tsir.test/nope', { headers: { 'x-request-id': 'trace-42' } }),
    );
    const body = (await response.json()) as { requestId: string };
    expect(body.requestId).toBe('trace-42');
  });

  test('HEAD returns the GET status and no body', async () => {
    const response = await handler(new Request('http://tsir.test/api/users', { method: 'HEAD' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });
});

describe('binding and validation', () => {
  test('path parameters are validated and coerced by the declared schema', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/api/users')
      class Users {
        @Route({ method: 'GET', path: '/:id', params: z.object({ id: IntParam }) })
        findOne({ params }: { params: { id: number } }): { id: number; type: string } {
          return { id: params.id, type: typeof params.id };
        }
      }
      // declared for its decorator side effect
      void Users;
    });

    const ok = await handler(new Request('http://tsir.test/api/users/42'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 42, type: 'number' });

    const bad = await handler(new Request('http://tsir.test/api/users/4.2'));
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as { code: string; issues: { path: string[]; code: string }[] };
    expect(body.code).toBe('HTP_VALIDATION_FAILED');
    expect(body.issues[0]?.path).toEqual(['id']);
  });

  test('an invalid body is a 422 listing each offending field', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/api/users')
      class Users {
        @Post('/', { status: 201 })
        create(): { created: true } {
          return { created: true };
        }
      }
      // declared for its decorator side effect
      void Users;
    });

    const schema = z.object({ email: z.email(), name: z.string().min(2) });
    const withSchema = build((registry) => {
      @Controller(registry, '/api/users')
      class Users2 {
        @Post('/', { status: 201, body: schema })
        create({ body }: { body: { email: string; name: string } }): { email: string } {
          return { email: body.email };
        }
      }
      // declared for its decorator side effect
      void Users2;
    });

    const response = await json(withSchema, { email: 'nope', name: 'x' }, '/api/users');
    expect(response.status).toBe(422);
    const body = (await response.json()) as { issues: { path: string[] }[] };
    expect(body.issues.map((issue) => issue.path[0]).sort()).toEqual(['email', 'name']);

    // The schema-less route accepts the same payload, proving the 422 came from
    // validation and not from body parsing.
    const unvalidated = await json(handler, { email: 'nope', name: 'x' }, '/api/users');
    expect(unvalidated.status).toBe(201);
  });

  test('a body on a route that declares no body is still size-limited', async () => {
    const handler = build(
      (registry) => {
        @Controller(registry, '/x')
        class X {
          @Post('/') go(): { ok: true } {
            return { ok: true };
          }
        }
        // declared for its decorator side effect
        void X;
      },
      { maxBodyBytes: 32 },
    );

    const response = await json(handler, { payload: 'x'.repeat(100) }, '/x');
    expect(response.status).toBe(413);
  });

  test('wrong content type is a 415 naming what the route consumes', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Post('/', { body: z.object({ a: z.string() }) })
        go(): { ok: true } {
          return { ok: true };
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const response = await handler(
      new Request('http://tsir.test/x', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: 'a,b',
      }),
    );
    expect(response.status).toBe(415);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toContain('application/json');
  });

  test('an unsatisfiable Accept is a 406', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Get('/', { produces: ['application/json'] })
        go(): { ok: true } {
          return { ok: true };
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const response = await handler(
      new Request('http://tsir.test/x', { headers: { accept: 'text/xml' } }),
    );
    expect(response.status).toBe(406);
  });

  test('query helpers: bounded paging and allowlisted sorting', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Get('/', {
          query: z.object({
            paging: PageQuery({ maxPerPage: 50 }),
            sort: SortQuery(['createdAt', 'email']),
          }),
        })
        go({ query }: { query: unknown }): unknown {
          return query;
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const defaults = await handler(new Request('http://tsir.test/x?paging=%7B%7D'));
    expect(defaults.status).toBe(422); // paging is an object schema, not a query string

    const direct = build((registry) => {
      @Controller(registry, '/y')
      class Y {
        @Get('/', { query: PageQuery({ maxPerPage: 50 }) })
        go({ query }: { query: { page: number; perPage: number } }): unknown {
          return query;
        }
      }
      // declared for its decorator side effect
      void Y;
    });

    expect(await (await direct(new Request('http://tsir.test/y'))).json()).toEqual({
      page: 1,
      perPage: 20,
    });
    expect(
      await (await direct(new Request('http://tsir.test/y?page=3&perPage=50'))).json(),
    ).toEqual({ page: 3, perPage: 50 });
    expect((await direct(new Request('http://tsir.test/y?perPage=51'))).status).toBe(422);
  });

  test('UUID and sort schemas reject what they should', async () => {
    expect(UuidParam.safeParse('2f1c1f9e-7d0a-4d3f-9a1e-2b6c5d4e3f21').success).toBe(true);
    expect(UuidParam.safeParse('not-a-uuid').success).toBe(false);

    const sort = SortQuery(['createdAt']);
    expect(sort.parse('-createdAt')).toEqual([{ field: 'createdAt', direction: 'desc' }]);
    // Unknown fields are rejected — an unvalidated sort reaches the database.
    expect(sort.safeParse('createdAt,email').success).toBe(false);
    expect(sort.parse('')).toEqual([]);
  });
});

describe('middleware, guards, policies', () => {
  test('global middleware wraps the handler in order', async () => {
    const order: string[] = [];
    const handler = build(
      (registry) => {
        @Controller(registry, '/x')
        class X {
          @Get('/') go(): { ok: true } {
            order.push('handler');
            return { ok: true };
          }
        }
        // declared for its decorator side effect
        void X;
      },
      {
        middleware: [
          async (_ctx, next) => {
            order.push('outer:in');
            const response = await next();
            order.push('outer:out');
            return response;
          },
          async (_ctx, next) => {
            order.push('inner:in');
            const response = await next();
            order.push('inner:out');
            return response;
          },
        ],
      },
    );

    await handler(new Request('http://tsir.test/x'));
    expect(order).toEqual(['outer:in', 'inner:in', 'handler', 'inner:out', 'outer:out']);
  });

  test('middleware can short-circuit without running the handler', async () => {
    let ran = false;
    const handler = build(
      (registry) => {
        @Controller(registry, '/x')
        class X {
          @Get('/') go(): { ok: true } {
            ran = true;
            return { ok: true };
          }
        }
        // declared for its decorator side effect
        void X;
      },
      { middleware: [() => new Response('blocked', { status: 403 })] },
    );

    const response = await handler(new Request('http://tsir.test/x'));
    expect(response.status).toBe(403);
    expect(ran).toBe(false);
  });

  test('a guard returning null is a 401; a guard returning a principal exposes it', async () => {
    const handler = build(
      (registry) => {
        @Controller(registry, '/private')
        class Private {
          @Get('/', { guards: ['auth'] })
          go({ ctx }: { ctx: { principal?: { subject: string } } }): { who: string } {
            return { who: ctx.principal?.subject ?? 'nobody' };
          }
        }
        // declared for its decorator side effect
        void Private;
      },
      {
        guards: {
          auth: (ctx) =>
            ctx.request.headers.get('authorization') === 'Bearer t'
              ? { subject: 'u1', data: null }
              : null,
        },
      },
    );

    const denied = await handler(new Request('http://tsir.test/private'));
    expect(denied.status).toBe(401);

    const allowed = await handler(
      new Request('http://tsir.test/private', { headers: { authorization: 'Bearer t' } }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ who: 'u1' });
  });

  test('a denied policy is a 403 with the reason; an allowed policy proceeds', async () => {
    const handler = build(
      (registry) => {
        @Controller(registry, '/orders')
        class Orders {
          @Get('/', { policies: [{ resource: 'order', action: 'read' }] })
          go(): { ok: true } {
            return { ok: true };
          }
        }
        // declared for its decorator side effect
        void Orders;
      },
      {
        policies: {
          'order:read': (ctx) =>
            ctx.request.headers.get('x-role') === 'admin'
              ? { allowed: true }
              : { allowed: false, reason: 'admins only' },
        },
      },
    );

    const denied = await handler(new Request('http://tsir.test/orders'));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { detail: string }).detail).toBe('admins only');

    const allowed = await handler(
      new Request('http://tsir.test/orders', { headers: { 'x-role': 'admin' } }),
    );
    expect(allowed.status).toBe(200);
  });

  test('an unregistered guard fails at construction, not per request', () => {
    expect(() =>
      build((registry) => {
        @Controller(registry, '/x')
        class X {
          @Get('/', { guards: ['missing'] })
          go(): { ok: true } {
            return { ok: true };
          }
        }
        // declared for its decorator side effect
        void X;
      }),
    ).toThrow(/not registered/);
  });
});

describe('responses', () => {
  test('a plain object becomes JSON with the declared status', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Post('/', { status: 201 })
        go(): { id: number } {
          return { id: 7 };
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const response = await json(handler, {}, '/x');
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ id: 7 });
  });

  test('a ResponsePlan sets status and headers', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Get('/')
        go(): { status: number; body: unknown; headers: Record<string, string> } {
          return { status: 202, body: { queued: true }, headers: { 'x-queued': 'yes' } };
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const response = await handler(new Request('http://tsir.test/x'));
    expect(response.status).toBe(202);
    expect(response.headers.get('x-queued') ?? '').toBe('yes');
    expect(await response.json()).toEqual({ queued: true });
  });

  test('204 with no body is fine; 204 with a body is a framework error', async () => {
    const clean = build((registry) => {
      @Controller(registry, '/a')
      class A {
        @Post('/', { status: 204 })
        go(): void {
          /* noop */
        }
      }
      // declared for its decorator side effect
      void A;
    });
    expect((await json(clean, {}, '/a')).status).toBe(204);

    const dirty = build((registry) => {
      @Controller(registry, '/b')
      class B {
        @Post('/', { status: 204 })
        go(): { unexpected: true } {
          return { unexpected: true };
        }
      }
      // declared for its decorator side effect
      void B;
    });
    const response = await json(dirty, {}, '/b');
    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe('HTP_BODY_NOT_ALLOWED');
  });

  test('a handler may return a Response and control everything', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Get('/')
        go(): Response {
          return new Response('raw', { status: 418, headers: { 'x-custom': '1' } });
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const response = await handler(new Request('http://tsir.test/x'));
    expect(response.status).toBe(418);
    expect(await response.text()).toBe('raw');
    expect(response.headers.get('x-custom') ?? '').toBe('1');
  });
});

describe('failure boundaries', () => {
  test('a thrown error becomes a 500 with the request id and no stack', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Get('/')
        go(): never {
          throw new Error('database exploded at 10.0.0.1');
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const response = await handler(new Request('http://tsir.test/x'));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('database exploded');
    expect(text).not.toContain('at 10.0.0.1');
    const body = JSON.parse(text) as { code: string; requestId: string };
    expect(body.code).toBe('HTP_HANDLER_ERROR');
    expect(body.requestId).toBe(response.headers.get('x-request-id') ?? '');
  });

  test('no problem body carries stack, cause, or a raw error message', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Get('/')
        go(): never {
          const err = new Error('internal detail that must not leak');
          (err as { cause?: unknown }).cause = new Error('nested cause');
          throw err;
        }
      }
      void X;
    });

    const response = await handler(new Request('http://tsir.test/x'));
    const body = JSON.parse(await response.text()) as Record<string, unknown>;
    // Only the fields problemBody() emits may be present.
    const allowed = new Set([
      'type',
      'title',
      'status',
      'code',
      'detail',
      'instance',
      'requestId',
      'issues',
    ]);
    for (const key of Object.keys(body)) expect(allowed.has(key)).toBe(true);
    expect(body.stack).toBeUndefined();
    expect(body.cause).toBeUndefined();
    expect(body.message).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('internal detail');
    expect(JSON.stringify(body)).not.toContain('nested cause');
  });

  test('a malformed body response does not echo the input', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Post('/', { body: z.object({}) })
        go(): { ok: true } {
          return { ok: true };
        }
      }
      void X;
    });

    const secret = 'secret-12345';
    const response = await handler(
      new Request('http://tsir.test/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{ "broken": ${secret} }`,
      }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(secret);
  });

  test('a ValidationError thrown in the handler is a 422 with issues', async () => {
    const { ValidationError } = await import('@tsir/validate');
    const handler = build((registry) => {
      @Controller(registry, '/x')
      class X {
        @Post('/')
        go(): never {
          throw new ValidationError(
            [{ path: ['sku'], code: 'missing', message: 'Required' }],
            'sku',
          );
        }
      }
      // declared for its decorator side effect
      void X;
    });

    const response = await json(handler, {}, '/x');
    expect(response.status).toBe(422);
    const body = (await response.json()) as { issues: { path: string[] }[] };
    expect(body.issues[0]?.path).toEqual(['sku']);
  });

  test('a route timeout produces a 504 even if the handler ignores its signal', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/slow')
      class Slow {
        @Get('/', { timeoutMs: 20 })
        go(): Promise<{ late: true }> {
          return new Promise((resolve) => setTimeout(() => resolve({ late: true }), 500));
        }
      }
      // declared for its decorator side effect
      void Slow;
    });

    const response = await handler(new Request('http://tsir.test/slow'));
    expect(response.status).toBe(504);
    expect(((await response.json()) as { code: string }).code).toBe('HTP_TIMEOUT');
  });

  test('a throwing onError mapper does not mask the failure', async () => {
    const handler = build(
      (registry) => {
        @Controller(registry, '/x')
        class X {
          @Get('/')
          go(): never {
            throw new Error('boom');
          }
        }
        // declared for its decorator side effect
        void X;
      },
      {
        onError: () => {
          throw new Error('mapper is broken too');
        },
      },
    );

    const response = await handler(new Request('http://tsir.test/x'));
    expect(response.status).toBe(500);
  });
});

describe('body hardening', () => {
  const handler = build((registry) => {
    @Controller(registry, '/x')
    class X {
      @Post('/', { body: z.object({ name: z.string() }) })
      go({ body }: { body: unknown }): unknown {
        return body;
      }
    }
    // declared for its decorator side effect
    void X;
  });

  test('prototype-polluting keys are rejected before validation', async () => {
    const response = await handler(
      new Request('http://tsir.test/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"a","__proto__":{"polluted":true}}',
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toContain(
      'forbidden object key',
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('a deeply nested body is rejected as malformed, not crashed', async () => {
    let payload = '1';
    for (let depth = 0; depth < 40; depth += 1) payload = `{"a":${payload}}`;

    const response = await handler(
      new Request('http://tsir.test/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
    );
    expect(response.status).toBe(400);
  });

  test('invalid JSON is a 400 that does not echo the payload', async () => {
    const response = await handler(
      new Request('http://tsir.test/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name": "secret-value"',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret-value');
  });
});

describe('streaming request bodies', () => {
  test('a streaming route hands the handler a ReadableStream', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/upload')
      class Upload {
        @Post('/', { stream: true })
        async receive(args: { body: unknown }): Promise<{ bytes: number }> {
          const stream = args.body as ReadableStream<Uint8Array>;
          const reader = stream.getReader();
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
          }
          return { bytes: total };
        }
      }
      void Upload;
    });

    const response = await handler(
      new Request('http://tsir.test/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3, 4, 5]),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bytes: 5 });
  });

  test('a streaming body over the size limit is rejected', async () => {
    const handler = build(
      (registry) => {
        @Controller(registry, '/upload')
        class Upload {
          @Post('/', { stream: true })
          async receive(args: { body: unknown }): Promise<{ ok: true }> {
            const stream = args.body as ReadableStream<Uint8Array>;
            const reader = stream.getReader();
            // Consume until done — the stream errors with HTP_BODY_TOO_LARGE
            // when the limit is exceeded, and that propagates to a 413.
            for (;;) {
              const { done } = await reader.read();
              if (done) break;
            }
            return { ok: true };
          }
        }
        void Upload;
      },
      { maxBodyBytes: 4 },
    );

    const response = await handler(
      new Request('http://tsir.test/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(Array.from({ length: 10 }, () => 1)),
      }),
    );
    expect(response.status).toBe(413);
  });

  test('a declared content-length over the limit is rejected before reading', async () => {
    const handler = build(
      (registry) => {
        @Controller(registry, '/upload')
        class Upload {
          @Post('/', { stream: true })
          receive(): { ok: true } {
            return { ok: true };
          }
        }
        void Upload;
      },
      { maxBodyBytes: 4 },
    );

    const response = await handler(
      new Request('http://tsir.test/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': '100' },
        body: new Uint8Array(Array.from({ length: 100 }, () => 1)),
      }),
    );
    expect(response.status).toBe(413);
  });
});

describe('security headers', () => {
  test('HTML responses get helmet-equivalent headers', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/page')
      class Page {
        @Get('/')
        render(): Response {
          return new Response('<html><body>hi</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
      }
      void Page;
    });

    const response = await handler(new Request('http://tsir.test/page'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  test('non-HTML responses do not get helmet headers', async () => {
    const handler = build((registry) => {
      @Controller(registry, '/api')
      class Api {
        @Get('/')
        data(): { ok: true } {
          return { ok: true };
        }
      }
      void Api;
    });

    const response = await handler(new Request('http://tsir.test/api'));
    expect(response.headers.get('x-content-type-options')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
});
