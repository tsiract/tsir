/**
 * The `memory` queue driver against the conformance kit (`CAP-005`).
 *
 * `memory` is a broker in the kit's sense — it owns the store *and* the lease — so it runs every
 * case, including the ones the platform drivers skip. That matters more than it sounds: this is
 * the driver every other test in the repo runs on, so a defect here makes the whole suite
 * confidently wrong.
 */

import { describe, expect, test } from 'bun:test';

import { conformanceCases } from '../conformance.ts';
import { memoryQueueDriver } from './memory.ts';

describe('memory queue driver', () => {
  test('the conformance kit passes', async () => {
    const driver = memoryQueueDriver({ now: () => 0 });

    for (const conformanceCase of conformanceCases({ driver, connection: 'default' })) {
      await conformanceCase.run();
    }
  });

  test('a message is addressed: it is only reservable on its own connection', async () => {
    // The opposite of the broker rule (`cloudflare-queues`), and deliberately so: two connections
    // share one store here, so `connection` is what keeps one worker from running another's job.
    const backend = memoryQueueDriver({ now: () => 0 }).open();

    await backend.push({
      id: 'j-1',
      name: 'report',
      payload: '{}',
      connection: 'heavy',
      attempts: 0,
      maxAttempts: 3,
      availableAt: 0,
      createdAt: 0,
    });

    // `reserve` takes the clock from the caller — the same discipline every driver here keeps,
    // so a lease is testable without sleeping.
    const ask = { limit: 10, now: 0, leaseMs: 1_000 };

    expect(await backend.reserve({ ...ask, connection: 'default' })).toEqual([]);
    expect((await backend.reserve({ ...ask, connection: 'heavy' })).map((m) => m.id)).toEqual([
      'j-1',
    ]);
    // Not a production default: the queue dies with the process.
    expect(backend.capabilities.persistent).toBe(false);
  });
});
