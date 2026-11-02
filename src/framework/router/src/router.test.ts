import { describe, expect, test } from 'bun:test';

import { compileRoutes } from './compile.ts';
import {
  assertValidPath,
  Controller,
  Get,
  Guards,
  joinPath,
  OnEventBridge,
  OnSns,
  OnStepTask,
  Policies,
  Post,
  Route,
  UseMiddleware,
} from './decorators.ts';
import { createMatcher } from './matcher.ts';
import { RouteRegistry } from './registry.ts';
import type { RouteEntry, RouteTable } from './types.ts';

/** Builds an isolated registry so tests never share the process-local one. */
function fresh(): RouteRegistry {
  return new RouteRegistry();
}

describe('decorators', () => {
  test('@Controller + @Route registers one route with a joined path', () => {
    const registry = fresh();

    @Controller(registry, '/api/users')
    class UsersController {
      @Route({ method: 'GET', path: '/:id' })
      findOne(): string {
        return 'ok';
      }
    }
    // declared for its decorator side effect
    void UsersController;

    const [entry] = registry.entries();
    expect(entry?.name).toBe('UsersController');
    expect(entry?.path).toBe('/api/users');
    expect(entry?.routes).toHaveLength(1);
    expect(entry?.routes[0]?.handler).toBe('findOne');

    const table = compileRoutes(registry.entries());
    expect(table.routes[0]?.path).toBe('/api/users/:id');
    expect(table.routes[0]?.method).toBe('GET');
    expect(table.routes[0]?.controller).toBe(UsersController);
  });

  test('sugar decorators compile to the same metadata as the explicit form', () => {
    const explicit = fresh();
    const sugar = fresh();

    @Controller(explicit, '/x')
    class Explicit {
      @Route({ method: 'POST', path: '/y', status: 201 })
      go(): string {
        return 'a';
      }
    }
    // declared for its decorator side effect
    void Explicit;

    @Controller(sugar, '/x')
    class Sugary {
      @Post('/y', { status: 201 })
      go(): string {
        return 'b';
      }
    }
    // declared for its decorator side effect
    void Sugary;

    const a = compileRoutes(explicit.entries()).routes[0];
    const b = compileRoutes(sugar.entries()).routes[0];
    expect(a?.meta).toEqual(b?.meta);
    expect(Explicit.name).toBe('Explicit');
  });

  test('class-level tokens precede route-level tokens', () => {
    const registry = fresh();

    @Controller(registry, '/orders')
    @Guards('auth')
    @Policies({ resource: 'order', action: 'write' })
    @UseMiddleware('log')
    class OrdersController {
      @Route({ method: 'POST', path: '/', guards: ['csrf'], middleware: ['validate'] })
      create(): string {
        return 'ok';
      }
    }
    // declared for its decorator side effect
    void OrdersController;

    const route = compileRoutes(registry.entries()).routes[0];
    expect(route?.guards).toEqual(['auth', 'csrf']);
    expect(route?.middleware).toEqual(['log', 'validate']);
    expect(route?.policies).toEqual([{ resource: 'order', action: 'write' }]);
  });

  test('inherited handler is picked up; subclass override wins', () => {
    const registry = fresh();
    const meta = { method: 'GET', path: '/a' } as const;

    class Base {
      handle(): string {
        return 'base';
      }
    }
    // declared for its decorator side effect
    void Base;
    const handle = Object.getOwnPropertyDescriptor(Base.prototype, 'handle')?.value as unknown;
    Object.defineProperty(handle as object, Symbol.for('tsir.route'), {
      value: Object.freeze(meta),
    });

    @Controller(registry, '')
    class Derived extends Base {}
    void Derived;

    expect(registry.entries()[0]?.routes[0]?.handler).toBe('handle');
    expect(compileRoutes(registry.entries()).routes[0]?.path).toBe('/a');
  });

  test('re-registering the same class replaces instead of duplicating', () => {
    const registry = fresh();

    @Controller(registry, '/a')
    class Twice {
      @Get('/') go(): string {
        return 'x';
      }
    }
    // declared for its decorator side effect
    void Twice;

    Controller(registry, '/b')(Twice, {} as ClassDecoratorContext);
    expect(registry.entries()).toHaveLength(1);
    expect(registry.entries()[0]?.path).toBe('/b');
  });
});

describe('path syntax', () => {
  test('joins prefixes without doubling or dropping slashes', () => {
    expect(joinPath('/api/users', '/:id')).toBe('/api/users/:id');
    expect(joinPath('/api/users', '/')).toBe('/api/users');
    expect(joinPath('', '/x')).toBe('/x');
    expect(joinPath('/a/', '/b/')).toBe('/a/b');
    expect(joinPath('/', '/')).toBe('/');
  });

  test('rejects malformed paths at declaration time', () => {
    expect(() => assertValidPath('users')).toThrow(/must start with/);
    expect(() => assertValidPath('/users/')).toThrow(/must not end/);
    expect(() => assertValidPath('/a//b')).toThrow(/must not contain/);
    expect(() => assertValidPath('/a/:')).toThrow(/needs a name/);
    expect(() => assertValidPath('/a/*/b')).toThrow(/only allowed as the last segment/);
    expect(() => assertValidPath('/a/b:c')).toThrow(/must be literal/);
  });

  test('accepts the documented forms', () => {
    for (const path of ['/', '/users', '/users/:id', '/files/*', '/a/:b/c']) {
      expect(() => assertValidPath(path)).not.toThrow();
    }
  });
});

describe('compilation', () => {
  function table(registry: RouteRegistry): RouteTable {
    return compileRoutes(registry.entries());
  }

  test('defaults the response status to 200 for every method', () => {
    const registry = fresh();

    @Controller(registry, '/x')
    class Routes {
      @Route({ method: 'POST', path: '/create' })
      create(): void {
        /* noop */
      }

      @Route({ method: 'DELETE', path: '/gone', status: 204 })
      remove(): void {
        /* noop */
      }

      @Route({ method: 'GET', path: '/read' })
      read(): string {
        return 'x';
      }
    }
    // declared for its decorator side effect
    void Routes;

    const routes = table(registry).routes;
    // A POST that returns nothing is still 200 unless it says 204: the request
    // body schema has no bearing on the response status.
    expect(routes.find((r) => r.path === '/x/create')?.meta.status).toBe(200);
    expect(routes.find((r) => r.path === '/x/read')?.meta.status).toBe(200);
    expect(routes.find((r) => r.path === '/x/gone')?.meta.status).toBe(204);
  });

  test('rejects a duplicate method+path with both controllers named', () => {
    const registry = fresh();

    @Controller(registry, '/a')
    class First {
      @Get('/x') go(): string {
        return '1';
      }
    }
    // declared for its decorator side effect
    void First;

    @Controller(registry, '/a')
    class Second {
      @Get('/x') go(): string {
        return '2';
      }
    }
    // declared for its decorator side effect
    void Second;

    expect(() => table(registry)).toThrow(/declared twice/);
    expect(First.name).toBe('First');
    expect(Second.name).toBe('Second');
  });

  test('rejects two paths with the same shape (parameter names do not disambiguate)', () => {
    const registry = fresh();

    @Controller(registry, '/users')
    class Users {
      @Get('/:id') byId(): string {
        return '1';
      }
    }
    // declared for its decorator side effect
    void Users;

    @Controller(registry, '/users')
    class Slugs {
      @Get('/:slug') bySlug(): string {
        return '2';
      }
    }
    // declared for its decorator side effect
    void Slugs;

    expect(() => table(registry)).toThrow(/ambiguous/);
  });

  test('rejects a controller that declares no routes', () => {
    const registry = fresh();

    @Controller(registry, '/empty')
    class Empty {}

    expect(() => table(registry)).toThrow(/declares no routes/);
    expect(Empty.name).toBe('Empty');
  });

  test('rejects a body schema on 204', () => {
    const registry = fresh();

    @Controller(registry, '/x')
    class Bad {
      @Route({ method: 'POST', path: '/b', status: 204, body: fakeSchema() })
      go(): void {
        /* noop */
      }
    }
    // declared for its decorator side effect
    void Bad;

    expect(() => table(registry)).toThrow(/declares a body schema/);
  });

  test('sorts by specificity, then path, then method — idempotently', () => {
    const registry = fresh();

    @Controller(registry, '')
    class Mixed {
      @Get('/files/*') wild(): string {
        return 'w';
      }

      @Get('/files/:id') param(): string {
        return 'p';
      }

      @Get('/files/new') static(): string {
        return 's';
      }

      @Get('/a') short(): string {
        return 'a';
      }
    }
    // declared for its decorator side effect
    void Mixed;

    // More specific first: static segments outrank parameters, which outrank
    // the wildcard, and a deeper path outranks a shallower one it could shadow.
    const paths = table(registry).routes.map((route) => route.path);
    expect(paths).toEqual(['/files/new', '/files/:id', '/files/*', '/a']);

    const again = table(registry).routes.map((route) => route.path);
    expect(again).toEqual(paths);
  });
});

function fakeSchema(): never {
  return { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: {} }) } } as never;
}

describe('matcher', () => {
  function build(): ReturnType<typeof createMatcher> {
    const registry = fresh();

    @Controller(registry, '')
    class Routes {
      @Get('/') index(): string {
        return 'index';
      }

      @Get('/files/new') fresh(): string {
        return 'new';
      }

      @Get('/files/:id') byId(): string {
        return 'byId';
      }

      @Get('/files/*') anything(): string {
        return 'anything';
      }

      @Post('/files') create(): string {
        return 'created';
      }

      @Post('/files/:id') update(): string {
        return 'updated';
      }
    }
    // declared for its decorator side effect
    void Routes;

    return createMatcher(compileRoutes(registry.entries()));
  }

  const matcher = build();

  test('static beats parameter beats wildcard', () => {
    const freshFile = matcher.match('GET', '/files/new');
    expect(freshFile.kind).toBe('matched');
    expect(freshFile.kind === 'matched' && freshFile.route.path).toBe('/files/new');

    const param = matcher.match('GET', '/files/42');
    expect(param.kind === 'matched' && param.route.path).toBe('/files/:id');
    expect(param.kind === 'matched' && param.params).toEqual({ id: '42' });

    const wild = matcher.match('GET', '/files/a/b/c');
    expect(wild.kind === 'matched' && wild.route.path).toBe('/files/*');
    expect(wild.kind === 'matched' && wild.params['*']).toBe('a/b/c');
  });

  test('method participates in matching: same path, different handlers', () => {
    const post = matcher.match('POST', '/files/9');
    expect(post.kind === 'matched' && post.route.handler).toBe('update');
    const get = matcher.match('GET', '/files/9');
    expect(get.kind === 'matched' && get.route.handler).toBe('byId');
  });

  test('405 lists the methods that are allowed, in a stable order', () => {
    const onlyPost = matcher.match('DELETE', '/files');
    expect(onlyPost.kind).toBe('method-not-allowed');
    expect(onlyPost.kind === 'method-not-allowed' && onlyPost.allow).toEqual(['POST']);

    // A path with GET also advertises HEAD, because HEAD is served from GET.
    const withGet = matcher.match('DELETE', '/files/42');
    expect(withGet.kind === 'method-not-allowed' && withGet.allow).toEqual(['GET', 'HEAD', 'POST']);
  });

  test('HEAD falls back to the GET handler and is flagged', () => {
    const result = matcher.match('HEAD', '/');
    expect(result.kind).toBe('matched');
    expect(result.kind === 'matched' && result.head).toBe(true);
    expect(result.kind === 'matched' && result.route.handler).toBe('index');
  });

  test('unknown path is not-found, not an error', () => {
    expect(matcher.match('GET', '/nope').kind).toBe('not-found');
  });

  test('root path matches the empty segment list', () => {
    const result = matcher.match('GET', '/');
    expect(result.kind === 'matched' && result.route.path).toBe('/');
  });

  test('trailing slash is strict by default and can be relaxed', () => {
    // Strict trailing slash = "no such resource", so `not-found` (→ 404), not a
    // malformed-path 400.
    expect(matcher.match('GET', '/files/new/').kind).toBe('not-found');
    const relaxed = createMatcher(
      { routes: [{ ...emptyRoute(), path: '/x', segments: ['x'] }] },
      { trailingSlash: 'ignore' },
    );
    expect(relaxed.match('GET', '/x/').kind).toBe('matched');
  });

  test('rejects encoded slashes and invalid encodings', () => {
    const encoded = matcher.match('GET', '/files/a%2Fb');
    expect(encoded.kind).toBe('bad-path');

    const broken = matcher.match('GET', '/files/%E0%A4%A');
    expect(broken.kind).toBe('bad-path');
  });

  test('decodes ordinary percent-encoding in parameters', () => {
    const result = matcher.match('GET', '/files/hello%20world');
    expect(result.kind === 'matched' && result.params['id']).toBe('hello world');
  });
});

function emptyRoute(): RouteEntry {
  return {
    method: 'GET',
    path: '/',
    segments: [],
    controller: class {},
    handler: 'go',
    meta: { method: 'GET', path: '/', unit: 'http' },
    middleware: [],
    guards: [],
    policies: [],
  };
}

describe('route unit attribution (RTR-011)', () => {
  test('defaults to http, and resolves route > controller > default', () => {
    const registry = new RouteRegistry();

    @Controller(registry, '/a')
    class Default {
      @Get('/')
      one(): unknown {
        return null;
      }
    }

    @Controller(registry, '/b', { unit: 'ingest' })
    class Ingest {
      @Get('/')
      two(): unknown {
        return null;
      }

      @Get('/override', { unit: 'reports' })
      three(): unknown {
        return null;
      }
    }
    void Default;
    void Ingest;

    const units = Object.fromEntries(
      compileRoutes(registry.entries()).routes.map((route) => [route.path, route.meta.unit]),
    );
    expect(units).toEqual({ '/a': 'http', '/b': 'ingest', '/b/override': 'reports' });
  });
});

describe('aws event listeners (DPL-026)', () => {
  test('@OnSns registers a listener with topic and default unit', () => {
    const registry = fresh();

    @Controller(registry)
    class OrdersListener {
      @OnSns({ topic: 'orders' })
      onOrder(): void {}
    }
    void OrdersListener;

    const [entry] = registry.entries();
    expect(entry?.listeners).toHaveLength(1);
    expect(entry?.listeners[0]).toEqual({
      handler: 'onOrder',
      meta: { kind: 'sns', topic: 'orders', unit: 'sns' },
    });
  });

  test('@OnEventBridge registers a listener with eventBus and detailType', () => {
    const registry = fresh();

    @Controller(registry)
    class EventsListener {
      @OnEventBridge({ eventBus: 'default', detailType: 'order.placed' })
      onEvent(): void {}
    }
    void EventsListener;

    const [entry] = registry.entries();
    expect(entry?.listeners).toHaveLength(1);
    expect(entry?.listeners[0]).toEqual({
      handler: 'onEvent',
      meta: { kind: 'eventbridge', eventBus: 'default', detailType: 'order.placed', unit: 'schedule' },
    });
  });

  test('@OnStepTask registers a listener with name and default admin unit', () => {
    const registry = fresh();

    @Controller(registry)
    class TasksListener {
      @OnStepTask({ name: 'process-refund' })
      onTask(): void {}
    }
    void TasksListener;

    const [entry] = registry.entries();
    expect(entry?.listeners).toHaveLength(1);
    expect(entry?.listeners[0]).toEqual({
      handler: 'onTask',
      meta: { kind: 'steptask', name: 'process-refund', unit: 'admin' },
    });
  });

  test('listeners and routes coexist on the same controller', () => {
    const registry = fresh();

    @Controller(registry, '/admin')
    class MixedController {
      @Get('/health')
      health(): string {
        return 'ok';
      }

      @OnSns({ topic: 'alerts' })
      onAlert(): void {}
    }
    void MixedController;

    const [entry] = registry.entries();
    expect(entry?.routes).toHaveLength(1);
    expect(entry?.listeners).toHaveLength(1);
    expect(entry?.routes.at(0)?.handler).toBe('health');
    expect(entry?.listeners.at(0)?.handler).toBe('onAlert');
  });

  test('listener unit can be overridden', () => {
    const registry = fresh();

    @Controller(registry)
    class CustomUnit {
      @OnSns({ topic: 'orders', unit: 'notifications' })
      onOrder(): void {}
    }
    void CustomUnit;

    const [entry] = registry.entries();
    expect(entry?.listeners.at(0)?.meta.unit).toBe('notifications');
  });
});
