import { describe, expect, test } from 'bun:test';
import type { Database } from '@tsir/database';

import { acquireMigrationLock } from './lock.ts';

/** A Postgres-shaped database whose `pg_try_advisory_lock` answers from a script. */
function fakeDatabase(answers: readonly boolean[]): Database {
  let call = 0;
  return {
    name: 'app',
    capabilities: { engine: 'postgres' },
    query: async () => {
      const locked = answers[Math.min(call, answers.length - 1)] ?? false;
      call += 1;
      return { rows: [{ locked }] };
    },
  } as unknown as Database;
}

describe('acquireMigrationLock wait deadline (CFG-011)', () => {
  test('an expired deadline on the injected clock gives up without sleeping', async () => {
    const times = [0, 2000];
    let slept = 0;
    const handle = await acquireMigrationLock(fakeDatabase([false]), {
      name: 'app',
      waitMs: 1000,
      now: () => times.shift() ?? 2000,
      sleep: async () => {
        slept += 1;
      },
    });
    expect(handle.acquired).toBe(false);
    expect(slept).toBe(0);
  });

  test('before the deadline it retries, and acquires once the lock frees', async () => {
    let slept = 0;
    const handle = await acquireMigrationLock(fakeDatabase([false, true]), {
      name: 'app',
      waitMs: 1000,
      now: () => 0,
      sleep: async () => {
        slept += 1;
      },
    });
    expect(handle.acquired).toBe(true);
    expect(slept).toBe(1);
  });
});
