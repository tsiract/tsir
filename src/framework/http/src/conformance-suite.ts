/**
 * Shared HTTP conformance suite (DPL-024).
 *
 * The same assertions run against every runtime target — Bun dev server,
 * Cloudflare Workers, and Lambda — because each target wraps the same
 * `createFetchHandler` pipeline in its own adapter. A behaviour that differs
 * between targets is a bug in one adapter, not a platform quirk, so the suite
 * is shared rather than copied.
 *
 * The suite takes a `serve` function: `(request: Request) => Promise<Response>`.
 * Each target test builds its adapter and provides this function.
 */

import { describe, expect, test } from 'bun:test';

import { Controller, Get, Post, RouteRegistry, compileRoutes } from '@tsir/router';

import { createFetchHandler } from './pipeline.ts';

export type ServeFn = (request: Request) => Promise<Response>;

/** The shared route set the conformance assertions exercise. */
export function createConformanceApp(): ServeFn {
  const registry = new RouteRegistry();

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

  return createFetchHandler(compileRoutes(registry.entries()));
}

/**
 * Run the conformance assertions against a `serve` function. `label` identifies
 * the target in test output (e.g. `'bun'`, `'cloudflare'`, `'lambda'`).
 */
export function runHttpConformance(label: string, serve: ServeFn): void {
  describe(`http · conformance · ${label}`, () => {
    describe('matching', () => {
      test('a static segment beats a parameter regardless of declaration order', async () => {
        const response = await serve(new Request('http://tsir.test/users/search'));
        expect(await response.json()).toEqual({ found: true });
      });

      test('a wrong method is 405 with an Allow header, never 404', async () => {
        const response = await serve(new Request('http://tsir.test/users', { method: 'DELETE' }));
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET, HEAD, POST');
        const body = (await response.json()) as { code: string };
        expect(body.code).toBe('HTP_METHOD_NOT_ALLOWED');
      });

      test('an unknown path is 404, and does not leak whether a sibling exists', async () => {
        const response = await serve(new Request('http://tsir.test/nothing/here'));
        expect(response.status).toBe(404);
        expect(response.headers.get('allow')).toBeNull();
      });

      test('trailing slash is strict by default', async () => {
        expect((await serve(new Request('http://tsir.test/users'))).status).toBe(200);
        expect((await serve(new Request('http://tsir.test/users/'))).status).toBe(404);
        expect((await serve(new Request('http://tsir.test/users/42/'))).status).toBe(404);
      });

      test('an encoded separator is rejected rather than smuggled past the matcher', async () => {
        const slash = await serve(new Request('http://tsir.test/users/a%2Fb'));
        expect(slash.status).toBe(400);
        expect(((await slash.json()) as { code: string }).code).toBe('HTP_BAD_REQUEST');

        const backslash = await serve(new Request('http://tsir.test/users/a%5Cb'));
        expect(backslash.status).toBe(400);
      });

      test('a path parameter is percent-decoded exactly once', async () => {
        const response = await serve(new Request('http://tsir.test/users/a%20b'));
        expect(await response.json()).toEqual({ id: 'a b' });
      });

      test('an empty segment is malformed, and says so', async () => {
        expect((await serve(new Request('http://tsir.test/users//42'))).status).toBe(400);
      });
    });

    describe('framing', () => {
      test('HEAD answers GET semantics with no body', async () => {
        const head = await serve(new Request('http://tsir.test/users', { method: 'HEAD' }));
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        expect(head.headers.get('content-type')).toContain('application/json');
      });

      test('HEAD on a route with no explicit HEAD registration does not 405', async () => {
        const head = await serve(new Request('http://tsir.test/users/42', { method: 'HEAD' }));
        expect(head.status).toBe(200);
        expect(head.headers.get('allow')).toBeNull();
      });

      test('every response carries a request id, including errors', async () => {
        for (const path of ['/users', '/users/42', '/nope']) {
          const response = await serve(new Request(`http://tsir.test${path}`));
          expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
        }
      });

      test('a handler-returned Response keeps its own content type', async () => {
        const response = await serve(new Request('http://tsir.test/users/1/avatar'));
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(await response.text()).toBe('bytes');
      });

      test('responses are problem+json only when they are problems', async () => {
        const ok = await serve(new Request('http://tsir.test/users'));
        expect(ok.headers.get('content-type')).toContain('application/json');
        expect(ok.headers.get('content-type')).not.toContain('problem');

        const bad = await serve(new Request('http://tsir.test/nope'));
        expect(bad.headers.get('content-type')).toContain('application/problem+json');
      });

      test('an empty body on a POST with no body schema is not a 400', async () => {
        const response = await serve(new Request('http://tsir.test/users', { method: 'POST' }));
        expect(response.status).toBe(200);
      });

      test('an unknown method is answered, not crashed', async () => {
        const response = await serve(new Request('http://tsir.test/users', { method: 'PROPFIND' }));
        expect([404, 405]).toContain(response.status);
      });
    });
  });
}
