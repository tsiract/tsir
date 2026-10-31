import { describe, expect, test } from 'bun:test';

import { Controller, Get, Post, RouteRegistry, compileRoutes } from '@tsir/router';
import { z } from '@tsir/validate';

import { accepted, contract, created, noContent, ok } from './contract.ts';
import { createFetchHandler, type AuditEvent, type Decision, type Policy } from './pipeline.ts';

function table(build: (registry: RouteRegistry) => void): ReturnType<typeof compileRoutes> {
  const registry = new RouteRegistry();
  build(registry);
  return compileRoutes(registry.entries());
}

const User = z.object({ id: z.number().int(), email: z.email() });

describe('http · response contract helpers (VLD-009)', () => {
  test('the helpers set exactly a status and, when given, a schema', () => {
    expect(ok(User)).toEqual({ status: 200, response: User });
    expect(created(User)).toEqual({ status: 201, response: User });
    expect(accepted()).toEqual({ status: 202 });
    expect(noContent()).toEqual({ status: 204 });
    expect(contract({ status: 409 })).toEqual({ status: 409 });
  });

  test('a contract is enforced on the value the handler returned', async () => {
    const build = (body: unknown) =>
      createFetchHandler(
        table((registry) => {
          @Controller(registry, '/users')
          class Users {
            @Post('/', { ...created(User) })
            create(): unknown {
              return body;
            }
          }
          void Users;
        }),
        { responseValidation: 'always' },
      );

    const good = await build({ id: 1, email: 'ada@example.com' })(
      new Request('http://t/users', { method: 'POST' }),
    );
    expect(good.status).toBe(201);

    const bad = await build({ id: 'wrong' })(new Request('http://t/users', { method: 'POST' }));
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as { code: string }).code).toBe('HTP_RESPONSE_INVALID');
  });

  test('noContent() declares a 204 and the pipeline enforces the empty body', async () => {
    const handler = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/users')
        class Users {
          @Post('/', { ...noContent() })
          create(): unknown {
            return undefined;
          }
        }
        void Users;
      }),
    );

    const response = await handler(new Request('http://t/users', { method: 'POST' }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  test('a 204 contract that returns a body is a framework error, not a silent drop', async () => {
    const handler = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/users')
        class Users {
          @Post('/', { ...noContent() })
          create(): unknown {
            return { leaked: true };
          }
        }
        void Users;
      }),
    );

    const response = await handler(new Request('http://t/users', { method: 'POST' }));
    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe('HTP_BODY_NOT_ALLOWED');
  });
});

describe('http · policy decisions and audit (HTP-011)', () => {
  function guarded(
    policy: Policy,
    audit: boolean,
  ): { events: AuditEvent[]; handler: ReturnType<typeof createFetchHandler> } {
    const events: AuditEvent[] = [];
    const handler = createFetchHandler(
      table((registry) => {
        @Controller(registry, '/docs')
        class Docs {
          @Get('/', {
            guards: ['auth'],
            policies: [{ resource: 'document', action: 'read', ...(audit ? { audit: true } : {}) }],
            principal: true,
          })
          read(): unknown {
            return { ok: true };
          }
        }
        void Docs;
      }),
      {
        guards: { auth: () => ({ subject: 'ada', data: null }) },
        policies: { 'document:read': policy },
        onAudit: (event) => events.push(event),
      },
    );
    return { events, handler };
  }

  const deny: Policy = (): Decision => ({ allowed: false, reason: 'not the owner' });
  const allow: Policy = (): Decision => ({ allowed: true });

  test('a denied policy is a 403 carrying the reason', async () => {
    const { handler } = guarded(deny, false);
    const response = await handler(new Request('http://t/docs'));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; detail?: string };
    expect(body.code).toBe('HTP_FORBIDDEN');
    expect(body.detail).toBe('not the owner');
  });

  test('every denial is audited, with the subject and the decision', async () => {
    const { events, handler } = guarded(deny, false);
    await handler(new Request('http://t/docs'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'authz.decision',
      route: '/docs',
      method: 'GET',
      subject: 'ada',
      resource: 'document',
      action: 'read',
      allowed: false,
      reason: 'not the owner',
    });
    expect(events[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('an allowed decision is audited only when the policy asked for it', async () => {
    const quiet = guarded(allow, false);
    expect((await quiet.handler(new Request('http://t/docs'))).status).toBe(200);
    expect(quiet.events).toHaveLength(0);

    const loud = guarded(allow, true);
    expect((await loud.handler(new Request('http://t/docs'))).status).toBe(200);
    expect(loud.events).toHaveLength(1);
    expect(loud.events[0]).toMatchObject({ allowed: true, subject: 'ada' });
    // No `reason` on an allow: there is no refusal to explain.
    expect(loud.events[0]?.reason).toBeUndefined();
  });

  test('an audited policy survives the generated route table', async () => {
    const registry = new RouteRegistry();
    @Controller(registry, '/docs')
    class Docs {
      @Get('/', { policies: [{ resource: 'document', action: 'read', audit: true }] })
      read(): unknown {
        return null;
      }
    }
    void Docs;
    const route = compileRoutes(registry.entries()).routes[0];
    expect(route?.policies[0]?.audit).toBe(true);
  });
});
