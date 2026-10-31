/**
 * The `cloudflare-queues` driver (`QUEUE-15`).
 *
 * The fake here is shaped like the platform rather than like the driver: a producer that
 * accepts `send`, and a `queue()` handler that is *pushed* a batch. That shape is the whole
 * reason this driver exists — Queues has no `receive`, so the port's `reserve` has to be fed
 * from an inbox the platform fills. A fake that let the driver pull would test nothing.
 *
 * What is asserted, and why each one is not obvious:
 *
 *   · **push → deliver → reserve is one message**, and `attempts` comes from the *platform's*
 *     count, so a retry is never counted twice;
 *   · **delay is translated to `delaySeconds`, and a delay past 12 h is refused** rather than
 *     clamped — a job that runs hours early is a bug nobody finds;
 *   · **retry maps to `retry({ delaySeconds })`**, and exhaustion acks *and* records: acking
 *     alone loses the message, retrying alone loops it;
 *   · **a body this driver did not write is acked and counted, never looped**;
 *   · **`transactional: false`** — which is what makes `requireOutbox` refuse it without one.
 */

import { describe, expect, test } from 'bun:test';

import {
  CLOUDFLARE_QUEUES_MAX_DELAY_SECONDS,
  cloudflareQueuesDriver,
  queueConsumer,
  type PushDrivenBackend,
  type QueueBatchLike,
  type QueueMessageLike,
} from './cloudflare-queues.ts';
import { conformanceCases } from '../conformance.ts';
import { createDeadLetterStore } from '../dead.ts';
import type { JobMessage } from '../port.ts';
import type { QueueSql, QueueSqlResult } from '../sql.ts';

/** A dead-letter table in memory, so the SQL statements are still exercised. */
function fakeSql() {
  const rows = new Map<string, Record<string, unknown>>();

  const sql: QueueSql = {
    capabilities: { engine: 'd1', placeholder: 'question' },
    query({ sql: text, params }): Promise<QueueSqlResult> {
      if (text.startsWith('INSERT INTO queue_dead')) {
        rows.set(String(params[0]), {
          id: params[0],
          name: params[1],
          payload: params[2],
          connection: params[3],
          attempts: params[4],
          max_attempts: params[5],
          available_at: params[6],
          created_at: params[7],
          last_error: params[8],
          idempotency_key: params[9],
        });
        return Promise.resolve({ rows: [], changes: 1 });
      }
      if (text.startsWith('SELECT * FROM queue_dead')) {
        return Promise.resolve({
          rows: [...rows.values()].slice(0, Number(params[0])),
          changes: 0,
        });
      }
      if (text.startsWith('DELETE FROM queue_dead WHERE id')) {
        const had = rows.delete(String(params[0]));
        return Promise.resolve({ rows: had ? [{ id: params[0] }] : [], changes: had ? 1 : 0 });
      }
      if (text.startsWith('DELETE FROM queue_dead')) {
        rows.clear();
        return Promise.resolve({ rows: [], changes: 1 });
      }
      throw new Error(`fake QueueSql does not understand: ${text}`);
    },
  };

  return { sql, rows };
}

/** The platform: a producer that records sends, and a batch builder that acks/retries. */
function fakePlatform(options: { readonly now?: () => number } = {}) {
  const sent: { body: unknown; delaySeconds?: number }[] = [];
  const settled: { id: string; action: 'ack' | 'retry'; delaySeconds?: number }[] = [];
  const now = options.now ?? ((): number => 1_000);

  const producer = {
    send(body: unknown, sendOptions?: { readonly delaySeconds?: number }): Promise<unknown> {
      sent.push({
        body,
        ...(sendOptions === undefined ? {} : { delaySeconds: sendOptions.delaySeconds }),
      });
      return Promise.resolve({});
    },
  };

  const batch = (bodies: readonly { body: unknown; attempts?: number }[]): QueueBatchLike => ({
    queue: 'jobs',
    messages: bodies.map((entry, index): QueueMessageLike => {
      const id = `p-${String(index)}`;
      return {
        id,
        body: entry.body,
        attempts: entry.attempts ?? 1,
        ack: () => settled.push({ id, action: 'ack' }),
        retry: (retryOptions) =>
          settled.push({
            id,
            action: 'retry',
            ...(retryOptions?.delaySeconds === undefined
              ? {}
              : { delaySeconds: retryOptions.delaySeconds }),
          }),
      };
    }),
  });

  return { producer, sent, settled, batch, now };
}

const message = (id: string, overrides: Partial<JobMessage> = {}): JobMessage => ({
  id,
  name: 'SendReceipt',
  payload: '{"orderId":"o-1"}',
  connection: 'jobs',
  attempts: 0,
  maxAttempts: 3,
  availableAt: 1_000,
  createdAt: 1_000,
  ...overrides,
});

function setup(withDead: boolean, now: () => number = () => 1_000) {
  const platform = fakePlatform({ now });
  const dead = fakeSql();
  const driver = cloudflareQueuesDriver({
    producer: platform.producer,
    ...(withDead ? { sql: dead.sql } : {}),
    now,
  });
  return { platform, dead, driver, backend: driver.open() as PushDrivenBackend };
}

describe('the cloudflare-queues driver', () => {
  test('its capabilities are the platform’s, honestly', () => {
    const { driver } = setup(true);

    expect(driver.name).toBe('cloudflare-queues');
    // The outbox exists because of this one flag (§ 4.2, ADR-0016 § 1.5).
    expect(driver.capabilities.transactional).toBe(false);
    expect(driver.capabilities.delay).toBe(true);
    // Queues cannot delete a message that is in flight, and it does not promise order.
    expect(driver.capabilities.cancel).toBe(false);
    expect(driver.capabilities.ordered).toBe(false);
    expect(driver.capabilities.deadLetter).toBe(true);
  });

  test('without a dead-letter store the capability says so instead of pretending', () => {
    const { driver, backend } = setup(false);
    expect(driver.capabilities.deadLetter).toBe(false);
    expect(backend.capabilities.deadLetter).toBe(false);
  });

  test('push sends a platform body, and deliver → reserve is one message', async () => {
    const { platform, backend } = setup(true);

    await backend.push(message('j-1'));
    expect(platform.sent).toHaveLength(1);
    // Nothing to reserve until the platform delivers: this driver is push-driven.
    expect(
      await backend.reserve({ connection: 'jobs', limit: 10, now: 1_000, leaseMs: 30_000 }),
    ).toEqual([]);

    const delivered = await backend.deliver(
      platform.batch([{ body: platform.sent[0]?.body, attempts: 1 }]),
    );
    expect(delivered).toEqual({ accepted: 1, rejected: 0 });

    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 10,
      now: 1_000,
      leaseMs: 30_000,
    });
    expect(reserved?.id).toBe('j-1');
    expect(reserved?.payload).toBe('{"orderId":"o-1"}');
    // The platform counted this delivery; the worker trusts it rather than adding one.
    expect(reserved?.attempts).toBe(1);

    // Reserved means handed out once: a second reserve in the same batch sees nothing.
    expect(
      await backend.reserve({ connection: 'jobs', limit: 10, now: 1_000, leaseMs: 30_000 }),
    ).toEqual([]);
  });

  test('completing a message acks it on the platform', async () => {
    const { platform, backend } = setup(true);
    await backend.push(message('j-1'));
    await backend.deliver(platform.batch([{ body: platform.sent[0]?.body }]));

    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 1_000,
    });
    expect(reserved).toBeDefined();
    await backend.complete(reserved!);

    expect(platform.settled).toEqual([{ id: 'p-0', action: 'ack' }]);
  });

  test('a retry becomes retry({ delaySeconds }), computed from the retryAt the worker chose', async () => {
    const { platform, backend } = setup(true);
    await backend.push(message('j-1'));
    await backend.deliver(platform.batch([{ body: platform.sent[0]?.body }]));
    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 1_000,
    });

    // The worker owns the backoff; the driver only translates it into the platform's unit.
    await backend.fail(reserved!, { error: 'boom', retryAt: 9_500 });

    expect(platform.settled).toEqual([{ id: 'p-0', action: 'retry', delaySeconds: 9 }]);
  });

  test('an exhausted message is acked and recorded in the dead-letter table', async () => {
    const { platform, backend, dead } = setup(true);
    await backend.push(message('j-1'));
    await backend.deliver(platform.batch([{ body: platform.sent[0]?.body, attempts: 3 }]));
    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 1_000,
    });

    await backend.fail(reserved!, { error: 'gave up' });

    // Acked, so the platform stops redelivering…
    expect(platform.settled).toEqual([{ id: 'p-0', action: 'ack' }]);
    // …and recorded, so it is not simply gone.
    expect(dead.rows.size).toBe(1);
    const listed = await backend.dead(10);
    expect(listed[0]?.id).toBe('j-1');
    expect(listed[0]?.lastError).toBe('gave up');
  });

  test('replay puts a dead message back on the platform queue and clears the record', async () => {
    const { platform, backend, dead } = setup(true);
    await backend.push(message('j-1'));
    await backend.deliver(platform.batch([{ body: platform.sent[0]?.body }]));
    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 1_000,
    });
    await backend.fail(reserved!, { error: 'nope' });

    expect(platform.sent).toHaveLength(1);
    expect(await backend.replay('j-1', 5_000)).toBe(true);

    // It went back through `push`, which is the same path a fresh dispatch takes.
    expect(platform.sent).toHaveLength(2);
    expect(dead.rows.size).toBe(0);
    expect(await backend.replay('j-1', 5_000)).toBe(false);
  });

  test('discard removes a dead letter, and reports whether it removed one', async () => {
    const { platform, backend } = setup(true);
    await backend.push(message('j-1'));
    await backend.deliver(platform.batch([{ body: platform.sent[0]?.body }]));
    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 1_000,
    });
    await backend.fail(reserved!, { error: 'gone' });

    expect(await backend.discard('j-1')).toBe(true);
    expect(await backend.discard('j-1')).toBe(false);
    // Without a store there is nothing to discard, and the answer is `false`, not a throw.
    const bare = setup(false);
    expect(await bare.backend.discard('anything')).toBe(false);
  });

  test('a delay travels as delaySeconds, and past 12 h it is refused, not clamped', async () => {
    const { platform, backend } = setup(true, () => 1_000);

    await backend.push(message('j-later', { availableAt: 1_000 + 30_000 }));
    expect(platform.sent[0]?.delaySeconds).toBe(30);

    // The platform's ceiling. A job that runs hours early is a bug nobody can reproduce.
    expect(
      backend.push(
        message('j-days', {
          availableAt: 1_000 + (CLOUDFLARE_QUEUES_MAX_DELAY_SECONDS + 1) * 1_000,
        }),
      ),
    ).rejects.toThrow(/maximum is 43200 s/u);
  });

  test('the queue is the address: a delivered message is this worker’s work', async () => {
    const { platform, backend } = setup(true);
    await backend.deliver(platform.batch([{ body: message('j-other', { connection: 'heavy' }) }]));

    // Filtering by the payload's connection would strand this message — accepted by the
    // platform, never run, and invisible except as a queue that never drains.
    const claimed = await backend.reserve({
      connection: 'jobs',
      limit: 10,
      now: 1_000,
      leaseMs: 1_000,
    });
    expect(claimed.map((entry) => entry.id)).toEqual(['j-other']);
  });

  test('a body this driver did not write is acked and counted, never looped', async () => {
    const { platform, backend } = setup(true);

    const delivered = await backend.deliver(platform.batch([{ body: { hello: 'world' } }]));

    expect(delivered).toEqual({ accepted: 0, rejected: 1 });
    // Acked: retrying a body nobody can parse is a queue-wide outage, not one bad job.
    expect(platform.settled).toEqual([{ id: 'p-0', action: 'ack' }]);
    expect(
      await backend.reserve({ connection: 'jobs', limit: 10, now: 1_000, leaseMs: 1_000 }),
    ).toEqual([]);
  });

  test('size is 0 by design: the messages in flight are the platform’s, not ours', async () => {
    const { backend } = setup(true);
    await backend.push(message('j-1'));
    expect(await backend.size()).toBe(0);
  });

  test('purge clears the inbox and the dead-letter store', async () => {
    const { platform, backend, dead } = setup(true);
    await backend.deliver(
      platform.batch([{ body: platform.batch.length === 0 ? message('x') : message('x') }]),
    );
    await dead.sql.query({
      sql: 'INSERT INTO queue_dead (id) VALUES (?)',
      params: ['manual'],
    });

    await backend.purge();
    expect(dead.rows.size).toBe(0);
    expect(
      await backend.reserve({ connection: 'jobs', limit: 10, now: 1_000, leaseMs: 1_000 }),
    ).toEqual([]);
  });

  test('the consumer helper delivers and drains in one call', async () => {
    const { platform, backend } = setup(true);
    let drained = 0;
    const consume = queueConsumer({ backend, drain: () => Promise.resolve((drained += 1)) });

    await consume(platform.batch([{ body: message('j-1') }]));

    // The invocation does not return until its own batch is settled — a crash mid-batch is the
    // platform's redelivery, not a message dying with the isolate.
    expect(drained).toBe(1);
    expect(
      await backend.reserve({ connection: 'jobs', limit: 10, now: 1_000, leaseMs: 1_000 }),
    ).toHaveLength(1);
  });
});

describe('the shared dead-letter store', () => {
  test('a row this store wrote is a row it can list, byte for byte', async () => {
    const fake = fakeSql();
    const store = createDeadLetterStore({ sql: fake.sql });

    await store.record(message('j-1', { lastError: 'boom', idempotencyKey: 'order-42' }));
    const [listed] = await store.list(10);

    expect(listed?.id).toBe('j-1');
    expect(listed?.lastError).toBe('boom');
    expect(listed?.idempotencyKey).toBe('order-42');
    expect(listed?.maxAttempts).toBe(3);
    expect(await store.remove('j-1')).toBe(true);
    expect(await store.remove('j-1')).toBe(false);
  });

  test('Postgres placeholders are used when the engine asks for them', async () => {
    const statements: string[] = [];
    const sql: QueueSql = {
      capabilities: { engine: 'postgres', placeholder: 'dollar' },
      query({ sql: text }: { sql: string; params: readonly unknown[] }): Promise<QueueSqlResult> {
        statements.push(text);
        return Promise.resolve({ rows: [], changes: 0 });
      },
    };

    await createDeadLetterStore({ sql }).record(message('j-1'));
    expect(statements[0]).toContain('$1');
    expect(statements[0]).not.toContain('?');
  });
});

describe('the cloudflare-queues driver against the conformance kit', () => {
  /**
   * `behaviour: 'platform'` because the lease belongs to Cloudflare, not to this driver: the kit
   * proves what the port owns (delivery, acknowledgement, dead letters) and skips the platform's
   * own clock, which the cases above cover against the fake.
   *
   * Each case gets a **fresh** platform and backend, because `flush` is stateful: it is "the
   * platform just delivered what you sent", and a shared one would leak messages between cases.
   */
  function kitFor(): readonly ReturnType<typeof conformanceCases>[number][] {
    const platform = fakePlatform({ now: () => 1_000_000 });

    return conformanceCases({
      driver: cloudflareQueuesDriver({ producer: platform.producer, now: () => 1_000_000 }),
      behaviour: 'platform',
      // The backend is the one the *case* opened — the kit opens a fresh one per case, and a
      // flush closed over a different instance would fill an inbox nobody reads.
      flush: async (backend) => {
        const bodies = platform.sent.splice(0).map((entry) => ({ body: entry.body, attempts: 1 }));
        if (bodies.length > 0) await (backend as PushDrivenBackend).deliver(platform.batch(bodies));
      },
    });
  }

  const names = kitFor().map((entry) => entry.name);

  for (const name of names) {
    test(name, async () => {
      const [fresh] = kitFor().filter((entry) => entry.name === name);
      expect(fresh).toBeDefined();
      await fresh!.run();
    });
  }

  test('the kit ran', () => {
    expect(names.length).toBeGreaterThan(2);
  });
});
