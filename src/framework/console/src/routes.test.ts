import { describe, expect, test } from 'bun:test';

import {
  Controller,
  Get,
  Guards,
  Post,
  RouteRegistry,
  UseMiddleware,
  compileRoutes,
} from '@tsir/router';

import { describeRoutes, formatRoutes, routesJson, type RouteRow } from './commands/routes.ts';

function table(build: (registry: RouteRegistry) => void) {
  const registry = new RouteRegistry();
  build(registry);
  return compileRoutes(registry.entries());
}

const fixture = () =>
  table((registry) => {
    @Controller(registry, '/api/users')
    @UseMiddleware('audit')
    @Guards('session')
    class Users {
      // Route-level tokens are route *metadata*, not a second decorator: one way
      // to declare a binding, checked by the same type as the rest of the route.
      @Get('/', { middleware: ['cache'] })
      list(): unknown {
        return null;
      }

      @Post('/', { status: 201, policies: [{ resource: 'user', action: 'create' }] })
      create(): unknown {
        return null;
      }
    }
    void Users;
  });

describe('console · route:list', () => {
  test('rows carry the metadata that changes behaviour', () => {
    const rows = describeRoutes(fixture());
    expect(rows).toHaveLength(2);

    const list = rows.find((row) => row.method === 'GET');
    const create = rows.find((row) => row.method === 'POST');
    expect(list).toEqual({
      method: 'GET',
      path: '/api/users',
      unit: 'http',
      controller: 'Users',
      handler: 'list',
      status: 200,
      // Class-level first, then route-level: the merge order is observable here.
      middleware: ['audit', 'cache'],
      guards: ['session'],
      policies: [],
      tags: [],
    });

    expect(create?.status).toBe(201);
    expect(create?.policies).toEqual(['user:create']);
  });

  test('text output is aligned and stays on one line per route', () => {
    const text = formatRoutes(describeRoutes(fixture()));
    const lines = text.trimEnd().split('\n');

    expect(lines).toHaveLength(2);
    const getLine = lines.find((line) => line.includes('GET'));
    expect(getLine).toMatch(/^ {2}GET {3}\/api\/users {2}200 {2}Users\.list/);
    expect(getLine).toContain('mw:audit,cache');
    expect(getLine).toContain('guard:session');
  });

  test('an empty table says so instead of printing nothing', () => {
    expect(formatRoutes([])).toBe('  no routes registered\n');
  });

  test('json output is versioned and machine-readable', () => {
    const parsed = JSON.parse(routesJson(describeRoutes(fixture()))) as {
      schemaVersion: number;
      count: number;
      routes: RouteRow[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.count).toBe(2);
    expect([...parsed.routes.map((route) => route.method)].sort()).toEqual(['GET', 'POST']);
  });
});
