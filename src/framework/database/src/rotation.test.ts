/**
 * The SQL rotation store without a server: a real SQLite engine behind the D1
 * binding shape (`VLT-019`, `VLT-021`).
 *
 * The Postgres suite proves the `$n` path and the advisory lock; this one proves
 * the other half of the same file — `?` placeholders, the ledger's primary key,
 * and that `commit` really is one transaction — using `bun:sqlite` rather than a
 * hand-written fake. A fake would happily accept the SQL; SQLite will not.
 */

import { Database as Sqlite } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';

import { createKeyring, createVault, formatKeySpec, runRotation, type Vault } from '@tsir/vault';

import { createDatabase } from './database.ts';
import { createD1Driver, type D1Like, type D1ResultLike, type D1StatementLike } from './d1.ts';
import { advisoryLockKey, createRotationStore } from './rotation.ts';

/** A D1 binding over `bun:sqlite`: same three methods, a real engine underneath. */
function sqliteBinding(sqlite: Sqlite): D1Like {
  const prepare = (sql: string, params: readonly unknown[] = []): D1StatementLike => ({
    bind(...values: readonly unknown[]) {
      return prepare(sql, [...params, ...values]);
    },
    async all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>> {
      if (!/^\s*(select|pragma|with)\b/i.test(sql)) {
        const run = sqlite.prepare(sql).run(...(params as never[]));
        return { success: true, results: [], meta: { changes: run.changes } };
      }
      const rows = sqlite.prepare(sql).all(...(params as never[])) as T[];
      return { success: true, results: rows, meta: { changes: 0 } };
    },
    async run(): Promise<D1ResultLike<never>> {
      const run = sqlite.prepare(sql).run(...(params as never[]));
      return { success: true, meta: { changes: run.changes } };
    },
  });

  return {
    prepare: (query: string) => prepare(query),
    async batch<T = Record<string, unknown>>(
      statements: readonly D1StatementLike[],
    ): Promise<readonly D1ResultLike<T>[]> {
      // D1's `batch` is one implicit transaction. Written out rather than with
      // `sqlite.transaction()` because that helper wants a synchronous callback
      // and these statements are promises — an explicit BEGIN/ROLLBACK is both
      // honest and the thing the store is being tested against.
      const out: D1ResultLike<T>[] = [];
      sqlite.run('begin');
      try {
        for (const statement of statements) out.push(await statement.all<T>());
        sqlite.run('commit');
        return out;
      } catch (error: unknown) {
        sqlite.run('rollback');
        throw error;
      }
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}

const TARGET = { table: 'invoices', column: 'tax_id', keyColumn: 'id' } as const;
const COLUMN = { table: 'invoices', column: 'tax_id' } as const;

let sqlite: Sqlite;
let vault: Vault;
let writer: Vault;

function spec(id: string): string {
  return formatKeySpec({
    id,
    alg: 'aes-256-gcm',
    material: crypto.getRandomValues(new Uint8Array(32)),
  });
}

function database() {
  return createDatabase({
    driver: createD1Driver({ binding: sqliteBinding(sqlite) }),
    logging: 'off',
  });
}

describe('database · rotation store on D1 (`?` placeholders)', () => {
  beforeEach(async () => {
    sqlite = new Sqlite(':memory:');
    sqlite.run('create table invoices (id text primary key, tax_id text not null)');

    const now = spec('v1');
    vault = await createVault({ keyring: createKeyring({ now }) });
    writer = await createVault({ keyring: createKeyring({ now, next: spec('v2') }) });

    for (const id of ['a', 'b', 'c']) {
      sqlite.run('insert into invoices (id, tax_id) values (?, ?)', [
        id,
        await vault.encrypt(COLUMN, `t-${id}`),
      ]);
    }
  });

  test('advisoryLockKey is a stable, signed 64-bit value', () => {
    const key = advisoryLockKey('invoices.tax_id');
    expect(key).toBe(advisoryLockKey('invoices.tax_id'));
    expect(key).not.toBe(advisoryLockKey('invoices.other'));
    // Postgres takes a signed bigint: the top bit is a sign, not a truncation.
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });

  test('rewrites the column, records the ledger, and reports nothing remaining', async () => {
    const db = database();
    const report = await runRotation({
      vault: writer,
      store: createRotationStore(db, TARGET),
      targets: [TARGET],
      batchSize: 2,
    });

    expect(report.rotated).toBe(3);
    expect(report.remaining).toBe(0);
    expect(report.failed).toBe(0);

    const rows = sqlite.prepare('select id, tax_id from invoices order by id').all() as {
      id: string;
      tax_id: string;
    }[];
    for (const row of rows) {
      expect(await writer.decrypt(COLUMN, row.tax_id)).toBe(`t-${row.id}`);
    }

    const ledger = sqlite
      .prepare('select row_key, key_id from __tsir_vault_rotation order by row_key')
      .all() as { row_key: string; key_id: string }[];
    expect(ledger.map((row) => row.row_key)).toEqual(['a', 'b', 'c']);
    // The ledger names the key that wrote the row, parsed from the envelope by
    // segment — the same segment `envelope.ts` puts there.
    expect(new Set(ledger.map((row) => row.key_id))).toEqual(new Set(['v2']));
    expect(rows[0]?.tax_id.split(':')[2]).toBe('v2');

    await db.close();
  });

  test('remaining counts the active key as done, and nulls as nothing to do', async () => {
    const db = database();
    const store = createRotationStore(db, TARGET);

    expect(await store.remaining(TARGET, 'v2')).toBe(3);

    await runRotation({ vault: writer, store, targets: [TARGET] });
    expect(await store.remaining(TARGET, 'v2')).toBe(0);

    await db.close();
  });

  test('countKey counts the rows a retirement would strand', async () => {
    const db = database();
    const store = createRotationStore(db, TARGET);

    expect(await store.countKey('v1')).toBe(3);
    expect(await store.countKey('v2')).toBe(0);

    // One row moves onto the new key; the count follows, and it is a prefix match
    // rather than a ledger lookup — the ledger only knows what a runner wrote.
    sqlite.run('update invoices set tax_id = ? where id = ?', [
      await writer.encrypt(COLUMN, 't-a'),
      'a',
    ]);
    expect(await store.countKey('v1')).toBe(2);
    expect(await store.countKey('v2')).toBe(1);
    expect(await store.countKey('nope')).toBe(0);

    await db.close();
  });

  test('a second run rewrites nothing, and the ledger refuses a duplicate', async () => {
    const db = database();
    const store = createRotationStore(db, TARGET);
    await runRotation({ vault: writer, store, targets: [TARGET] });
    const again = await runRotation({ vault: writer, store, targets: [TARGET] });

    expect(again.rotated).toBe(0);
    const ledger = sqlite.prepare('select count(*) as n from __tsir_vault_rotation').get() as {
      n: number;
    };
    expect(ledger.n).toBe(3);

    await db.close();
  });

  test('commit is one transaction: a failed ledger write leaves the value untouched', async () => {
    const db = database();
    const store = createRotationStore(db, TARGET);

    // A ledger that exists but refuses every write: `ensureLedger` is a no-op, so
    // the failure lands mid-commit rather than at startup.
    sqlite.run(`create table __tsir_vault_rotation (
      table_name text not null,
      column_name text not null,
      row_key text not null,
      key_id text not null,
      rotated_at integer not null,
      primary key (table_name, column_name, row_key),
      check (key_id = 'never')
    )`);

    const report = await runRotation({
      vault: writer,
      store,
      targets: [TARGET],
      maxFailureSamples: 1,
    });

    // Every row fails the same way, and none of them is half-written.
    expect(report.rotated).toBe(0);
    expect(report.failed).toBe(3);
    expect(report.failures).toHaveLength(1); // `maxFailureSamples` keeps the report small
    expect(report.failures[0]?.key).toBe('a');
    // The report keeps the engine's own code rather than flattening it: an operator
    // needs to tell a constraint violation from a dropped connection.
    expect(report.failures[0]?.code).toBe('SQLITE_CONSTRAINT_CHECK');

    const row = sqlite.prepare("select tax_id from invoices where id = 'a'").get() as {
      tax_id: string;
    };
    // The update rolled back with the insert it was batched with.
    expect(row.tax_id.split(':')[2]).toBe('v1');
    expect(await vault.decrypt(COLUMN, row.tax_id)).toBe('t-a');

    await db.close();
  });

  test('a target mismatch is refused rather than silently rotating a different column', async () => {
    const db = database();
    const store = createRotationStore(db, TARGET);

    expect(() => store.withLock({ ...TARGET, column: 'other' }, async () => 1)).toThrow(
      /rotates invoices\.tax_id/,
    );
    await db.close();
  });

  test('identifiers are validated before they reach SQL', () => {
    const db = database();
    for (const bad of ['invoices; drop table x', '1nvoices', 'in voices', '']) {
      expect(() => createRotationStore(db, { table: bad, column: 'tax_id' })).toThrow(
        /is not a valid table/,
      );
    }
    expect(() => createRotationStore(db, { table: 'invoices', column: 'a"]' })).toThrow(
      /is not a valid column/,
    );
    void db.close();
  });
});
