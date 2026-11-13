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

| Capability         | Port           | Default: Cloudflare → AWS → bun       | Drivers this build ships                                                       | Selectable in `tsir.js`            | Refused in production                                                                   |
| ------------------ | -------------- | ------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------- |
| **Cache**          | `Cache`        | `cloudflare-kv` → `redis` → `memory`  | `memory`, `null`, `database`, `redis`, `cloudflare-kv`                         | all five                           | `memory`, `null` as default or `required`                                               |
| **Queue**          | `Queue`        | `cloudflare-queues` → `sqs` → `sync`  | `memory`, `sync`, `database`, `cloudflare-queues`, `sqs`                       | all five                           | `memory`, `sync` as default or `required`                                               |
| **Mail**           | `Mailer`       | `resend` → `ses` → `log`              | `log`, `memory`, `smtp`, `ses`, `resend`, `postmark`, `sendgrid`, `cloudflare` | all eight                          | `log`, `memory` as default                                                              |
| **Storage**        | `Disk`         | `s3` + R2 endpoint → `s3` → `local`   | `memory`, `local`, `s3`                                                        | all three                          | `memory` as default or `required`                                                       |
| **Notifications**  | `Notifier`     | `database` → `database` → `memory`    | `mail`, `database`, `webhook`, `chat`, `sms`, `memory`                         | all six                            | `memory` — any send in production throws                                                |
| **Broadcast**      | `Broadcaster`  | `durable-object` → `redis` → `memory` | `memory`, `redis`, `pusher`, `durable-object`                                  | all four                           | `memory` — `CAP_FORBIDDEN_IN_PRODUCTION`                                                |
| **Search**         | `SearchEngine` | `typesense` → `postgres` → `memory`   | `memory`, `sqlite`, `postgres`, `typesense`, `meilisearch`, `algolia`          | all six                            | `memory` — `CAP_FORBIDDEN_IN_PRODUCTION`                                                |
| **Media**          | `MediaManager` | `cloudflare` → `sharp` → `sharp`      | `cloudflare`, `cloudinary`, `imagekit`, `sharp`, `ffmpeg`                      | all five                           | `sharp`, `ffmpeg` — `CAP_FORBIDDEN_IN_PRODUCTION` (they cannot store what they produce) |
| **Sessions**       | `SessionStore` | `database` → `database` → `memory`    | `memory`, `database`                                                           | `auth.sessions.store` in `tsir.js` | `memory` refused in production                                                          |
| **API keys**       | `KeyStore`     | `database` → `database` → `memory`    | `memory`, `database`                                                           | `auth.apiKeys.store` in `tsir.js`  | `memory` refused in production                                                          |
| **Feature flags**  | `FeatureStore` | `database` → `database` → `memory`    | `memory`, `database`, `null`                                                   | `featureFlags.stores` in `tsir.js` | `database` refused on `mysql`; `memory` refused in production                           |
| **Scheduler lock** | `LockProvider` | `database` → `database` → `memory`    | `memory`, `database`                                                           | **none** yet (`CAP-006`)           | nothing yet — no registry                                                               |
| **Database**       | `Database`     | `d1` → `postgres` → `postgres`        | `d1`, `postgres`, `mysql`, `sqlite`                                            | all four                           | nothing — a binding, a url or a file is required anyway                                 |
| **Vault keys**     | `Keyring`      | generated at first run                | `file` (`TSIR_KEYRING_FILE`)                                                   | n/a (one mechanism)                | an absent key refuses to boot                                                           |

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

**There is no gap left in this table.** Every capability in it resolves its driver from `tsir.js`,
so `tsir doctor` can report what a deployment actually uses and each package's production refusal
has a place to fire. That was not true a few weeks ago: `broadcast`, `search`, `media`,
`featureFlags`, `sessions` and `api keys` were constructors the app entry wired by hand, and a
constructor called from `app.ts` cannot refuse anything — it has no idea whether it is running in
production. Two of those defaults were `memory` stores that deployed happily.
`featureFlags` was the sharpest: the admin app wired `memoryStore` unconditionally, so every rollout
reset on the next deploy and nothing failed.

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
| Sessions       | `memorySessionStore`, `databaseSessionStore`                                                 | a SQL port for the database one; `tsir_sessions` (`sessionTableDdl`)                                                             |
| API keys       | `memoryApiKeyStore`, `databaseApiKeyStore`                                                   | a SQL port for the database one; `tsir_api_keys` (`apiKeyTableDdl`)                                                              |
| Feature flags  | `memoryStore`, `databaseStore`, `nullStore`                                                  | a query function for the database one; a `features` table (`featureTableDdl`, `tsir migrate`)                                    |
| Scheduler lock | `memoryLock`, `databaseLock`                                                                 | a SQL port for the database one                                                                                                  |

---

## 2.5 When neither Cloudflare nor AWS has it

Two capabilities have no first-party answer on either platform, and inventing one would be the
"memory as an excuse" this table exists to avoid. Both have a settled field, and the drivers are
real:

### Database — `database.connections.<name>`

| Engine     | Needs                                    | Defaults that apply                                                   |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `d1`       | `binding`                                | `logging: 'slow'`, `slowQueryMs: 200`, `statementTimeoutMs: 5 000`    |
| `postgres` | `url` (a pooler that speaks HTTP)        | the above; `pool` and `applicationName` are accepted and ignored here |
| `mysql`    | `url` (the gateway's statement endpoint) | the above, plus `databaseName` for the schema                         |
| `sqlite`   | `url` (the file path)                    | the above; opened by `createDatabaseBootstrap`, `:memory:` is allowed |

`postgres` and `mysql` declare `interactiveTx: false`: one HTTP request is one session, so a
transaction begun in one and committed in the next are two different backends. `declare({ requires:
{ interactiveTx: true } })` therefore refuses at boot rather than failing on the request that needed
it. A project that needs transactions on either wants a client that holds a socket — which on
Workers means D1 or Hyperdrive, not these transports.

### Which engines each capability accepts

Four capabilities are tables, and a table's driver writes SQL to a _dialect_. The upsert is where
they diverge: SQLite and Postgres have `ON CONFLICT … DO UPDATE … RETURNING`, and MySQL has
`ON DUPLICATE KEY UPDATE`, which cannot carry the `WHERE` that makes a conditional write
conditional. So the ports are not all interchangeable, and each refuses the engines it cannot serve
**at construction** — a coded error, not a syntax error on the first tick:

| Port                        | Engines                    | Why the others are refused                                                         |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `cache` (`database`)        | `d1`, `postgres`, `sqlite` | the acquire and increment upserts need `ON CONFLICT … RETURNING`                   |
| `notify` inbox              | `d1`, `postgres`, `sqlite` | `ON CONFLICT DO NOTHING`; MySQL's `INSERT IGNORE` also swallows a truncated column |
| `pennant` (`databaseStore`) | `d1`, `postgres`, `sqlite` | `ON CONFLICT (name) DO UPDATE`                                                     |
| scheduler lock              | `d1`, `postgres`, `sqlite` | the conditional upsert; MySQL's form has no `WHERE`                                |
| `queue` (`database`)        | all four                   | plain `UPDATE`/`SELECT` — no upsert syntax                                         |
| `auth` sessions and keys    | all four                   | plain `INSERT`/`SELECT`/`DELETE`                                                   |

`pennant`'s store takes a query function and a `placeholder`, which distinguishes Postgres from
SQLite but **not** Postgres from MySQL — both answer `$1`. That is why it also takes `engine`, and
why the flag alone was never enough.

### Broadcast — `broadcast.connections.<name>`

| Driver           | Needs                           | Defaults that apply                                  |
| ---------------- | ------------------------------- | ---------------------------------------------------- |
| `memory`         | nothing                         | refused when `production: true`                      |
| `redis`          | `bindings.redis[connection]`    | `connection: 'default'`, `prefix: 'tsir:broadcast:'` |
| `durable-object` | `bindings.realtime[connection]` | `connection: 'default'`                              |
| `pusher`         | `bindings.pusher[connection]`   | `connection: 'default'`                              |

### Search — `search.engines.<name>`

| Driver                     | Needs                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `memory`                   | nothing (refused when `production: true`)                                  |
| `sqlite`, `postgres`       | `bindings.databases[connection]` and `collection`                          |
| `typesense`, `meilisearch` | `host`, `collection`, `apiKey` as `{ fromEnv: '…' }`                       |
| `algolia`                  | the above, plus `searchApiKey` when the write key must not reach a browser |

`databaseQuery(connection)` is the adapter that makes a `@tsir/database` connection usable as the
SQL engines' `bindings.databases` entry; it pins the row format the engines read.

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
1. **The registry work is finished (`CAP-018`).** All eleven capabilities resolve a driver by name
   from `tsir.js`: `cache`, `queue`, `mail`, `storage`, `notify`, `broadcast`, `search`, `media`,
   `featureFlags`, `sessions` and `api keys`. What each still lacks is the last piece of the
   five-part change — `tsir <capability>:drivers` — which lists what a build ships without reading
   the source.
1. **The guards run now.** `isProduction()` derives the flag from `APP_ENV`, every bootstrap in
   `src/apps` passes it, and `make production-wiring` fails when a new one does not. Before that
   every refusal in this guide was reachable only from a test.
1. **The per-target defaults are read by the starter (`CAP-008`).** `tsir new --target
cloudflare|lambda|bun` writes one `config/<capability>.ts` per capability from
   `DRIVER_DEFAULTS`, with the row's `requires` as comments and its `why` as the reason — a lambda
   app now starts on Postgres rather than on a D1 binding that nothing injects. Secrets go in as
   `{ fromEnv }` references and the variables are listed in `.env.example`, because the alternative
   was a fresh app whose first `tsir dev` refused with `MAIL_CONFIG_INVALID: the resend driver
needs an apiKey` — correct, and the wrong moment to say it. What still does not read the table
   is `tsir doctor`, which should print the row it would have chosen.
1. **The three missing database engines are shipped (`CAP-009`).** `DATABASE_ENGINES` is
   `['d1', 'postgres', 'mysql', 'sqlite']` and every one of the four is built from `tsir.js`, which
   it was not before: `from-config.ts` answered `DB_POSTGRES_BOOTSTRAP_UNWIRED` for _any_
   url-based connection, so the Lambda and Bun **defaults** named an engine that could not start.
   `postgres` and `mysql` reach a pooler over HTTP — one `POST` per statement, no socket, no SDK —
   because that is what Neon, Supabase, TiDB Cloud and PlanetScale publish, and because a Worker
   has no socket to open. `sqlite` is the D1 driver over a `bun:sqlite` handle: same dialect, real
   `BEGIN IMMEDIATE`, and `health().engine` says `sqlite` rather than claiming a binding.
1. **A transaction over HTTP is refused at boot, not discovered mid-request.** The two url engines
   declare `interactiveTx: false` because one HTTP request is one session: a `BEGIN` in one and a
   `COMMIT` in the next are different backends. `declare()` therefore refuses the component that
   needs one, before the first request, with the fix in the message.
1. **`mysql` shipped, and it needed more than a driver.** It was in `make:connection`'s list by
   mistake and never in `DATABASE_ENGINES`, so adding it was an engine: a third placeholder style
   (`?` like SQLite, nothing else alike). The structural SQL ports took `mysql` in the type and
   refuse it at construction where their upsert cannot be expressed in it — a type that excluded it
   would only move the failure to whoever typed the config, and the caller holds an engine that is
   a runtime value, not a literal. `migrate` kept two
   dialects plus `sqlite` — its branches are `=== 'postgres'` with SQLite as the else, so a file is
   the same SQL as a binding — and refuses `mysql` with `DB_MIGRATION_ENGINE_UNSUPPORTED`, because
   its two tables are written in two dialects and a third would be invented SQL.
1. **Fixed 2026-11-13 — `make:connection` wrote drivers the schema rejects.** `KINDS` listed
   `['d1', 'postgres', 'mysql']` while `DATABASE_ENGINES` was `['d1', 'postgres']`, so
   `--driver mysql` wrote a `tsir.js` that failed at boot, and a typo'd cache, queue, storage or
   mail driver was accepted because those kinds carried no list at all. Every kind now reads its
   package's exported constant, so the command cannot drift from the registry.
1. **Fixed 2026-11-13 — the admin app documented a cache table that does not exist.** Its
   `config/cache.ts` comments said `tsir_cache`; `tsir cache:table` prints `cache_entries`. The
   comment was stale and is corrected. This was a documentation error with a real failure mode:
   the commented-out entry would have created the wrong table.
1. **`broadcast`'s `memory` driver still leaks — but no longer reaches production.** The
   broadcaster appends listeners and never releases them (`INF-009`). It now has a registry to
   carry the guard, so `production: true` answers `CAP_FORBIDDEN_IN_PRODUCTION` instead of
   publishing into an array nobody else can see. The Durable Object driver does not leak — it
   aborts the stream when the last listener leaves — which is another reason it is the Workers
   default.
1. **`media` has a registry now (`CAP-017`).** `media.adapters.<name>` is read from `tsir.js`, and
   `production: true` refuses `sharp` and `ffmpeg`: they transform a buffer and hand it back, which
   is a real choice on a server with a disk and a lost upload on a Worker. A route that returns 200
   and drops the image is the failure the refusal exists for.
1. **`broadcast` and `search` have a registry now (`CAP-014`, `CAP-015`).** `broadcast.driver` and
   `search.driver` are read from `tsir.js`, an unknown name is `CAP_DRIVER_MISSING` listing what
   ships, and `memory` is refused in production on both.
1. **`featureFlags` has a registry now (`CAP-006`).** `featureFlags.stores.<name>` is read from
   `tsir.js`, and `production: true` refuses `memory` — a `Map` in one process, so the next deploy
   hands every user the control group again and two instances disagree about who is in an
   experiment. `null` stays legal everywhere ("flags are off" loses nothing). `mysql` is refused at
   construction because the store's upsert is `ON CONFLICT (name) DO UPDATE`, which that engine does
   not speak. What remains constructor-only is `sessions` and `api keys` — both default to
   `database`, a real engine on every target.
1. **`sessions` and `api keys` have registries now (`CAP-018`).** `auth.sessions.store` and
   `auth.apiKeys.store` are read from `tsir.js`, kept separate because an app may well put sessions
   in one place and keys in another. `production: true` refuses `memory` on both: a session in one
   process logs the user out when their next request lands on another instance, and a key in one
   process is `401` on the instance that has not seen it. Neither throws, which is why it went
   unnoticed.

### Task index

| ID       | Task                                                                                | Where                                                      |
| -------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `CAP-1`  | ~~`mysql` in `make:connection`'s driver list~~ — done                               | `make-connection.ts` § 5                                   |
| `CAP-2`  | ~~Validate every kind's driver from its constant~~ — done                           | `make-connection.ts` § 5                                   |
| `CAP-3`  | ~~Settle the cache table name in one place~~ — done                                 | `admin.product.com/config/cache.ts`                        |
| `CAP-4`  | ~~Wire `production: true` from `APP_ENV` into every bootstrap~~ — done (`CAP-007`)  | `isProduction()` in `@tsir/core`, `make production-wiring` |
| `CAP-5`  | `tsir new --target cloudflare` writes the Cloudflare rows                           | `plans/tasks/07-capabilities.md` (`CAP-008`)               |
| `CAP-6`  | Registries for the four remaining constructor-only ports                            | `plans/tasks/07-capabilities.md` (`CAP-006`)               |
| `CAP-8`  | `tsir <capability>:drivers` for every registry                                      | `plans/operations/11-dx.md` § 2.4                          |
| `CAP-7`  | ~~Database engines `mysql` and `sqlite`~~ — done (`CAP-009`)                        | `src/framework/database/src/`                              |
| `CAP-9`  | ~~A `tsir.js` registry for `broadcast` and `search`~~ — done (`CAP-014`, `CAP-015`) | `broadcast/src/config.ts`, `scout/src/config.ts`           |
| `CAP-10` | ~~A `tsir.js` registry for `media`~~ — done (`CAP-017`)                             | `src/framework/media/src/config.ts`                        |
| `CAP-11` | ~~Ports that accept an engine they cannot serve~~ — done (`CAP-016`)                | `cache`, `notify`, `pennant`, `schedule`                   |

### Open questions

| ID    | Question                                                                                 | Status                                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Q72` | Should the constructor-only ports get `tsir.js` registries, or is code the better place? | **answered for cache, queue, mail, storage, notify, broadcast, search and media**: a registry, because it is what lets the production guard run. Still open only for `sessions`, `api keys`, `feature flags` and the lock, whose defaults are already `database` |
| `Q73` | `cache` on Workers: KV (fast, convergent) or D1 (consistent, costs a query slot)?        | open                                                                                                                                                                                                                                                             |
| `Q74` | Should `memory` remain a selectable driver at all, or only reachable through a test kit? | open                                                                                                                                                                                                                                                             |

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
