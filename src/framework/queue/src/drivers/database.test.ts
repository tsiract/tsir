/**
 * The `database` driver (`§ 4.2`).
 *
 * Two layers of proof, the same two the cache driver uses and for the same reason — this file
 * is mostly SQL, and SQL is where "it looked right" is not evidence:
 *
 *   · a **fake `QueueSql`** that understands the statements the driver issues, keyed by their
 *     shape rather than their exact text. That exercises the real lifecycle: lease, retry,
 *     move-to-dead, replay;
 *   · **dialect assertions**: `$1` on Postgres, `?` on D1, and `FOR UPDATE SKIP LOCKED` only
 *     where the engine actually has row locks. A driver that emits `$1` to D1 passes every
 *     behavioural test in this file and fails on the first real message.
 */

import { describe, expect, test } from 'bun:test';

import { databaseQueueDriver, queueTableDdl, type DatabaseQueueOptions } from './database.ts';
import { conformanceCases, type ConformanceCase } from '../conformance.ts';
import type { QueueSql, QueueSqlResult, QueueSqlStatement } from '../sql.ts';

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  payload: string;
  connection: string;
  attempts: number;
  max_attempts: number;
  available_at: number;
  leased_until: number;
  created_at: number;
  last_error: string | null;
  idempotency_key: string | null;
}

/**
 * A `QueueSql` over two Maps, matching statements by shape. Everything a real client must do
 * is done here too: the due/lease filter, the idempotency conflict, `RETURNING`.
 */
function fakeSql(
  options: { placeholder?: 'question' | 'dollar'; skipLocked?: boolean; now?: () => number } = {},
) {
  const jobs = new Map<string, Row>();
  const dead = new Map<string, Row>();
  const statements: QueueSqlStatement[] = [];
  const now = options.now ?? ((): number => 1_000);
  const placeholder = options.placeholder ?? 'question';

  const ok = (rows: readonly Row[] = [], changes = 0): QueueSqlResult => ({ rows, changes });
  const rowFrom = (id: string, params: readonly unknown[]): Row => ({
    id,
    name: String(params[1]),
    payload: String(params[2]),
    connection: String(params[3]),
    attempts: Number(params[4] ?? 0),
    max_attempts: Number(params[5] ?? 5),
    available_at: Number(params[6]),
    leased_until: 0,
    created_at: Number(params[7]),
    last_error: (params[8] as string | null) ?? null,
    idempotency_key: (params[9] as string | null) ?? null,
  });

  const sql: QueueSql = {
    capabilities: {
      engine: placeholder === 'dollar' ? 'postgres' : 'd1',
      placeholder,
      skipLocked: options.skipLocked ?? placeholder === 'dollar',
    },
    async query(statement) {
      statements.push({ sql: statement.sql, params: statement.params });
      const text = statement.sql.replace(/\s+/g, ' ').trim();
      const params = statement.params;

      // INSERT … SELECT … FROM queue_jobs: the move into the dead-letter store.
      if (/^INSERT INTO queue_dead .* SELECT /u.test(text)) {
        const row = jobs.get(String(params[0]));
        if (row === undefined) return ok();
        dead.set(row.id, { ...row, last_error: String(params[1]) });
        return ok([], 1);
      }

      if (/^INSERT INTO queue_jobs/u.test(text)) {
        const row = rowFrom(String(params[0]), params);
        const duplicate =
          row.idempotency_key !== null &&
          [...jobs.values()].some((entry) => entry.idempotency_key === row.idempotency_key);
        // `ON CONFLICT (idempotency_key) DO NOTHING` — a second dispatch with one key lands
        // nowhere, which is the behaviour the idempotency test depends on.
        if (duplicate && text.includes('ON CONFLICT')) return ok();
        jobs.set(row.id, row);
        return ok([], 1);
      }

      if (/^UPDATE queue_jobs SET leased_until/u.test(text)) {
        const [clock, connection, leaseUntil, limit] = [
          Number(params[0]),
          String(params[1]),
          Number(params[2]),
          Number(params[3]),
        ] as const;
        const due = [...jobs.values()]
          .filter((row) => row.connection === connection)
          .filter((row) => row.available_at <= clock && row.leased_until <= clock)
          .sort((a, b) => a.available_at - b.available_at)
          .slice(0, limit);

        for (const row of due) {
          row.leased_until = leaseUntil;
          row.attempts += 1;
        }
        return ok(due);
      }

      if (/^UPDATE queue_jobs SET attempts/u.test(text)) {
        const [id, retryAt, attempts, error] = params as [string, number, number, string];
        const row = jobs.get(id);
        if (row === undefined) return ok();
        row.attempts = attempts;
        row.available_at = retryAt;
        row.leased_until = 0;
        row.last_error = error;
        return ok([], 1);
      }

      if (/^SELECT \* FROM queue_dead WHERE id/u.test(text)) {
        const row = dead.get(String(params[0]));
        return ok(row === undefined ? [] : [row]);
      }

      if (/^SELECT \* FROM queue_dead ORDER BY/u.test(text)) {
        const rows = [...dead.values()].sort((a, b) => a.created_at - b.created_at);
        return ok(rows.slice(0, Number(params[0])));
      }

      if (/^DELETE FROM .* RETURNING id/u.test(text)) {
        const id = String(params[0]);
        const table = text.includes('queue_dead') ? dead : jobs;
        if (!table.has(id)) return ok();
        table.delete(id);
        return ok([{ id } as unknown as Row], 1);
      }

      if (/^DELETE FROM queue_jobs WHERE id/u.test(text)) {
        const removed = jobs.delete(String(params[0]));
        return ok([], removed ? 1 : 0);
      }

      if (/^DELETE FROM queue_dead WHERE id/u.test(text)) {
        const removed = dead.delete(String(params[0]));
        return ok([], removed ? 1 : 0);
      }

      if (/^DELETE FROM queue_jobs$/u.test(text)) {
        const size = jobs.size;
        jobs.clear();
        return ok([], size);
      }

      if (/^DELETE FROM queue_dead$/u.test(text)) {
        const size = dead.size;
        dead.clear();
        return ok([], size);
      }

      if (/^SELECT COUNT\(\*\) AS removed FROM queue_jobs/u.test(text)) {
        return ok([{ removed: jobs.size } as unknown as Row]);
      }

      throw new Error(`fake QueueSql does not understand: ${text}`);
    },
  };

  return { sql, jobs, dead, statements, now };
}

function driverOf(fake: ReturnType<typeof fakeSql>, options: Partial<DatabaseQueueOptions> = {}) {
  return databaseQueueDriver({ sql: fake.sql, ...options }).open();
}

describe('the database driver', () => {
  test('a pushed message is reserved once, and the live row carries the attempt', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    await backend.push({
      id: 'j-1',
      name: 'SendReceipt',
      payload: '{"id":"o-1"}',
      connection: 'default',
      attempts: 0,
      maxAttempts: 3,
      availableAt: 1_000,
      createdAt: 1_000,
    });

    const [reserved] = await backend.reserve({
      connection: 'default',
      limit: 1,
      now: 1_000,
      leaseMs: 5_000,
    });
    expect(reserved?.id).toBe('j-1');
    // The claim already counted this attempt; the worker must not count it again.
    expect(reserved?.attempts).toBe(1);
    expect(fake.jobs.get('j-1')?.leased_until).toBe(6_000);
  });

  test('a message that is not due, or already leased, is not handed out', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    const base = {
      name: 'Later',
      payload: '{}',
      connection: 'default',
      attempts: 0,
      maxAttempts: 3,
      createdAt: 1_000,
    };
    await backend.push({ ...base, id: 'future', availableAt: 5_000 });
    await backend.push({ ...base, id: 'due', availableAt: 1_000 });

    const first = await backend.reserve({
      connection: 'default',
      limit: 5,
      now: 1_000,
      leaseMs: 5_000,
    });
    expect(first.map((message) => message.id)).toEqual(['due']);

    // Within the lease, nothing else comes out — a second worker must not double-run `due`.
    const second = await backend.reserve({
      connection: 'default',
      limit: 5,
      now: 2_000,
      leaseMs: 5_000,
    });
    expect(second).toEqual([]);

    // Only when its moment arrives: `available_at` is the whole delay mechanism.
    const later = await backend.reserve({
      connection: 'default',
      limit: 5,
      now: 5_000,
      leaseMs: 5_000,
    });
    expect(later.map((message) => message.id)).toEqual(['future']);

    // Past the lease, an abandoned message is resumable: a dead worker must not hold it forever.
    const third = await backend.reserve({
      connection: 'default',
      limit: 5,
      now: 6_001,
      leaseMs: 5_000,
    });
    expect(third.map((message) => message.id)).toEqual(['due']);
    expect(third[0]?.attempts).toBe(2);
  });

  test('reserve is per connection, and a lease is measured on the injected clock', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    const base = {
      name: 'Work',
      payload: '{}',
      attempts: 0,
      maxAttempts: 3,
      availableAt: 1_000,
      createdAt: 1_000,
    };
    await backend.push({ ...base, id: 'a', connection: 'default' });
    await backend.push({ ...base, id: 'b', connection: 'heavy' });

    expect(
      await backend.reserve({ connection: 'heavy', limit: 5, now: 1_000, leaseMs: 5_000 }),
    ).toHaveLength(1);
    expect(
      await backend.reserve({ connection: 'default', limit: 5, now: 1_000, leaseMs: 5_000 }),
    ).toHaveLength(1);
  });

  test('a retry puts the row back with its delay and clears the lease', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    await backend.push({
      id: 'j-1',
      name: 'SendReceipt',
      payload: '{}',
      connection: 'default',
      attempts: 0,
      maxAttempts: 3,
      availableAt: 1_000,
      createdAt: 1_000,
    });

    const [reserved] = await backend.reserve({
      connection: 'default',
      limit: 1,
      now: 1_000,
      leaseMs: 5_000,
    });
    expect(reserved).toBeDefined();
    await backend.fail(reserved!, { error: 'boom', retryAt: 4_000 });

    const row = fake.jobs.get('j-1');
    expect(row?.available_at).toBe(4_000);
    expect(row?.leased_until).toBe(0);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe('boom');
    // It is gone until its retry time arrives.
    expect(
      await backend.reserve({ connection: 'default', limit: 1, now: 3_999, leaseMs: 5_000 }),
    ).toEqual([]);
    expect(
      await backend.reserve({ connection: 'default', limit: 1, now: 4_000, leaseMs: 5_000 }),
    ).toHaveLength(1);
  });

  test('exhaustion moves the row to the dead-letter table rather than deleting it', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    await backend.push({
      id: 'j-1',
      name: 'SendReceipt',
      payload: '{"id":"o-1"}',
      connection: 'default',
      attempts: 2,
      maxAttempts: 3,
      availableAt: 1_000,
      createdAt: 1_000,
    });

    const [reserved] = await backend.reserve({
      connection: 'default',
      limit: 1,
      now: 1_000,
      leaseMs: 5_000,
    });
    await backend.fail(reserved!, { error: 'last try failed' });

    expect(fake.jobs.has('j-1')).toBe(false);
    const dead = await backend.dead(10);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.lastError).toBe('last try failed');
    expect(dead[0]?.payload).toBe('{"id":"o-1"}');

    expect(backend.dead(10)).resolves.toHaveLength(1);
  });

  test('replay restores the budget, and a missing id is simply not there', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    await backend.push({
      id: 'j-1',
      name: 'SendReceipt',
      payload: '{}',
      connection: 'default',
      attempts: 2,
      maxAttempts: 3,
      availableAt: 1_000,
      createdAt: 500,
    });
    const [reserved] = await backend.reserve({
      connection: 'default',
      limit: 1,
      now: 1_000,
      leaseMs: 5_000,
    });
    await backend.fail(reserved!, { error: 'nope' });

    expect(await backend.replay('missing', 9_000)).toBe(false);
    expect(await backend.replay('j-1', 9_000)).toBe(true);

    const [replayed] = await backend.reserve({
      connection: 'default',
      limit: 1,
      now: 9_000,
      leaseMs: 5_000,
    });
    expect(replayed?.id).toBe('j-1');
    expect(replayed?.attempts).toBe(1);
    expect(replayed?.lastError).toBeUndefined();
    expect(await backend.dead(10)).toEqual([]);
  });

  test('discard removes a dead message, a live one, or nothing at all', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    await backend.push({
      id: 'live',
      name: 'SendReceipt',
      payload: '{}',
      connection: 'default',
      attempts: 0,
      maxAttempts: 5,
      availableAt: 1_000,
      createdAt: 1_000,
    });

    expect(await backend.discard('nobody')).toBe(false);
    expect(await backend.discard('live')).toBe(true);
    expect(await backend.size()).toBe(0);
  });

  test('size and purge speak about rows, not about leases', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    for (const id of ['a', 'b', 'c']) {
      await backend.push({
        id,
        name: 'Job',
        payload: '{}',
        connection: 'default',
        attempts: 0,
        maxAttempts: 5,
        availableAt: 1_000,
        createdAt: 1_000,
      });
    }

    expect(await backend.size()).toBe(3);
    await backend.purge();
    expect(await backend.size()).toBe(0);
  });

  test('an idempotency key makes a second push a no-op', async () => {
    const fake = fakeSql({ now: () => 1_000 });
    const backend = driverOf(fake);

    const message = {
      id: 'j-1',
      name: 'SendReceipt',
      payload: '{}',
      connection: 'default',
      attempts: 0,
      maxAttempts: 5,
      availableAt: 1_000,
      createdAt: 1_000,
      idempotencyKey: 'order-42',
    };
    await backend.push(message);
    await backend.push({ ...message, id: 'j-2' });

    expect(await backend.size()).toBe(1);
    expect(fake.jobs.get('j-1')?.idempotency_key).toBe('order-42');
  });
});

describe('the database dialect', () => {
  const message = {
    id: 'j-1',
    name: 'SendReceipt',
    payload: '{}',
    connection: 'default',
    attempts: 0,
    maxAttempts: 5,
    availableAt: 1_000,
    createdAt: 1_000,
  };

  test('Postgres gets $n placeholders and a locking claim', async () => {
    const fake = fakeSql({ placeholder: 'dollar', skipLocked: true });
    const backend = driverOf(fake);

    await backend.push(message);
    await backend.reserve({ connection: 'default', limit: 1, now: 1_000, leaseMs: 5_000 });

    const claim = fake.statements.find((statement) =>
      statement.sql.startsWith('UPDATE queue_jobs SET leased_until'),
    );
    expect(claim?.sql).toContain('available_at <= $1');
    expect(claim?.sql).toContain('connection = $2');
    expect(claim?.sql).toContain('LIMIT $4');
    expect(claim?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim?.params).toEqual([1_000, 'default', 6_000, 1]);
  });

  test('D1 gets ? placeholders and no lock hint at all', async () => {
    const fake = fakeSql({ placeholder: 'question', skipLocked: false });
    const backend = driverOf(fake);

    await backend.push(message);
    await backend.reserve({ connection: 'default', limit: 1, now: 1_000, leaseMs: 5_000 });

    const claim = fake.statements.find((statement) =>
      statement.sql.startsWith('UPDATE queue_jobs SET leased_until'),
    );
    expect(claim?.sql).not.toContain('$');
    // A `FOR UPDATE` D1 cannot honour is worse than none: it reads as a guarantee.
    expect(claim?.sql).not.toContain('SKIP LOCKED');
    expect(claim?.sql).toContain('RETURNING *');
  });

  test('the DDL differs only where the engines really differ', () => {
    const postgres = queueTableDdl({ engine: 'postgres' });
    const d1 = queueTableDdl({ engine: 'd1' });

    expect(postgres.join('\n')).toContain('available_at BIGINT');
    expect(d1.join('\n')).toContain('available_at INTEGER');
    expect(postgres.join('\n')).toContain('queue_dead');
    expect(postgres.join('\n')).toContain('queue_outbox');
    // The partial unique index is what makes idempotency a database guarantee.
    expect(postgres.join('\n')).toContain('UNIQUE INDEX IF NOT EXISTS queue_jobs_idempotency');

    // Names are configurable, because a shared database is a real thing.
    const renamed = queueTableDdl({
      engine: 'postgres',
      table: 'jobs',
      deadTable: 'jobs_dead',
      outboxTable: 'outbox',
    });
    expect(renamed.join('\n')).toContain('CREATE TABLE IF NOT EXISTS jobs (');
    expect(renamed.join('\n')).toContain('CREATE TABLE IF NOT EXISTS outbox (');
    expect(renamed.join('\n')).not.toContain('queue_jobs');
  });
});

describe('the database driver against the conformance kit', () => {
  // The kit is the contract; this is where the SQL driver has to satisfy it. A fake `QueueSql`
  // is a fair judge here because every case is about the lifecycle the driver orchestrates —
  // the dialect assertions above are what cover the part the fake cannot see.
  const cases: readonly ConformanceCase[] = conformanceCases({
    driver: databaseQueueDriver({
      sql: fakeSql({ placeholder: 'dollar', skipLocked: true }).sql,
      now: () => 1_000_000,
    }),
  });

  for (const entry of cases) {
    test(entry.name, () => entry.run());
  }

  test('the kit actually ran', () => {
    expect(cases.length).toBeGreaterThan(5);
  });
});
