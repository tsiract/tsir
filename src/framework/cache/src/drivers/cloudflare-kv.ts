/**
 * The `cloudflare-kv` driver (`§ 4.1`, `CACHE-8`).
 *
 * KV is the driver that taught this package to say "no" out loud, because almost everything
 * that makes a cache pleasant is either absent or eventually true on KV:
 *
 * | Thing | KV | What this driver does |
 * | --- | --- | --- |
 * | read-your-writes | **eventually consistent** (up to 60 s across regions) | advertises `readYourWrites: false`; a `requires` block can refuse it at boot |
 * | tags | none | refused (`invalidateTag` throws) rather than emulated with `list()` |
 * | increment | none | refused, because a read-modify-write across regions loses updates |
 * | clear | only by listing the keyspace | refused; delete the namespace in `wrangler` instead |
 * | TTL | minimum **60 s** | a shorter TTL is refused, not rounded up |
 *
 * The TTL floor is the subtle one. Rounding 10 s up to 60 s looks harmless until the caller
 * is a rate limiter — then it is a limiter that permits six times the traffic it was asked
 * to permit. So the default is a refusal, and `roundTtlUp: true` is how a caller who really
 * means "at least this long" opts in, visibly, in one place.
 *
 * The namespace is app-supplied (ADR-0027 § 1): `KVNamespace` is a binding, not a client
 * this package can construct, and taking it structurally means no `wrangler` types leak into
 * `@tsir/cache`.
 */

import { unsupportedOperation } from '../errors.ts';
import type { CacheBackend, CacheDriver, StoredValue } from '../port.ts';

/** The slice of a Workers `KVNamespace` this driver uses. */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CloudflareKvDriverOptions {
  readonly namespace: KvNamespaceLike;
  /** Round a too-short TTL up to the floor instead of refusing it. Off by default. */
  readonly roundTtlUp?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

/** KV's documented minimum: 60 seconds, and the API rejects anything shorter. */
export const KV_TTL_FLOOR_MS = 60_000;

export const CLOUDFLARE_KV_CAPABILITIES = {
  persistent: true,
  sharedAcrossInstances: true,
  // The one honest lie in the whole package, stated as a capability rather than a footnote.
  readYourWrites: false,
  tags: false,
  increment: false,
  ttl: true,
  clearAll: false,
  ttlFloorMs: KV_TTL_FLOOR_MS,
} as const;

export function cloudflareKvDriver(options: CloudflareKvDriverOptions): CacheDriver<never> {
  const now = options.now ?? Date.now;

  return {
    name: 'cloudflare-kv',
    capabilities: CLOUDFLARE_KV_CAPABILITIES,
    open(): CacheBackend {
      const { namespace } = options;

      return {
        name: 'cloudflare-kv',
        capabilities: CLOUDFLARE_KV_CAPABILITIES,
        now,

        async read(key: string): Promise<StoredValue | undefined> {
          const raw = await namespace.get(key);
          // `expiresAt` is not reported: the edge expires entries itself, and inventing a
          // local deadline would delete keys the namespace still serves everywhere else.
          return raw === null ? undefined : { raw };
        },

        // No `tags` parameter: the wrapper refuses a tagged write before it reaches here
        // (`capabilities.tags` is false), so accepting them would be a promise this driver
        // cannot keep.
        async write(key: string, raw: string, expiresAt: number | undefined): Promise<void> {
          if (expiresAt === undefined) {
            await namespace.put(key, raw);
            return;
          }

          const ttl = expiresAt - now();
          if (ttl < KV_TTL_FLOOR_MS && options.roundTtlUp !== true) {
            throw unsupportedOperation(
              'cloudflare-kv',
              'cloudflare-kv',
              'a TTL shorter than 60 s',
              `${String(ttl)} ms was requested; pass \`roundTtlUp: true\` if "at least this long" is acceptable`,
            );
          }

          // `expiration` (epoch seconds) rather than `expirationTtl` (relative): the port
          // already computed an absolute deadline, and a second conversion is a second
          // chance to disagree with it.
          const effective =
            options.roundTtlUp === true ? Math.max(expiresAt, now() + KV_TTL_FLOOR_MS) : expiresAt;
          await namespace.put(key, raw, { expiration: Math.ceil(effective / 1_000) });
        },

        async remove(key: string): Promise<boolean> {
          // KV's `delete` is idempotent and says nothing, so the only way to answer the
          // port's "did it exist" honestly is to look first. That costs a read, and this is
          // the one place where the driver spends one deliberately.
          const existing = await namespace.get(key);
          if (existing === null) return false;
          await namespace.delete(key);
          return true;
        },

        increment: (): Promise<number> =>
          Promise.reject(new Error('cache: cloudflare-kv cannot increment')),

        // Unreachable through the port (`capabilities.tags` is false, so the wrapper refuses
        // first) — refusing again here is cheaper than a `0` that looks like "nothing matched".
        removeTag: (): Promise<number> =>
          Promise.reject(new Error('cache: cloudflare-kv has no tag index')),

        async clear(): Promise<void> {
          // Reached only if a caller ignores capabilities; refusing here keeps the answer
          // correct for anyone who calls the backend directly.
          throw unsupportedOperation(
            'cloudflare-kv',
            'cloudflare-kv',
            'clear',
            'emptying a namespace means listing the whole keyspace — delete the namespace in wrangler instead',
          );
        },
      };
    },
  };
}

export const cloudflareKvCapabilities = CLOUDFLARE_KV_CAPABILITIES;
