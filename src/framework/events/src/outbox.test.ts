/**
 * The transactional outbox (`§ 4.2`, `§ 4.5`), tested where it lives.
 *
 * The mechanism moved out of `@tsir/queue` because the queue cannot answer the question the
 * outbox answers — *what* is being delivered — and a build that refuses a broker "without
 * `@tsir/events`" has to be telling the truth about where the writer is.
 *
 * What has to be true, and is therefore what is tested:
 *
 *   · a recorded message is invisible to the queue until the relay publishes it;
 *   · publishing marks the row, and marking is **idempotent** — a crash between dispatch and
 *     `markPublished` republishes rather than loses, which is only harmless if the second
 *     publish is recognisably the same message (hence the idempotency key);
 *   · `record(message, statement)` joins the caller's batch instead of writing on its own —
 *     that is the atomicity, and a driver that quietly took its own connection would look
 *     correct and be useless;
 *   · a non-transactional driver with no outbox is a build error, not a runtime surprise.
 */

import { describe, expect, test } from 'bun:test';

import type {
  DispatchOptions,
  DispatchResult,
  JobMessage,
  QueueSql,
  QueueSqlResult,
} from '@tsir/queue';

import { createOutbox } from './outbox.ts';

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  payload: string;
  connection: string;
  created_at: number;
  max_attempts: number;
  idempotency_key: string | null;
  published_at: number | null;
}

/** The three statements the outbox issues, over a Map. */
function fakeSql(placeholder: 'question' | 'dollar' = 'question') {
  const rows = new Map<string, Row>();
  const statements: string[] = [];

  const sql: QueueSql = {
    capabilities: { engine: placeholder === 'dollar' ? 'postgres' : 'd1', placeholder },
    async query({ sql: text, params }): Promise<QueueSqlResult> {
      statements.push(text);

      if (/^INSERT INTO \S+ \(id, name, payload/u.test(text)) {
        rows.set(String(params[0]), {
          id: String(params[0]),
          name: String(params[1]),
          payload: String(params[2]),
          connection: String(params[3]),
          created_at: Number(params[4]),
          max_attempts: Number(params[5] ?? 5),
          idempotency_key: (params[6] as string | null) ?? null,
          published_at: null,
        });
        return { rows: [], changes: 1 };
      }

      if (/^SELECT \* FROM \S+ WHERE published_at IS NULL/u.test(text)) {
        const unpublished = [...rows.values()]
          .filter((row) => row.published_at === null)
          .sort((a, b) => a.created_at - b.created_at)
          .slice(0, Number(params[0]));
        return { rows: unpublished, changes: 0 };
      }

      if (/^UPDATE \S+ SET published_at/u.test(text)) {
        // `params[0]` is the stamp and `params[1]` the id: the fake reads the parameters in the
        // order the placeholders appear in the SQL, which is the only order a `?` engine has.
        const row = rows.get(String(params[1]));
        if (row === undefined || row.published_at !== null) return { rows: [], changes: 0 };
        row.published_at = Number(params[0]);
        return { rows: [{ id: row.id }], changes: 1 };
      }

      if (/^SELECT COUNT\(\*\) AS removed FROM /u.test(text)) {
        return {
          rows: [{ removed: [...rows.values()].filter((row) => row.published_at === null).length }],
          changes: 0,
        };
      }

      throw new Error(`fake QueueSql does not understand: ${text}`);
    },
  };

  return { sql, rows, statements };
}

const message = (id: string, overrides: Partial<JobMessage> = {}): JobMessage => ({
  id,
  name: 'SendReceipt',
  payload: '{"orderId":"o-1"}',
  connection: 'default',
  attempts: 0,
  maxAttempts: 4,
  availableAt: 1_000,
  createdAt: 1_000,
  ...overrides,
});

/** A queue that only records what it was asked to dispatch. */
function fakeQueue() {
  const dispatched: { name: string; payload: unknown; options: DispatchOptions }[] = [];
  return {
    dispatched,
    dispatch: async (
      job: { name: string },
      payload: unknown,
      options: DispatchOptions = {},
    ): Promise<DispatchResult> => {
      dispatched.push({ name: job.name, payload, options });
      return {
        id: `q-${String(dispatched.length)}`,
        connection: 'default',
        name: job.name,
        accepted: true,
      };
    },
  };
}

describe('the outbox', () => {
  test('a recorded message waits for the relay instead of going straight to the queue', async () => {
    const fake = fakeSql();
    const outbox = createOutbox({ sql: fake.sql });
    const queue = fakeQueue();

    await outbox.record(message('ob-1'));

    expect(await outbox.size()).toBe(1);
    expect(queue.dispatched).toEqual([]);

    expect(await outbox.relay(queue)).toBe(1);
    expect(queue.dispatched).toHaveLength(1);
    expect(queue.dispatched[0]?.name).toBe('SendReceipt');
    // The payload is re-parsed, not re-encoded: the queue must see the object it would have
    // been given by a direct dispatch.
    expect(queue.dispatched[0]?.payload).toEqual({ orderId: 'o-1' });
    expect(await outbox.size()).toBe(0);
  });

  test('the relay keeps the outbox id, so a republish is the same message', async () => {
    const fake = fakeSql();
    const outbox = createOutbox({ sql: fake.sql });
    const queue = fakeQueue();

    await outbox.record(message('ob-1', { idempotencyKey: 'order-42' }));
    await outbox.relay(queue);

    expect(queue.dispatched[0]?.options.idempotencyKey).toBe('order-42');
    expect(queue.dispatched[0]?.options.maxAttempts).toBe(4);

    // Nothing left: a second relay is a no-op, not a second delivery.
    expect(await outbox.relay(queue)).toBe(0);
    expect(queue.dispatched).toHaveLength(1);
  });

  test('with no idempotency key the message id stands in for one', async () => {
    const fake = fakeSql();
    const outbox = createOutbox({ sql: fake.sql });
    const queue = fakeQueue();

    await outbox.record(message('ob-7'));
    await outbox.relay(queue);

    expect(queue.dispatched[0]?.options.idempotencyKey).toBe('ob-7');
  });

  test('publishing twice counts once, and reports the truth', async () => {
    const fake = fakeSql();
    const outbox = createOutbox({ sql: fake.sql });

    await outbox.record(message('ob-1'));

    expect(await outbox.markPublished(['ob-1', 'ob-missing'])).toBe(1);
    expect(await outbox.markPublished(['ob-1'])).toBe(0);
    expect(fake.rows.get('ob-1')?.published_at).toBeNumber();
  });

  test('pending is bounded and oldest-first, so a backfill drains in order', async () => {
    const fake = fakeSql();
    const outbox = createOutbox({ sql: fake.sql });

    await outbox.record(message('ob-2', { createdAt: 2_000 }));
    await outbox.record(message('ob-1', { createdAt: 1_000 }));
    await outbox.record(message('ob-3', { createdAt: 3_000 }));

    const pending = await outbox.pending(2);
    expect(pending.map((entry) => entry.message.id)).toEqual(['ob-1', 'ob-2']);
    expect(pending[0]?.message.maxAttempts).toBe(4);
  });

  test('a caller-supplied statement joins their batch and never touches the outbox connection', async () => {
    const fake = fakeSql();
    const outbox = createOutbox({ sql: fake.sql });

    const batch: { sql: string; params: readonly unknown[] }[] = [];
    await outbox.record(message('ob-1'), (text, params) => {
      batch.push({ sql: text, params });
    });

    // The atomicity lives in the caller's batch: `batch([insertOrder, outboxRow])` commits or
    // rolls back together, and the outbox must not open a second write of its own.
    expect(batch).toHaveLength(1);
    expect(batch[0]?.sql).toContain('INSERT INTO queue_outbox');
    expect(batch[0]?.params[0]).toBe('ob-1');
    expect(fake.statements).toEqual([]);
    expect(fake.rows.size).toBe(0);
  });

  test('Postgres placeholders are numbered like every other statement in the package', async () => {
    const fake = fakeSql('dollar');
    const outbox = createOutbox({ sql: fake.sql });

    await outbox.record(message('ob-1'));

    expect(fake.statements[0]).toContain('$1');
    expect(fake.statements[0]).not.toContain('?');
  });

  test('the update’s placeholders follow the parameter order — the only order a `?` engine has', async () => {
    // The bug this pins: numbering the placeholders `p(2)`/`p(1)` while passing `[id, stamp]` reads
    // correctly for Postgres and is inverted for D1, where both placeholders are `?`. The row is
    // then never marked, and the relay re-sends it on every tick — silently, forever.
    const question = fakeSql();
    await createOutbox({ sql: question.sql }).markPublished(['ob-1']);
    const [update] = question.statements.filter((text) => text.startsWith('UPDATE'));
    expect(update).toContain('SET published_at = ? WHERE id = ?');

    const dollar = fakeSql('dollar');
    await createOutbox({ sql: dollar.sql }).markPublished(['ob-1']);
    const [numbered] = dollar.statements.filter((text) => text.startsWith('UPDATE'));
    // `$1` is the stamp and `$2` the id, matching `[stamp, id]`.
    expect(numbered).toContain('SET published_at = $1 WHERE id = $2');
  });

  test('a custom table name is honoured', async () => {
    const fake = fakeSql();
    const outbox = createOutbox({ sql: fake.sql, table: 'outbox' });

    await outbox.record(message('ob-1'));
    expect(fake.statements[0]).toContain('INSERT INTO outbox');
  });
});
