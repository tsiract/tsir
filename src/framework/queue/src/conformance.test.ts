/**
 * The conformance kit, run against the drivers that need no database.
 *
 * The kit is public API (`@tsir/queue/conformance`), so it has to be proven before it is
 * published: a case that passes vacuously is worse than no case, because it tells a third-party
 * driver author their driver is fine. Two things are asserted here:
 *
 *   · every case passes for `memory` (a full broker) and `sync` (inline);
 *   · the kit **fails** a driver that breaks the contract — proven with deliberately broken
 *     backends below, which is the only way to know the cases have teeth.
 *
 * The `database` driver is run through the same kit from `drivers/database.test.ts`, where its
 * fake `QueueSql` already lives.
 */

import { describe, expect, test } from 'bun:test';

import { conformanceCases } from './conformance.ts';
import { memoryQueueDriver } from './drivers/memory.ts';
import { syncQueueDriver } from './drivers/sync.ts';
import type { JobMessage, QueueBackend, QueueDriver } from './port.ts';

/** Runs a kit and reports the names that failed, so a failure names its case. */
async function runKit(
  cases: readonly { name: string; run: () => Promise<void> }[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const entry of cases) {
    try {
      await entry.run();
    } catch (error: unknown) {
      failed.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed;
}

describe('the conformance kit', () => {
  test('memory passes every case', async () => {
    const cases = conformanceCases({ driver: memoryQueueDriver({ now: () => 1_000_000 }) });
    expect(await runKit(cases)).toEqual([]);
    expect(cases.length).toBeGreaterThan(5);
  });

  test('sync passes every case, as an inline driver', async () => {
    const cases = conformanceCases({
      driver: syncQueueDriver({ execute: async () => undefined, now: () => 1_000_000 }),
      behaviour: 'inline',
    });
    expect(await runKit(cases)).toEqual([]);
    // No storage means no lease, no delay, no retry window — the cases must not invent them.
    expect(cases.length).toBeLessThan(5);
  });

  test('the cases have teeth: a driver that loses messages fails', async () => {
    const real = memoryQueueDriver({ now: () => 1_000_000 });
    const leaky: QueueDriver<never> = {
      name: 'leaky',
      capabilities: real.capabilities,
      open(): QueueBackend {
        const backend = real.open();
        // The classic bug: `push` accepted, message never stored.
        return { ...backend, push: async () => undefined };
      },
    };

    const failed = await runKit(conformanceCases({ driver: leaky }));
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.join('\n')).toMatch(/leaky: (push, reserve, complete|a lease hides)/u);
  });

  test('the cases have teeth: a driver that double-counts attempts fails', async () => {
    const real = memoryQueueDriver({ now: () => 1_000_000 });
    const eager: QueueDriver<never> = {
      name: 'eager',
      capabilities: real.capabilities,
      open(): QueueBackend {
        const backend = real.open();
        // `attempts + 2`: the worker would then run every job one attempt short.
        return {
          ...backend,
          reserve: async (input) => {
            const messages: readonly JobMessage[] = await backend.reserve(input);
            return messages.map((message) => ({ ...message, attempts: message.attempts + 1 }));
          },
        };
      },
    };

    const failed = await runKit(conformanceCases({ driver: eager }));
    expect(failed.join('\n')).toMatch(/reserve counts the attempt it is starting/u);
  });
});
