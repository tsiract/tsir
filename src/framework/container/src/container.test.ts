import { describe, expect, test } from 'bun:test';

import { Container } from './container.ts';
import { TsirError } from './errors.ts';
import { classProvider, factoryProvider, valueProvider } from './provider.ts';
import { contract, token } from './token.ts';

class Logger {
  readonly lines: string[] = [];
  log(line: string): void {
    this.lines.push(line);
  }
}

class Repository {
  constructor(readonly log: Logger) {}
}

class Service {
  constructor(
    readonly repo: Repository,
    readonly log: Logger,
  ) {}
}

const LoggerToken = token<Logger>('Logger');
const RepositoryToken = contract<Repository>('Repository');
const ServiceToken = token<Service>('Service');
const MissingLogger = token<Logger>('MissingLogger');

function expectCode(fn: () => unknown, code: string): TsirError {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(TsirError);
    const tsirError = error as TsirError;
    expect(tsirError.code).toBe(code);
    return tsirError;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

/** Asserts a rejected promise carries a specific Tsir code. */
async function rejectsWithCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) {
      throw new Error(`expected code ${code}, received ${actual ?? String(error)}`);
    }
    return;
  }
  throw new Error(`expected code ${code}, but the promise resolved`);
}

function graph(): Container {
  const container = new Container();
  container.register(
    classProvider(LoggerToken, Logger, []),
    classProvider(RepositoryToken, Repository, [LoggerToken]),
    classProvider(ServiceToken, Service, [RepositoryToken, LoggerToken]),
  );
  return container;
}

describe('container · lifetimes', () => {
  test('singleton returns the same instance', () => {
    const container = graph();
    expect(container.resolve(LoggerToken)).toBe(container.resolve(LoggerToken));
  });

  test('transient returns a new instance each time', () => {
    const container = new Container();
    container.register(classProvider(LoggerToken, Logger, [], { lifetime: 'transient' }));
    expect(container.resolve(LoggerToken)).not.toBe(container.resolve(LoggerToken));
  });

  test('value providers return the registered reference', () => {
    const value = { hello: 'world' };
    const ValueToken = token<typeof value>('Value');
    const container = new Container();
    container.register(valueProvider(ValueToken, value));
    expect(container.resolve(ValueToken)).toBe(value);
  });

  test('dependency graph resolves positionally', () => {
    const service = graph().resolve(ServiceToken);
    expect(service.repo).toBeInstanceOf(Repository);
    expect(service.repo.log).toBe(service.log);
  });
});

describe('container · scopes', () => {
  test('scoped providers are cached per scope and isolated across scopes', () => {
    const container = new Container();
    const RequestToken = token<Logger>('RequestLogger');
    container.register(classProvider(RequestToken, Logger, [], { lifetime: 'scoped' }));

    const first = container.createScope('request');
    const second = container.createScope('request');

    expect(first.resolve(RequestToken)).toBe(first.resolve(RequestToken));
    expect(first.resolve(RequestToken)).not.toBe(second.resolve(RequestToken));
  });

  test('scoped provider resolved outside a scope is a hard error', () => {
    const container = new Container();
    container.register(classProvider(LoggerToken, Logger, [], { lifetime: 'scoped' }));
    const error = expectCode(() => container.resolve(LoggerToken), 'CTN_NO_SCOPE');
    expect(error.hint).toContain('scope');
  });

  test('scope disposal disposes owned instances exactly once', async () => {
    const disposed: string[] = [];
    class Resource {
      async dispose(): Promise<void> {
        disposed.push('resource');
      }
    }
    const ResourceToken = token<Resource>('Resource');
    const container = new Container();
    container.register(classProvider(ResourceToken, Resource, [], { lifetime: 'scoped' }));

    const scope = container.createScope('job');
    scope.resolve(ResourceToken);
    await scope.dispose();
    await scope.dispose();
    expect(disposed).toEqual(['resource']);
    expect(scope.disposed).toBe(true);
    expectCode(() => scope.resolve(ResourceToken), 'CTN_DISPOSED');
  });
});

describe('container · diagnostics', () => {
  test('missing provider reports the chain', () => {
    const container = new Container();
    container.register(classProvider(RepositoryToken, Repository, [MissingLogger]));
    const error = expectCode(() => container.resolve(RepositoryToken), 'CTN_NO_PROVIDER');
    expect(error.message).toContain('Missing');
    expect(error.message).toContain('required by');
    expect(error.hint).toBeDefined();
  });

  test('revealChain=false omits the chain', () => {
    const container = new Container({ revealChain: false });
    container.register(classProvider(RepositoryToken, Repository, [MissingLogger]));
    const error = expectCode(() => container.resolve(RepositoryToken), 'CTN_NO_PROVIDER');
    expect(error.message).not.toContain('required by');
  });

  test('cycles are reported with the full path', () => {
    const A = token<unknown>('A');
    const B = token<unknown>('B');
    const container = new Container();
    container.register(
      factoryProvider(A, () => ({}), []),
      factoryProvider(B, () => ({}), []),
    );
    // Build the cycle by hand: A factory depends on B, B factory depends on A.
    const cyclic = new Container();
    cyclic.register(
      factoryProvider(A, (b: unknown) => ({ b }), [B]),
      factoryProvider(B, (a: unknown) => ({ a }), [A]),
    );
    const error = expectCode(() => cyclic.resolve(A), 'CTN_CYCLE');
    expect(error.message).toContain('A');
    expect(error.message).toContain('→');
    expect(error.context?.['cycle']).toContain('B');
    expect(container.has(A)).toBe(true);
  });

  test('duplicate registration is rejected at composition time', () => {
    const container = new Container();
    container.register(classProvider(LoggerToken, Logger, []));
    expectCode(() => container.register(classProvider(LoggerToken, Logger, [])), 'CTN_DUPLICATE');
  });

  test('overriding an unknown token is a typo guard', () => {
    const container = new Container();
    expectCode(
      () => container.override(valueProvider(LoggerToken, new Logger())),
      'CTN_OVERRIDE_UNKNOWN',
    );
  });

  test('override replaces a registered provider', () => {
    const container = new Container();
    const original = new Logger();
    const replacement = new Logger();
    container.register(valueProvider(LoggerToken, original));
    container.override(valueProvider(LoggerToken, replacement));
    expect(container.resolve(LoggerToken)).toBe(replacement);
  });

  test('resolution depth is bounded', () => {
    const container = new Container({ maxResolutionDepth: 3 });
    const T1 = token<unknown>('T1');
    const T2 = token<unknown>('T2');
    const T3 = token<unknown>('T3');
    const T4 = token<unknown>('T4');
    container.register(
      factoryProvider(T1, (t2: unknown) => [t2], [T2]),
      factoryProvider(T2, (t3: unknown) => [t3], [T3]),
      factoryProvider(T3, (t4: unknown) => [t4], [T4]),
      factoryProvider(T4, () => [], []),
    );
    expectCode(() => container.resolve(T1), 'CTN_DEPTH');
  });

  test('repeated transient construction reports a leak once', () => {
    const events: string[] = [];
    const container = new Container({
      transientLeakThreshold: 5,
      onDiagnostic: (event) => events.push(event.type),
    });
    container.register(classProvider(LoggerToken, Logger, [], { lifetime: 'transient' }));
    container.register(
      factoryProvider(RepositoryToken, (log: Logger) => new Repository(log), [LoggerToken], {
        lifetime: 'transient',
      }),
    );

    for (let index = 0; index < 8; index += 1) {
      container.resolve(RepositoryToken);
    }
    expect(events.filter((event) => event === 'transient-leak')).toHaveLength(1);
  });

  test('factory failures are wrapped and keep the cause', () => {
    const Boom = token<unknown>('Boom');
    const container = new Container();
    const root = new Error('kaboom');
    container.register(
      factoryProvider(Boom, () => {
        throw root;
      }, []),
    );
    const error = expectCode(() => container.resolve(Boom), 'CTN_FACTORY_FAILED');
    expect(error.cause).toBe(root);
  });
});

describe('container · async', () => {
  test('async factory requires resolveAsync', () => {
    const AsyncToken = token<{ ready: boolean }>('Async');
    const container = new Container();
    container.register(
      factoryProvider(AsyncToken, async () => ({ ready: true }), [], { lifetime: 'transient' }),
    );
    expectCode(() => container.resolve(AsyncToken), 'CTN_ASYNC_PROVIDER');
  });

  test('concurrent async singletons are single-flighted', async () => {
    let constructions = 0;
    const AsyncToken = token<{ id: number }>('Async');
    const container = new Container();
    container.register(
      factoryProvider(AsyncToken, async () => {
        constructions += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { id: constructions };
      }, []),
    );

    const results = await Promise.all(
      Array.from({ length: 25 }, () => container.resolveAsync(AsyncToken)),
    );
    expect(constructions).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  test('async dependencies resolve before construction', async () => {
    const SettingsToken = token<{ dsn: string }>('Settings');
    const ClientToken = contract<{ dsn: string }>('Client');
    const container = new Container();
    container.register(
      factoryProvider(SettingsToken, async () => ({ dsn: 'postgres://x' }), []),
      factoryProvider(ClientToken, (settings: { dsn: string }) => settings, [SettingsToken], {
        lifetime: 'transient',
      }),
    );
    expect(await container.resolveAsync(ClientToken)).toEqual({ dsn: 'postgres://x' });
  });
});

describe('container · disposal', () => {
  test('singletons are disposed in reverse construction order', async () => {
    const order: string[] = [];
    class First {
      async dispose(): Promise<void> {
        order.push('first');
      }
    }
    class Second {
      constructor(readonly first: First) {}
      async dispose(): Promise<void> {
        order.push('second');
      }
    }
    const FirstToken = token<First>('First');
    const SecondToken = token<Second>('Second');
    const container = new Container();
    container.register(
      classProvider(FirstToken, First, []),
      classProvider(SecondToken, Second, [FirstToken]),
    );
    container.resolve(SecondToken);
    await container.dispose();
    expect(order).toEqual(['second', 'first']);
  });

  test('dispose is idempotent and blocks further resolution', async () => {
    const container = graph();
    container.resolve(ServiceToken);
    const first = container.dispose();
    const second = container.dispose();
    expect(first).toBe(second);
    await first;
    expect(container.disposed).toBe(true);
    expectCode(() => container.resolve(LoggerToken), 'CTN_DISPOSED');
  });

  test('a hanging disposable times out without blocking others', async () => {
    const order: string[] = [];
    class Slow {
      async dispose(): Promise<void> {
        await new Promise(() => {
          // never resolves
        });
      }
    }
    class Fast {
      async dispose(): Promise<void> {
        order.push('fast');
      }
    }
    const SlowToken = token<Slow>('Slow');
    const FastToken = token<Fast>('Fast');
    const container = new Container({ disposalTimeoutMs: 20 });
    container.register(classProvider(SlowToken, Slow, []), classProvider(FastToken, Fast, []));
    container.resolve(SlowToken);
    container.resolve(FastToken);

    await rejectsWithCode(() => container.dispose(), 'CTN_DISPOSE_FAILED');
    expect(order).toEqual(['fast']);
  });
});
