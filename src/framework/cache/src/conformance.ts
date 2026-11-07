/**
 * The driver conformance kit (`§ 5`).
 *
 * Every driver — ours and anyone else's — must satisfy the same contract, and the contract is
 * written once here as **data**: a list of named cases, each a function that throws on
 * violation. No test framework is imported, because a third-party driver author should be
 * able to run this under whatever runner they already use:
 *
 * ```ts
 * import { conformanceCases } from '@tsir/cache/conformance';
 * for (const c of conformanceCases({ driver: myDriver() })) test(c.name, () => c.run());
 * ```
 *
 * Two rules the kit enforces that are easy to get wrong:
 *
 *   · **A capability that is advertised must work, and one that is not must throw.** A driver
 *     that claims `tags: false` and then silently ignores `tags` is worse than one that
 *     crashes: the caller believes invalidation happened.
 *   · **A miss is `undefined`, never `null`, never `''`.** The port's whole error handling
 *     rests on that one value.
 */

import { json } from './codec.ts';
import { createCache } from './store.ts';
import type { Cache, CacheDriver } from './port.ts';

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface ConformanceOptions<Config = unknown> {
  readonly driver: CacheDriver<Config>;
  readonly config?: Config | undefined;
  /** Base name used in messages; the kit appends a random suffix per case. */
  readonly store?: string | undefined;
  /**
   * `'store'` (default) is a caching driver: a write is readable. `'never-store'` is the
   * testing shape (`null`): every read misses and every write is a no-op **by contract**, so
   * "does this code path depend on cache warmth?" can be answered.
   */
  readonly behaviour?: 'store' | 'never-store' | undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`);
}

async function expectRejection(
  operation: Promise<unknown>,
  pattern: RegExp,
  what: string,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code ?? '';
    assert(
      pattern.test(message) || pattern.test(code),
      `${what} must fail with ${String(pattern)}, got: ${code} ${message}`,
    );
    return;
  }
  throw new Error(`conformance: ${what} must fail, but it succeeded`);
}

/** A fresh store name per case, so cases cannot leak into each other. */
function makeStore<Config>(options: ConformanceOptions<Config>, suffix: string): Cache<unknown> {
  const backend = options.driver.open(options.config);
  return createCache({
    name: `${options.store ?? 'conformance'}:${suffix}`,
    backend,
    codec: json<unknown>(),
  });
}

export function conformanceCases<Config = unknown>(
  options: ConformanceOptions<Config>,
): readonly ConformanceCase[] {
  const capabilities = options.driver.capabilities;
  const name = options.driver.name;

  const behaviour = options.behaviour ?? 'store';

  if (behaviour === 'never-store') {
    return [
      {
        name: `${name}: every read misses`,
        async run() {
          const store = makeStore(options, 'miss');
          await store.set('k', 'v');
          assert((await store.get('k')) === undefined, 'a never-store driver must always miss');
          assert((await store.has('k')) === false, 'has() must always be false');
          assert((await store.delete('k')) === false, 'delete() must always report false');
        },
      },
      {
        name: `${name}: a write is accepted and forgotten`,
        async run() {
          const store = makeStore(options, 'forget');
          // Accepting the write matters: rejecting it would make the driver unusable as a
          // drop-in, and a test that throws where production would succeed proves nothing.
          await store.set('k', 'v');
          await store.clear();
          assert((await store.get('k')) === undefined, 'nothing may survive a write');
        },
      },
      {
        name: `${name}: counters and tags are refused, not faked`,
        async run() {
          const store = makeStore(options, 'refuse');
          await expectRejection(
            store.increment('n'),
            /CAP_UNSUPPORTED_OPERATION|atomic increment/u,
            'increment on a never-store driver',
          );
          await expectRejection(
            store.set('k', 'v', { tags: ['t'] }),
            /CAP_UNSUPPORTED_OPERATION|does not support tags/u,
            'tagging on a never-store driver',
          );
        },
      },
    ];
  }

  const cases: ConformanceCase[] = [
    {
      name: `${name}: a miss is undefined`,
      async run() {
        const store = makeStore(options, 'miss');
        assert((await store.get('absent')) === undefined, 'an absent key must read as undefined');
        assert((await store.has('absent')) === false, 'has() on an absent key must be false');
        assert((await store.delete('absent')) === false, 'delete() of an absent key must be false');
      },
    },
    {
      name: `${name}: values round-trip through the codec`,
      async run() {
        const store = makeStore(options, 'roundtrip');
        const value = { id: 'u1', nested: { n: [1, 2, 3] }, text: 'héllo' };
        await store.set('k', value);
        assert(
          JSON.stringify(await store.get('k')) === JSON.stringify(value),
          'a value must come back equal to what was written',
        );
        assert((await store.has('k')) === true, 'has() must be true after a write');
      },
    },
    {
      name: `${name}: delete removes exactly one key`,
      async run() {
        const store = makeStore(options, 'delete');
        await store.set('a', 1);
        await store.set('b', 2);
        assert((await store.delete('a')) === true, 'delete() of a present key must be true');
        assert((await store.get('a')) === undefined, 'the deleted key must be gone');
        assert((await store.get('b')) === 2, 'its neighbour must survive');
      },
    },
    capabilities.clearAll
      ? {
          name: `${name}: clear empties the store`,
          async run() {
            const store = makeStore(options, 'clear');
            await store.set('a', 1);
            await store.set('b', 2);
            await store.clear();
            assert((await store.get('a')) === undefined, 'clear() must remove every key');
            assert((await store.get('b')) === undefined, 'clear() must remove every key');
          },
        }
      : {
          name: `${name}: clear is refused, not emulated with a keyspace scan`,
          async run() {
            const store = makeStore(options, 'clear');
            await expectRejection(
              store.clear(),
              /CAP_UNSUPPORTED_OPERATION|does not support clear/u,
              'clear() on a driver that cannot enumerate',
            );
          },
        },
  ];

  if (capabilities.ttl) {
    cases.push({
      name: `${name}: a zero TTL is already expired`,
      async run() {
        const store = makeStore(options, 'ttl');
        // Absolute expiry, so this holds for every driver: `expiresAt <= now` on the same
        // millisecond. A driver with a minimum TTL must refuse the too-short ones instead.
        if (capabilities.ttlFloorMs !== undefined) {
          await expectRejection(
            store.set('k', 'v', { ttlMs: 0 }),
            /CAP_UNSUPPORTED_OPERATION|shorter than/u,
            'a TTL below the floor',
          );
          return;
        }
        await store.set('k', 'v', { ttlMs: 0 });
        assert((await store.get('k')) === undefined, 'an entry with a zero TTL must not read back');
      },
    });
  } else {
    cases.push({
      name: `${name}: a TTL is refused, not ignored`,
      async run() {
        const store = makeStore(options, 'ttl');
        await expectRejection(
          store.set('k', 'v', { ttlMs: 1_000 }),
          /CAP_UNSUPPORTED_OPERATION|does not support a TTL/u,
          'a TTL on a driver without expiry',
        );
      },
    });
  }

  if (capabilities.tags) {
    cases.push({
      name: `${name}: invalidating a tag removes only its entries`,
      async run() {
        const store = makeStore(options, 'tags');
        await store.set('a', 1, { tags: ['group'] });
        await store.set('b', 2, { tags: ['group'] });
        await store.set('c', 3, { tags: ['other'] });
        assert((await store.invalidateTag('group')) === 2, 'two entries were tagged `group`');
        assert((await store.get('a')) === undefined, 'a tagged entry must be gone');
        assert((await store.get('c')) === 3, 'an untagged entry must survive');
      },
    });
  } else {
    cases.push({
      name: `${name}: tags are refused, not ignored`,
      async run() {
        const store = makeStore(options, 'tags');
        await expectRejection(
          store.set('k', 'v', { tags: ['x'] }),
          /CAP_UNSUPPORTED_OPERATION|does not support tags/u,
          'tagging on a driver without a tag index',
        );
        await expectRejection(
          store.invalidateTag('x'),
          /CAP_UNSUPPORTED_OPERATION|does not support tags/u,
          'invalidateTag on a driver without a tag index',
        );
      },
    });
  }

  if (capabilities.increment) {
    cases.push({
      name: `${name}: increment is atomic and reads back through the codec`,
      async run() {
        const store = makeStore(options, 'increment');
        assert((await store.increment('n')) === 1, 'the first increment of a missing key is 1');
        assert((await store.increment('n', 4)) === 5, 'increment adds its argument');
        // The point of the counter codec: an incremented key is still a readable key.
        assert((await store.get('n')) === 5, 'the counter reads back through the codec');
      },
    });
  } else {
    cases.push({
      name: `${name}: increment is refused, not approximated`,
      async run() {
        const store = makeStore(options, 'increment');
        await expectRejection(
          store.increment('n'),
          /CAP_UNSUPPORTED_OPERATION|atomic increment/u,
          'increment on a driver without an atomic counter',
        );
      },
    });
  }

  if (capabilities.locks) {
    cases.push({
      name: `${name}: a lock is acquired only once and released by its owner`,
      async run() {
        const store = makeStore(options, 'lock');
        const lock = store.lock('mutex', 10_000);
        // Two owners, one lock: the first acquire wins, the second loses.
        assert((await lock.get()) === true, 'the first acquire must succeed');
        const other = store.lock('mutex', 10_000);
        assert((await other.get()) === false, 'a second owner must not acquire a held lock');
        // The first owner releases; the second can now acquire.
        assert((await lock.release()) === true, 'the owner must release its own lock');
        assert((await other.get()) === true, 'after release the lock is free again');
        await other.release();
      },
    });
    cases.push({
      name: `${name}: a lock runs and releases a callback on acquire`,
      async run() {
        const store = makeStore(options, 'lock-cb');
        const lock = store.lock('cb', 10_000);
        let ran = Boolean(false);
        const result = await lock.get(() => {
          ran = true;
          return 42;
        });
        assert(result === 42, 'the callback result is returned');
        assert(ran, 'the callback ran');
        // The callback path releases automatically: a fresh owner can acquire.
        const next = store.lock('cb', 10_000);
        assert((await next.get()) === true, 'the callback path released the lock');
        await next.release();
      },
    });
    cases.push({
      name: `${name}: forceRelease clears the lock regardless of owner`,
      async run() {
        const store = makeStore(options, 'lock-force');
        const holder = store.lock('force', 10_000);
        assert((await holder.get()) === true, 'the holder acquires');
        const intruder = store.lock('force', 10_000);
        // forceRelease is the recovery hatch: it removes the lock even though `intruder` is not the owner.
        await intruder.forceRelease();
        assert((await intruder.get()) === true, 'after forceRelease the lock is free');
        await intruder.release();
      },
    });
  } else {
    cases.push({
      name: `${name}: locks are refused when the backend cannot acquire and release atomically`,
      async run() {
        const store = makeStore(options, 'lock');
        let threw = false;
        try {
          store.lock('x');
        } catch {
          threw = true;
        }
        assert(threw, 'lock() must throw when capabilities.locks is false');
      },
    });
  }

  return cases;
}
