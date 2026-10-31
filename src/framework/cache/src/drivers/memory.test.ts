/**
 * The `memory` driver against the conformance kit (`CAP-005`).
 *
 * The kit already carries the generic contract; what is left here is the part only this driver
 * can answer — eviction, and the clock it keeps so TTLs are testable without sleeping. A driver
 * that shipped without a kit run would have a contract made of whatever its own tests happened
 * to assert, which is the failure `§ 5` exists to prevent.
 */

import { describe, expect, test } from 'bun:test';

import { json } from '../codec.ts';
import { conformanceCases } from '../conformance.ts';
import { createCache } from '../store.ts';
import { memoryDriver } from './memory.ts';

describe('memory driver', () => {
  test('the conformance kit passes', async () => {
    const driver = memoryDriver({ now: () => 0 });

    for (const conformanceCase of conformanceCases({ driver, store: 'memory' })) {
      await conformanceCase.run();
    }
  });

  test('an entry stops being readable the millisecond its TTL is up', async () => {
    let now = 1_000;
    const cache = createCache<unknown>({
      name: 'memory',
      backend: memoryDriver({ now: () => now }).open(),
      codec: json(),
    });

    await cache.set('k', 'v', { ttlMs: 500 });
    now = 1_499;
    expect(await cache.get('k')).toBe('v');
    now = 1_500;
    // Expiry is a read-time decision, not a sweep: nothing has to have run for the miss.
    expect(await cache.get('k')).toBeUndefined();
  });

  test('maxEntries evicts the oldest entry, and says so by missing', async () => {
    const cache = createCache<unknown>({
      name: 'memory',
      backend: memoryDriver({ now: () => 0, maxEntries: 2 }).open(),
      codec: json(),
    });

    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);

    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('c')).toBe(3);
  });
});
