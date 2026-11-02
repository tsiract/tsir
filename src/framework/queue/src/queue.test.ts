/**
 * The queue port, the worker, and the contract between them (`§ 4.2`).
 *
 * The reliability features Gate P7 names are the tests here, in order:
 *
 *   · **retries with backoff** — asserted on the exact delay the driver was told to use,
 *     through an injected clock, so nothing sleeps;
 *   · **dead letters with a replay** — a job that exhausts its attempts lands in a store
 *     `queue:retry` can read, and replaying it resets the budget;
 *   · **idempotency keys** — two dispatches with one key deliver once;
 *   · **graceful drain** — a stop stops reserving, waits for in-flight work, then reports what
 *     it abandoned rather than claiming a clean shutdown it did not have.
 */

import { describe, expect, test } from 'bun:test';

import { describeSchedule, retryDelayMs, retrySchedule } from './backoff.ts';
import { createJobRegistry, defineJob } from './job.ts';
import { memoryQueueDriver } from './drivers/memory.ts';
import { syncQueueDriver } from './drivers/sync.ts';
import { createQueue } from './queue.ts';
import { createWorker } from './worker.ts';
import type { JobMessage } from './port.ts';

/** A clock the test owns: retries become assertions, not sleeps. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

function setup(options: { readonly maxAttempts?: number } = {}) {
  const time = clock();
  let ids = 0;
  const ran: string[] = [];
  const failures = new Map<string, number>();

  const job = defineJob<{ id: string }>({
    name: 'SendReceipt',
    maxAttempts: options.maxAttempts ?? 3,
    backoff: { baseMs: 100, factor: 2, maxMs: 10_000, jitter: 0 },
    timeoutMs: 1_000,
    handle({ payload }) {
      ran.push(payload.id);
      const count = (failures.get(payload.id) ?? 0) + 1;
      failures.set(payload.id, count);
      if (count <= (failures.get(`fail:${payload.id}`) ?? 0))
        throw new Error(`attempt ${count} failed`);
    },
  });

  const failing = defineJob<{ id: string; times: number }>({
    name: 'Flaky',
    maxAttempts: options.maxAttempts ?? 3,
    backoff: { baseMs: 100, factor: 2, maxMs: 10_000, jitter: 0 },
    timeoutMs: 1_000,
    handle({ payload }) {
      const attempt = (failures.get(payload.id) ?? 0) + 1;
      failures.set(payload.id, attempt);
      if (attempt <= payload.times) throw new Error(`attempt ${attempt} failed`);
      ran.push(payload.id);
    },
  });

  const registry = createJobRegistry([job, failing]);
  const backend = memoryQueueDriver({ now: time.now }).open();
  const queue = createQueue({
    connection: 'default',
    backend,
    jobs: registry,
    connections: ['default'],
    now: time.now,
    newId: () => `msg-${String(++ids)}`,
  });

  const worker = createWorker({
    connection: 'default',
    backend,
    jobs: registry,
    now: time.now,
    backoff: { jitter: 0 },
    sleep: () => Promise.resolve(),
  });

  return { time, queue, worker, backend, ran, failures, registry, Flaky: failing };
}

describe('dispatching', () => {
  test('a dispatch writes one message with the job’s own policy', async () => {
    const { queue, backend } = setup();

    const result = await queue.dispatch({ name: 'SendReceipt' }, { id: 'o-1' });

    expect(result.accepted).toBe(true);
    expect(result.id).toBe('msg-1');
    expect(result.connection).toBe('default');
    expect(await backend.size()).toBe(1);
  });

  test('an unregistered job is refused at dispatch, not at run time', async () => {
    const { queue, backend } = setup();

    // `dispatch` is async, so the refusal arrives as a rejection — still *before* anything is
    // stored, which is the property that matters.
    const attempt = queue.dispatch({ name: 'SendReciept' }, { id: 'o-1' });

    expect(attempt).rejects.toThrow(
      /unknown job "SendReciept" \(registered: SendReceipt, Flaky\)/u,
    );
    expect(attempt).rejects.toMatchObject({ code: 'CAP_UNKNOWN_JOB' });
    expect(await backend.size()).toBe(0);
  });

  test('an undeclared connection never falls back to the default', async () => {
    const { queue, backend } = setup();

    expect(
      queue.dispatch({ name: 'SendReceipt' }, { id: 'o-1' }, { connection: 'heavy' }),
    ).rejects.toThrow(/unknown queue connection "heavy"/u);
    expect(await backend.size()).toBe(0);
  });

  test('an idempotency key makes the second dispatch a no-op', async () => {
    const { queue, backend } = setup();

    await queue.dispatch({ name: 'SendReceipt' }, { id: 'o-1' }, { idempotencyKey: 'receipt:o-1' });
    await queue.dispatch({ name: 'SendReceipt' }, { id: 'o-1' }, { idempotencyKey: 'receipt:o-1' });

    expect(await backend.size()).toBe(1);
  });

  test('a requestId travels from dispatch into the job context', async () => {
    const time = clock();
    let ids = 0;
    let capturedRequestId: string | undefined;

    const job = defineJob<{ id: string }>({
      name: 'SendReceipt',
      handle(ctx) {
        capturedRequestId = ctx.requestId;
      },
    });
    const registry = createJobRegistry([job]);
    const backend = memoryQueueDriver({ now: time.now }).open();
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default'],
      now: time.now,
      newId: () => `msg-${String(++ids)}`,
    });
    const worker = createWorker({
      connection: 'default',
      backend,
      jobs: registry,
      now: time.now,
      sleep: () => Promise.resolve(),
    });

    await queue.dispatch({ name: 'SendReceipt' }, { id: 'o-1' }, { requestId: 'req-abc-123' });
    await worker.drainOnce();

    expect(capturedRequestId).toBe('req-abc-123');
  });

  test('a message without a requestId has an undefined requestId on the context', async () => {
    const time = clock();
    let ids = 0;
    let capturedRequestId: string | undefined = 'unset';
    const job = defineJob<{ id: string }>({
      name: 'NoRequestId',
      handle(ctx) {
        capturedRequestId = ctx.requestId;
      },
    });
    const registry = createJobRegistry([job]);
    const backend = memoryQueueDriver({ now: time.now }).open();
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default'],
      now: time.now,
      newId: () => `msg-${String(++ids)}`,
    });
    const worker = createWorker({
      connection: 'default',
      backend,
      jobs: registry,
      now: time.now,
      sleep: () => Promise.resolve(),
    });

    await queue.dispatch({ name: 'NoRequestId' }, { id: 'o-1' });
    await worker.drainOnce();

    expect(capturedRequestId).toBeUndefined();
  });

  test('dispatchLater stores it for later instead of running it now', async () => {
    const { queue, worker, time, ran } = setup();

    await queue.dispatchLater({ name: 'SendReceipt' }, { id: 'o-1' }, { delayMs: 5_000 });

    expect(await worker.drainOnce()).toEqual([]);
    time.advance(5_000);
    const [result] = await worker.drainOnce();
    expect(result?.outcome).toBe('completed');
    expect(ran).toEqual(['o-1']);
  });
});

describe('retries and the dead-letter store', () => {
  test('a failure is rescheduled at the backoff delay, and the clock is the only thing that moves', async () => {
    const { queue, worker, time, backend, Flaky } = setup({ maxAttempts: 3 });

    await queue.dispatch(Flaky, { id: 'f-1', times: 1 });

    const [first] = await worker.drainOnce();
    expect(first?.outcome).toBe('retried');
    // `reserve` counted this attempt, so the worker reports 1 for the first run.
    expect(first?.attempt).toBe(1);

    // Still not due: the message sits with availableAt = now + 100 ms.
    expect(await worker.drainOnce()).toEqual([]);
    time.advance(99);
    expect(await worker.drainOnce()).toEqual([]);
    time.advance(1);

    const [second] = await worker.drainOnce();
    expect(second?.outcome).toBe('completed');
    expect(second?.attempt).toBe(2);
    expect(await backend.size()).toBe(0);
  });

  test('exhausted attempts land in the dead-letter store with the last error', async () => {
    const { queue, worker, time, backend, Flaky } = setup({ maxAttempts: 2 });

    await queue.dispatch(Flaky, { id: 'f-2', times: 99 });

    await worker.drainOnce();
    time.advance(100);
    const [result] = await worker.drainOnce();

    expect(result?.outcome).toBe('dead');
    expect(await backend.size()).toBe(0);

    const dead = await backend.dead(10);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.name).toBe('Flaky');
    expect(dead[0]?.attempts).toBe(2);
    expect(dead[0]?.lastError).toContain('attempt 2 failed');
  });

  test('replay puts it back with a fresh budget, and it can then succeed', async () => {
    const { queue, worker, time, backend, Flaky } = setup({ maxAttempts: 2 });

    await queue.dispatch(Flaky, { id: 'f-3', times: 2 });
    await worker.drainOnce();
    time.advance(100);
    await worker.drainOnce();

    const [dead] = await backend.dead(1);
    expect(dead).toBeDefined();
    expect(await queue.retry(dead?.id ?? '')).toBe(true);

    // `times: 2` means the third attempt succeeds — the budget reset is what makes it run.
    const [result] = await worker.drainOnce();
    expect(result?.outcome).toBe('completed');
    expect(result?.attempt).toBe(1);
  });

  test('`retryable: false` goes straight to the dead-letter store', async () => {
    const time = clock();
    let runs = 0;
    const charge = defineJob<{ id: string }>({
      name: 'ChargeCard',
      retryable: false,
      maxAttempts: 5,
      handle() {
        runs += 1;
        throw new Error('gateway timed out');
      },
    });

    const registry = createJobRegistry([charge]);
    const backend = memoryQueueDriver({ now: time.now }).open();
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default'],
      now: time.now,
    });
    const worker = createWorker({ connection: 'default', backend, jobs: registry, now: time.now });

    await queue.dispatch(charge, { id: 'c-1' });
    const [result] = await worker.drainOnce();

    expect(result?.outcome).toBe('dead');
    expect(runs).toBe(1);
    expect(await backend.dead(10)).toHaveLength(1);
  });

  test('a timeout is a failure, and the handler gets an aborted signal', async () => {
    const time = clock();
    let aborted = false;
    const slow = defineJob<Record<string, never>>({
      name: 'Slow',
      maxAttempts: 1,
      timeoutMs: 5,
      async handle({ signal }) {
        signal.addEventListener('abort', () => (aborted = true));
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    const registry = createJobRegistry([slow]);
    const backend = memoryQueueDriver().open();
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default'],
    });
    const worker = createWorker({ connection: 'default', backend, jobs: registry });

    await queue.dispatch(slow, {});
    const [result] = await worker.drainOnce();

    expect(result?.outcome).toBe('dead');
    expect(result?.error).toContain('exceeded 5 ms');
    expect(aborted).toBe(true);
    void time;
  });

  test('an unregistered job that somehow got into the queue is dead, not dropped', async () => {
    const time = clock();
    const registry = createJobRegistry([]);
    const backend = memoryQueueDriver({ now: time.now }).open();
    const worker = createWorker({ connection: 'default', backend, jobs: registry, now: time.now });

    // A message from an older deploy that no longer has this job.
    const message: JobMessage = {
      id: 'orphan',
      name: 'GoneJob',
      payload: '{}',
      connection: 'default',
      attempts: 0,
      maxAttempts: 1,
      availableAt: 0,
      createdAt: 0,
    };
    await backend.push(message);

    const [result] = await worker.drainOnce();
    expect(result?.outcome).toBe('dead');
    expect((await backend.dead(10))[0]?.lastError).toContain('unknown job');
  });
});

describe('the drain', () => {
  test('stop() drains in-flight work instead of killing it', async () => {
    const time = clock();
    let finished = 0;
    const job = defineJob<Record<string, never>>({
      name: 'Slowish',
      maxAttempts: 1,
      timeoutMs: 5_000,
      async handle() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished += 1;
      },
    });

    const registry = createJobRegistry([job]);
    const backend = memoryQueueDriver({ now: time.now }).open();
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default'],
      now: time.now,
    });
    const worker = createWorker({
      connection: 'default',
      backend,
      jobs: registry,
      now: time.now,
      shutdownTimeoutMs: 1_000,
      pollMs: 1,
    });

    await queue.dispatch(job, {});
    await queue.dispatch(job, {});

    const running = worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.stop();
    await running;

    expect(finished).toBeGreaterThan(0);
    expect(worker.running).toBe(false);
  });

  test('a worker with nothing to do returns an empty batch', async () => {
    const { worker } = setup();

    expect(await worker.drainOnce()).toEqual([]);
  });

  test('work that outlives the budget is abandoned, logged, and its signal aborted', async () => {
    const time = clock();
    const logs: string[] = [];
    let aborted = false;

    const job = defineJob<Record<string, never>>({
      name: 'Stuck',
      maxAttempts: 1,
      timeoutMs: 60_000,
      async handle({ signal }) {
        // Never finishes within the budget: the worker has to give up on it, not wait.
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    });

    const registry = createJobRegistry([job]);
    const backend = memoryQueueDriver({ now: time.now }).open();
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default'],
      now: time.now,
    });
    const worker = createWorker({
      connection: 'default',
      backend,
      jobs: registry,
      now: time.now,
      // No grace at all: the interesting branch is the one after the budget runs out.
      shutdownTimeoutMs: 0,
      pollMs: 1,
      log: (line) => logs.push(line),
    });

    await queue.dispatch(job, {});
    const running = worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.stop();
    await running;

    expect(aborted).toBe(true);
    expect(logs.join('\n')).toMatch(/draining/u);
    expect(logs.join('\n')).toMatch(/abandoned/u);
    expect(worker.running).toBe(false);
  });
});

describe('backoff', () => {
  test('exponential, capped, and `attempt 1` is the base delay', () => {
    expect(retryDelayMs(1, { jitter: 0 })).toBe(1_000);
    expect(retryDelayMs(2, { jitter: 0 })).toBe(2_000);
    expect(retryDelayMs(3, { jitter: 0 })).toBe(4_000);
    expect(retryDelayMs(20, { jitter: 0 })).toBe(300_000);
  });

  test('jitter stays inside the band, and is deterministic when injected', () => {
    expect(retryDelayMs(1, { jitter: 0.2, random: () => 0 })).toBe(800);
    // ±20 % of 1 000: `random() → 0.999` lands at the top of the band, 1 200 ms.
    expect(retryDelayMs(1, { jitter: 0.2, random: () => 0.999 })).toBe(1_200);
    expect(retryDelayMs(1, { jitter: 0.2, random: () => 0.5 })).toBe(1_000);
  });

  test('the schedule reads like a sentence', () => {
    expect(retrySchedule(4, { jitter: 0, baseMs: 1_000 })).toEqual([1_000, 2_000, 4_000]);
    expect(describeSchedule(4, { baseMs: 1_000 })).toBe('1 s · 2 s · 4 s');
  });
});

describe('the sync driver', () => {
  test('it runs the job inside dispatch', async () => {
    const ran: string[] = [];
    const job = defineJob<{ id: string }>({
      name: 'Inline',
      handle: ({ payload }) => {
        ran.push(payload.id);
      },
    });

    const registry = createJobRegistry([job]);
    const backend = syncQueueDriver({
      execute: async (message) => {
        const definition = registry.get(message.name);
        await definition?.handle({
          payload: JSON.parse(message.payload),
          attempt: message.attempts + 1,
          maxAttempts: message.maxAttempts,
          id: message.id,
          connection: message.connection,
          name: message.name,
          signal: new AbortController().signal,
          log: () => undefined,
        });
      },
    }).open();
    const queue = createQueue({
      connection: 'local',
      backend,
      jobs: registry,
      connections: ['local'],
    });

    await queue.dispatch(job, { id: 'x' });

    expect(ran).toEqual(['x']);
    // Nothing is stored: there is nothing for a worker to reserve.
    expect(await backend.size()).toBe(0);
  });

  test('a failure keeps retrying inline, then dead-letters', async () => {
    let attempts = 0;
    const job = defineJob<Record<string, never>>({
      name: 'AlwaysFails',
      maxAttempts: 3,
      handle: () => {
        attempts += 1;
        throw new Error('nope');
      },
    });

    const registry = createJobRegistry([job]);
    const backend = syncQueueDriver({
      execute: async () => {
        attempts += 1;
        throw new Error('nope');
      },
    }).open();
    const queue = createQueue({
      connection: 'local',
      backend,
      jobs: registry,
      connections: ['local'],
    });

    await queue.dispatch(job, {});

    expect(attempts).toBe(3);
    expect(await backend.dead(10)).toHaveLength(1);
  });

  test('a dead inline failure can be listed, replayed and discarded like a durable one', async () => {
    let fail = true;
    const job = defineJob<Record<string, never>>({
      name: 'Brittle',
      maxAttempts: 1,
      handle: () => {
        if (fail) throw new Error('not yet');
      },
    });

    const registry = createJobRegistry([job]);
    const backend = syncQueueDriver({
      execute: async () => {
        await job.handle({
          payload: {},
          attempt: 1,
          maxAttempts: 1,
          id: 'x',
          connection: 'local',
          name: 'Brittle',
          signal: new AbortController().signal,
          log: () => undefined,
        });
      },
    }).open();
    const queue = createQueue({
      connection: 'local',
      backend,
      jobs: registry,
      connections: ['local'],
    });
    const worker = createWorker({ connection: 'local', backend, jobs: registry, now: () => 1_000 });

    await queue.dispatch(job, {});
    const [dead] = await backend.dead(10);
    expect(dead?.lastError).toBe('not yet');
    // Nothing is stored, so the worker has nothing to drain — the dead letter is the only trace.
    expect(await worker.drainOnce()).toEqual([]);
    expect(await backend.size()).toBe(0);

    fail = false;
    expect(await backend.replay(dead?.id ?? '', 1_000)).toBe(true);
    // The replay ran the job inline and it succeeded, so the store is empty again.
    expect(await backend.dead(10)).toEqual([]);

    expect(await backend.discard('nothing')).toBe(false);
    await backend.purge();
    expect(await backend.dead(10)).toEqual([]);
  });
});

describe('the queue façade', () => {
  test('dispatchMany enqueues in order and reports one result per message', async () => {
    const { queue, backend } = setup();

    const results = await queue.dispatchMany([
      { job: { name: 'SendReceipt' }, payload: { id: 'a' } },
      { job: { name: 'SendReceipt' }, payload: { id: 'b' }, options: { delayMs: 500 } },
    ]);

    expect(results.map((result) => result.accepted)).toEqual([true, true]);
    expect(results.map((result) => result.id)).toEqual(['msg-1', 'msg-2']);
    expect(await backend.size()).toBe(2);
  });

  test('dispatchMany stops at the first refusal, naming the message that failed', async () => {
    const { queue, backend } = setup();

    const attempt = queue.dispatchMany([
      { job: { name: 'SendReceipt' }, payload: { id: 'a' } },
      { job: { name: 'Ghost' }, payload: {} },
      { job: { name: 'SendReceipt' }, payload: { id: 'c' } },
    ]);

    expect(attempt).rejects.toThrow(/unknown job "Ghost"/u);
    // The first one was accepted before the bad name was seen; the third never was. A partial
    // batch is the honest outcome — reporting "none were sent" would be a lie.
    expect(await backend.size()).toBe(1);
  });

  test('dispatchLater is a delayed dispatch, and a negative delay is refused', async () => {
    const { queue, backend } = setup();

    await queue.dispatchLater({ name: 'SendReceipt' }, { id: 'later' }, { delayMs: 5_000 });
    expect(await backend.size()).toBe(1);
    // Nothing is reservable before its time, so "later" means later.
    expect(
      await backend.reserve({ connection: 'default', limit: 10, now: 1_000, leaseMs: 1_000 }),
    ).toEqual([]);

    expect(
      queue.dispatchLater({ name: 'SendReceipt' }, { id: 'never' }, { delayMs: -1 }),
    ).rejects.toThrow(/delayMs must not be negative/u);
  });

  test('cancel removes a message that has not been reserved yet', async () => {
    const { queue, backend } = setup();

    const result = await queue.dispatch({ name: 'SendReceipt' }, { id: 'o-1' });
    expect(await backend.size()).toBe(1);
    expect(await queue.cancel(result.id)).toBe(true);
    expect(await backend.size()).toBe(0);
    // Idempotent in the only sense that matters: cancelling again says so, and does no harm.
    expect(await queue.cancel(result.id)).toBe(false);
  });

  test('dead, retry and discard are the dead-letter surface queue:retry uses', async () => {
    const { queue, backend, time, worker } = setup({ maxAttempts: 1 });

    // `Flaky` fails while its attempt number is below `times`; one attempt means it is spent.
    await queue.dispatch({ name: 'Flaky' }, { id: 'doomed', times: 5 });
    const [result] = await worker.drainOnce();
    expect(result?.outcome).toBe('dead');

    const dead = await queue.dead(10);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.id).toBe('msg-1');

    time.advance(1_000);
    expect(await queue.retry('msg-1')).toBe(true);
    expect(await queue.dead(10)).toEqual([]);
    expect(await backend.size()).toBe(1);

    // And discard really discards, live message or dead letter.
    expect(await queue.discard('msg-1')).toBe(true);
    expect(await backend.size()).toBe(0);
  });

  test('size and purge are the two numbers an operator asks for', async () => {
    const { queue, backend } = setup();

    await queue.dispatch({ name: 'SendReceipt' }, { id: 'a' });
    await queue.dispatch({ name: 'SendReceipt' }, { id: 'b' });
    expect(await queue.size()).toBe(2);

    await queue.purge();
    expect(await queue.size()).toBe(0);
    expect(await backend.dead(10)).toEqual([]);
  });

  test('a driver without cancel refuses rather than pretending', async () => {
    const job = defineJob<Record<string, never>>({ name: 'Inline', handle: async () => undefined });
    const registry = createJobRegistry([job]);
    const backend = syncQueueDriver({ execute: async () => undefined }).open();
    const queue = createQueue({
      connection: 'local',
      backend,
      jobs: registry,
      connections: ['local'],
    });

    expect(queue.cancel('anything')).rejects.toThrow(/does not support cancel/u);
  });

  test('a job that prefers another declared connection is refused by this instance, by name', async () => {
    const job = defineJob<Record<string, never>>({
      name: 'Heavy',
      connection: 'heavy',
      handle: async () => undefined,
    });
    const registry = createJobRegistry([job]);
    const backend = memoryQueueDriver().open();
    // Both names are declared, which is exactly the trap: the registry knows `heavy`, but this
    // queue instance speaks for one backend and must not silently dispatch to it.
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default', 'heavy'],
    });

    expect(queue.dispatch(job, {})).rejects.toThrow(
      /unknown queue connection "heavy" \(declared: default\)/u,
    );
    expect(await backend.size()).toBe(0);
  });

  test('a backend that refuses the push becomes CAP_DISPATCH_FAILED, with the backend’s reason', async () => {
    const registry = createJobRegistry([
      defineJob<Record<string, never>>({ name: 'Job', handle: async () => undefined }),
    ]);
    const real = memoryQueueDriver().open();
    const backend = {
      ...real,
      push: async () => {
        throw new Error('connection pool exhausted');
      },
    };
    const queue = createQueue({
      connection: 'default',
      backend,
      jobs: registry,
      connections: ['default'],
    });

    const attempt = queue.dispatch({ name: 'Job' }, {});
    expect(attempt).rejects.toThrow(
      /could not dispatch "Job" to connection "default": connection pool exhausted/u,
    );
    expect(attempt).rejects.toMatchObject({ code: 'CAP_DISPATCH_FAILED' });
  });

  test('a delayed dispatch on a driver without delay is refused, not delivered early', async () => {
    const job = defineJob<Record<string, never>>({ name: 'Inline', handle: async () => undefined });
    const registry = createJobRegistry([job]);
    let ran = 0;
    const backend = syncQueueDriver({
      execute: async () => {
        ran += 1;
      },
    }).open();
    const queue = createQueue({
      connection: 'local',
      backend,
      jobs: registry,
      connections: ['local'],
    });

    expect(queue.dispatchLater(job, {}, { delayMs: 1_000 })).rejects.toThrow(
      /does not support a delayed dispatch/u,
    );
    // The whole point: nothing ran. A "delay" that fires immediately is worse than a refusal.
    expect(ran).toBe(0);
  });

  test('the façade reports the driver and capabilities it is actually bound to', () => {
    const { queue } = setup();
    expect(queue.connection).toBe('default');
    expect(queue.driver).toBe('memory');
    expect(queue.capabilities.persistent).toBe(false);
  });
});
