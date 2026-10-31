/**
 * Publishing through the outbox (`§ 4.5`).
 *
 * The claim this file exists to prove is a two-line one:
 *
 * ```ts
 * await db.batch([insertOrder, publisher.record(OrderPlaced, payload)]);   // atomic
 * await publisher.relay();                                                // …later
 * ```
 *
 * So: the row joins **the caller's** batch and never opens a write of its own; the relay sends
 * exactly what committed; and a `sync` listener on an outboxed event is refused, because "inline
 * after the commit" is not a thing that can happen.
 */

import { describe, expect, test } from 'bun:test';
import type { DispatchOptions, DispatchResult, QueueSql, QueueSqlResult } from '@tsir/queue';

import { createEvents } from './bus.ts';
import { defineEvent, defineListener } from './event.ts';
import type { Outbox } from './outbox.ts';
import { createPublisher } from './publish.ts';

interface OrderPlaced {
  readonly orderId: string;
}
const OrderPlaced = defineEvent<OrderPlaced>({ name: 'order.placed' });
const OrderShipped = defineEvent<{ readonly orderId: string }>({ name: 'order.shipped' });

/** The three statements the outbox issues, over a Map — the same fake the outbox test uses. */
function fakeSql() {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const rows = new Map<string, Record<string, unknown>>();

  const sql: QueueSql = {
    capabilities: { engine: 'd1', placeholder: 'question' },
    async query({ sql: text, params }): Promise<QueueSqlResult> {
      statements.push({ sql: text, params });
      if (/^INSERT INTO \S+ \(id, name/u.test(text)) {
        rows.set(String(params[0]), {
          id: String(params[0]),
          name: String(params[1]),
          payload: String(params[2]),
          connection: String(params[3]),
          created_at: Number(params[4]),
          max_attempts: Number(params[5] ?? 5),
          idempotency_key: params[6] ?? null,
          published_at: null,
        });
        return { rows: [], changes: 1 };
      }
      if (/^SELECT \* FROM \S+ WHERE published_at IS NULL/u.test(text)) {
        const pending = [...rows.values()]
          .filter((row) => row['published_at'] === null)
          .sort((a, b) => Number(a['created_at']) - Number(b['created_at']))
          .slice(0, Number(params[0] ?? 100));
        return { rows: pending, changes: 0 };
      }
      if (/^UPDATE \S+ SET published_at/u.test(text)) {
        // Placeholder order, not parameter-array order: `SET published_at = ?, … id = ?`.
        const row = rows.get(String(params[1]));
        if (row === undefined || row['published_at'] !== null) return { rows: [], changes: 0 };
        row['published_at'] = Number(params[0]);
        return { rows: [{ id: row['id'] }], changes: 1 };
      }
      if (/^SELECT COUNT\(\*\)/u.test(text)) {
        const count = [...rows.values()].filter((row) => row['published_at'] === null).length;
        return { rows: [{ removed: count }], changes: 0 };
      }
      return { rows: [], changes: 0 };
    },
  };

  return { sql, statements, rows };
}

/** A queue that only records what it was asked to dispatch. */
function fakeQueue(connection = 'default') {
  const dispatched: { name: string; payload: unknown; options: DispatchOptions }[] = [];
  return {
    dispatched,
    connection,
    dispatch: async (
      job: { name: string },
      payload: unknown,
      options: DispatchOptions = {},
    ): Promise<DispatchResult> => {
      dispatched.push({ name: job.name, payload, options });
      return { id: `q-${String(dispatched.length)}`, connection, name: job.name, accepted: true };
    },
  };
}

function publisherFor(listeners: readonly ReturnType<typeof defineListener>[]) {
  const fake = fakeSql();
  const queue = fakeQueue('default');
  const events = createEvents({ listeners, queue, newId: () => 'dispatch-1', now: () => 5_000 });
  const outbox: Outbox = {
    record: async (message, statement) => {
      const params = [
        message.id,
        message.name,
        message.payload,
        message.connection,
        message.createdAt,
        message.maxAttempts,
        message.idempotencyKey ?? null,
      ] as const;
      if (statement !== undefined) {
        statement(
          `INSERT INTO queue_outbox (id, name, payload, connection, created_at, max_attempts, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params,
        );
        return;
      }
      await fake.sql.query({
        sql: `INSERT INTO queue_outbox (id, name, payload, connection, created_at, max_attempts, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params,
      });
    },
    pending: async (limit) => {
      const result = await fake.sql.query({
        sql: 'SELECT * FROM queue_outbox WHERE published_at IS NULL ORDER BY created_at ASC LIMIT ?',
        params: [limit ?? 100],
      });
      return (result.rows as readonly Record<string, unknown>[]).map((row) => ({
        message: {
          id: String(row['id']),
          name: String(row['name']),
          payload: String(row['payload']),
          connection: String(row['connection']),
          attempts: 0,
          maxAttempts: Number(row['max_attempts']),
          availableAt: Number(row['created_at']),
          createdAt: Number(row['created_at']),
          idempotencyKey: String(row['idempotency_key']),
        },
      }));
    },
    markPublished: async (ids, at) => {
      let changed = 0;
      for (const id of ids) {
        const result = await fake.sql.query({
          sql: 'UPDATE queue_outbox SET published_at = ? WHERE id = ? AND published_at IS NULL RETURNING id',
          params: [at ?? 5_001, id],
        });
        changed += result.rows.length;
      }
      return changed;
    },
    relay: async (queueLike, limit) => {
      const pending = await outbox.pending(limit);
      let published = 0;
      for (const entry of pending) {
        await queueLike.dispatch(
          { name: entry.message.name },
          JSON.parse(entry.message.payload) as unknown,
          {
            maxAttempts: entry.message.maxAttempts,
            idempotencyKey: entry.message.idempotencyKey ?? entry.message.id,
          },
        );
        published += await outbox.markPublished([entry.message.id]);
      }
      return published;
    },
    size: async () => {
      const result = await fake.sql.query({
        sql: 'SELECT COUNT(*) AS removed FROM queue_outbox WHERE published_at IS NULL',
        params: [],
      });
      return Number((result.rows[0] as Record<string, unknown> | undefined)?.['removed'] ?? 0);
    },
  };

  const publisher = createPublisher({
    events,
    outbox,
    queue,
    now: () => 5_000,
    newId: () => 'dispatch-1',
  });
  return { publisher, outbox, queue, fake };
}

describe('createPublisher', () => {
  test('record writes one row per queued listener, into the caller’s batch', async () => {
    const { publisher, queue, fake } = publisherFor([
      defineListener(OrderPlaced, {
        name: 'send-receipt',
        mode: 'queued',
        handle: () => undefined,
      }),
      defineListener(OrderPlaced, {
        name: 'update-ledger',
        mode: 'queued',
        handle: () => undefined,
      }),
    ]);

    const batch: { sql: string; params: readonly unknown[] }[] = [];
    const ids = await publisher.record(OrderPlaced, { orderId: 'o-1' }, (sql, params) => {
      batch.push({ sql, params });
    });

    expect(ids).toEqual(['dispatch-1:send-receipt', 'dispatch-1:update-ledger']);
    expect(batch).toHaveLength(2);
    expect(batch[0]?.sql).toContain('INSERT INTO queue_outbox');
    expect(batch[1]?.params[1]).toBe('event:order.placed:update-ledger');
    // The atomicity is the caller's: the outbox never opened a connection of its own.
    expect(fake.statements).toEqual([]);
    expect(fake.rows.size).toBe(0);
    expect(queue.dispatched).toEqual([]);
  });

  test('the recorded row is the same delivery a direct dispatch would have made', async () => {
    const { publisher } = publisherFor([
      defineListener(OrderPlaced, {
        name: 'send-receipt',
        mode: 'queued',
        maxAttempts: 7,
        handle: () => undefined,
      }),
    ]);

    const batch: { sql: string; params: readonly unknown[] }[] = [];
    await publisher.record(OrderPlaced, { orderId: 'o-2' }, (sql, params) => {
      batch.push({ sql, params });
    });

    const params = batch[0]?.params;
    expect(params?.[1]).toBe('event:order.placed:send-receipt');
    // Payload, connection, attempts and the idempotency key all match the direct path, so a
    // retry behaves the same however the event was published.
    expect(JSON.parse(String(params?.[2]))).toEqual({
      event: 'order.placed',
      listener: 'send-receipt',
      payload: { orderId: 'o-2' },
      occurredAt: 5_000,
      dispatchId: 'dispatch-1',
    });
    expect(params?.[3]).toBe('default');
    expect(params?.[5]).toBe(7);
    expect(params?.[6]).toBe('dispatch-1:send-receipt');
  });

  test('relay publishes what committed, and only once', async () => {
    const { publisher, queue } = publisherFor([
      defineListener(OrderPlaced, {
        name: 'send-receipt',
        mode: 'queued',
        handle: () => undefined,
      }),
    ]);

    await publisher.record(OrderPlaced, { orderId: 'o-3' });
    expect(await publisher.size()).toBe(1);
    expect(queue.dispatched).toEqual([]);

    expect(await publisher.relay()).toBe(1);
    expect(queue.dispatched).toHaveLength(1);
    expect(queue.dispatched[0]?.name).toBe('event:order.placed:send-receipt');
    expect(queue.dispatched[0]?.options.idempotencyKey).toBe('dispatch-1:send-receipt');
    expect(await publisher.size()).toBe(0);

    // A relay on an empty outbox is a no-op, not a second delivery.
    expect(await publisher.relay()).toBe(0);
    expect(queue.dispatched).toHaveLength(1);
  });

  test('a sync listener cannot be published through the outbox', async () => {
    const { publisher, fake } = publisherFor([
      defineListener(OrderPlaced, {
        name: 'send-receipt',
        mode: 'queued',
        handle: () => undefined,
      }),
      defineListener(OrderPlaced, {
        name: 'warm-dashboard',
        mode: 'sync',
        handle: () => undefined,
      }),
    ]);

    const error = await publisher
      .record(OrderPlaced, { orderId: 'o-4' }, () => undefined)
      .then(() => undefined)
      .catch((caught: unknown) => caught as { code?: string; message: string });

    expect(error?.code).toBe('CAP_EVENTS_SYNC_OUTBOXED');
    expect(error?.message).toContain('"warm-dashboard"');
    // Nothing was half-recorded: the refusal is before the first write.
    expect(fake.statements).toEqual([]);
  });

  test('an undeclared event is refused at record time too', async () => {
    const { publisher } = publisherFor([
      defineListener(OrderPlaced, {
        name: 'send-receipt',
        mode: 'queued',
        handle: () => undefined,
      }),
    ]);

    const error = await publisher
      .record(OrderShipped, { orderId: 'o-5' })
      .then(() => undefined)
      .catch((caught: unknown) => caught as { code?: string; message: string });

    expect(error?.code).toBe('CAP_UNKNOWN_EVENT');
  });

  test('a write that fails inside the batch is the whole guarantee, so it is named', async () => {
    // The promise this package makes is "the row joins your batch". If `record` fails and says
    // nothing useful, the caller is left holding a business write that committed without its
    // deliveries — the exact failure the outbox exists to prevent. `CAP_OUTBOX_WRITE_FAILED`
    // has to carry the event and the underlying reason (CAP-P7 F7).
    const queue = fakeQueue();
    const events = createEvents({
      listeners: [
        defineListener(OrderPlaced, {
          name: 'send-receipt',
          mode: 'queued',
          handle: () => undefined,
        }),
      ],
      queue,
    });
    const publisher = createPublisher({
      events,
      queue,
      outbox: {
        record: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')),
        pending: () => Promise.resolve([]),
        markPublished: () => Promise.resolve(0),
        relay: () => Promise.resolve(0),
        size: () => Promise.resolve(0),
      },
    });

    const failure = await publisher
      .record(OrderPlaced, { orderId: 'o-1' })
      .then(() => 'resolved')
      .catch((error: unknown) => error as { code?: string; message?: string });

    expect(failure).not.toBe('resolved');
    expect((failure as { code?: string }).code).toBe('CAP_OUTBOX_WRITE_FAILED');
    expect((failure as { message?: string }).message).toContain('order.placed');
    expect((failure as { message?: string }).message).toContain('SQLITE_BUSY');
  });

  test('a non-Error rejection is reported too, rather than swallowed as "[object Object]"', async () => {
    // A driver that rejects with a bare string is common; the failure must still name it.
    const reason: unknown = 'the connection went away';
    const queue = fakeQueue();
    const events = createEvents({
      listeners: [
        defineListener(OrderPlaced, {
          name: 'send-receipt',
          mode: 'queued',
          handle: () => undefined,
        }),
      ],
      queue,
    });
    const publisher = createPublisher({
      events,
      queue,
      outbox: {
        // Deliberately not an `Error`: a driver may reject with a bare string, and the failure
        // report has to name it rather than print `[object Object]`.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        record: () => Promise.reject(reason),
        pending: () => Promise.resolve([]),
        markPublished: () => Promise.resolve(0),
        relay: () => Promise.resolve(0),
        size: () => Promise.resolve(0),
      },
    });

    const message = await publisher
      .record(OrderPlaced, { orderId: 'o-2' })
      .then(() => '')
      .catch((error: unknown) => (error as { message?: string }).message ?? '');
    expect(message).toContain('the connection went away');
  });

  test('pending(limit) is passed through, so a relay tick can bound its own batch', async () => {
    const { publisher, outbox } = publisherFor([
      defineListener(OrderPlaced, {
        name: 'send-receipt',
        mode: 'queued',
        handle: () => undefined,
      }),
    ]);
    await publisher.record(OrderPlaced, { orderId: 'o-1' });

    const seen: (number | undefined)[] = [];
    const spy: Outbox = {
      ...outbox,
      pending: (limit) => {
        seen.push(limit);
        return outbox.pending(limit);
      },
    };
    const bounded = createPublisher({
      events: createEvents({ listeners: [], queue: fakeQueue() }),
      outbox: spy,
      queue: fakeQueue(),
    });
    await bounded.pending(7);
    await bounded.pending();
    expect(seen).toEqual([7, undefined]);
  });

  test('an event nobody listens to records nothing', async () => {
    const { publisher, fake } = publisherFor([]);
    // `createEvents` with no listeners has no event names at all, so the publisher refuses it —
    // which is the honest answer: publishing into a registry that knows nothing is a typo.
    const error = await publisher
      .record(OrderPlaced, { orderId: 'o-6' })
      .then(() => undefined)
      .catch((caught: unknown) => caught as { code?: string });

    expect(error?.code).toBe('CAP_UNKNOWN_EVENT');
    expect(fake.statements).toEqual([]);
  });
});
