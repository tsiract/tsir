/**
 * `search.driver` as a name in `tsir.js` (`CAP-006`).
 *
 * The three groups need three different things — nothing, a query function, or a host and a key —
 * and the registry's value is that the error names which one is missing. A `{ fromEnv }` reference
 * that is unset must fail at boot naming the variable, because the alternative is a first search
 * that fails with `401` in a log nobody is watching.
 */

import { describe, expect, test } from 'bun:test';

import { createScoutBootstrap } from './bootstrap.ts';
import { engineFor, searchFromConfig } from './config.ts';
import { SEARCH_DRIVERS } from './scout.ts';

const query = (): Promise<readonly Record<string, unknown>[]> => Promise.resolve([]);

function codeOf(fn: () => unknown): { code?: string; hint?: string; message?: string } {
  try {
    fn();
  } catch (error: unknown) {
    return error as { code?: string; hint?: string; message?: string };
  }
  return {};
}

describe('search registry · every engine is a name in tsir.js', () => {
  test('memory, sqlite and postgres need nothing but the binding they document', () => {
    expect(engineFor({ driver: 'memory' })).toBeDefined();
    expect(
      engineFor({ driver: 'sqlite' }, { bindings: { databases: { default: query } } }),
    ).toBeDefined();
    expect(
      engineFor({ driver: 'postgres' }, { bindings: { databases: { default: query } } }),
    ).toBeDefined();
  });

  test.each(['typesense', 'meilisearch', 'algolia'] as const)(
    '%s builds from host + collection + a resolved key',
    (driver: string) => {
      const engine = engineFor(
        {
          driver,
          host: driver === 'algolia' ? 'https://abc-dsn.algolia.net' : 'https://search.example.com',
          collection: 'docs',
          apiKey: { fromEnv: 'SEARCH_KEY' },
        },
        { env: { SEARCH_KEY: 'k' } },
      );
      expect(engine).toBeDefined();
    },
  );

  test('an unknown driver lists every engine, ours and hosted', () => {
    const thrown = codeOf(() => engineFor({ driver: 'elastic' }));
    expect(thrown.code).toBe('CAP_DRIVER_MISSING');
    expect(thrown.hint).toContain(SEARCH_DRIVERS.join(', '));
  });

  test('a SQL driver with no query function says which binding is missing', () => {
    const thrown = codeOf(() => engineFor({ driver: 'sqlite' }));
    expect(thrown.code).toBe('CAP_DRIVER_MISSING');
    expect(thrown.hint).toContain('bindings.databases.default');
  });

  test('a hosted driver with no key names the environment variable that was empty', () => {
    const thrown = codeOf(() =>
      engineFor(
        {
          driver: 'typesense',
          host: 'https://x',
          collection: 'docs',
          apiKey: { fromEnv: 'TYPESENSE_API_KEY' },
        },
        { env: {} },
      ),
    );
    expect(thrown.code).toBe('CAP_DRIVER_MISSING');
    expect(thrown.hint).toContain('TYPESENSE_API_KEY');
  });

  test('a hosted driver with no host or collection fails before any request', () => {
    expect(
      codeOf(() => engineFor({ driver: 'meilisearch', collection: 'docs' })).message,
    ).toContain('host');
    expect(codeOf(() => engineFor({ driver: 'meilisearch', host: 'https://x' })).message).toContain(
      'collection',
    );
  });
});

describe('search registry · memory is refused in production', () => {
  test('an index that dies with the isolate is not a production engine', () => {
    const thrown = codeOf(() => engineFor({ driver: 'memory' }, { production: true }));
    expect(thrown.code).toBe('CAP_FORBIDDEN_IN_PRODUCTION');
    expect(thrown.hint).toContain('sqlite');
    expect(thrown.hint).toContain('postgres');
  });

  test('no search block is memory in development and a refusal in production', () => {
    expect(searchFromConfig({})).toBeDefined();
    expect(codeOf(() => searchFromConfig({ production: true })).code).toBe(
      'CAP_FORBIDDEN_IN_PRODUCTION',
    );
  });

  test('sqlite is an acceptable production engine — it is a real index', () => {
    expect(
      searchFromConfig({
        search: { driver: 'sqlite' },
        bindings: { databases: { default: query } },
        production: true,
      }),
    ).toBeDefined();
  });
});

describe('scout bootstrap · one way in, no silent override', () => {
  test('the tsir.js block is used when given', () => {
    expect(
      createScoutBootstrap({
        search: { driver: 'postgres' },
        bindings: { databases: { default: query } },
      }).engine,
    ).toBeDefined();
  });

  test('an engine and a block together is refused', () => {
    expect(() =>
      createScoutBootstrap({
        search: { driver: 'memory' },
        engine: {
          index: async () => undefined,
          remove: async () => undefined,
          search: async () => [],
        },
      }),
    ).toThrow(/not both/u);
  });

  test('no arguments is the development default', () => {
    expect(createScoutBootstrap().engine).toBeDefined();
  });
});
