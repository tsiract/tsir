/**
 * The `sync` queue driver against the conformance kit (`CAP-005`), in its `inline` shape.
 *
 * `sync` is the driver whose job is to have no lifecycle: `push` runs the work and stores
 * nothing. The kit's `inline` behaviour is what keeps that honest — it still asks for retries,
 * dead letters, replay and discard, because those survive in the process even when the messages
 * do not, and it does not ask for a lease the driver never grants.
 */

import { describe, expect, test } from 'bun:test';

import type { JobMessage } from '../port.ts';
import { conformanceCases } from '../conformance.ts';
import { syncQueueDriver } from './sync.ts';

const message = (id: string): JobMessage => ({
  id,
  name: 'report',
  payload: '{}',
  connection: 'default',
  attempts: 0,
  maxAttempts: 3,
  availableAt: 0,
  createdAt: 0,
});

describe('sync queue driver', () => {
  test('the conformance kit passes', async () => {
    let fail = false;
    const driver = syncQueueDriver({
      now: () => 0,
      execute: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve()),
    });

    for (const conformanceCase of conformanceCases({
      driver,
      connection: 'default',
      behaviour: 'inline',
    })) {
      await conformanceCase.run();
    }

    // ...and the same driver with a job that always fails, because the dead-letter half of the
    // kit is the half that a happy-path fake would skip.
    fail = true;
    for (const conformanceCase of conformanceCases({
      driver,
      connection: 'default',
      behaviour: 'inline',
    })) {
      await conformanceCase.run();
    }
  });

  test('push has already run the job when it returns', async () => {
    // The whole reason the driver exists: a test can assert on effects without polling.
    const ran: string[] = [];
    const backend = syncQueueDriver({
      now: () => 0,
      execute: (job) => {
        ran.push(job.id);
        return Promise.resolve();
      },
    }).open();

    await backend.push(message('j-1'));

    expect(ran).toEqual(['j-1']);
    // Nothing is stored, so nothing is reservable — `queue:work` on this connection is a no-op,
    // which is the honest answer rather than a worker that exits and looks broken.
    expect(
      await backend.reserve({ connection: 'default', limit: 10, now: 0, leaseMs: 1_000 }),
    ).toEqual([]);
  });
});
