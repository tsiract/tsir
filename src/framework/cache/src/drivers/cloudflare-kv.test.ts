/**
 * The `cloudflare-kv` driver (`CACHE-8`).
 *
 * This driver exists to be honest about a backend that cannot do most of what the port
 * offers, so the tests are mostly about the refusals — and about the four capabilities where
 * KV's answer is "eventually" rather than "yes".
 *
 * The namespace is a fake with a real expiry table, because the two things a KV fake must get
 * right are the 60-second floor and the fact that `put` returns before the value is visible
 * everywhere. Consistency is modelled by the capability flag; the floor is modelled for real.
 */

import { describe, expect, test } from 'bun:test';

import { json } from '../codec.ts';
import { conformanceCases } from '../conformance.ts';
import { createCache } from '../store.ts';
import { assertRequirements, createCaches, defineStore } from '../stores.ts';
import {
  CLOUDFLARE_KV_CAPABILITIES,
  cloudflareKvDriver,
  KV_TTL_FLOOR_MS,
  type KvNamespaceLike,
} from './cloudflare-kv.ts';

interface Entry {
  readonly value: string;
  /** Epoch seconds, as KV stores it. */
  readonly expiration?: number | undefined;
}

function fakeNamespace(now: () => number) {
  const entries = new Map<string, Entry>();
  const puts: { key: string; value: string; expiration?: number }[] = [];

  const namespace: KvNamespaceLike = {
    async get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (entry.expiration !== undefined && entry.expiration <= Math.floor(now() / 1_000)) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options) {
      puts.push({
        key,
        value,
        ...(options?.expiration === undefined ? {} : { expiration: options.expiration }),
      });
      entries.set(key, {
        value,
        ...(options?.expiration === undefined ? {} : { expiration: options.expiration }),
      });
    },
    async delete(key) {
      entries.delete(key);
    },
  };

  return { namespace, entries, puts };
}

function store(options: { roundTtlUp?: boolean; now?: () => number } = {}) {
  let clock = options.now?.() ?? 1_000_000;
  const fake = fakeNamespace(() => clock);
  const driver = cloudflareKvDriver({
    namespace: fake.namespace,
    ...(options.roundTtlUp === true ? { roundTtlUp: true } : {}),
    now: () => clock,
  });
  const cache = createCache<string>({ name: 'kv', backend: driver.open(), codec: json<string>() });

  return { fake, driver, cache, advance: (ms: number) => (clock += ms) };
}

describe('what KV can honestly claim', () => {
  test('the capability record says "eventually", not "yes"', () => {
    expect(CLOUDFLARE_KV_CAPABILITIES).toEqual({
      persistent: true,
      sharedAcrossInstances: true,
      readYourWrites: false,
      tags: false,
      increment: false,
      ttl: true,
      clearAll: false,
      ttlFloorMs: 60_000,
    });
  });

  test('a `requires` block naming readYourWrites refuses the store at boot', () => {
    const fake = fakeNamespace(() => 0);
    const caches = createCaches({
      default: 'pages',
      stores: {
        pages: defineStore({
          driver: cloudflareKvDriver({ namespace: fake.namespace }),
          codec: json<string>(),
        }),
      },
    });

    expect(caches.capabilities('pages').readYourWrites).toBe(false);
    // The requirement is the point of the registry: this is a boot failure, not a race
    // condition somebody debugs at 3am.
    expect(() => assertRequirements(caches, [{ store: 'pages', readYourWrites: true }])).toThrow(
      /store "pages" \(driver "cloudflare-kv"\) does not support readYourWrites/u,
    );
    // And a block that asks for what KV *can* do still passes.
    expect(() => assertRequirements(caches, [{ store: 'pages', persistent: true }])).not.toThrow();
  });
});

describe('the TTL floor is refused, not rounded', () => {
  test('a TTL under 60 s fails, and the message shows the floor and the flag', async () => {
    const { cache } = store();

    try {
      await cache.set('k', 'v', { ttlMs: 10_000 });
      throw new Error('expected a refusal');
    } catch (error: unknown) {
      const tsir = error as { code?: string; message: string };
      expect(tsir.code).toBe('CAP_UNSUPPORTED_OPERATION');
      expect(tsir.message).toContain('10000 ms was requested');
      expect(tsir.message).toContain('roundTtlUp: true');
    }
  });

  test('exactly the floor is accepted, and lands as an absolute `expiration` in seconds', async () => {
    const { cache, fake, advance } = store();

    advance(KV_TTL_FLOOR_MS);
    await cache.set('k', 'v', { ttlMs: KV_TTL_FLOOR_MS });

    const put = fake.puts.at(-1);
    // 1 000 000 ms start + 60 000 advanced + 60 000 TTL = 1 120 000 ms → epoch seconds.
    expect(put?.expiration).toBe(1_120);
  });

  test('`roundTtlUp: true` is the visible opt-in, and it rounds to the floor', async () => {
    const { cache, fake } = store({ roundTtlUp: true });

    await cache.set('k', 'v', { ttlMs: 5_000 });

    const put = fake.puts.at(-1);
    expect(put?.expiration).toBe(Math.ceil((1_000_000 + KV_TTL_FLOOR_MS) / 1_000));
  });

  test('no TTL means no expiration option at all', async () => {
    const { cache, fake } = store();

    await cache.set('k', 'v');

    expect(fake.puts.at(-1)?.expiration).toBeUndefined();
  });
});

describe('what it refuses outright', () => {
  test('increment, tags and clear are all unsupported — never approximated', async () => {
    const { cache } = store();

    expect(cache.increment('n')).rejects.toThrow(/atomic increment/u);
    expect(cache.set('k', 'v', { tags: ['t'] })).rejects.toThrow(/does not support tags/u);
    expect(cache.invalidateTag('t')).rejects.toThrow(/does not support tags/u);
    expect(cache.clear()).rejects.toThrow(/does not support clear/u);
  });

  test('the clear refusal names the real alternative', async () => {
    const { cache } = store();

    try {
      await cache.clear();
      throw new Error('expected a refusal');
    } catch (error: unknown) {
      expect((error as Error).message).toContain('delete the namespace');
    }
  });
});

describe('the normal path', () => {
  test('values round-trip, and delete reports whether the key existed', async () => {
    const { cache } = store();

    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
    expect(await cache.delete('k')).toBe(true);
    expect(await cache.delete('k')).toBe(false);
  });

  test('an entry the edge has expired reads as a miss', async () => {
    const { cache, advance } = store();

    await cache.set('k', 'v', { ttlMs: KV_TTL_FLOOR_MS });
    advance(KV_TTL_FLOOR_MS + 1);

    expect(await cache.get('k')).toBeUndefined();
  });

  test('the conformance kit passes — KV is a caching driver, just a slow one', async () => {
    const fake = fakeNamespace(() => 0);
    const driver = cloudflareKvDriver({ namespace: fake.namespace, now: () => 0 });

    for (const conformanceCase of conformanceCases({ driver, store: 'kv' })) {
      await conformanceCase.run();
    }
  });
});
