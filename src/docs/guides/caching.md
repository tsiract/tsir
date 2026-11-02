# Caching

After [installation](../installation.md), add the package to your app with
`bun add '@tsir/cache@workspace:*'`.

## Why and how caching works

A cache stores the result of an expensive operation (a database query, an API call, a computed
value) so the next request can skip the work. Laravel calls this `Cache::remember()`; Tsir calls
it `cache.remember()`. The idea is identical.

Tsir's cache has three moving parts:

- **A store** — a named backend: `memory` (local only), `database`, `redis`, or
  `cloudflare-kv`.
- **A codec** — how values are serialized. `json<T>()` is the default.
- **A TTL** — how long a value lives, in **milliseconds**.

This local example exercises a read-through cache, expiry and invalidation with the in-memory
driver.

```ts verify
import { createCaches, defineStore, json } from '@tsir/cache';
import { memoryDriver } from '@tsir/cache/memory';

type Profile = { id: string; name: string };
const caches = createCaches({
  default: 'profiles',
  stores: {
    profiles: defineStore({ driver: memoryDriver(), codec: json<Profile>(), ttlMs: 60_000 }),
  },
});
const cache = caches.store('profiles');
const profile = await cache.remember('user:42', 60_000, async () => ({ id: '42', name: 'Ada' }));
console.log(profile.name);
await cache.delete('user:42');
```

Choose a durable, shared driver for production: `database`, `redis` (application-supplied client),
or `cloudflare-kv` (namespace binding). `cachesFromConfig` converts named `cache.stores` into
stores when the application supplies matching `bindings`; it does not create cloud resources.
The memory and null defaults are rejected in production. Check the selected store's capabilities
before using tags, atomic increment, clear-all or read-your-writes; unsupported operations fail
rather than silently falling back. In particular, Cloudflare KV is eventually consistent: do not
use it for locks, rate limits or sessions that need strong consistency. Cache misses and invalidation
are normal; the database remains the source of truth. TTLs are milliseconds in Tsir's API.
Avoid secrets and personal data in keys; decide whether cached values are safe for that backend.
See the [cache reference](../packages/cache.md).
