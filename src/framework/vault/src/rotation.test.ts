import { describe, expect, test } from 'bun:test';

import { createVault, type Vault } from './cipher.ts';
import { looksLikeEnvelope, parseEnvelope } from './envelope.ts';
import { createKeyring } from './keyring.ts';
import { formatKeySpec } from './keys.ts';
import {
  ROTATION_METRICS,
  rotationStatus,
  runRotation,
  type RotationObserver,
  type RotationRow,
  type RotationScope,
  type RotationStore,
  type RotationTarget,
} from './rotation.ts';

function specOf(id: string): string {
  return formatKeySpec({
    id,
    alg: 'aes-256-gcm',
    material: crypto.getRandomValues(new Uint8Array(32)),
  });
}

const V1 = specOf('v1');
const V2 = specOf('v2');

const TARGET: RotationTarget = { table: 'users', column: 'tax_id', keyColumn: 'id' };

/**
 * An in-memory store that behaves like the SQL one: rows are key-ordered, `commit`
 * is the only write, and the lock is exclusive. The engine must be correct against
 * this before any dialect-specific SQL exists.
 */
class MemoryStore implements RotationStore {
  readonly rows = new Map<string, Map<string, string>>();
  readonly ledger = new Set<string>();
  readonly commits = new Map<string, number>();
  readonly held = new Set<string>();
  batches = 0;
  failLockFor: string | undefined;

  constructor(seed: Readonly<Record<string, Record<string, string>>> = {}) {
    for (const [scope, rows] of Object.entries(seed)) {
      this.rows.set(scope, new Map(Object.entries(rows)));
    }
  }

  private scope(target: RotationTarget): string {
    return `${target.table}.${target.column}`;
  }

  private table(target: RotationTarget): Map<string, string> {
    const scope = this.scope(target);
    const existing = this.rows.get(scope);
    if (existing !== undefined) return existing;
    const created = new Map<string, string>();
    this.rows.set(scope, created);
    return created;
  }

  async ensureLedger(): Promise<void> {
    this.ledger.add('created');
  }

  /** Mirrors the SQL store: the lock is held for the whole callback. */
  async withLock<T>(target: RotationTarget, run: (scope: RotationScope) => Promise<T>): Promise<T> {
    const name = this.scope(target);
    if (this.failLockFor === name) throw new Error('lock table is unavailable');
    if (this.held.has(name)) {
      const error = new Error(`rotation already running for ${name}`) as Error & { code: string };
      error.code = 'VLT_ROTATION_LOCKED';
      throw error;
    }
    this.held.add(name);

    try {
      return await run({
        batch: async (_activeKeyId, after, limit) => this.batch(target, after, limit),
        commit: async (row, rewritten) => this.commit(target, row, rewritten),
      });
    } finally {
      this.delete(name);
    }
  }

  private delete(name: string): void {
    this.held.delete(name);
  }

  private async batch(
    target: RotationTarget,
    after: string | undefined,
    limit: number,
  ): Promise<readonly RotationRow[]> {
    this.batches += 1;
    return [...this.table(target).entries()]
      .filter(([key]) => after === undefined || key > after)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, limit)
      .map(([key, value]) => ({ key, value }));
  }

  private async commit(target: RotationTarget, row: RotationRow, rewritten: string): Promise<void> {
    this.table(target).set(row.key, rewritten);
    this.commits.set(row.key, (this.commits.get(row.key) ?? 0) + 1);
    this.ledger.add(`${this.scope(target)}:${row.key}`);
  }

  async remaining(target: RotationTarget, activeKeyId: string): Promise<number> {
    let count = 0;
    for (const value of this.table(target).values()) {
      const current = looksLikeEnvelope(value) ? parseEnvelope(value).keyId : 'unreadable';
      if (current !== activeKeyId) count += 1;
    }
    return count;
  }

  values(target: RotationTarget = TARGET): Record<string, string> {
    return Object.fromEntries(this.table(target));
  }

  keyIds(target: RotationTarget = TARGET): string[] {
    return [...this.table(target).values()].map((value) =>
      looksLikeEnvelope(value) ? parseEnvelope(value).keyId : 'unreadable',
    );
  }
}

async function vaults(): Promise<{ old: Vault; writing: Vault }> {
  return {
    old: await createVault({ keyring: createKeyring({ now: V1 }) }),
    // ADR-0021: `v2` is deployed as APP_KEY_NEXT, so it is the writer.
    writing: await createVault({ keyring: createKeyring({ now: V1, next: V2 }) }),
  };
}

async function seedOldRows(vault: Vault, count: number): Promise<Record<string, string>> {
  const rows: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    const key = `id-${String(index).padStart(3, '0')}`;
    rows[key] = await vault.encrypt(TARGET, `tax-${String(index)}`);
  }
  return rows;
}

describe('rotation ledger and watermark batching (VLT-019)', () => {
  test('rewrites every old-key row onto the active key and records each one', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 7) });

    const report = await runRotation({ vault: writing, store, targets: [TARGET], batchSize: 3 });

    expect(report.rotated).toBe(7);
    expect(report.failed).toBe(0);
    expect(report.remaining).toBe(0);
    expect(store.keyIds()).toEqual(Array(7).fill('v2'));
    // The ledger has one row per (target, key) — the uniqueness the SQL table enforces.
    expect([...store.ledger].filter((entry) => entry.startsWith('users.tax_id:'))).toHaveLength(7);
    // Batching is real: 7 rows at 3 per batch is three round trips.
    expect(store.batches).toBe(3);
  });

  test('a second run is a no-op, and no row is rewritten twice', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 5) });

    await runRotation({ vault: writing, store, targets: [TARGET] });
    const second = await runRotation({ vault: writing, store, targets: [TARGET] });

    expect(second.rotated).toBe(0);
    expect(second.remaining).toBe(0);
    expect([...store.commits.values()]).toEqual(Array(5).fill(1));
  });

  test('rows are re-encrypted with the active key, not merely touched', async () => {
    const { old, writing } = await vaults();
    const plaintext = '123-45-6789';
    const store = new MemoryStore({ 'users.tax_id': { a: await old.encrypt(TARGET, plaintext) } });

    await runRotation({ vault: writing, store, targets: [TARGET] });

    const stored = store.values()['a'] as string;
    expect(stored).not.toContain(plaintext);
    expect(parseEnvelope(stored).keyId).toBe('v2');
    expect(await writing.decrypt(TARGET, stored)).toBe(plaintext);
    // The old vault can no longer read it — that is what "rotation completed" means.
    // It fails at the key lookup (`v2` is not in that keyring) rather than at the
    // tag, which is the better error: it says which key the row belongs to.
    expect(await old.decrypt(TARGET, stored).catch((reason: unknown) => reason)).toMatchObject({
      code: 'VLT_UNKNOWN_KEY',
    });
  });

  test('an empty table is reported honestly instead of dividing by zero', async () => {
    const { writing } = await vaults();
    const store = new MemoryStore();

    const report = await runRotation({ vault: writing, store, targets: [TARGET] });

    expect(report.rotated).toBe(0);
    expect(report.rowsPerSecond).toBe(0);
    expect(report.etaMs).toBeUndefined();
  });
});

describe('resumable runner (VLT-020)', () => {
  test('a run killed mid-batch resumes without double-rotating', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 10) });

    const controller = new AbortController();
    const first = await runRotation({
      vault: writing,
      store,
      targets: [TARGET],
      batchSize: 4,
      signal: controller.signal,
      onBatch: (progress) => {
        if (progress.rotated >= 4) controller.abort();
      },
    });

    expect(first.targets[0]?.aborted).toBe(true);
    expect(first.rotated).toBe(4);
    expect(first.remaining).toBe(6);

    const second = await runRotation({ vault: writing, store, targets: [TARGET], batchSize: 4 });

    expect(second.rotated).toBe(6);
    expect(second.remaining).toBe(0);
    expect([...store.commits.values()]).toEqual(Array(10).fill(1));
  });

  test('a row that cannot be read is counted, sampled, and left for the next run', async () => {
    const { old, writing } = await vaults();
    const seeded = await seedOldRows(old, 4);
    const store = new MemoryStore({
      'users.tax_id': { ...seeded, broken: 'not-an-envelope' },
    });

    const report = await runRotation({ vault: writing, store, targets: [TARGET] });

    expect(report.rotated).toBe(4);
    expect(report.failed).toBe(1);
    expect(report.remaining).toBe(1);
    expect(report.failures[0]).toMatchObject({
      target: 'users.tax_id',
      key: 'broken',
      code: 'VLT_MALFORMED_ENVELOPE',
    });
  });

  test('progress is reported per batch and never goes backwards', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 6) });
    const seen: number[] = [];

    await runRotation({
      vault: writing,
      store,
      targets: [TARGET],
      batchSize: 2,
      onBatch: (progress) => seen.push(progress.rotated),
    });

    expect(seen).toEqual([2, 4, 6]);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  test('a row already on the active key is skipped without a rewrite', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({
      'users.tax_id': {
        a: await old.encrypt(TARGET, 'old'),
        // A concurrent writer moved this row to v2 while the run was in flight.
        b: await writing.encrypt(TARGET, 'new'),
      },
    });

    const report = await runRotation({ vault: writing, store, targets: [TARGET] });

    expect(report.rotated).toBe(1);
    expect(store.commits.get('b')).toBeUndefined();
    expect(store.commits.get('a')).toBe(1);
  });

  test('two targets rotate independently and report separately', async () => {
    const { old, writing } = await vaults();
    const taxId: RotationTarget = TARGET;
    const phone: RotationTarget = { table: 'users', column: 'phone', keyColumn: 'id' };
    const store = new MemoryStore({
      'users.tax_id': await seedOldRows(old, 2),
      'users.phone': {
        a: await old.encrypt(phone, '+63 900'),
        b: await old.encrypt(phone, '+63 901'),
        c: await old.encrypt(phone, '+63 902'),
      },
    });

    const report = await runRotation({ vault: writing, store, targets: [taxId, phone] });

    expect(report.rotated).toBe(5);
    expect(report.targets.map((entry) => entry.rotated)).toEqual([2, 3]);
    expect(store.keyIds(phone)).toEqual(['v2', 'v2', 'v2']);
  });
});

describe('one runner per target (VLT-021)', () => {
  test('a held lock is reported instead of rotated, and released afterwards', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 3) });
    store.held.add('users.tax_id');

    const report = await runRotation({ vault: writing, store, targets: [TARGET] });

    expect(report.targets[0]?.locked).toBe(true);
    expect(report.rotated).toBe(0);
    // Nothing was touched, so the work is still there for whoever holds the lock.
    expect(report.remaining).toBe(3);

    // Once the holder lets go, the same call finishes the job.
    store.held.delete('users.tax_id');
    const second = await runRotation({ vault: writing, store, targets: [TARGET] });
    expect(second.rotated).toBe(3);
    expect(store.held.size).toBe(0);
  });

  test('a store error is reported per target, not thrown through the run', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 1) });
    store.failLockFor = 'users.tax_id';

    const report = await runRotation({ vault: writing, store, targets: [TARGET] });

    expect(report.targets[0]?.error).toBe('lock table is unavailable');
    expect(report.rotated).toBe(0);
  });
});

describe('rotation status (VLT-022, VLT-023)', () => {
  test('reports what is left without touching anything', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 4) });

    const before = await rotationStatus({
      store,
      targets: [TARGET],
      activeKeyId: writing.activeKeyId,
    });
    expect(before.remaining).toBe(4);
    expect(before.targets[0]?.percent).toBeUndefined();
    expect(store.commits.size).toBe(0);

    await runRotation({ vault: writing, store, targets: [TARGET] });
    const after = await rotationStatus({
      store,
      targets: [TARGET],
      activeKeyId: writing.activeKeyId,
    });
    expect(after.remaining).toBe(0);
  });
});

describe('rotation metrics (VLT-023)', () => {
  /** A sink that records instead of exporting: the seam `@tsir/telemetry` fills. */
  function recorder(): {
    readonly counters: { name: string; value: number; labels: Record<string, string> }[];
    readonly gauges: { name: string; value: number; labels: Record<string, string> }[];
    readonly observer: RotationObserver;
  } {
    const counters: { name: string; value: number; labels: Record<string, string> }[] = [];
    const gauges: { name: string; value: number; labels: Record<string, string> }[] = [];
    return {
      counters,
      gauges,
      observer: {
        counter: (name, value, labels) => counters.push({ name, value, labels: { ...labels } }),
        gauge: (name, value, labels) => gauges.push({ name, value, labels: { ...labels } }),
      },
    };
  }

  test('counts rows, errors and remaining per column', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({
      'users.tax_id': {
        a: await old.encrypt(TARGET, 'tax-a'),
        b: await old.encrypt(TARGET, 'tax-b'),
        c: 'not-an-envelope',
      },
    });

    const sink = recorder();
    const report = await runRotation({
      vault: writing,
      store,
      targets: [TARGET],
      batchSize: 2,
      observer: sink.observer,
    });

    expect(report.rotated).toBe(2);
    expect(report.failed).toBe(1);

    const rows = sink.counters.filter((entry) => entry.name === ROTATION_METRICS.rows);
    expect(rows).toHaveLength(2);
    expect(rows.every((entry) => entry.value === 1)).toBe(true);
    expect(rows[0]?.labels).toEqual({ table: 'users', column: 'tax_id' });

    const errors = sink.counters.filter((entry) => entry.name === ROTATION_METRICS.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.labels['code']).toBe('VLT_MALFORMED_ENVELOPE');

    // The gauge is sampled once per target, after the work: a dashboard wants the
    // backlog, not a stream of samples that mostly restate the last one.
    const remaining = sink.gauges.filter((entry) => entry.name === ROTATION_METRICS.remaining);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.value).toBe(1);
  });

  test('a throwing metrics sink cannot fail a rotation', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': { a: await old.encrypt(TARGET, 'tax-a') } });

    const report = await runRotation({
      vault: writing,
      store,
      targets: [TARGET],
      observer: {
        counter: () => {
          throw new Error('metrics buffer full');
        },
        gauge: () => {
          throw new Error('metrics buffer full');
        },
      },
    });

    expect(report.rotated).toBe(1);
    expect(report.remaining).toBe(0);
  });
});

describe('rotation clock (CFG-011)', () => {
  test('the elapsed time comes from the injected clock, so the rate is exact', async () => {
    const { old, writing } = await vaults();
    const store = new MemoryStore({ 'users.tax_id': await seedOldRows(old, 10) });
    const readings = [1000, 3000];

    const report = await runRotation({
      vault: writing,
      store,
      targets: [TARGET],
      now: () => readings.shift() ?? 3000,
    });

    expect(report.rotated).toBe(10);
    expect(report.rowsPerSecond).toBe(5);
  });
});
