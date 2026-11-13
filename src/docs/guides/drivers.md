# Services, drivers, and defaults

Every capability in tsir is a **port** with several **drivers**, chosen in `tsir.js` by name. This is
the map: what each capability is called, which drivers this build ships, which one you get when you
say nothing, what each driver needs you to supply, and what happens in production.

Two columns carry the weight. **Selectable** answers "can I write this name in `tsir.js`?" — a driver
that is only a constructor is imported in code, never named in config. **Production** is the boot
refusal: a driver whose data dies with the process is refused as the default when the app says
`production: true`, so a missing config fails at boot rather than at 3 a.m.

> The defaults are deliberately the _ephemeral_ ones — `memory`, `log`, `sync`. A generated project
> boots with no services and no credentials, and `production: true` refuses every one of them. That
> is the design: local development should not need a database to render a page, and production
> should not be able to forget that it does.

---

## 1. The map

Ours = the driver ships in this repository. Selectable = the name works in `tsir.js` today.

| Capability         | Port           | Default: Cloudflare → AWS → bun       | Drivers this build ships                                                       | Selectable in `tsir.js`  | Refused in production                           |
| ------------------ | -------------- | ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------ | ----------------------------------------------- |
| **Cache**          | `Cache`        | `cloudflare-kv` → `redis` → `memory`  | `memory`, `null`, `database`, `redis`, `cloudflare-kv`                         | all five                 | `memory`, `null` as default or `required`       |
| **Queue**          | `Queue`        | `cloudflare-queues` → `sqs` → `sync`  | `memory`, `sync`, `database`, `cloudflare-queues`, `sqs`                       | all five                 | `memory`, `sync` as default or `required`       |
| **Mail**           | `Mailer`       | `resend` → `ses` → `log`              | `log`, `memory`, `smtp`, `ses`, `resend`, `postmark`, `sendgrid`, `cloudflare` | all eight                | `log`, `memory` as default                      |
| **Storage**        | `Disk`         | `s3` + R2 endpoint → `s3` → `local`   | `memory`, `local`, `s3`                                                        | all three                | `memory` as default or `required`               |
| **Notifications**  | `Notifier`     | `database` → `database` → `memory`    | `mail`, `database`, `webhook`, `chat`, `sms`, `memory`                         | all six                  | `memory` — any send in production throws        |
| **Broadcast**      | `Broadcaster`  | `durable-object` → `redis` → `memory` | `memory`, `redis`, `pusher`, `durable-object`                                  | **none** yet (`CAP-006`) | nothing yet — no registry                       |
| **Search**         | `SearchEngine` | `typesense` → `postgres` → `memory`   | `memory`, `sqlite`, `postgres`, `typesense`, `meilisearch`, `algolia`          | **none** yet (`CAP-006`) | nothing yet — no registry                       |
| **Media**          | `MediaManager` | `cloudflare` → `sharp` → `sharp`      | `cloudflare`, `cloudinary`, `imagekit`, `sharp`, `ffmpeg`                      | **none** yet (`CAP-006`) | nothing yet — no registry                       |
| **Sessions**       | `SessionStore` | `database` → `database` → `memory`    | `memory`, `database`                                                           | **none** yet (`CAP-006`) | nothing yet — no registry                       |
| **API keys**       | `KeyStore`     | `database` → `database` → `memory`    | `memory`, `database`                                                           | **none** yet (`CAP-006`) | nothing yet — no registry                       |
| **Feature flags**  | `FeatureStore` | `database` → `database` → `memory`    | `memory`, `database`, `null`                                                   | **none** yet (`CAP-006`) | nothing yet — no registry                       |
| **Scheduler lock** | `LockProvider` | `database` → `database` → `memory`    | `memory`, `database`                                                           | **none** yet (`CAP-006`) | nothing yet — no registry                       |
| **Database**       | `Database`     | `d1` → `postgres` → `postgres`        | `d1`, `postgres` (+ `sqlite`, `mysql` — [see § 5](#5-what-is-missing))         | both                     | nothing — a binding or a URL is required anyway |
| **Vault keys**     | `Keyring`      | generated at first run                | `file` (`TSIR_KEYRING_FILE`)                                                   | n/a (one mechanism)      | an absent key refuses to boot                   |

**Two notes the columns hide.**

_Mail's production refusal is real; the "default" column is not a resolution order inside the
package._ A project that declares no `mail` block gets one `log` mailer, and `production: true`
refuses it — that is `mailers.ts`. What the Cloudflare → AWS column means is the driver a
**generated project on that target** is written with, and it is not a fallback the package invents.

_`memory` on `notify` is refused at send time, not at boot._ `createNotifier` checks
`capabilities.delivers` on every selected channel and throws `NOT_FORBIDDEN_IN_PRODUCTION` when the
notifier was built with `production: true` (`notifier.ts:152`). So a memory channel is a boot-clean
configuration that fails at the first delivery — earlier than a silent drop, later than boot. That is
why it is not a default on either cloud target.

**The gap this table makes visible:** five capabilities resolve their driver from `tsir.js`
(`cache`, `queue`, `mail`, `storage`, `notify`) and seven do not — `broadcast`, `search`, `media`,
`sessions`, `api keys`, `feature flags` and the scheduler lock. A `tsir.js` that says
`broadcast: { driver: 'redis' }` is not read by anything; you construct
`redisBroadcaster({ client })` in your app entry instead. That is a real asymmetry, and it is
`CAP-006`, not a documented design; see § 5.

---

## 2. What each driver needs you to supply

A driver is either **self-contained** (no configuration) or needs a **binding** — an object you pass
in code, because the driver refuses to depend on an SDK it would have to tree-shake in anyway
(ADR-0027 § 1). A `{ fromEnv: 'NAME' }` reference is the only way a secret enters config: a literal
secret in `tsir.js` is refused on purpose.

### Cache — `cache.stores.<name>`

| Driver          | Needs                            | Defaults that apply                                                               |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `memory`        | nothing                          | —                                                                                 |
| `null`          | nothing                          | — (every read misses; for tests)                                                  |
| `database`      | `bindings.databases[connection]` | `connection: 'default'`, `table: 'cache_entries'`, `tagTable: 'cache_entry_tags'` |
| `redis`         | `bindings.redis[connection]`     | `connection: 'default'`, no prefix                                                |
| `cloudflare-kv` | `bindings.kv[connection]`        | `connection: 'default'`, `roundTtlUp: false`                                      |

### Queue — `queue.connections.<name>`

| Driver              | Needs                                                                | Defaults that apply                                                                         |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `memory`            | nothing                                                              | —                                                                                           |
| `sync`              | `bindings.executors[connection]`                                     | — (runs the job inline; no `queue:work`)                                                    |
| `database`          | `bindings.databases[connection]`                                     | `connection: 'default'`, `table: 'queue_jobs'`, `deadTable: 'queue_dead'`                   |
| `cloudflare-queues` | `bindings.queues[connection]` **and `outbox: true`**                 | `deadTable: 'queue_dead'` (optional; without it `queue:failed` says "no dead-letter store") |
| `sqs`               | `bindings.sqs[connection]` **and `queueUrl`** and **`outbox: true`** | `fifo: false`; a FIFO queue needs `messageGroupId`                                          |

`outbox: true` is mandatory on the two brokers that cannot enlist in the caller's transaction. It is
a **correctness** rule, refused in development too: without it, an enqueue is a second write, and the
two ways that fails — a receipt for an order that rolled back, an order with no receipt — are both
unrecoverable after the fact.

### Mail — `mail.mailers.<name>`

| Driver       | Needs                                                             | Defaults that apply                                                                   |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `log`        | nothing                                                           | `from` defaults to a local address                                                    |
| `memory`     | nothing                                                           | `from` defaults to a local address                                                    |
| `smtp`       | `host`; `password: { fromEnv }` when `user` is set                | `secure: false`; `port: 587`, or `465` when `secure: true` (implicit TLS vs STARTTLS) |
| `ses`        | `credentials.accessKeyId` and `.secretAccessKey` as `{ fromEnv }` | `region: 'us-east-1'`                                                                 |
| `resend`     | `apiKey: { fromEnv: 'RESEND_API_KEY' }`                           | —                                                                                     |
| `postmark`   | `serverToken: { fromEnv: 'POSTMARK_SERVER_TOKEN' }`               | no `messageStream` unless the account is split into streams                           |
| `cloudflare` | the `EMAIL` binding from the runtime, via `bindings`              | `binding: 'EMAIL'`                                                                    |

Every mailer that delivers needs `from`. A mailer with two credentials and no `default` is an error
listing both, rather than a guess about which one sends a password reset.

### Storage — `storage.disks.<name>`

| Driver   | Needs                                                                                   | Defaults that apply                                                                              |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `memory` | nothing                                                                                 | —                                                                                                |
| `local`  | `root` — the directory, relative to the project                                         | —                                                                                                |
| `s3`     | `bucket`, `credentials.accessKeyId`, `credentials.secretAccessKey` (**never** literals) | `region: 'auto'` (correct for R2, wrong for S3 — set it), `forcePathStyle: false`, no `endpoint` |

`s3` points at R2, MinIO or AWS with the same driver: set `endpoint` and `forcePathStyle: true` for
anything that is not AWS.

### Notifications — `notify.channels.<name>`

| Driver     | Needs                                                                   | Defaults that apply                     |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `mail`     | `mailers` supplied to the same bootstrap                                | `mailer` = the default mailer           |
| `database` | `database` supplied to the same bootstrap                               | `table: 'notification_inbox'`           |
| `webhook`  | `allowHosts` — **required**, an unfiltered webhook is an SSRF primitive | `timeoutMs: 10_000`, `allowHttp: false` |
| `chat`     | `url` (a Slack or Discord incoming webhook) and `provider`              | `timeoutMs: 10_000`                     |
| `sms`      | `accountSid`, `authToken`, `from` (Twilio)                              | —                                       |
| `memory`   | nothing                                                                 | — (records deliveries; for tests)       |

### Constructors — no config file, no defaults to add

These are built in the app entry and handed to a bootstrap. There is nothing to write in `tsir.js`,
which is the asymmetry in § 5.

| Capability     | Constructors                                                                                 | Needs                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Broadcast      | `memoryBroadcaster`, `redisBroadcaster`, `pusherBroadcaster`                                 | a Redis or Pusher client (`trigger` method)                                                                                      |
| Search         | `memoryEngine`, `sqliteEngine`, `postgresEngine`                                             | a query function for the SQL two                                                                                                 |
| Media          | `cloudflareAdapter`, `cloudinaryAdapter`, `imagekitAdapter`, `sharpAdapter`, `ffmpegAdapter` | `accountId` + `apiToken`; `cloudName` + `uploadPreset`; `publicKey` + `privateKey` + `urlEndpoint`; nothing for `sharp`/`ffmpeg` |
| Sessions       | `memorySessionStore`, `databaseSessionStore`                                                 | a SQL port for the database one                                                                                                  |
| API keys       | `memoryApiKeyStore`, `databaseApiKeyStore`                                                   | a SQL port for the database one                                                                                                  |
| Feature flags  | `memoryStore`, `databaseStore`, `nullStore`                                                  | a query function for the database one                                                                                            |
| Scheduler lock | `memoryLock`, `databaseLock`                                                                 | a SQL port for the database one                                                                                                  |

---

## 2.5 When neither Cloudflare nor AWS has it

Two capabilities have no first-party answer on either platform, and inventing one would be the
"memory as an excuse" this table exists to avoid. Both have a settled field, and the drivers are
real:

### Search — Cloudflare has none, AWS has OpenSearch

D1's FTS5 (`sqlite`) is a genuine engine and the free starting point. Past a few thousand rows the
choices that matter are hosted, and 2026 has consolidated on three. All three are `fetch` + a key,
which is why one driver covers them (`hostedSearch({ provider })`):

| Provider        | Free tier                   | ~$/mo at 500K docs | Why it wins                                                  |
| --------------- | --------------------------- | ------------------ | ------------------------------------------------------------ |
| **Typesense**   | 30-day trial, MIT self-host | ~$14–28            | flat node pricing, ~4 ms median, no per-query invoice spikes |
| **Meilisearch** | 14-day trial, MIT self-host | ~$170              | typo tolerance and hybrid/semantic search                    |
| **Algolia**     | 10K records / 10K searches  | ~$655              | the commercial default; merchandising and analytics          |

Default for a Workers deploy is **Typesense**, because flat pricing fits a startup that cannot
predict traffic, and leaving for Algolia or Meilisearch is a config change rather than a rewrite.
AWS defaults to Postgres full-text (no cluster to run) with the same three hosted drivers
available.

### Mail — Cloudflare's is beta, capped, and paid

`send_email` is real, but it is still beta, requires Workers Paid, caps a message at 50 recipients,
and before domain onboarding can only send to verified destinations. That is not a default to be
surprised by on launch day, so the Workers default is **Resend** (3,000/month free, one POST) with
`cloudflare` a selectable driver for projects already committed to the Workers plan. The top three
for transactional are covered: Resend, Postmark (highest deliverability) and SendGrid (the
long-established workhorse, now with a real `content`/`personalizations` shape here). SES covers
AWS.

### Broadcast — nothing hosted, so the platform's own primitive

There is no "WebSocket-as-a-service" worth naming that is not Pusher/Ably (covered as `pusher`).
Workers' own answer is a **Durable Object**: one actor per channel, reachable from every isolate.
That is now `durableObjectBroadcaster`, and the hub class ships as source the app drops into its
Worker entry (`DURABLE_OBJECT_HUB`) — the protocol is the framework's, so a rename cannot silently
break it.

## 3. The DDL you must run

A `database` driver is a table you have to create. Three commands print the exact DDL for the engine
you are on — run the output through your migration tool, do not retype it.

```bash
tsir cache:table      # cache_entries, cache_entry_tags
tsir queue:table      # queue_jobs, queue_dead
tsir schedule:table   # schedule_locks
```

Two more tables have no command yet, and are created by the driver's own `CREATE TABLE IF NOT
EXISTS` on first use, or by your migration:

| Table                | Belongs to                    | Default name         |
| -------------------- | ----------------------------- | -------------------- |
| `notification_inbox` | `notify` `database` channel   | `notification_inbox` |
| `tsir_sessions`      | `auth` `databaseSessionStore` | `tsir_sessions`      |
| `tsir_api_keys`      | `auth` `keysDatabase`         | `tsir_api_keys`      |
| `features`           | `pennant` `databaseStore`     | `features`           |

---

## 4. A production `tsir.js`, block by block

What a Workers deploy looks like when it stops being a prototype. Every block below is the
Cloudflare row of the table in § 1, which is what the target already offers — nothing here adds a
second vendor.

One thing must be on before any of it matters: **`production: true` has to reach the bootstrap.**
The guard lives in the builder, not in the environment, so an app that never passes it has no guard
at all — and today no generated stub passes it. That is the first item in § 5.

```ts
// config/cache.ts — a database store is durable and needs no extra service
export default {
  default: 'database',
  stores: {
    database: { driver: 'database', connection: 'primary', table: 'cache_entries' },
    memory: { driver: 'memory' }, // kept for tests, never the default
  },
};
```

```ts
// config/queue.ts — durable, and the outbox only matters on a broker
export default {
  default: 'database',
  connections: {
    database: { driver: 'database', connection: 'primary', table: 'queue_jobs' },
    // On Workers, replace with: { driver: 'cloudflare-queues', outbox: true }
    // On AWS, replace with: { driver: 'sqs', queueUrl: '…', outbox: true }
  },
};
```

```ts
// config/storage.ts — memory is refused as the default in production
export default {
  default: 'uploads',
  disks: {
    uploads: {
      driver: 's3',
      bucket: 'my-uploads',
      region: 'auto',
      endpoint: 'https://<account>.r2.cloudflarestorage.com',
      forcePathStyle: true,
      credentials: {
        accessKeyId: { fromEnv: 'R2_ACCESS_KEY_ID' },
        secretAccessKey: { fromEnv: 'R2_SECRET_ACCESS_KEY' },
      },
    },
  },
};
```

```ts
// config/mail.ts — log is refused as the default in production
export default {
  default: 'ses',
  mailers: {
    ses: {
      driver: 'ses',
      region: 'ap-southeast-1',
      from: 'no-reply@example.com',
      credentials: {
        accessKeyId: { fromEnv: 'AWS_ACCESS_KEY_ID' },
        secretAccessKey: { fromEnv: 'AWS_SECRET_ACCESS_KEY' },
      },
    },
  },
};
```

The environment variables are the only secrets; nothing above is a credential in the repository.

---

## 5. What is missing

The map above is the state of the code, and it exposes five gaps. They are listed here so the table
is honest, not because they are acceptable.

1. **`production: true` is never passed, so none of the guards above run.** Every refusal in § 1 is
   implemented in the builder (`cachesFromConfig`, `queuesFromConfig`, `mailersFromConfig`,
   `disksFromConfig`, `createNotifier`) and every one of them is keyed on `options.production`.
   No app, no fixture and no generated stub passes it — so an ephemeral default is accepted in
   production today, silently, and the table's whole right-hand column is aspirational until this
   is wired. This is the one gap that makes the others matter.
1. **Seven capabilities cannot be configured by name.** `broadcast`, `search`, `media`, `sessions`,
   `api keys`, `feature flags` and the scheduler lock have constructors but no registry, so `tsir.js`
   cannot select them and `tsir doctor` cannot report them. The five that do have registries
   (`cache`, `queue`, `mail`, `storage`, `notify`) are the ones with a `*_DRIVERS` constant and a
   `driverFor` switch. Closing this is the same five-part change each time: a constant, a switch, a
   `*FromConfig` builder, a bootstrap that reads it, and a `tsir <capability>:drivers` command.
1. **The per-target defaults are data, not yet a resolver.** `DRIVER_DEFAULTS` in `@tsir/core` says
   what each capability converges on per target, and `make check` holds it to "durable on a
   stateless target". Nothing reads it yet: the starter writes `memory` for every block, and
   `tsir doctor` does not print the row. The next step is `tsir new --target cloudflare` writing
   the Cloudflare rows, which is the difference between a default and a documented intention.
1. **`sqlite` as a database engine is still a plan.** `DATABASE_ENGINES` is `['d1', 'postgres']`, so
   a local SQLite file and a Cloudflare Container cannot use the same config shape as D1 even
   though all three speak the same dialect and the proxy dialect already exists. The seam is ready
   — `DbDriver` takes `engine: 'd1' | 'postgres'` and `placeholder`, and the auth and cache SQL
   ports already read both — but the driver is not written.
1. **`mysql` is not supported, and `make:connection` now says so.** It was in the command's list by
   mistake and never in `DATABASE_ENGINES`. Adding it is an engine, not a driver: a third
   placeholder style (`?` like SQLite, but nothing else alike) and a `DATABASE_ENGINES` change that
   every `engine === 'postgres'` branch has to learn about.
1. **Fixed 2026-11-13 — `make:connection` wrote drivers the schema rejects.** `KINDS` listed
   `['d1', 'postgres', 'mysql']` while `DATABASE_ENGINES` was `['d1', 'postgres']`, so
   `--driver mysql` wrote a `tsir.js` that failed at boot, and a typo'd cache, queue, storage or
   mail driver was accepted because those kinds carried no list at all. Every kind now reads its
   package's exported constant, so the command cannot drift from the registry.
1. **Fixed 2026-11-13 — the admin app documented a cache table that does not exist.** Its
   `config/cache.ts` comments said `tsir_cache`; `tsir cache:table` prints `cache_entries`. The
   comment was stale and is corrected. This was a documentation error with a real failure mode:
   the commented-out entry would have created the wrong table.
1. **`broadcast`'s `memory` default leaks.** `createBroadcastBootstrap` appends listeners and never
   releases them (`INF-009`), so its default is the one driver that grows without bound. It has no
   production guard because it has no registry to carry one. The Durable Object driver does not
   leak — it aborts the stream when the last listener leaves — which is another reason it is the
   Workers default.
1. **`broadcast` and `search` ship drivers with no `tsir.js` registry yet.** `BROADCAST_DRIVERS` and
   `SEARCH_DRIVERS` exist and `make driver-defaults` reads them, but nothing in `tsir.js` does:
   today a project wires `durableObjectBroadcaster` and `hostedSearch` in its entry. That is the
   `CAP-006` work below, and these two are next because their defaults are now real services
   rather than `memory`.

### Task index

| ID      | Task                                                        | Where                                        |
| ------- | ----------------------------------------------------------- | -------------------------------------------- |
| `CAP-1` | ~~`mysql` in `make:connection`'s driver list~~ — done       | `make-connection.ts` § 5                     |
| `CAP-2` | ~~Validate every kind's driver from its constant~~ — done   | `make-connection.ts` § 5                     |
| `CAP-3` | ~~Settle the cache table name in one place~~ — done         | `admin.product.com/config/cache.ts`          |
| `CAP-4` | Wire `production: true` from `APP_ENV` into every bootstrap | `plans/tasks/07-capabilities.md` (`CAP-007`) |
| `CAP-5` | `tsir new --target cloudflare` writes the Cloudflare rows   | `plans/tasks/07-capabilities.md` (`CAP-008`) |
| `CAP-6` | Registries for the constructor-only ports                   | `plans/tasks/07-capabilities.md` (`CAP-006`) |
| `CAP-7` | A `sqlite` database driver (`CAP-009`)                      | `src/framework/database/src/`                |
| `CAP-8` | `tsir <capability>:drivers` for every registry              | `plans/operations/11-dx.md` § 2.4            |

### Open questions

| ID    | Question                                                                                 | Status |
| ----- | ---------------------------------------------------------------------------------------- | ------ |
| `Q72` | Should the constructor-only ports get `tsir.js` registries, or is code the better place? | open   |
| `Q73` | `cache` on Workers: KV (fast, convergent) or D1 (consistent, costs a query slot)?        | open   |
| `Q74` | Should `memory` remain a selectable driver at all, or only reachable through a test kit? | open   |

### Failure modes

Every refusal in this guide is a boot failure with a hint that names the fix: `CAP_DRIVER_MISSING`
for a driver name this build does not ship, `CAP_FORBIDDEN_IN_PRODUCTION` for an ephemeral default,
and `CFG_INVALID` for a driver missing a required value. They fire at `production: true`, before the
first request, which is the only time a configuration mistake is cheap.

### Security considerations

Secrets enter config only as `{ fromEnv: 'NAME' }`; a literal credential in `tsir.js` is refused
because `tsir.js` is committed. `webhook` requires `allowHosts` and refuses `http` unless
`allowHttp: true`, so a notification cannot be pointed at an internal address. The `s3` driver never
accepts a credential as a literal, and its `region` default of `auto` is R2-correct and S3-wrong —
setting it explicitly is part of the production checklist above.
