# 15 — Capabilities: Cache, Queue, Mail & Notifications

> `@tsir/cache`, `@tsir/queue`, `@tsir/mail`, `@tsir/notify` — and the driver mechanism `@tsir/storage`,
> `@tsir/schedule`, `@tsir/pulse` and `@tsir/auth` (sessions) reuse. Phase 7.
>
> **Status (2026-10-29):** built. All ten modules ship with drivers, conformance kits and CLI
> commands; the mechanism is [ADR-0027](../decisions/0027-capability-drivers.md). The registry,
> default-resolution and capability rules below are the ones in the code. What is still a claim
> rather than a measurement is cross-target behaviour — `make coverage` proves per-package lines,
> `make verify-dist` proves bundles, and no capability module has been booted on a real Worker or
> Lambda.

---

## 0. Why this document exists

Phase 7 was, until now, ten package names in a table and one sentence each ("Driver-based cache").
That is enough to sequence the work and not enough to build it. The questions it left unanswered are
exactly the ones that decide the design:

- Which driver is the **default**, and is it the same on Bun, Workers and Lambda?
- Is "Cloudflare services first" a good default, or a trap?
- Where does the driver live — another package, a subpath export, or a string in `tsir.js`?
- What happens when a driver cannot honour an operation the API exposes?

The answers below follow from three constraints already fixed elsewhere: **Postgres-first**
(`05-database.md`), **tree-shaking is mandatory** (ADR-0012), and **deploy topology defaults to
separate units** (ADR-0005).

---

## 1. Vocabulary (because "driver" is doing four jobs)

Laravel calls everything a "driver" and gets away with it because PHP has no bundle size and one
process per request. Tsir cannot. The words matter here:

| Term           | Meaning                                                                         | Example                                                      |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Port**       | The interface the application code depends on. Owned by the capability package. | `Cache`, `Queue`, `Mailer`, `Notifier`                       |
| **Driver**     | A concrete implementation of a port, selected by config.                        | `cache/database`, `queue/sqs`, `mail/cloudflare`             |
| **Transport**  | A lower-level client a driver is built on.                                      | `postgres.js`, a Workers binding, `fetch`                    |
| **Channel**    | A delivery route for a notification (`@tsir/notify` only).                      | `mail`, `database`, `sms`, `push`, `webhook`, `chat`         |
| **Capability** | A declared, machine-readable property of a driver.                              | `atomicIncrement`, `readYourWrites`, `minTtlMs`              |
| **Trigger**    | What makes queued work actually run on a target.                                | a drain loop, a `scheduled` handler, an event source mapping |

A driver is **not** a plugin the application implements at runtime. It is a subpath export that is
statically imported, for the same reason `tsir.js` is compiled rather than evaluated at boot.

---

## 2. The mechanism: ports, subpath drivers, declared capabilities

```ts
// application code — depends on the port, never on a driver
constructor(private readonly cache: Cache) {}

await this.cache.remember('user:42', 60_000, () => this.users.find(42));
```

```ts
// tsir.js — names the driver; the CLI generates a static import
cache: { driver: 'database', table: 'cache_entries' },
```

Package shape follows ADR-0004's precedent for `@tsir/link` — one package, per-driver entrypoints:

```
@tsir/cache            → the port, memory + null drivers (no dependencies)
@tsir/cache/database   → the Postgres driver (depends on @tsir/database)
@tsir/cache/redis      → optional, separate manifest under ADR-0012
```

**Driver selection is static.** `tsir.js` names a driver string; `tsir build` emits a
`drivers.gen.ts` that imports exactly the chosen drivers. There is no runtime map from
`'redis'` → `import('@tsir/cache/redis')`, because a runtime map is a bundle-size liability and a
supply-chain surface that config could silently add to. A probe in `verify-dist` asserts that
importing `@tsir/cache` alone pulls no Drizzle and no database client.

### 2.1 Capabilities are declared, checked, and enforced

This is the part that prevents the usual "works until it doesn't" driver experience. Every driver
publishes a record:

```ts
const capabilities = {
  readYourWrites: true, // false on Workers KV
  atomicIncrement: true, // false on Workers KV — silently wrong for rate limiting
  minTtlMs: 1_000, // 60_000 on Workers KV
  sharedAcrossInstances: true, // false for the memory driver
  tags: true, // false on Redis without a workaround
} as const satisfies CacheCapabilities;
```

Boot validates the _application's_ usage against the _driver's_ record. Declaring
`rateLimit: { store: 'cache' }` on a driver with `atomicIncrement: false` fails at startup with
`CAP_UNSUPPORTED_OPERATION` and names the alternative driver. It does not degrade to a
non-atomic read-modify-write and hope.

Where a capability cannot be checked statically (a caller invoking `.increment()` on an
injected `Cache`), the call throws. **Silent semantic downgrade is the failure mode this whole
section exists to prevent** — a cache that is occasionally stale is merely slow; a counter that is
occasionally wrong is corrupt.

### 2.2 Stores and connections: many of one port (ADR-0019)

A port has **one contract and many connections**. Naming a single driver in `tsir.js` was enough to
start and wrong for anything real: a `sessions` store that must be shared correctly beside a `pages`
store that only needs speed; a `heavy` queue drained by a different worker with a different
concurrency; a `sync` connection for tests that must never be selectable in production.

```js
// tsir.js
cache: {
  default: 'app',
  stores: {
    app:      { driver: 'database' },                  // Postgres default
    sessions: { driver: 'database', table: 'sessions', required: true },
    pages:    { driver: 'cloudflare-kv', ttlFloorMs: 60_000 }, // readYourWrites: false — fine for pages
    local:    { driver: 'memory' },                    // development only
  },
},
queue: {
  default: 'default',
  connections: {
    default: { driver: 'cloudflare-queues' },
    heavy:   { driver: 'sqs', queueUrl: { fromEnv: 'HEAVY_QUEUE_URL' } },
    sync:    { driver: 'sync' },                       // tests / make dev
  },
},
```

```ts
await this.cache.store('sessions').remember(key, ttl, fn);   // Cache — same port, that store
await this.queue.connection('heavy').dispatch(sendReport, payload);
constructor(@InjectCache('sessions') private readonly sessions: Cache) {}
```

Rules:

- **The key is a purpose, the driver is a property.** The same driver twice is normal
  (`app` and `sessions` both `database`, different tables).
- **`default` is explicit; unknown names throw.** `cache.store('sessons')` →
  `CAP_UNKNOWN_STORE`; `queue.connection('hvy')` → `CAP_UNKNOWN_CONNECTION`. Never a silent fallback
  to the default: a rate limiter that quietly lands on the wrong store is the failure this document
  exists to prevent.
- **Capabilities are per store, not per driver — and are checked at boot.** A requirement such as
  `requires: { cache: { store: 'sessions', readYourWrites: true } }` fails at startup with
  `CAP_UNSUPPORTED_OPERATION` naming the store _and_ the driver. This is the whole reason the
  registry exists: `app` may be a KV store while `sessions` is a database store, and only a
  per-store check can tell them apart.
- **A store's driver set still compiles statically.** Two stores on one driver emit one import in
  `drivers.gen.ts`; `tsir build` refuses a store naming a driver that is not in the manifest.
- **Production guards are per store.** `memory` / `sync` / `null` are refused in production on the
  _default_ connection and on anything a `requires` block names; a `local` memory store that no
  production code path resolves is allowed, because forbidding it outright would push developers to
  fake a database in local dev.
- **Queue connections carry their trigger.** Each connection is drained by exactly one trigger in
  the deploy graph (§ 4.2); `tsir build` fails if a connection has no trigger on the chosen target,
  or if a non-transactional connection has no outbox.
- **The store/connection name is an observability dimension**: cache hit/miss metrics and queue
  dispatch metrics are labelled with it, never aggregated into one anonymous number.

Mail and storage use the same shape (`mail.mailers`, `storage.disks`) so there is one mechanism to
learn, one failure-mode table, and one place where "which one did this use?" is answerable.

---

## 3. Where the default comes from

The question "should Cloudflare be the default driver" has a more useful answer than yes or no.

### 3.1 What Laravel actually does

Worth stating precisely, because it is the model being borrowed:

- **Cache** — default store is `database` (Laravel 11+; previously `file`). Drivers: database, redis,
  memcached, dynamodb, file, array, null.
- **Queue** — default connection is `database` (Laravel 13.x ships `QUEUE_CONNECTION=database`;
  earlier versions defaulted to `sync`). Drivers: database, redis, sqs, beanstalkd, sync, deferred.
- **Session** — default driver is `database`, for the same reason.
- **Mail** — default transport is `log`/`smtp` depending on scaffold; drivers: smtp, ses, postmark,
  resend, sendmail, log, array.
- **Notifications** — _not_ driver-based. Channels: mail, database, broadcast, vonage, slack.

So the precedent is not "pick the vendor's own services first". It is **the one durable store the
application already has, then everything else as an opt-in**. Laravel can default cache to
`database` because every Laravel app has a database. That is the property worth copying — not the
specific driver.

### 3.2 The resolution order (Tsir)

```
1. tsir.js names a driver            → wins, always
2. deploy adapter supplies defaults  → per unit, per target
3. portable fallback                 → D1 + Queues + outbox on Workers, Postgres elsewhere
4. development fallback              → memory / sync / log, no services required
```

Two rules keep this honest:

- **`make dev` needs no cloud account and no Docker.** The dev fallback is the only case where a
  default is allowed to be "not production-grade", and it is reachable only when
  `NODE_ENV !== 'production'` or the driver is explicitly `dev`. Production boot with an
  unresolved default fails; it never silently picks the memory driver.
- **Mail has no portable production default.** The dev default (`log`) writes the message and never
  sends it. In production, `mail.driver` must be explicit — the one place where "it should just
  work" is the wrong instinct, because the failure is silent and the recipient is a real person.

### 3.3 Should Cloudflare be the default?

**On the Workers target, yes — where the semantics survive. Not as a portable default. Not for
caching.**

| Capability               | Cloudflare-first?                            | Why                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| database                 | **Yes — Hyperdrive, or D1**                  | Hyperdrive is Cloudflare's recommendation for reaching _an external Postgres_. D1 is the other answer — a Cloudflare-native SQLite engine. ADR-0016 decides which; a D1 default is an engine change (SQLite, no interactive transactions), not a driver swap. |
| storage                  | **Yes — R2**                                 | S3-compatible API, zero egress. The `s3` driver with an R2 endpoint _is_ the R2 driver; no special case needed.                                                                                                                                               |
| queue (volume path)      | **Yes — Queues**                             | Native, at-least-once, DLQ, no egress. But see § 4.3: it breaks transactional enqueue.                                                                                                                                                                        |
| queue (correctness path) | **Postgres, or a D1 outbox**                 | The enqueue must be atomic with the business write. On D1 that means a transactional outbox written in the same `batch()` as the business row, then pumped to Queues (ADR-0016 § 1.5).                                                                        |
| mail                     | **Watch — Email Sending is public beta**     | Real and usable (Workers Paid: 3,000/mo, 5 MiB, 50 recipients), but beta plus a plan requirement is not a default anyone should be surprised by.                                                                                                              |
| cache                    | **No — KV is the wrong shape. D1 is right.** | KV has no atomic increment and a 1 write/sec/key ceiling. D1 has both solved; use a separate `CACHE` database so it does not share the app database's single query slot (ADR-0016 § 1.4).                                                                     |
| notify                   | n/a                                          | Channels, not drivers (§ 6).                                                                                                                                                                                                                                  |

**Why KV must not be the cache default** — three documented properties, any one of which
disqualifies it as a general cache:

1. **Eventual consistency**, up to 60 s across locations, with no read-your-writes guarantee
   ([docs](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).
2. **One write per second per key**, above which writes return 429
   ([write API](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
3. **No atomic operations** — Cloudflare's own docs redirect to Durable Objects
   ([docs](https://developers.cloudflare.com/kv/concepts/how-kv-works/)).

A cache API with `put`, `get`, `delete` and `increment` maps onto KV in a way that compiles and is
wrong. The `cloudflare-kv` driver therefore exists, declares `readYourWrites: false`,
`atomicIncrement: false`, `minTtlMs: 60_000`, and is selectable — never default.

---

## 4. Module decisions

### 4.1 `@tsir/cache`

The table is **per store** (§ 2.2): each entry in `cache.stores` picks one driver, and the "Default"
column describes the store named by `cache.default` — a project routinely runs three stores on two
drivers at once.

| Driver          | Target      | Default          | Notes                                                                                                                                                      |
| --------------- | ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d1`            | Workers     | **default**      | A **separate `CACHE` D1 database** so it never shares the app database's single query slot. Atomic `increment` via `UPDATE ... RETURNING` (ADR-0016 § 1.4) |
| `database`      | Postgres    | postgres default | Table `cache_entries(key, value, expires_at, tags)`; atomic `increment` via `UPDATE ... RETURNING`                                                         |
| `memory`        | all         | development      | Per-isolate. `sharedAcrossInstances: false` — never a production default                                                                                   |
| `cloudflare-kv` | Workers     | no               | Semantics above                                                                                                                                            |
| `redis`         | Bun, Lambda | no               | Separate manifest; ADR-0012 review required                                                                                                                |
| `null`          | all         | tests            | Always misses; asserts no read depends on cache warmth                                                                                                     |

Values are serialized explicitly (`JSON` codec, or a registered codec per key prefix). No implicit
`JSON.parse` of unknown payloads — the same rule as `05-database.md` codecs and `13-observability.md`.

**As built (2026-10-28).** `@tsir/cache` is complete for this phase: the port, the
`json`/`text` codecs, five drivers — `memory`, `null`, `database` (D1 + Postgres),
`redis` and `cloudflare-kv`, the last two with app-supplied clients/bindings (ADR-0027) — a
conformance kit that runs as data, `cache.stores` in `tsir.js`, and `tsir cache:table`,
`cache:probe` (exit 1 on any failing store) and `cache:clear --store`. The `database` driver
is where `tags` and `increment` are real; `cloudflare-kv` is where the refusals are — no
read-your-writes, no tags, no increment, no `clear`, and a 60 s TTL floor it refuses to round.

**Invalidation must be explicit.** `tags` are implemented with a real index in the `database`
driver and refused (`CAP_UNSUPPORTED_OPERATION`) elsewhere, rather than emulated with `SCAN`/`KEYS`,
because a pattern-delete that is O(keyspace) is a production incident waiting for load.

### 4.2 `@tsir/queue`

The API is small: `dispatch(job, payload, options)`, `schedule(at)`, `cancel(id)`. The driver
decides _where the message lives_; the **trigger** decides what runs it, and the trigger belongs to
the deploy adapter, not the queue.

Connections (§ 2.2) make that split explicit: `queue.connection('heavy').dispatch(...)` chooses the
store _and_ therefore the trigger, and a worker is configured for a connection, not for "the queue" —
`tsir queue:work --connection=heavy`. A job may declare its preferred connection
(`static readonly connection = 'heavy'`), but the declaration is checked at dispatch against the
registry; an undeclared name is `CAP_UNKNOWN_CONNECTION`, not a quiet trip to the default queue.

| Driver              | Target      | Default          | Delivery                                                                                                                                       |
| ------------------- | ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`          | Postgres    | Postgres default | at-least-once, `SELECT ... FOR UPDATE SKIP LOCKED`                                                                                             |
| `cloudflare-queues` | Workers     | **default**      | at-least-once, no ordering guarantee. Always paired with the D1 outbox — Queues cannot be enqueued atomically with a D1 write (ADR-0016 § 1.5) |
| `sqs`               | Lambda, Bun | opt-in           | at-least-once; FIFO queues available                                                                                                           |
| `sync`              | all         | development      | runs inline, for tests and `make dev`                                                                                                          |

**Why an outbox, not a direct dispatch** — D1 has no interactive transactions, so a job cannot be
enqueued inside the write that caused it. `batch()` _is_ atomic, so the business row and the outbox
row commit together:

```ts
// one atomic batch: the order and its outbox row land together, or neither does
await db.batch([
  db.insert(orders).values(order),
  db.insert(outbox).values({ id, job: 'SendReceipt', payload }),
]);
```

Without the outbox, the enqueue is a second, independent write: it can succeed after a rollback (a
receipt for an order that does not exist) or fail after a commit (an order with no receipt). The
**transactional outbox** — already in `@tsir/events`' package scope — is the only way to recover that
guarantee on a broker, and on D1 it is not optional. The rule is:

> Every non-transactional queue driver requires the outbox. **On the default Cloudflare stack that means always.** `tsir build` refuses
> `queue.driver: 'sqs'` without `@tsir/events` enabled, because the alternative is a plan that looks
> fine and loses messages.

**Triggers per target** — this is the coupling that `08-deploy.md` must emit, and the reason a
queue driver cannot be chosen independently of the topology:

| Driver              | Bun                                                                        | Workers                                    | Lambda                              |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| `database`          | `tsir queue:work --connection` per connection (owned by `make dev`/`kill`) | `scheduled` handler drains a bounded batch | EventBridge schedule → invoke drain |
| `cloudflare-queues` | —                                                                          | native `queue` handler                     | —                                   |
| `sqs`               | poller loop                                                                | — (needs SQS HTTP API + a scheduled drain) | native event source mapping         |

Applied **per connection** (§ 2.2), this table is what the deploy graph emits: a project with a
`default` Queues connection and a `heavy` SQS connection gets two triggers in the same Worker bundle,
each bound to its own queue and drained by its own handler. A connection with no trigger on the
chosen target fails `tsir build`, and so does a worker pointed at a connection the target cannot
reach.

The Lambda + `database` combination is viable but pays for an invoke every interval even when idle.
That is a real cost, not a footnote — it is the honest reason a Lambda team might choose `sqs` plus
the outbox, and the docs should say so in exactly those terms.

Reliability features that are **required**, not optional (Gate P7): retries with exponential
backoff, a dead-letter table with a replay command, idempotency keys, and graceful drain on
`SIGTERM` bounded by `shutdownTimeoutMs` (`03-core.md` § lifecycle). Workers has no `SIGTERM`;
the drain bound becomes the invocation's remaining time.

### 4.3 `@tsir/mail`

Two-step by design: `Mailer` composes and sends; it does not queue. Queuing is `@tsir/queue`'s job,
composed in `@tsir/notify` or by the caller. A mail package that silently queues creates an
invisible dependency on a worker being alive.

| Transport             | Target      | Default                         | Notes                                                                                       |
| --------------------- | ----------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `log`                 | all         | **development**                 | Writes the message, sends nothing. Refuses to boot in production                            |
| `cloudflare`          | Workers     | Workers default when configured | Email Sending binding; **public beta**, Workers Paid, 3,000/mo, 5 MiB, 50 recipients        |
| `resend` / `postmark` | all         | —                               | `fetch`-based, edge-safe. Needs an ADR-0012 review each                                     |
| `ses`                 | Lambda, Bun | —                               | SigV4 signing; no `node:` crypto on Workers → not an edge transport                         |
| `smtp`                | Bun, Lambda | —                               | Raw TCP. `node:net` exists on Workers under `nodejs_compat`, but treat as unsupported there |
| `memory`              | all         | tests                           | Collects messages for assertions                                                            |

Templates are a separate concern from transport and stay in `@tsir/mail` core: typed template
parameters, no string-concatenated HTML from user data, and an explicit escaping boundary (see
`14-security.md`).

**As built (2026-10-29).** `@tsir/mail` is complete for this phase: the port, seven transports, the
template layer, a conformance kit and `tsir mail:mailers|test|preview`
([`tasks/mail.md`](../tasks/mail.md)).

| Transport    | Delivers | HTML | Attachments | Tags | Notes                                                                   |
| ------------ | -------- | ---- | ----------- | ---- | ----------------------------------------------------------------------- |
| `log`        | no       | yes  | yes         | no   | Development default. Prints the message; **refused in production**      |
| `memory`     | no       | yes  | yes         | yes  | Collects for tests; also refused in production                          |
| `cloudflare` | yes      | yes  | yes         | no   | Email Sending binding; 50 recipients per message, checked before send   |
| `resend`     | yes      | yes  | yes         | yes  | `fetch`, no SDK, base64 attachments                                     |
| `postmark`   | yes      | yes  | yes         | no   | `Tags: false`: Postmark has one `Tag`, and a map would drop all but one |
| `ses`        | yes      | yes  | yes         | yes  | SES v2 raw MIME, SigV4 reused from `@tsir/storage` — no AWS SDK         |
| `smtp`       | yes      | yes  | yes         | no   | Protocol over an injectable connection; `node:net` only in the adapter  |

**`delivers` is a capability, not a comment.** `log` and `memory` reach nobody, so `production: true`
refuses one as the default or as a `required` mailer (`MAIL_FORBIDDEN_IN_PRODUCTION`) — the same
argument § 6.1 makes for a `memory` disk, and a stronger one: a password-reset link written to a
terminal is a user who cannot get in.

**A `false` capability refuses before the request.** `mailer.send({ …, tags })` on a `postmark`
mailer is `MAIL_UNSUPPORTED_OPERATION` naming the transport and the feature — never a message that
arrives without the thing the caller asked for. Every transport declares the same five facts
(`delivers`, `html`, `attachments`, `customHeaders`, `tags`), and `mailConformance` proves a
transport's declarations against the mailer's own check.

**Two-step, still.** `send` composes, checks and sends: no queue and no retry inside the package,
because a mailer that silently queues creates an invisible dependency on a worker (`§ 4.3`), and a
mailer that retries multiplies whatever the queue already did. `mail:test` is the check that a
project's credentials, sender domain and transport agree — one message, one exit code.

**Addresses are the injection boundary.** A newline in an address or a display name is a second
header, so `parseAddress` parses and refuses control characters, unbalanced brackets, quoted local
parts and reserved header names **before** any transport exists (`MAIL_INVALID_ADDRESS`). The same
rule keeps `Bcc` out of the written message: recipients are the envelope's business.

**Templates stay in core**, as this section promised: `defineTemplate<Data>` types the data,
`html` escapes every interpolation and `raw()` is the one visible way around it, and
`tsir mail:preview` renders a template's `sample` (or `--data` JSON) so a template is loadable with
no database and no customer.

**Q40 is still open and still matters:** Cloudflare Email Sending is in public beta (3,000/month,
5 MiB, 50 recipients), so `cloudflare` is a configured transport and not the Workers default. When it
leaves beta the default changes in `mailersFromConfig` and nowhere else.

**Q39 (merge `mail` and `notify`) is answered by shipping them separately:** `notify` is channels
over transports, and a channel worth having (`database`, `webhook`, `sms`) is not a mailer. The
merge would put a Twilio client inside the package that sends receipts.

### 4.4 `@tsir/notify`

Channels, not drivers — and this is worth copying from Laravel precisely because Laravel got it
right. The driver question reappears one level down, per channel:

| Channel    | Backed by                              | Requirement                    |
| ---------- | -------------------------------------- | ------------------------------ |
| `mail`     | `@tsir/mail`                           | module enabled                 |
| `database` | `@tsir/database` (in-app inbox table)  | module enabled                 |
| `webhook`  | `fetch` + `@tsir/link` signing         | URL allowlist, signed payloads |
| `sms`      | provider drivers (twilio, …)           | explicit config only           |
| `push`     | provider drivers (web-push, FCM, APNs) | explicit config only           |
| `chat`     | slack/discord webhooks                 | explicit config only           |

Defaults: `database` + `mail` if those modules are present, and **nothing else** — an SMS that
costs money must never be enabled by a default. Notifications are queued by default (unlike
Laravel's opt-in `ShouldQueue`), because on Tsir the queue is transactional, so "queue it" costs
correctness nothing and buys the request path a great deal.

**As built (2026-10-29).** `@tsir/notify` is complete for this phase: the channel port, six
channels, the notifier, queued delivery, a conformance kit and `tsir notify:channels|preview|test`
([`tasks/notify.md`](../tasks/notify.md)).

| Channel    | Delivers | HTML | Attachments | Backed by                                              |
| ---------- | -------- | ---- | ----------- | ------------------------------------------------------ |
| `mail`     | yes      | yes  | yes         | A `@tsir/mail` mailer (four members of one, as a port) |
| `database` | yes      | no   | no          | `notification_inbox`, one row per delivery             |
| `webhook`  | yes      | no   | no          | Signed POST to a host on `allowHosts`                  |
| `chat`     | yes      | no   | no          | Slack/Discord incoming webhook (configured URL)        |
| `sms`      | yes      | no   | no          | Provider port; `twilio` ships; E.164 only              |
| `memory`   | **no**   | yes  | yes         | A list, for tests — refused in production              |

`push` is not built: FCM v1 needs a service-account JWT and APNs needs HTTP/2 with a key, and both
are credential formats ahead of a user asking for them. The port is the seam (`defineChannel`), and
[`tasks/notify.md`](../tasks/notify.md) records the decision rather than leaving it to be inferred.

**Queued by default, and the queue is a port.** `send` needs `Pick<Queue,'connection'|'dispatch'>`
— the same slice `@tsir/events` takes — and a notifier built without one **refuses** a queued
notification (`NOTIFY_NO_QUEUE`) instead of quietly sending inline. The two escape hatches are named
in the error: `{ immediately: true }` for one send, `queued: false` on the declaration.

**One job per channel, named for the destination** (`notify:deliver:mail`). A provider outage then
retries the email and not the webhook that already arrived, and `tsir queue:failed` reads like a
list of destinations. The delivery id (`<dispatch>:<channel>`) is the idempotency key, which is what
makes a retried inbox insert a no-op rather than a duplicate row — `INSERT OR IGNORE` on D1,
`ON CONFLICT (id) DO NOTHING` on Postgres.

**Payloads are built and checked before anything is queued**, and validated _again_ at delivery
because a queue is a JSON boundary. The notification owns the payload (the same fact is a subject, a
title and an event name), the channel owns the destination, and neither knows the other's business —
which is what makes a channel swappable and a notification previewable.

**`webhook` is the only channel whose destination comes from data**, so it is the only one with an
allowlist: mandatory at construction, `https:` unless the project says otherwise, no credentials in
the URL, and a body signed as `t=<seconds>,v1=<hex>` over `${t}.${body}` so a receiver can tell a
replay from a delivery. `verifySignature` ships with it, because the receiver needs it.

**`delivers` is a capability here too.** `memory` is `false`, production refuses it as a target, and
`tsir notify:channels` warns about every notification that uses it — the same rule `log` gets in
`@tsir/mail § 4.3`, applied one level up.

### 4.5 `@tsir/events`

Events are the other half of the queue's transactional story, and the half that owns the outbox.

Two paths, and the difference between them is the whole module:

| Path                                 | What it guarantees                                                                                                           | Use it when                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `events.dispatch(event, payload)`    | `sync` listeners run inline (their failure is yours); `queued` listeners become jobs                                         | a transactional driver, a dev `memory`/`sync` connection     |
| `publisher.record(…)` then `relay()` | the delivery is written **in the caller's `batch()`**, so the business row and its consequences commit or roll back together | any non-transactional broker — which on Cloudflare is always |

**Sync vs async is declared, never inferred.** A listener is `sync` (runs inside the caller's
flow) or `queued` (becomes a job, named `event:<event>:<listener>`, on the connection it names).
The two have different failure modes and different owners: a receipt mail that silently became a
job is a support ticket, and a stock reservation that silently ran inline is a transaction held
open on a network call. Both are cheap to prevent at the declaration and expensive to notice in
production, so `mode` is a required part of the contract rather than a heuristic.

Four rules the package enforces rather than documents:

- **An undeclared event is `CAP_UNKNOWN_EVENT`**, not an empty fan-out. "Nobody listened" and
  "you misspelt the event" must not look the same in a log.
- **A `sync` listener on an outboxed event is refused** (`CAP_EVENTS_SYNC_OUTBOXED`). The relay
  runs after the commit, so "inline" would mean inline with nothing; running it at relay time
  would be a queued listener wearing a misleading name.
- **One dispatch id, one delivery id per listener** (`<dispatch>:<listener>`). Sharing one
  idempotency key across listeners would make a backend with real idempotency drop all but the
  first.
- **A `queued` listener is the same job either way** — same name, same payload envelope, same
  attempts — so a retry behaves identically however the event was published.

The outbox table is `queue_outbox` from `@tsir/queue`'s DDL (`tsir queue:table` prints all three
tables); the **writer** lives here, because the queue knows what a message is and does not know
what a delivery means. That split is what lets `tsir build` refuse a broker connection in a
project with no events registry (`DPL_EVENTS_OUTBOX_MISSING`) and be telling the truth: there is
no outbox implementation anywhere else to fall back on.

---

### 4.6 `@tsir/schedule`

A task is **a name, a cron and a handler**. Everything else is a default with an opinion:

```
defineTask({ name: 'hourly', cron: '@hourly', handle: (context) => … })
```

| Default | Value                 | Why it is the default                                                                                                                                                                      |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| overlap | `skip`                | A task that takes four minutes on a every-minute cron stacks four copies by minute four. Overlap prevention is what was almost meant; `allow` is the exception that has to be written down |
| timeout | 300 000 ms            | A cron has no request to time out. A hung task holds its lock until the TTL, which is the _next_ tick's problem                                                                            |
| cron    | parsed at declaration | A bad expression fails where it is written, not at the first tick — where the only evidence is a task that never ran                                                                       |
| time    | UTC, plus an offset   | `utcOffsetMinutes: 480` is 3 AM in Manila, the same on every machine and in every region. A cron that follows the host's `TZ` is a bug                                                     |

Four rules the package enforces rather than documents:

- **`busy` is an outcome, not a failure.** "Skipped because the previous run is still going" and
  "ran and failed" are different pages in an on-call rotation, so they are different statuses
  (`ran` / `failed` / `timeout` / `busy`) and the CLI exits 0 for `busy`.
- **A lock is released on every path, including failure and timeout.** The lock exists to stop
  _overlap_, not to stop the next tick. A crashed process skips the release, and the TTL is the
  crash bound: `timeoutMs + 60 s`.
- **Both day fields restricted is refused.** Crontab reads `0 0 1 * 1` as OR, EventBridge needs
  `?` and keeps one. A cron whose meaning depends on the target is a declaration error with the
  two-task fix in the message — and `toAwsSchedule` now refuses it too, instead of silently
  narrowing it to the day of week.
- **A local hour the platform cannot fire is a build error.** `0 3 1 * *` at UTC+8 is the last day
  of the previous month in UTC; `DPL_CRON_NOT_UTC` names it rather than firing a billing run on
  the wrong day. The shift that _is_ expressible (`0 3 * * *` at UTC+8 → `0 19 * * *`, the same
  instants one UTC day label apart) is emitted, and `deploy:plan --explain` shows both.

**The lock is its own port, not a cache.** This document said the lock would reuse `@tsir/cache`
via its `atomicIncrement` / compare-and-set declaration (§ 6). Building it showed that the cache
port has **no conditional write**: `increment` is atomic but `set` is unconditional, and there is
no compare-and-set, so a cache-backed lock is a read-then-write race wearing the name "mutual
exclusion". Widening five cache drivers to serve one caller was the wrong trade, so the lock became
`LockProvider` — four methods (`acquire`, `release`, `inspect`, `list`), a `shared` capability, and
two drivers:

| Driver         | Targets      | Shared | Notes                                                                                       |
| -------------- | ------------ | ------ | ------------------------------------------------------------------------------------------- |
| `memoryLock`   | dev, tests   | no     | Read-time expiry. `shared: false` is the whole story — see the production guard below       |
| `databaseLock` | d1, postgres | yes    | One statement: `INSERT … ON CONFLICT … DO UPDATE … WHERE expires_at <= ?` returning the row |

`databaseLock` refuses MySQL (`CAP_LOCK_REFUSED`): `ON DUPLICATE KEY UPDATE` has no `WHERE`, so the
conditional take would be a race. `tsir schedule:table` prints the DDL for the engines that work.

**`shared` is a capability, not a hope.** A cron fires in every isolate, so a per-process lock does
not prevent overlap — it reports having prevented it, which is worse than not trying. The scheduler
therefore refuses `production: true` with a non-shared lock whenever a task uses the default
`overlap: 'skip'` (`SCHED_LOCK_NOT_SHARED`, naming the tasks).

**Triggers per target** — the coupling `08-deploy.md` emits:

| Target    | Trigger                                                    | Who builds the `scheduled` handler                                                      |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Workers   | `triggers.crons` + the `scheduled(controller, env)` export | the app: `export const scheduled = (c) => scheduler.scheduled({ at: c.scheduledTime })` |
| Lambda    | `Events::Schedule` → invoke the unit                       | the same entry export, through the adapter                                              |
| Bun / dev | `tsir schedule:work` (`--once` for one tick)               | the console                                                                             |

The app writes that one line itself, deliberately: the handler needs the _lock_, and on Workers the
lock needs a `D1` binding from `env` — plumbing a generated entry cannot do without also owning the
binding lifecycle. Generating it is a decision for `08-deploy.md`, not a shortcut to take here.

`defineTask` names are unique in a project because **the name is the lock key**: two tasks named
`nightly` would share one lock, skip each other, and neither would say so (`createTaskRegistry`
refuses the second). The registry is read from the app entry's `tasks` export — by `tsir schedule:*`
and by `deploymentOf()` — so the crons a project deploys and the tasks a worker runs are one
declaration read twice, never two declarations that drift.

### 4.7 `@tsir/policy`

Roles, permissions and policies — the Laravel shape, with the one addition that makes it usable
outside a controller: **`authorize()` is the API, and it knows nothing about HTTP.**

```
unauthenticated ──▶ deny gates ──▶ allow gates ──▶ declared policy ──▶ role permission ──▶ deny
```

| Concept    | Form                                         | Rule                                                                                            |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Permission | `resource.action` (`post.update`)            | One string, so a role grants exactly what a route names — no translation table to drift         |
| Role       | `defineRole({ name, implies, permissions })` | Implications are depth-first; a cycle is refused **with the closing path**, at construction     |
| Policy     | `(context) => Decision`                      | The only step that sees `data`, so ownership lives here and nowhere else                        |
| Gate       | `deny` / `allow`, checked first              | A suspended account stays suspended; an `allowGate` is the only bypass, and it is a declaration |
| Decision   | `{ allowed, source, reason }`                | A denial cannot be written without a reason; `source` never reaches the client                  |

**The order is fixed, and there is no `after` hook.** A callback that can overturn a denial is how a
policy bug becomes a breach; the one bypass is a gate somebody declared by name, which is visible in
the file and in `matrix()`. A non-decision return is `POL_INVALID_DECISION` and fails **closed**: a
broken rule must not be an open door.

**`toHttpPolicies(registry, { data })` emits a policy for every `registry.refs` entry**, which closes
`@tsir/http`'s behaviour of allowing a route whose policy ref nothing answers; `missing(refs)` is the
same fact as a command-line diagnostic. `require()` is `authorize()` that throws, for the callers
that have no response to write — a job that forgets to check a returned decision is a silent bypass,
and this variant cannot be forgotten.

**As built (2026-10-29).** Six modules, **26 tests**, **92.96 % lines / 88.61 % functions**,
`@tsir/container` as its only dependency ([`tasks/policy.md`](../tasks/policy.md)). Per-call `roles`
**narrow and never widen** a token's privileges, an unknown role in a token grants nothing, and
`permissionsOf` hands back a copy of the effective set — `Object.freeze` does not stop `Set.add`.

### 4.8 `@tsir/auth`

Passwords, sessions, tokens and API keys. The four things an application authenticates with, and the
four things it invents badly when nobody ships them.

| Port             | Shipped drivers                                    | The decision that matters                                                              |
| ---------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `PasswordHasher` | `pbkdf2` (default, WebCrypto), `argon2id` (`/bun`) | The hash names its algorithm, so raising the cost or moving runtime is not a migration |
| `SessionStore`   | `memory`, `database` (D1 + Postgres)               | Rows are keyed by `sha256(token)`; the token is never stored                           |
| `ApiKeyStore`    | `memory`, `database`                               | `tsk_<hex id>_<base64url secret>`; one indexed read, secret compared in constant time  |
| `Guard`          | `session`, `bearer`, `api-key`, `composeGuards`    | A guard answers `Principal                                                             | null` and never explains itself to the client |

**Failures are uniform on purpose.** A wrong password, an unknown user, a bad token and a revoked key
produce one message; the distinction lives in a log line. **Sessions are revoked by deleting the
row**, so a session that merely "was not returned" cannot come back when a clock is corrected. The
cookie is `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` — fixed, because `__Host-`
_requires_ the other three, and it is what stops a compromised subdomain planting a session.

**As built (2026-10-29).** Ten modules plus two subpaths (`/memory`, `/bun`), **87 tests**,
**95.85 % lines / 97.03 % functions** ([`tasks/auth.md`](../tasks/auth.md)). Two findings recorded
there rather than here: the API-key id is **hex** because base64url contains the `_` separator, and a
hash whose algorithm cannot be read is a **coded error**, never "wrong password".

### 4.9 `@tsir/pulse` (observability)

Logging, metrics, tracing and health — not a capability in the sense above (no driver registry, no
config block of its own), so the decisions live in
the [`13-observability.md`](../operations/13-observability.md) plan and [`tasks/pulse.md`](../tasks/pulse.md). It is listed
here because it is the same kind of package: a port (`Sink`, `MetricExporter`, `SpanExporter`,
`HealthCheck`) with implementations that a project chooses, and a **fail-open** contract that is the
telemetry equivalent of § 2.1's capability rule — a driver that cannot work is reported and bypassed,
never allowed to break the request.

**As built (2026-10-29).** Nine modules, **123 tests**, **97.27 % lines / 97.39 % functions**, and the
same single dependency (`@tsir/container`). Three layers of redaction, four wire formats, a
cardinality guard, `traceparent` with parent-based sampling, and readiness with a `degraded` state.

## 5. Driver conformance kit

A driver is not "done" when it works; it is done when it passes the same suite as every other
driver for that port. `@tsir/testing` gains a conformance package:

```ts
import { cacheConformance } from '@tsir/testing/conformance';

cacheConformance({ create: async () => new DatabaseCache(testDb) });
```

The kit asserts behaviour, not implementation: TTL expiry (including sub-second where the driver
declares it), capability honesty (every `false` capability must throw, not degrade), serialization
round-trips including `undefined`/`Date`/`Buffer`, concurrent `increment` under N parallel writers,
and a negative test that the driver refuses operations it declared unsupported.

**Capability honesty is a test, not a comment.** A driver that claims `atomicIncrement: false` must
fail a concurrency test that proves it — otherwise the claim drifts from reality, which is the exact
failure this design exists to prevent.

---

## 6. The other users of this mechanism

Written here so the pattern is decided once:

- **`@tsir/storage`** — drivers `s3` (which covers R2 by endpoint), `local`, `memory`. Default: `s3`,
  pointed at R2 on Workers. **As built (2026-10-29)** — see below.
- **`@tsir/schedule`** — cron definitions; the _trigger_ is the `scheduled` handler (Workers) or
  EventBridge (Lambda). ~~The distributed lock needs the same capability declaration as the cache
  (`atomicIncrement` / compare-and-set), reusing `@tsir/cache`.~~ **Amended in § 4.6:** the cache
  port has an atomic `increment` but no conditional write, so the lock is its own port with a
  `shared` capability and `memory` / `database` drivers.
- **`@tsir/auth` sessions** — needs `readYourWrites: true` and `sharedAcrossInstances: true`. This
  rules out `cloudflare-kv` as a session store on correctness grounds, and it rules out `memory` in
  production. Worth an explicit error, because "sessions sometimes vanish" is the hardest bug class
  to diagnose in production.

### 6.1 `@tsir/storage` as built

The fourth store registry, and the first one whose entries are **disks** rather than connections:
`storage.disks` is `default` + named entries (`CAP-001`), each with a driver, credentials by name
(`{ fromEnv: 'R2_SECRET' }`), and no other meaning. Three drivers, one per runtime shape:

| Driver   | Durable | Shared | Public URLs        | Signed URLs | Filesystem | Why it exists                                                                              |
| -------- | ------- | ------ | ------------------ | ----------- | ---------- | ------------------------------------------------------------------------------------------ |
| `s3`     | yes     | yes    | if `publicBaseUrl` | yes         | no         | **Default.** One driver for AWS and R2 — an `endpoint` switches the URL to path-style      |
| `local`  | yes     | yes    | no                 | no          | yes        | A directory. Atomic writes, a `.tsir-meta` sidecar, `STO_FILESYSTEM_UNAVAILABLE` elsewhere |
| `memory` | no      | no     | no                 | no          | no         | Development and tests; the default when no `storage` block exists at all                   |

**Two decisions the port makes explicit**, both of which are the sort of thing a storage layer
usually guesses:

- **A content type is declared, never sniffed.** `application/octet-stream` is the default, and a
  `put` of a JS string is a `TypeError` naming `utf8()` — silent encoding is how a driver corrupts
  every JPEG while every text test keeps passing.
- **A capability that is `false` throws.** `url()` on a `local` disk is `STO_UNSUPPORTED_OPERATION`
  naming the disk and the driver, not a path that works on the machine and 403s in production. The
  same rule makes `memory` refused as a **default or `required`** disk when `production: true`
  (`STO_FORBIDDEN_IN_PRODUCTION`): an upload that survives the request and not the process is not
  a bug anyone debugs twice.

**`s3` ships no SDK.** Signing Version 4 is written out against WebCrypto (`sigv4.ts`) and checked
against AWS's published vectors — the signing key and the `ListUsers` request — rather than against
a recorded response of our own. R2 is not a fourth driver: it is the same code with an `endpoint`,
which is what § 3 promised and what an SDK per provider would have quietly broken.

**The key is the security boundary.** `assertKey` refuses empty keys, a leading `/`, `\`, control
characters, `//`, `.`/`..` segments and anything over 1024 bytes **before** a driver sees it, and
the `local` driver resolves its root once and re-checks every path against it. Two locks on one
door, because traversals are what a storage layer gets wrong once and then forever.

**`tsir storage:disks|probe|url`** is one command family, not one per backend — the reason § 7
gives for `tsir make:connection` applies to the runtime commands too. `probe` writes, reads back,
compares, deletes, and exits non-zero if any disk failed; `url` returns the public URL when the
disk has one and signs otherwise, with `--expires <seconds>` as the whole difference. `diskConformance`
(`CAP-005`) ships as a subpath so a third-party driver is provable, and it is run over **two**
drivers in this repo so the kit is known to be passable by more than the one it was written against.

What `@tsir/storage` deliberately does not do: multipart uploads (one request, bounded by the
caller's memory), retries (a retry policy belongs to whoever knows whether the write is idempotent),
`copy`/`move` (read then write is the caller's two calls), and image processing. Each is a real
feature; none is one a first version can fake.

---

## 7. Corrections this document forces elsewhere

- `05-database.md` § 2 lists Workers as `postgres.js` under `nodejs_compat` with Hyperdrive. **Hyperdrive's
  documented recommendation is now node-postgres (`pg`)**, with `postgres.js` supported but secondary.
  Either the plan changes the Workers default to `pg`, or it records why Tsir diverges. It cannot
  stay as-is by accident.
- `08-deploy.md` must emit queue **triggers**, not just bindings — see § 4.2.
- `02-monorepo.md` § 2 gains the per-driver entrypoints in the "Binary / entry" column.
- `09-tsir-config.md` needs `cache`, `queue`, `mail`, `notify` blocks with the resolution order in
  § 3.2 — **each shaped as `default` + a named registry (§ 2.2, ADR-0019)**, not a flat
  `{ driver }` object — and `tsir bootstrap` needs to detect a `wrangler.toml` and _suggest_ —
  never silently apply — the Workers defaults.
- `05-database.md` § 3.1 uses the same registry shape for `database.connections`, so one generator
  (`tsir make:connection`) scaffolds a database connection, a cache store, a queue connection or a
  storage disk instead of four near-identical commands.
- `08-deploy.md` must emit one queue **trigger per connection**, and one migrate unit per database
  connection with a journal (§ 5.2 there).

---

## 8. Failure modes

| Failure                                      | Detection                                 | Behaviour                                            |
| -------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Driver can't run on target                   | boot capability probe                     | `CAP_DRIVER_UNAVAILABLE`, names supported drivers    |
| Operation unsupported                        | declared capability + call-time check     | `CAP_UNSUPPORTED_OPERATION`; never a silent fallback |
| Non-transactional queue without outbox       | `tsir build` graph check                  | Build fails with the two-line repair                 |
| Production defaults to `memory`/`log`/`sync` | boot guard on `NODE_ENV`                  | `CAP_DEV_DRIVER_IN_PRODUCTION`, refuses to boot      |
| Driver import bloats an unrelated bundle     | `verify-dist` probe                       | Budget failure with the offending import chain       |
| Job runs twice                               | at-least-once by design + idempotency key | Duplicate suppressed by key; documented, not hidden  |

---

## 9. Security considerations

These are the modules that hold credentials, touch other people's inboxes, and decide who may
do what, so the security rules are per-module rather than one umbrella:

- **Secrets are environment references, never literals** (`{ fromEnv: 'R2_SECRET_ACCESS_KEY' }`),
  resolved by the registry at boot and never stored in `tsir.js`. A connection config that
  contains a credential in plain text is a review rejection, and the resolver is what makes the
  rule real rather than aspirational.
- **Drivers take an app-supplied client** (ADR-0027 § 1), so the framework carries no credential-
  bearing SDK and no dependency that could exfiltrate on import. What the application supplies is
  what the driver can reach.
- **`auth` hashes at rest and never stores a recoverable secret**: PBKDF2 or argon2id for
  passwords, hashes for API keys, `__Host-` cookies for sessions. A session cookie that is not
  `__Host-` prefixed is a subdomain-takeover surface, and the prefix is refused when it cannot be
  honoured (a `__Host-` cookie without `Secure` is silently dropped by a browser — `CAP-P7 F1`).
- **`auth` does not throttle, and says so.** Password verification, session lookup and API-key
  lookup are constant-time but rate-independent: there is no lockout, no exponential backoff and
  no attempt counter in the package. That is deliberate — the right policy depends on the
  deployment (a KV counter on Workers, a row in Postgres, an edge WAF rule) — but it means an
  application that exposes a login form without adding one of those is offering unlimited
  password guesses at full speed. The primitive is `@tsir/cache`'s `increment`; the policy is a
  decision each application has to make. See `CAP-P7 F3`.
- **`policy` fails closed.** An unmapped permission is a denial, `authorize()` throws rather than
  returning a falsy value a caller might ignore, and the audit trail (`HTP-011`) is opt-in
  because a log of every authorisation decision is itself sensitive.
- **`mail` and `notify` treat every address and template variable as untrusted**: header
  injection is blocked at the address boundary (`MAIL-4`), HTML is escaped unless the template
  explicitly says otherwise, and a signed webhook verifies its signature before the payload is
  parsed.
- **`storage` signs rather than proxies.** SigV4 in WebCrypto means a presigned URL is minted
  and handed out; credentials never travel to a browser. The signing helpers behind it stay
  unexported on purpose.
- **`pulse` redacts in three layers** and its sinks fail open — a logger that throws takes the
  request with it. The redaction is the security control; the fail-open is the availability
  trade, stated so it is not mistaken for one.

What is **not** true: none of these modules has had an independent security audit, and the
vault review ([`reviews/`](../reviews)) is the author's own. A capability that handles
credentials in production should be reviewed by someone other than its author first.

---

## 10. Open questions

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Blocks       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Q36 | ~~Redis/`ioredis` on Bun and Lambda: allowlisted, or explicitly unsupported until asked for?~~ **Answered 2026-10-28: app-supplied client, no dependency** (ADR-0027 § 1)                                                                                                                                                                                                                                                                                                                                               | —            |
| Q37 | ~~Does `@tsir/cache/redis` ship in the same package or as `@tsir/cache-redis`?~~ **Answered: subpath; graduates to a package only when it carries a dependency** (ADR-0027 § 2)                                                                                                                                                                                                                                                                                                                                         | —            |
| Q38 | ~~Lambda + `database` queue: scheduled-poll cost, or force `sqs` + outbox?~~ **Answered: `sqs` by default; `database` with `allowScheduledPoll` + a build warning** (ADR-0027 § 3)                                                                                                                                                                                                                                                                                                                                      | —            |
| Q39 | ~~`@tsir/notify` and `@tsir/mail` merge into one package?~~ **Carried to Gate P7 as a _measurable_ question, not decided by taste:** ship both, then compare their dependency sets and transport tables (§ 4.3, § 4.4 as built). The merge is right only if `notify` ends up re-exporting most of `mail`; if a channel worth having (`database`, `webhook`, `sms`) is not a third-party HTTP POST, it is not a mailer. Nothing in `mail` blocks either answer — `Notifier` is a port, `mail` is a transport it can wrap | Gate P7      |
| Q40 | Cloudflare Email Sending leaves beta — does `mail` gain a Workers **production** default? (Today: no. `cloudflare` is a configured transport, and `mailersFromConfig` is the one function that would change — see § 4.3 as built                                                                                                                                                                                                                                                                                        | Phase 7      |
| Q46 | ~~Does a `requires` block validate every store at boot?~~ **Answered: capabilities validate at boot without I/O; backends open lazily; `probe()` is explicit** (ADR-0027 § 4)                                                                                                                                                                                                                                                                                                                                           | —            |
| Q47 | ~~Worker fan-out on Lambda: one worker process per connection, or one process draining `--connection` from argv?~~ **Answered 2026-10-29: one process per connection, chosen by `--connection`** — a worker is bound to a connection, not to "the queue" (`QUEUE-13`), because that is what lets `heavy` have its own concurrency and its own trigger per target; a single process draining everything would merge two failure domains and make the per-connection triggers unusable on Bun                             | —            |
| Q48 | Dynamic stores for tenancy (`cache.store(tenant)`) — allowed through `defineStore`, or application-owned? Mirrors `05-database.md` Q44                                                                                                                                                                                                                                                                                                                                                                                  | Post-Phase 7 |

---

## 11. Task index

[`tasks/07-capabilities.md`](../tasks/07-capabilities.md) — written 2026-10-28. Q36–Q38 are
answered in [ADR-0027](../decisions/0027-capability-drivers.md), so work may be opened against
this document.

Reserved identifiers for the connection work, so it is not renumbered later:

| ID        | Title                                                                                                                                    | Depends                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `CAP-001` | Store/connection registry per port (`cache.stores`, `queue.connections`, `mail.mailers`, `storage.disks`) with `default` and typed names | `15 § 2.2`                |
| `CAP-002` | Per-store capability records + boot validation (`CAP_UNKNOWN_STORE`, `CAP_UNSUPPORTED_OPERATION` naming store and driver)                | `CAP-001`                 |
| `CAP-003` | `drivers.gen.ts` emits one import per driver regardless of how many stores use it                                                        | `CAP-001`                 |
| `CAP-004` | One queue trigger per connection in the deploy graph; `queue:work --connection`                                                          | `CAP-001`, `08-deploy.md` |
