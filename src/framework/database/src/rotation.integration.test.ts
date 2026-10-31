/**
 * The SQL rotation store against a real Postgres (`VLT-019`, `VLT-021`, `VLT-024`).
 *
 * Every property this test asserts is one the in-memory suite cannot: the ledger's
 * primary key refusing a second row, `commit` being a single transaction, and
 * `pg_try_advisory_lock` actually excluding a second session.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createKeyring, createVault, formatKeySpec, type Vault } from '@tsir/vault';
import { runRotation, type RotationTarget } from '@tsir/vault';

import { createDatabase, type Database } from '../src/index.ts';
import { createPostgresDriver } from '../src/postgres.ts';
import { createRotationStore } from '../src/rotation.ts';
import { connectPostgres, databaseUrl, type TestDatabase } from '../../../tools/pg-test-client.ts';

const url = databaseUrl();
const suite = url === undefined ? describe.skip : describe;

const TARGET: RotationTarget = { table: 'it_rotation', column: 'tax_id', keyColumn: 'id' };
const COLUMN = { table: 'it_rotation', column: 'tax_id' } as const;

let pg: TestDatabase;
let db: Database;
let oldVault: Vault;
let writingVault: Vault;

function spec(id: string): string {
  return formatKeySpec({
    id,
    alg: 'aes-256-gcm',
    material: crypto.getRandomValues(new Uint8Array(32)),
  });
}

suite('database · rotation store on Postgres (VLT-019, VLT-021, VLT-024)', () => {
  beforeAll(async () => {
    pg = connectPostgres(url ?? '');
    db = createDatabase({ driver: createPostgresDriver({ client: pg.client }), logging: 'off' });

    // One Debian-style rotation: `v1` wrote the rows, `v2` is the new writer.
    const v1 = spec('v1');
    oldVault = await createVault({ keyring: createKeyring({ now: v1 }) });
    writingVault = await createVault({ keyring: createKeyring({ now: v1, next: spec('v2') }) });
  });

  afterAll(async () => {
    await db.close();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.run('drop table if exists it_rotation');
    await pg.run('drop table if exists __tsir_vault_rotation');
    await pg.run('create table it_rotation (id text primary key, tax_id text not null)');

    for (const id of ['a', 'b', 'c', 'd']) {
      await pg.run('insert into it_rotation (id, tax_id) values ($1, $2)', [
        id,
        await oldVault.encrypt(COLUMN, `tax-${id}`),
      ]);
    }
  });

  function store() {
    return createRotationStore(db, { table: 'it_rotation', column: 'tax_id', keyColumn: 'id' });
  }

  test('rewrites every row, records the ledger, and reports zero remaining', async () => {
    const report = await runRotation({
      vault: writingVault,
      store: store(),
      targets: [TARGET],
      batchSize: 3,
    });

    expect(report.rotated).toBe(4);
    expect(report.remaining).toBe(0);
    expect(report.failed).toBe(0);

    const rows = (await pg.run('select id, tax_id from it_rotation order by id')) as {
      id: string;
      tax_id: string;
    }[];
    for (const row of rows) {
      // The stored value names the new key, and only the new vault reads it.
      expect(row.tax_id.startsWith('tsir:v1:v2:')).toBe(true);
      expect(await writingVault.decrypt(COLUMN, row.tax_id)).toBe(`tax-${row.id}`);
      expect(await oldVault.decrypt(COLUMN, row.tax_id).catch((e: unknown) => e)).toMatchObject({
        code: 'VLT_UNKNOWN_KEY',
      });
    }

    const ledger = (await pg.run(
      "select count(*)::text as count from __tsir_vault_rotation where table_name = 'it_rotation'",
    )) as { count: string }[];
    expect(ledger[0]?.count).toBe('4');
  });

  test('a second run is a no-op, and the ledger cannot record a row twice', async () => {
    const target = store();
    await runRotation({ vault: writingVault, store: target, targets: [TARGET] });
    const second = await runRotation({ vault: writingVault, store: target, targets: [TARGET] });

    expect(second.rotated).toBe(0);
    expect(second.remaining).toBe(0);

    const ledger = (await pg.run('select count(*)::text as count from __tsir_vault_rotation')) as {
      count: string;
    }[];
    expect(ledger[0]?.count).toBe('4');
  });

  test('a second runner is excluded by the advisory lock, not by luck', async () => {
    const first = store();

    await first.withLock(TARGET, async () => {
      // A different store, therefore a different pinned session.
      const report = await runRotation({
        vault: writingVault,
        store: createRotationStore(db, { table: 'it_rotation', column: 'tax_id' }),
        targets: [TARGET],
      });

      expect(report.targets[0]?.locked).toBe(true);
      expect(report.rotated).toBe(0);
      expect(report.remaining).toBe(4);
    });

    // The lock is gone with the session that took it.
    const after = await runRotation({ vault: writingVault, store: store(), targets: [TARGET] });
    expect(after.rotated).toBe(4);
  });

  test('a row written by the application mid-rotation is already on the new key', async () => {
    // Matrix row 13: a live request inserts while the runner is working. It writes
    // with the active key, so the runner must never touch it.
    await pg.run('insert into it_rotation (id, tax_id) values ($1, $2)', [
      'live',
      await writingVault.encrypt(COLUMN, 'tax-live'),
    ]);

    const report = await runRotation({ vault: writingVault, store: store(), targets: [TARGET] });

    expect(report.rotated).toBe(4);
    expect(report.remaining).toBe(0);
    const live = (await pg.run("select tax_id from it_rotation where id = 'live'")) as {
      tax_id: string;
    }[];
    expect(live[0]?.tax_id.startsWith('tsir:v1:v2:')).toBe(true);
    expect(await writingVault.decrypt(COLUMN, live[0]?.tax_id ?? '')).toBe('tax-live');
  });

  test('an interrupted run resumes where it stopped (matrix row 12)', async () => {
    const controller = new AbortController();
    const first = await runRotation({
      vault: writingVault,
      store: store(),
      targets: [TARGET],
      batchSize: 2,
      signal: controller.signal,
      onBatch: (progress) => {
        if (progress.rotated >= 2) controller.abort();
      },
    });

    expect(first.rotated).toBe(2);
    expect(first.remaining).toBe(2);

    const second = await runRotation({
      vault: writingVault,
      store: store(),
      targets: [TARGET],
      batchSize: 2,
    });
    expect(second.rotated).toBe(2);
    expect(second.remaining).toBe(0);
  });
});
