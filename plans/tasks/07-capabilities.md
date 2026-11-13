# Tasks — Capabilities (Phase 7)

> The modules that are **not** the framework core: cache, queue, events, schedule, mail,
> notify, storage. Each is independently adoptable and none is required by Phases 1–6.
>
> **Plan:** [`15-capabilities.md`](../modules/15-capabilities.md) (mechanism, defaults, failure modes)
> and [`decisions/0027`](../decisions/0027-capability-drivers.md) (packaging, clients, registries).

**Status: open — started 2026-10-28.** Gate P6 is satisfied for everything this environment
can satisfy; its cloud half is tracked in [`07-deploy-cloud-checks.md`](./07-deploy-cloud-checks.md)
and does not block capability work, which touches no deployment adapter yet. The old
"Phase 7 does not start until Gate P6 passes" guard is replaced by that sentence, on the
record, rather than quietly dropped.

## Order

The mechanism comes before any module, and the smallest module proves it:

1. `CAP-001`–`CAP-003` — store registry, per-store capabilities, one import per driver.
2. `@tsir/cache` — the first package, and the cheapest proof: a driver port, an explicit codec,
   two drivers that behave in opposite ways (`memory`, `null`).
3. `@tsir/queue` + outbox, then `@tsir/events` (the outbox is shared, so queue lands first) — both
   done; [`queue.md`](./queue.md) and [`events.md`](./events.md).
4. `@tsir/auth` + `@tsir/policy` (separate packages, documented seam) — **both done** (2026-10-29):
   [`auth.md`](./auth.md) and [`policy.md`](./policy.md). The seam held: `policy` sees only
   `{ subject, data }` and `auth` never imports it, so a project can take one without the other.
5. `@tsir/schedule` — **done**, [`schedule.md`](./schedule.md). Its lock turned out to be a port of
   its own rather than a cache reuse (`15-capabilities.md § 4.6`), so it unblocks nothing else.
6. `@tsir/storage`, `@tsir/mail`, `@tsir/notify` — **all three done**: [`storage.md`](./storage.md),
   [`mail.md`](./mail.md) and [`notify.md`](./notify.md) (2026-10-29). `notify` is the first
   capability built on a transport rather than a driver: it imports mail's mailer and the queue's
   `dispatch`, and owns no transport of its own.

## Foundation

| ID        | Task                                                                                                                    | Status | Depends          | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAP-001` | Store/connection registry per port (`cache.stores`, `queue.connections`, …, with `default`, typed names)                | `[x]`  | `15 § 2.2`       | One shape for four ports: typed by declaration, lazy open, `CAP_UNKNOWN_STORE`/`CAP_UNKNOWN_CONNECTION`, default (and `required`) opened eagerly. `storage.disks` landed with `STOR-10`, `mail.mailers` with `MAIL-9` — including the rule that made it worth generalizing: a name that was never declared is an error, never a fallback                                                                                                                                                                                                                                                                                                                                     |
| `CAP-002` | Per-store capability records + boot validation                                                                          | `[x]`  | `CAP-001`        | `CAP_UNSUPPORTED_OPERATION` names store **and** driver; `checkRequirements` reports all problems at once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CAP-003` | `drivers.gen.ts` emits one import per driver regardless of how many stores use it                                       | `[x]`  | `CAP-001`        | Two stores on one driver → one import; a store naming an uninstalled driver fails `tsir build` before anything is written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CAP-004` | One queue trigger per connection in the deploy graph; `queue:work --connection`                                         | `[x]`  | `CAP-001`, queue | `queue:work --connection` (`QUEUE-13`) and the per-connection trigger (`QUEUE-17`): `DPL_QUEUE_TRIGGER_MISSING` names the matrix cell, `DPL_QUEUE_OUTBOX_MISSING` refuses a broker without an outbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CAP-005` | Driver conformance kit                                                                                                  | `[x]`  | `15 § 5`         | `@tsir/cache/conformance`, `@tsir/queue/conformance`, `@tsir/storage/conformance` and `@tsir/mail/conformance` ship as data; every shipped driver of each runs it, in the shape it declares (`store`, `never-store`, `broker`, `inline`, `platform`, `disk`, `transport`)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CAP-006` | A `tsir.js` registry for the five constructor-only ports (broadcast, scout, media, auth stores, pennant, schedule lock) | `[ ]`  | `CAP-001`        | The gap [`guides/drivers.md § 5`](../../src/docs/guides/drivers.md) makes visible: `cache`, `queue`, `mail`, `storage` and `notify` resolve a driver by name from `tsir.js`; `broadcast`, `scout`, `media`, `auth`, `pennant` and `schedule`'s lock are constructors the app entry wires by hand, so `tsir.js` cannot select them and `tsir doctor` cannot report them. Same five-part change each time: a `*_DRIVERS` constant, a `driverFor` switch, a builder, a bootstrap that reads it, and refusal in production. The first is `broadcast` — its `memory` default is the one driver that leaks (`INF-009`)                                                             |
| `CAP-007` | `production: true` reaches every bootstrap, from `APP_ENV`                                                              | `[ ]`  | `CAP-001`        | The guards are all implemented and all keyed on `options.production` (`cachesFromConfig`, `queuesFromConfig`, `mailersFromConfig`, `disksFromConfig`, `createNotifier`) — and **no app, fixture or generated stub passes it**, so an ephemeral default is accepted in production today and the guards are unreachable. Wiring it is one value from `APP_ENV` into each bootstrap; it is the item that makes every other refusal real                                                                                                                                                                                                                                         |
| `CAP-008` | `tsir new --target cloudflare` writes the Cloudflare rows                                                               | `[ ]`  | `CAP-007`        | `DRIVER_DEFAULTS` (`@tsir/core`) says what each capability converges on per target and `make check` holds it to "durable on a stateless target", but nothing reads it: the starter writes `memory` for every block. The gap between a documented default and an actual one                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CAP-009` | The three missing database engines                                                                                      | `[x]`  | `CAP-007`        | `DATABASE_ENGINES` is `['d1','postgres','mysql','sqlite']` and every one is built from `tsir.js`. The real defect was `from-config.ts` answering `DB_POSTGRES_BOOTSTRAP_UNWIRED` for _any_ url connection — the Lambda and Bun defaults named an engine that could not start. `postgres` and `mysql` now reach a pooler over HTTP (one `POST` per statement, no socket, no SDK) and declare `interactiveTx: false` because one request is one session, which `declare()` turns into a boot refusal. `sqlite` is the D1 driver over a `bun:sqlite` handle: real `BEGIN IMMEDIATE`, and `health().engine` reports `sqlite` rather than a binding this connection does not have |
| `CAP-010` | `sendgrid` transport, and `postJson` returns headers                                                                    | `[x]`  | `MAIL-7`         | Resend and Postmark covered two of the three top transactional providers; SendGrid is the third and the one a team most often already has. Two shapes are its own: `personalizations` (addresses nested) and `content` as an ordered array (plain before html, which is the client's fallback order, not ours). Its message id is the `X-Message-Id` **header** on an empty-bodied `202`, so `postJson` now returns headers — without it the caller got an untrackable success                                                                                                                                                                                               |
| `CAP-011` | `durableObjectBroadcaster` — Workers' real fan-out point                                                                | `[x]`  | `INF-009`        | Workers has no process to hold a listener list, so `memory` there publishes into an array nobody else sees. One Durable Object per channel, reached through the standard stub `fetch`; the hub class ships as source (`DURABLE_OBJECT_HUB`) because only the app's entry can export it for `wrangler.toml`. The subscription stream aborts when the last listener leaves, which is what stops the object billing forever — and what closes `INF-009` for the Workers path                                                                                                                                                                                                    |
| `CAP-012` | Hosted search: Typesense, Meilisearch, Algolia                                                                          | `[x]`  | `scout`          | Neither Cloudflare nor AWS offers a search product that is not a cluster. Three drivers behind one `hostedSearch({ provider })`, because all three are `fetch` + a key; what differs is auth header, URL shape, request body and response envelope, and each of those is asserted. Algolia's app id is parsed at construction so a malformed host fails at boot                                                                                                                                                                                                                                                                                                              |
| `CAP-013` | `pennant` `databaseStore` on Postgres                                                                                   | `[x]`  | `INF-011`        | It wrote `?` literals, so it was correct on D1 and SQLite and a syntax error on Postgres — the dialect bug `INF-011` recorded. `placeholder: 'question' \| 'dollar'` is now a parameter, and `table` too; both are asserted                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CAP-016` | Every table-backed port accepts the engines it can actually serve                                                       | `[x]`  | `CAP-009`        | Four ports emit `ON CONFLICT … DO UPDATE … RETURNING` and MySQL has no equivalent: cache, the notify inbox, pennant's store and the scheduler lock. Each now takes `mysql` in the type and refuses it **at construction** with `CAP_ENGINE_UNSUPPORTED` / `NOTIFY_ENGINE_UNSUPPORTED` / `PENNANT_ENGINE_UNSUPPORTED`, naming the statement. The queue and auth ports kept all four because they emit plain SQL. `pennant` gained an `engine` option: `placeholder` separates Postgres from SQLite but not from MySQL, since both answer `$1`, so the flag alone let a MySQL connection through                                                                               |
| `CAP-017` | `tsir.js` registry for `media`, and a production guard for the process adapters                                         | `[x]`  | `CAP-007`        | `media.adapters.<name>` × `MEDIA_DRIVERS`, with `adapterFor`/`mediaFromConfig` and `createMediaBootstrap` taking the block. The guard is the point: `sharp` and `ffmpeg` transform a buffer and hand it back, so `production: true` refuses them (`CAP_FORBIDDEN_IN_PRODUCTION`) — a route that returns 200 and drops the image is indistinguishable from success. The three service adapters (`cloudflare`, `cloudinary`, `imagekit`) store the asset and pass                                                                                                                                                                                                              |
| `CAP-014` | `tsir.js` registry for `broadcast`                                                                                      | `[x]`  | `CAP-011`        | `broadcast.driver` is now a name in config: `BROADCAST_DRIVERS`, `broadcasterFor`, and a `broadcasterFromConfig` the bootstrap reads. A driver whose binding is absent names `bindings.realtime.default` rather than "no broadcaster", and `memory` is refused in production (`CAP_FORBIDDEN_IN_PRODUCTION`) — a refusal that had nowhere to live while the driver was a constructor called from `app.ts`                                                                                                                                                                                                                                                                    |
| `CAP-015` | `tsir.js` registry for `search`                                                                                         | `[x]`  | `CAP-012`        | Same shape: `search.driver`, `engineFor`, `searchFromConfig`. The three groups need visibly different things — nothing, a query function, or a host and a `{ fromEnv }` key — and the error names which is absent. `memory` is refused in production; `sqlite` is not, because it is a real index                                                                                                                                                                                                                                                                                                                                                                            |

## `@tsir/cache`

| ID         | Task                                                                     | Status | Depends   | Acceptance                                                                                             |
| ---------- | ------------------------------------------------------------------------ | ------ | --------- | ------------------------------------------------------------------------------------------------------ |
| `CACHE-1`  | Port + store wrapper (`get`/`set`/`has`/`delete`/`remember`/`increment`) | `[x]`  | `CAP-001` | Codec applied once, above every driver; `remember` documents that the compute runs outside a lock      |
| `CACHE-2`  | Explicit codecs (`json` envelope, `text`) + counter form                 | `[x]`  | `CACHE-1` | Wrong codec → `CAP_CODEC_FAILED` naming store, key and codec; `undefined` is a miss, not a value       |
| `CACHE-3`  | `memory` driver                                                          | `[x]`  | `CACHE-1` | Injectable clock, `maxEntries` eviction, honest capabilities (`persistent: false`)                     |
| `CACHE-4`  | `null` driver                                                            | `[x]`  | `CACHE-1` | Always misses; increment refused rather than returning 0                                               |
| `CACHE-5`  | Production guard                                                         | `[x]`  | `CAP-002` | Ephemeral driver refused as default or on a `required` store; a local store nobody resolves is allowed |
| `CACHE-6`  | `database` driver (Postgres/MySQL table + `UPDATE … RETURNING`)          | `[x]`  | `CACHE-1` | Atomic increment and a real tag index; expiry honoured on read                                         |
| `CACHE-7`  | `redis` driver (app-supplied client, ADR-0027)                           | `[x]`  | `CACHE-1` | Fake client satisfies the conformance kit; a missing method is a startup error                         |
| `CACHE-8`  | `cloudflare-kv` driver                                                   | `[x]`  | `CACHE-1` | `readYourWrites: false` and a documented TTL floor; tags refused                                       |
| `CACHE-9`  | `tsir cache:*` commands (`cache:probe`, `cache:clear --store`)           | `[x]`  | `CACHE-6` | Probe prints per store; clear requires the store name (never "all" by default)                         |
| `CACHE-10` | Config: `cache.stores` in `tsir.js` + schema                             | `[x]`  | `CACHE-1` | Unknown driver and unknown default fail with a message naming the declared ones                        |

### As built: the `database` driver (`CACHE-6`)

`@tsir/cache/database` takes an app-supplied `CacheSql` — `{ capabilities, query }` — which
`@tsir/database`'s `Database` satisfies **structurally**, so the package gains no dependency
and one driver serves D1 and Postgres.

```
cache_entries(key PK, value TEXT, counter BIGINT, expires_at BIGINT)
cache_entry_tags(key, tag, PK(key, tag)) + INDEX (tag)
increment → INSERT … ON CONFLICT (key) DO UPDATE SET counter = COALESCE(counter,0) + excluded.counter RETURNING counter
invalidateTag → COUNT(tag) · DELETE entries WHERE key IN (SELECT key … WHERE tag = ?) · DELETE tags
```

- **A counter is a numeric column.** Arithmetic on a JSON string is not portable and not
  atomic; `StoredValue.counterValue` carries the number back so `get` still returns the
  store's declared type.
- **Placeholders follow the engine** (`?` on D1, `$n` on Postgres) and the driver asserts it.
- **Proven on a real engine, offline**: `database.sqlite.test.ts` runs the dialect through
  `bun:sqlite` — including 50 concurrent increments landing exactly 50, and an
  `EXPLAIN QUERY PLAN` check that tag invalidation uses the tag index rather than scanning.
  `database.integration.test.ts` runs the same statements against Postgres when
  `DATABASE_URL` is set (skipped here — no server).

### As built: the `cloudflare-kv` driver (`CACHE-8`)

KV is the driver that made two capability flags necessary, because most of what a cache
should do is either absent or eventually true on it:

|                  | KV                                 | What the driver does                                                         |
| ---------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| read-your-writes | eventual (up to 60 s cross-region) | advertises `readYourWrites: false`; a `requires` block fails at **boot**     |
| tags             | none                               | refused                                                                      |
| increment        | none atomically                    | refused                                                                      |
| clear            | only by listing the keyspace       | **refused** — new `clearAll: false` capability                               |
| TTL              | minimum 60 s                       | **refused below the floor** (new `ttlFloorMs`), `roundTtlUp: true` to opt in |

Rounding a 10 s TTL up to 60 s looks harmless until the caller is a rate limiter — then it is
a limiter allowing six times the traffic it was asked for. So the default is a refusal, and
the opt-in is one visible flag.

The `expiration` is written as **epoch seconds**, converted once from the absolute deadline
the port computed; `delete` costs one `get` because KV's `delete` cannot report whether the
key existed.

### As built: `redis`, the commands, and the config block (`CACHE-7`, `CACHE-9`, `CACHE-10`)

**`@tsir/cache/redis`** takes an app-supplied `RedisLike` (ADR-0027 § 1), so `make deps` is
still 2 and the fake client _is_ the driver's test. Three details:

- a TTL travels as **`SET … PX ms`**, one round trip — a value that outlives its TTL because
  the second command failed is a cache that quietly becomes a database;
- counters live under `count:<key>` because `INCRBY` needs a bare integer (the Redis version
  of the `database` driver's numeric column), and `write` retires the counter;
- tags are two sets per tag, so invalidation is two `DEL`s and never a `SCAN`; `clear()` needs
  the client's `keys`, so it is a **capability** (`clearAll`) rather than an assumption.

**`tsir cache:*`** — `cache:table` prints the DDL the `database` driver queries (per engine),
`cache:probe` opens every store and **exits 1 when any fails** (a pipeline gate, not a
report), and `cache:clear` requires `--store` and does nothing without `--yes`: there is no
`--all`, because the store that needs clearing is always known to the person running it.

**`cache.stores`** in `tsir.js` is validated by `cachesFromConfig`: an unknown driver is
`CAP_DRIVER_MISSING` listing the shipped ones, an unknown `default` is `CAP_UNKNOWN_DEFAULT`
listing the declared ones, and a driver needing an app-supplied client (`database`, `redis`,
`cloudflare-kv`) names the missing binding. No configuration at all yields one `memory` store
so a fresh project can probe before deciding anything.

### As built: `drivers.gen.ts` (`CAP-003`)

`tsir build` writes `.tsir/drivers.gen.ts`: **one import per driver**, sorted, deduplicated by
driver name across any number of stores or connections, and **factories rather than
instances** — a generated file cannot know the SQL or Redis client an app would pass, and one
that guessed would be a second configuration.

```
cache.stores: { app: memory, sessions: memory, pages: database }
                  │                 │              │
drivers.gen.ts:   └──── one `memory` import ──────┴── one `database` import
```

The refusal is the part that matters: a driver this build does not ship fails `tsir build`
**before anything is written**, naming the store, the driver and the shipped ones. A generated
module that quietly omitted a driver would compile here and fail at boot in production. The
plan is pure (`planDrivers`) so a test can assert on it without a filesystem, and the output is
byte-stable so a diff in that file only ever means a change in configuration.

## `@tsir/queue`

The queue's own task list — port, worker, five drivers, outbox, commands, conformance kit, and
the per-connection triggers — lives in [`queue.md`](./queue.md). The short version: `memory`,
`sync`, `database`, `cloudflare-queues` and `sqs` are all done and conformance-tested; `tsir
queue:work | failed | retry | table` is done; and `queue.connections` is graph input, so a
connection that cannot be triggered on a chosen target — or a broker with no outbox — fails
`tsir build` instead of shipping a Worker that never fires.

### As built: the trigger matrix (`CAP-004`)

| Driver              | Bun        | Workers                     | Lambda                      |
| ------------------- | ---------- | --------------------------- | --------------------------- |
| `database`          | drain loop | `scheduled` → bounded batch | EventBridge → drain         |
| `cloudflare-queues` | —          | native `queue` handler      | —                           |
| `sqs`               | poller     | —                           | native event source mapping |

The matrix is data (`QUEUE_TRIGGER_MATRIX`), so the build's refusals and the docs cannot drift:
`DPL_QUEUE_TRIGGER_MISSING` prints the cell it came from _and_ the targets the driver does run
on. `DPL_QUEUE_OUTBOX_MISSING` refuses a non-transactional connection without `outbox: true` —
the same pairing `createQueues` refuses at boot, so build and boot agree.

### As built: `required` on a queue connection (`CAP-001`)

`required: true` was declared in `ConfiguredConnection` and read by nothing — the kind of option
that looks like it does something until the incident. It now does what it does on a cache store:
the connection is **built at boot**, so its production guard and its client check fire at
startup rather than at the first tick of a cron nobody is watching. The default is still eager
for the original reason, and every unnamed connection is still lazy, so declaring one that is
used nowhere costs nothing.

`CAP-001` is now done for every port that exists: `cache.stores`, `queue.connections`,
`storage.disks` (`STOR-10`, [`storage.md`](./storage.md)) and `mail.mailers` (`MAIL-9`,
[`mail.md`](./mail.md)) are one shape — `default`, named entries, and a name that was never declared
is an error rather than a fallback. `notify` channels are the same mechanism over a port that does
not exist yet, so they are tracked where they will be built (`CAP-NOTIFY-*`) instead of as an open
row here that could only ever mean "not yet".

### As built: the conformance kit covers every shipped driver (`CAP-005`)

`memory` and `null` (cache) and `memory` and `sync` (queue) had no kit run — they were exercised
only through their own tests and through every other test in the repo that happens to use them.
That made the kit's coverage a claim about the drivers with a broker behind them, which is
backwards: `memory` is the driver the rest of the suite runs on, so a defect there makes the
whole suite confidently wrong. Each now runs the kit in the shape it declares — `null` as
`never-store`, `sync` as `inline`, and both queue drivers as `broker` (they own their lease,
unlike the two platform drivers).

## Rules that apply to every module here

- **No capability package is imported by a Phase 1–6 package.** The boundary tool enforces it.
- **A capability names its store/connection in every error and every metric.** Anonymous
  aggregates are how "the cache is slow" becomes unanswerable.
- **Refusal beats emulation.** If a driver cannot do it correctly, the operation throws
  `CAP_UNSUPPORTED_OPERATION` rather than approximating it (§ 4.1 on tags, § 4.2 on outbox).
- **Nothing ships without a conformance case.** A driver that only passes its own tests is a
  driver whose contract is whatever it happens to do.

## Still open in `15-capabilities.md`

Answered and recorded in ADR-0027: `Q36`, `Q37`, `Q38`, `Q46`. Answered by the as-built queue:
`Q47` — one worker process per connection, chosen by `--connection`, which is what the
per-connection triggers assume.

Still open, each with the phase it blocks: `Q39` (mail/notify merge — Gate P7), `Q40`
(Cloudflare Email Sending in beta — mail), `Q48` (dynamic stores per tenant — post-Phase 7).
