import { describe, expect, test } from 'bun:test';

import { Controller, Post, RouteRegistry, compileRoutes, type RouteOptions } from '@tsir/router';
import { z } from '@tsir/validate';
import { IntParam } from '@tsir/validate/http';

import { createFetchHandler } from './pipeline.ts';
import { bindsPrincipal, type RouteArgs } from './route-args.ts';

const CreateUser = z.object({ email: z.email(), name: z.string().min(1) });
const UserIdParams = z.object({ id: IntParam });
const User = z.object({ id: z.number(), email: z.email() });

/**
 * Both sides of RTR-004 in one declaration.
 *
 * `satisfies` is load-bearing: it keeps the literal type (so `RouteArgs` can read
 * the schemas off it) while still rejecting a typo like `statsu`. If a schema
 * and the handler's use of it ever disagree, `tsc` fails here — not in
 * production.
 */
const createUserRoute = {
  params: UserIdParams,
  body: CreateUser,
  status: 201,
  tags: ['users'],
} satisfies RouteOptions;

type CreateArgs = RouteArgs<typeof createUserRoute>;

/** Compile-time equality: assignable both ways, and not `any`. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// These constants are assertions. If inference regresses, this file stops
// compiling — which is why the type test lives next to the runtime test instead
// of in a comment.
const bodyIsTyped: Equals<CreateArgs['body'], { email: string; name: string }> = true;
const paramsAreTyped: Equals<CreateArgs['params'], { id: number }> = true;
const queryIsUnknown: Equals<CreateArgs['query'], unknown> = true;
const ctxIsPresent: Equals<CreateArgs['ctx'] extends { id: string } ? true : false, true> = true;
const noPrincipal: Equals<'principal' extends keyof CreateArgs ? true : false, false> = true;

const withPrincipalRoute = { guards: ['auth'], principal: true } satisfies RouteOptions;
type GuardedArgs = RouteArgs<typeof withPrincipalRoute>;
const principalIsPresent: Equals<'principal' extends keyof GuardedArgs ? true : false, true> = true;

describe('http · handler args derived from route options (RTR-004)', () => {
  test('the type assertions above are real assertions', () => {
    // If any of them were false the module would not typecheck; this test simply
    // documents that they are compiled, not dead code.
    expect([bodyIsTyped, paramsAreTyped, queryIsUnknown, ctxIsPresent, noPrincipal]).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(principalIsPresent).toBe(true);
  });

  test('the same options object powers validation and typing', async () => {
    const registry = new RouteRegistry();

    @Controller(registry, '/users')
    class Users {
      @Post('/:id', createUserRoute)
      create(args: RouteArgs<typeof createUserRoute>): unknown {
        // `args.params` and `args.body` are typed *by the decorator's options*.
        return { id: args.params.id, email: args.body.email, name: args.body.name };
      }
    }
    void Users;

    const handler = createFetchHandler(compileRoutes(registry.entries()));
    const response = await handler(
      new Request('http://t/users/7', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 7, email: 'ada@example.com', name: 'Ada' });
  });

  test('a contract can be folded into the same options object', () => {
    // `response` is part of RouteOptions, so a handler that returns a typed shape
    // declares it in the same place — and HTP-013 enforces it.
    const contractRoute = { body: CreateUser, response: User } satisfies RouteOptions;
    type Args = RouteArgs<typeof contractRoute>;
    const typed: Equals<Args['body'], { email: string; name: string }> = true;
    // Also used at runtime, so the declaration is not type-only scaffolding.
    expect([typed, bindsPrincipal(contractRoute)]).toEqual([true, false]);
  });

  test('bindsPrincipal reads the same flag the type does', () => {
    expect(bindsPrincipal(createUserRoute)).toBe(false);
    expect(bindsPrincipal(withPrincipalRoute)).toBe(true);
  });
});
