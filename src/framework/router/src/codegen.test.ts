import { describe, expect, test } from 'bun:test';

import { emitRoutesModule, type GeneratedRoute } from './index.ts';

const usersController = { specifier: './controllers/users.controller.ts', name: 'UsersController' };
const createUser = { specifier: './controllers/users.controller.ts', name: 'CreateUser' };

function route(overrides: Partial<GeneratedRoute> = {}): GeneratedRoute {
  return {
    method: 'GET',
    path: '/api/users',
    declaredPath: '/',
    segments: ['api', 'users'],
    controller: usersController,
    handler: 'list',
    status: 200,
    unit: 'http',
    schemas: {},
    middleware: [],
    guards: [],
    policies: [],
    ...overrides,
  };
}

describe('router · routes.gen emitter', () => {
  test('is deterministic: same input, same bytes', () => {
    const input = { app: 'demo', routes: [route(), route({ method: 'POST', status: 201 })] };
    expect(emitRoutesModule(input)).toBe(emitRoutesModule(input));
  });

  test('import order does not depend on discovery order', () => {
    // Two routes whose imports were discovered in opposite order must still emit
    // one sorted import line — otherwise every recompile is a spurious diff.
    const first = emitRoutesModule({
      app: 'demo',
      routes: [
        route({ schemas: { body: createUser } }),
        route({ controller: { specifier: './a.controller.ts', name: 'A' } }),
      ],
    });
    const second = emitRoutesModule({
      app: 'demo',
      routes: [
        route({ controller: { specifier: './a.controller.ts', name: 'A' } }),
        route({ schemas: { body: createUser } }),
      ],
    });
    const importsOf = (source: string): string[] =>
      source.split('\n').filter((line) => line.startsWith('import'));
    expect(importsOf(first).sort()).toEqual(importsOf(second).sort());
  });

  test('emits a valid table shape with merged metadata', () => {
    const source = emitRoutesModule({
      app: 'demo',
      routes: [
        route({
          schemas: { body: createUser },
          status: 201,
          guards: ['auth'],
          policies: [{ resource: 'user', action: 'create' }],
          middleware: ['cache'],
          operationId: 'users.create',
          summary: "Create a user's record",
          tags: ['users'],
          timeoutMs: 2500,
        }),
      ],
    });

    expect(source).toContain("import { defineRoute, type RouteEntry } from '@tsir/router';");
    expect(source).toContain(
      "import { CreateUser, UsersController } from './controllers/users.controller.ts';",
    );
    expect(source).toContain("handler: 'list'");
    expect(source).toContain('controller: UsersController');
    expect(source).toContain('body: CreateUser');
    expect(source).toContain("guards: ['auth']");
    expect(source).toContain("{ resource: 'user', action: 'create' }");
    expect(source).toContain('timeoutMs: 2500');
    expect(source).toContain("summary: 'Create a user\\'s record'"); // apostrophe escaped
    expect(source).toContain('export const routes: readonly RouteEntry[] = [');
  });

  test('omits absent optional metadata instead of emitting undefined', () => {
    const source = emitRoutesModule({ app: 'demo', routes: [route()] });
    expect(source).not.toContain('undefined');
    expect(source).not.toContain('operationId');
    expect(source).not.toContain('tags');
  });

  test('an empty table is still a valid module', () => {
    const source = emitRoutesModule({ app: 'demo', routes: [] });
    expect(source).toContain('export const routes: readonly RouteEntry[] = [];');
    expect(source).not.toContain('import {  }');
  });

  test('the header carries no timestamp or absolute path', () => {
    const source = emitRoutesModule({ app: 'demo', routes: [route()] });
    const header = source.split('\n').slice(0, 2).join('\n');
    expect(header).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(header).not.toContain('/home/');
  });
});
