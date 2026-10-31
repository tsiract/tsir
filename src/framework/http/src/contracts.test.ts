import { describe, expect, test } from 'bun:test';

import { Controller, Get, RouteRegistry, compileRoutes } from '@tsir/router';
import { z } from '@tsir/validate';

import { createFetchHandler } from './pipeline.ts';
import type { Guard } from './pipeline.ts';

function table(build: (registry: RouteRegistry) => void): ReturnType<typeof compileRoutes> {
  const registry = new RouteRegistry();
  build(registry);
  return compileRoutes(registry.entries());
}

const ok = (init?: RequestInit): Request => new Request('http://tsir.test/', init);

describe('http · principal binding (HTP-008)', () => {
  test('principal reaches the handler only when the route declares it', async () => {
    const handler = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Things {
          @Get('/', { guards: ['auth'], principal: true })
          withPrincipal({ principal }: { principal: { subject: string } }): unknown {
            return { subject: principal.subject };
          }

          @Get('/public')
          withoutPrincipal(args: { principal?: unknown }): unknown {
            return { bound: 'principal' in args };
          }
        }
        void Things;
      }),
      { guards: { auth: (() => ({ subject: 'ada', data: null })) satisfies Guard } },
    );

    const guarded = await handler(ok());
    expect(await guarded.json()).toEqual({ subject: 'ada' });

    // Not requested → not present at all, rather than present and undefined.
    const open = await handler(new Request('http://tsir.test/public'));
    expect(await open.json()).toEqual({ bound: false });
  });

  test('a guard returning null stops the request before the handler', async () => {
    let ran = false;
    const handler = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Things {
          @Get('/', { guards: ['deny'], principal: true })
          secret(): unknown {
            ran = true;
            return { ok: true };
          }
        }
        void Things;
      }),
      { guards: { deny: () => null } },
    );

    const response = await handler(ok());
    expect(response.status).toBe(401);
    // RFC 9110 § 15.5.2: a 401 without a challenge tells the client nothing.
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(ran).toBe(false);
  });

  test('declaring principal without a guard fails at compile time', () => {
    expect(() =>
      table((registry) => {
        @Controller(registry, '/')
        class Things {
          @Get('/', { principal: true })
          bad(): unknown {
            return {};
          }
        }
        void Things;
      }),
    ).toThrow(/RTR_PRINCIPAL_WITHOUT_GUARD|binds `principal` but declares no guard/);
  });
});

describe('http · response validation (HTP-013)', () => {
  const User = z.object({ id: z.number().int(), email: z.email() });

  function broken(build: (registry: RouteRegistry) => void, mode: 'dev' | 'always' | 'never') {
    const seen: string[] = [];
    const handler = createFetchHandler(table(build), {
      responseValidation: mode,
      onInvalidResponse: (failure) => seen.push(failure.route.handler),
    });
    return { handler, seen };
  }

  test('an invalid body is passed through in dev, and reported', async () => {
    const { handler, seen } = broken((registry) => {
      @Controller(registry, '/')
      class Things {
        @Get('/', { response: User })
        wrong(): unknown {
          return { id: 'not-a-number', email: 'nope' };
        }
      }
      void Things;
    }, 'dev');

    const response = await handler(ok());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'not-a-number', email: 'nope' });
    expect(seen).toEqual(['wrong']);
  });

  test('an invalid body becomes a 500 in always', async () => {
    const { handler, seen } = broken((registry) => {
      @Controller(registry, '/')
      class Things {
        @Get('/', { response: User })
        wrong(): unknown {
          return { id: 1, email: 'not-an-email' };
        }
      }
      void Things;
    }, 'always');

    const response = await handler(ok());
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('HTP_RESPONSE_INVALID');
    expect(seen).toEqual(['wrong']);
  });

  test('never skips validation entirely', async () => {
    const { handler, seen } = broken((registry) => {
      @Controller(registry, '/')
      class Things {
        @Get('/', { response: User })
        wrong(): unknown {
          return { id: 'nope' };
        }
      }
      void Things;
    }, 'never');

    const response = await handler(ok());
    expect(response.status).toBe(200);
    expect(seen).toEqual([]);
  });

  test('a valid body is untouched and validated after binding', async () => {
    const { handler, seen } = broken((registry) => {
      @Controller(registry, '/')
      class Things {
        @Get('/', { response: User })
        right(): unknown {
          return { id: 3, email: 'ada@example.com' };
        }
      }
      void Things;
    }, 'always');

    const response = await handler(ok());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 3, email: 'ada@example.com' });
    expect(seen).toEqual([]);
  });
});

describe('http · CORS (HTP-019)', () => {
  const routes = (registry: RouteRegistry): void => {
    @Controller(registry, '/')
    class Things {
      @Get('/', {})
      one(): unknown {
        return { ok: true };
      }
    }
    void Things;
  };

  test('a configured origin is echoed back with vary: Origin, not a wildcard', async () => {
    const handler = createFetchHandler(table(routes), {
      cors: { origins: ['https://app.example'] },
    });

    const allowed = await handler(ok({ headers: { origin: 'https://app.example' } }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(allowed.headers.get('vary')).toContain('Origin');

    const denied = await handler(ok({ headers: { origin: 'https://evil.example' } }));
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(denied.status).toBe(200); // denied CORS is not an error response
  });

  test('a preflight is answered without matching a route or running guards', async () => {
    let guarded = false;
    const handler = createFetchHandler(table(routes), {
      cors: {
        origins: ['https://app.example'],
        credentials: true,
        maxAgeSeconds: 600,
        headers: ['content-type', 'authorization'],
      },
      guards: {
        always: () => {
          guarded = true;
          return { subject: 'x', data: null };
        },
      },
    });

    const response = await handler(
      new Request('http://tsir.test/', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example',
          'access-control-request-method': 'POST',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'content-type, authorization',
    );
    expect(response.headers.get('access-control-max-age')).toBe('600');
    expect(guarded).toBe(false);
  });

  test('a preflight from a denied origin gets no allow headers at all', async () => {
    const handler = createFetchHandler(table(routes), {
      cors: { origins: ['https://app.example'] },
    });

    const response = await handler(
      new Request('http://tsir.test/', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'GET',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
  });

  test('wildcard with credentials is refused at boot, not shipped broken', () => {
    let code: string | undefined;
    try {
      createFetchHandler(table(routes), { cors: { origins: ['*'], credentials: true } });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('HTP_CORS_WILDCARD_CREDENTIALS');
  });

  test('CORS off by default', async () => {
    const handler = createFetchHandler(table(routes));
    const response = await handler(ok({ headers: { origin: 'https://app.example' } }));
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('http · client disconnect (HTP-016)', () => {
  test('aborting the request aborts the context signal the handler sees', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    // The pipeline is async; wait until the handler is actually running before
    // asserting, otherwise the check races the dispatch and reads `undefined`.
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });

    const handler = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Things {
          @Get('/', { timeoutMs: 5_000 })
          slow({ ctx }: { ctx: { signal: AbortSignal } }): unknown {
            observed = ctx.signal;
            started();
            return new Promise((resolve) => {
              ctx.signal.addEventListener('abort', () => resolve({ aborted: true }), {
                once: true,
              });
            });
          }
        }
        void Things;
      }),
    );

    const pending = handler(ok({ signal: controller.signal }));
    await running;
    expect(observed?.aborted).toBe(false);

    controller.abort('client went away');

    const response = await pending;
    expect(observed?.aborted).toBe(true);
    expect(await response.json()).toEqual({ aborted: true });
  });

  test('a route timeout aborts the same signal', async () => {
    const handler = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/')
        class Things {
          @Get('/', { timeoutMs: 20 })
          never({ ctx }: { ctx: { signal: AbortSignal } }): unknown {
            return new Promise((resolve) => {
              // Ignores the signal entirely; the pipeline must still answer.
              setTimeout(() => resolve({ late: ctx.signal.aborted }), 50);
            });
          }
        }
        void Things;
      }),
    );

    const response = await handler(ok());
    expect(response.status).toBe(504);
  });
});
