# `@tsir/cache`

Named cache stores over one port: explicit serialization, per-store capabilities, and no silent
fallback. A store is a name, a driver, and a codec — nothing is inferred from stored bytes.

## Capabilities

Every store advertises what its driver can actually do, and the port refuses what it cannot:

| Capability              | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `persistent`            | Survives a process restart.                                                    |
| `sharedAcrossInstances` | Visible to other instances.                                                    |
| `readYourWrites`        | A read after your own write sees it.                                           |
| `tags`                  | A real tag index exists — invalidation is not emulated with a keyspace scan.   |
| `increment`             | Atomic add-and-return, not read-modify-write.                                  |
| `ttl`                   | Entries can expire.                                                            |
| `clearAll`              | `clear()` can be honoured without listing the keyspace.                        |
| `locks`                 | Atomic compare-and-set, so advisory locks can be acquired and released safely. |

## Drivers

- `@tsir/cache/memory` — in-process; all capabilities except `persistent` and `sharedAcrossInstances`.
- `@tsir/cache/database` — Postgres or D1, one table; all capabilities.
- `@tsir/cache/redis` — app-supplied client; all capabilities (`locks` requires `eval`).
- `@tsir/cache/cloudflare-kv` — eventually consistent; `tags`, `increment`, `clearAll`, and `locks` are refused.
- `@tsir/cache/null` — always misses, never stores; only `clearAll` is true.

## Advisory locks

`cache.lock(name, ttlMs?, owner?)` returns a `CacheLock` backed by the same backend. Acquiring is
"set if absent"; releasing is "delete if the owner still matches". Both are atomic on the backend,
which is why `locks` is a capability — Cloudflare KV cannot do either atomically and refuses.

```ts
const lock = store.lock('import:users', 30_000);
if (await lock.get()) {
  try {
    await importUsers();
  } finally {
    await lock.release();
  }
}
```

A lock with a callback releases automatically:

```ts
const result = await store.lock('import:users', 30_000).get(() => importUsers());
if (result === false) {
  // another process holds the lock
}
```

`forceRelease()` removes the lock regardless of owner — the recovery hatch for a stuck lock.
