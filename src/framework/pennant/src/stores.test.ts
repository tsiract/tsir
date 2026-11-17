/**
 * `databaseStore` on both dialects.
 *
 * The bug this covers: the store wrote `?` literals, so it worked on D1 and SQLite and failed on
 * Postgres with `syntax error at or near "?"` — a failure whose message points at the SQL, not at
 * the configuration that produced it. The placeholder is now a parameter, and both shapes are
 * asserted so the next edit cannot quietly pick one.
 */

import { describe, expect, test } from 'bun:test';

import { databaseStore } from './stores.ts';

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function recorder(): {
  query: (sql: string, params: readonly unknown[]) => Promise<never[]>;
  statements: Statement[];
} {
  const statements: Statement[] = [];
  return {
    statements,
    query: (sql: string, params: readonly unknown[]): Promise<never[]> => {
      statements.push({ sql, params });
      return Promise.resolve([]);
    },
  };
}

describe('databaseStore · the placeholder is the engine’s, not ours', () => {
  test('SQLite/D1 get `?`, and that is the default', async () => {
    const { query, statements } = recorder();
    const store = databaseStore(query);

    await store.get('beta');
    expect(statements[0]?.sql).toBe('SELECT name, description, rule FROM features WHERE name = ?');

    await store.set({ name: 'beta', rule: { type: 'boolean', value: true } });
    expect(statements[1]?.sql).toContain('VALUES (?, ?, ?)');
  });

  test('Postgres gets `$1`, `$2`, `$3` — the bug this file exists for', async () => {
    const { query, statements } = recorder();
    const store = databaseStore(query, { placeholder: 'dollar' });

    await store.get('beta');
    expect(statements[0]?.sql).toBe('SELECT name, description, rule FROM features WHERE name = $1');

    await store.set({ name: 'beta', rule: { type: 'boolean', value: true } });
    expect(statements[1]?.sql).toContain('VALUES ($1, $2, $3)');
    expect(statements[1]?.sql).not.toContain('?');
  });

  test('a second connection can point at its own table', async () => {
    const { query, statements } = recorder();
    const store = databaseStore(query, { table: 'feature_flags', placeholder: 'dollar' });
    await store.all();
    expect(statements[0]?.sql).toBe('SELECT name, description, rule FROM feature_flags');
  });

  test('params keep their order, so `$1` and `?` bind the same values', async () => {
    const { query, statements } = recorder();
    const store = databaseStore(query, { placeholder: 'dollar' });
    await store.set({
      name: 'beta',
      description: 'the beta',
      rule: { type: 'boolean', value: true },
    });
    expect(statements[0]?.params).toEqual(['beta', 'the beta', '{"type":"boolean","value":true}']);
  });
});

describe('databaseStore · the engine decides what is legal (CAP-009)', () => {
  test('a mysql connection is refused, because the placeholder cannot reveal it', async () => {
    // `$1` means Postgres *and* MySQL, so `placeholder` alone passes a MySQL connection through and
    // the upsert fails later. The flag is what makes the refusal possible.
    const { query } = recorder();
    let caught: unknown;
    try {
      databaseStore(query, { placeholder: 'dollar', engine: 'mysql' });
    } catch (thrown: unknown) {
      caught = thrown;
    }
    expect(String(caught)).toMatch(/mysql/u);
    expect(String(caught)).toMatch(/ON CONFLICT/u);
  });

  test('postgres and sqlite are accepted', () => {
    for (const engine of ['d1', 'sqlite', 'postgres'] as const) {
      const { query } = recorder();
      expect(() =>
        databaseStore(query, {
          placeholder: engine === 'postgres' ? 'dollar' : 'question',
          engine,
        }),
      ).not.toThrow();
    }
  });

  test('a caller that omits the engine is still allowed', () => {
    // Optional on purpose: the store only needs a query function, and a test double has no engine.
    const { query } = recorder();
    expect(() => databaseStore(query)).not.toThrow();
  });
});
