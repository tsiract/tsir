/**
 * The `sqs` driver (`QUEUE-16`).
 *
 * No AWS account, no `@aws-sdk` dependency: the driver takes an app-supplied client
 * (ADR-0027 § 1) holding four calls, and the fake below is those four calls with a small
 * model of a queue behind them. What that model deliberately includes, because the driver's
 * correctness depends on it:
 *
 *   · `receiveMessage` makes a message invisible for `VisibilityTimeout` — the lease;
 *   · `changeMessageVisibility` re-hides it, which is how the driver schedules a retry;
 *   · `ApproximateReceiveCount` is a **string**, and it is the attempt number;
 *   · `DelaySeconds` is capped at 900 and **refused entirely on FIFO queues**.
 *
 * The FIFO case is the one worth the test: a driver that reported `delay: true` on a FIFO
 * queue would deliver a "delayed" dispatch immediately, and the caller would find out days
 * later from a duplicate email.
 */

import { describe, expect, test } from 'bun:test';

import {
  SQS_MAX_DELAY_SECONDS,
  sqsClientOf,
  sqsDriver,
  type SqsLike,
  type SqsMessageLike,
  type SqsReceiveInput,
  type SqsSendInput,
} from './sqs.ts';
import { conformanceCases } from '../conformance.ts';
import type { JobMessage } from '../port.ts';
import type { QueueSql, QueueSqlResult } from '../sql.ts';

interface Held {
  readonly id: string;
  body: string;
  receiveCount: number;
  visibleAt: number;
  receipt: string;
}

function fakeSqs(now: () => number = () => 1_000) {
  const queue = new Map<string, Held>();
  const calls: string[] = [];
  const deleted: string[] = [];
  let sequence = 0;

  const client: SqsLike = {
    sendMessage(input: SqsSendInput): Promise<{ MessageId: string }> {
      calls.push(`send:${String(input.DelaySeconds ?? 0)}`);
      sequence += 1;
      const id = `s-${String(sequence)}`;
      queue.set(id, {
        id,
        body: input.MessageBody,
        receiveCount: 0,
        visibleAt: now() + (input.DelaySeconds ?? 0) * 1_000,
        receipt: `r-${String(sequence)}`,
      });
      return Promise.resolve({ MessageId: id });
    },

    receiveMessage(input: SqsReceiveInput): Promise<{ Messages: readonly SqsMessageLike[] }> {
      calls.push(`receive:${String(input.MaxNumberOfMessages ?? 0)}`);
      const visible = [...queue.values()]
        .filter((held) => held.visibleAt <= now())
        .slice(0, input.MaxNumberOfMessages ?? 1);

      const messages = visible.map((held): SqsMessageLike => {
        held.receiveCount += 1;
        held.visibleAt = now() + (input.VisibilityTimeout ?? 30) * 1_000;
        return {
          MessageId: held.id,
          Body: held.body,
          ReceiptHandle: held.receipt,
          Attributes: { ApproximateReceiveCount: String(held.receiveCount) },
        };
      });
      return Promise.resolve({ Messages: messages });
    },

    deleteMessage(input: { ReceiptHandle: string }): Promise<unknown> {
      calls.push('delete');
      deleted.push(input.ReceiptHandle);
      for (const [id, held] of queue) if (held.receipt === input.ReceiptHandle) queue.delete(id);
      return Promise.resolve({});
    },

    changeMessageVisibility(input: {
      ReceiptHandle: string;
      VisibilityTimeout: number;
    }): Promise<unknown> {
      calls.push(`visibility:${String(input.VisibilityTimeout)}`);
      for (const held of queue.values()) {
        if (held.receipt === input.ReceiptHandle)
          held.visibleAt = now() + input.VisibilityTimeout * 1_000;
      }
      return Promise.resolve({});
    },
  };

  return { client, queue, calls, deleted, now };
}

function fakeSql() {
  const rows = new Map<string, Record<string, unknown>>();
  const sql: QueueSql = {
    capabilities: { engine: 'postgres', placeholder: 'dollar' },
    query({ sql: text, params }): Promise<QueueSqlResult> {
      if (text.startsWith('INSERT INTO queue_dead')) {
        rows.set(String(params[0]), { id: params[0], last_error: params[8], payload: params[2] });
        return Promise.resolve({ rows: [], changes: 1 });
      }
      if (text.startsWith('SELECT * FROM queue_dead')) {
        return Promise.resolve({
          rows: [...rows.values()].map((row) => ({
            id: row.id,
            name: 'SendReceipt',
            payload: row.payload,
            connection: 'jobs',
            attempts: 1,
            max_attempts: 3,
            available_at: 1_000,
            created_at: 1_000,
            last_error: row.last_error,
          })),
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

/** One clock for the fake queue and the driver, so "at 6 000 ms" means the same to both. */
function setup(options: { fifo?: boolean; dead?: boolean } = {}) {
  let clock = 1_000;
  const now = (): number => clock;
  const fake = fakeSqs(now);
  const dead = fakeSql();
  const driver = sqsDriver({
    client: fake.client,
    queueUrl: 'https://sqs.eu-west-1.amazonaws.com/0/jobs',
    ...(options.fifo === undefined ? {} : { fifo: options.fifo }),
    ...(options.dead === true ? { sql: dead.sql } : {}),
    now,
  });
  /** Move time forward: nothing here sleeps. */
  const at = (ms: number): void => {
    clock = ms;
  };
  return { fake, dead, driver, backend: driver.open(), at };
}

describe('the sqs driver', () => {
  test('a standard queue: at-least-once, delayed, not ordered, not transactional', () => {
    const { driver } = setup({ dead: true });

    expect(driver.name).toBe('sqs');
    expect(driver.capabilities.transactional).toBe(false);
    expect(driver.capabilities.delay).toBe(true);
    expect(driver.capabilities.ordered).toBe(false);
    expect(driver.capabilities.cancel).toBe(false);
    expect(driver.capabilities.deadLetter).toBe(true);
  });

  test('a FIFO queue keeps order and admits it cannot delay', () => {
    const { driver } = setup({ fifo: true });

    expect(driver.capabilities.ordered).toBe(true);
    // SQS rejects `DelaySeconds` on FIFO queues. Claiming otherwise would deliver a "delayed"
    // dispatch immediately, and the caller would learn about it from a duplicate receipt.
    expect(driver.capabilities.delay).toBe(false);
  });

  test('without a dead-letter store the capability says so', () => {
    expect(setup().driver.capabilities.deadLetter).toBe(false);
  });

  test('push → reserve → complete is one round trip', async () => {
    const { fake, backend } = setup();

    await backend.push(message('j-1'));
    expect(fake.calls[0]).toBe('send:0');

    const reserved = await backend.reserve({
      connection: 'jobs',
      limit: 5,
      now: 1_000,
      leaseMs: 30_000,
    });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.id).toBe('j-1');
    // `ApproximateReceiveCount` is a string and it is the attempt number.
    expect(reserved[0]?.attempts).toBe(1);

    await backend.complete(reserved[0]!);
    expect(fake.deleted).toEqual(['r-1']);
    expect(fake.queue.size).toBe(0);
  });

  test('a failed message becomes invisible for exactly the retry delay', async () => {
    const { fake, backend, at } = setup();
    await backend.push(message('j-1'));
    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 30_000,
    });

    // The worker chose 5 s; the driver re-hides the message for 5 s rather than deleting it.
    await backend.fail(reserved!, { error: 'boom', retryAt: 6_000 });
    expect(fake.calls).toContain('visibility:5');

    // Still invisible at 5 999 ms, visible at 6 000 — the delay is the platform's, not a timer
    // this process has to keep alive.
    at(5_999);
    expect(
      await backend.reserve({ connection: 'jobs', limit: 1, now: 5_999, leaseMs: 30_000 }),
    ).toEqual([]);
    at(6_000);
    const again = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 6_000,
      leaseMs: 30_000,
    });
    expect(again[0]?.attempts).toBe(2);
  });

  test('exhaustion deletes from the queue and records the dead letter', async () => {
    const { fake, backend, dead } = setup({ dead: true });
    await backend.push(message('j-1'));
    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 30_000,
    });

    await backend.fail(reserved!, { error: 'spent' });

    // Deleted, not re-hidden at 0: `ChangeMessageVisibility(0)` would put it straight back
    // into this consumer's next poll — a spin, not a retry.
    expect(fake.deleted).toEqual(['r-1']);
    expect(dead.rows.size).toBe(1);

    const listed = await backend.dead(10);
    expect(listed[0]?.id).toBe('j-1');
    expect(listed[0]?.lastError).toBe('spent');
  });

  test('replay re-sends and clears the record; discard removes it', async () => {
    const { fake, backend } = setup({ dead: true });
    await backend.push(message('j-1'));
    const [reserved] = await backend.reserve({
      connection: 'jobs',
      limit: 1,
      now: 1_000,
      leaseMs: 30_000,
    });
    await backend.fail(reserved!, { error: 'nope' });

    expect(await backend.replay('j-1', 2_000)).toBe(true);
    expect(fake.calls.filter((call) => call.startsWith('send:'))).toHaveLength(2);
    expect(await backend.dead(10)).toEqual([]);
    expect(await backend.replay('j-1', 2_000)).toBe(false);

    expect(await backend.discard('nothing')).toBe(false);
  });

  test('a delay becomes DelaySeconds, and past 15 minutes it is refused', async () => {
    const { fake, backend } = setup();

    await backend.push(message('j-soon', { availableAt: 1_000 + 60_000 }));
    expect(fake.calls[0]).toBe('send:60');

    expect(
      backend.push(message('j-far', { availableAt: 1_000 + (SQS_MAX_DELAY_SECONDS + 1) * 1_000 })),
    ).rejects.toThrow(/maximum is 900 s/u);
  });

  test('a FIFO connection refuses a delayed dispatch instead of sending it now', async () => {
    const { fake, backend } = setup({ fifo: true });

    expect(backend.push(message('j-later', { availableAt: 1_000 + 5_000 }))).rejects.toThrow(
      /FIFO/u,
    );
    // Nothing was sent: a "delayed" message that arrives immediately is the bug this refuses.
    expect(fake.calls).toEqual([]);

    // An undelayed dispatch on FIFO is fine, and carries the group id SQS demands.
    await backend.push(message('j-now'));
    expect(fake.calls[0]).toBe('send:0');
  });

  test('a body that is not one of ours is deleted rather than redelivered forever', async () => {
    const { fake, backend } = setup();
    fake.queue.set('foreign', {
      id: 'foreign',
      body: 'not json',
      receiveCount: 0,
      visibleAt: 0,
      receipt: 'r-foreign',
    });

    const reserved = await backend.reserve({
      connection: 'jobs',
      limit: 5,
      now: 1_000,
      leaseMs: 30_000,
    });
    expect(reserved).toEqual([]);
    expect(fake.deleted).toEqual(['r-foreign']);
  });

  test('a message for another connection is still claimed: the queue URL is the address', async () => {
    const { backend } = setup();
    await backend.push(message('j-other', { connection: 'heavy' }));

    const claimed = await backend.reserve({
      connection: 'jobs',
      limit: 5,
      now: 1_000,
      leaseMs: 30_000,
    });
    // Which queue a message is in *is* its connection; refusing it here would strand it.
    expect(claimed.map((entry) => entry.id)).toEqual(['j-other']);
  });

  test('size is 0 by design and purge clears the local bookkeeping', async () => {
    const { backend } = setup({ dead: true });
    await backend.push(message('j-1'));
    expect(await backend.size()).toBe(0);
    await backend.purge();
    expect(await backend.dead(10)).toEqual([]);
  });

  test('sqsClientOf adapts an SDK-shaped client without this package importing it', async () => {
    const sent: unknown[] = [];
    class SendMessageCommand {
      constructor(readonly input: SqsSendInput) {}
    }
    class ReceiveMessageCommand {
      constructor(readonly input: SqsReceiveInput) {}
    }
    class DeleteMessageCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    class ChangeMessageVisibilityCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }

    const client = sqsClientOf(
      {
        send: (command: unknown) => {
          sent.push(command);
          return Promise.resolve({
            Messages: [{ MessageId: 'x', Body: '{}', ReceiptHandle: 'r' }],
          });
        },
      },
      {
        SendMessageCommand,
        ReceiveMessageCommand,
        DeleteMessageCommand,
        ChangeMessageVisibilityCommand,
      },
    );

    await client.sendMessage({ QueueUrl: 'u', MessageBody: '{}' });
    const received = await client.receiveMessage({ QueueUrl: 'u' });
    // The unwrapping is the adapter's job: callers get `Messages`, not `{ Messages, $metadata }`.
    expect(received.Messages).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(SendMessageCommand);
  });
});

describe('the sqs driver against the conformance kit', () => {
  // Same reasoning as Queues: the visibility timeout is the platform's lease, so the kit runs
  // in `'platform'` mode and skips the expiry cases the driver's own tests cover.
  for (const entry of conformanceCases({
    driver: sqsDriver({
      client: fakeSqs(() => 1_000_000).client,
      queueUrl: 'https://sqs.eu-west-1.amazonaws.com/0/jobs',
      now: () => 1_000_000,
    }),
    behaviour: 'platform',
  })) {
    test(entry.name, () => entry.run());
  }
});
