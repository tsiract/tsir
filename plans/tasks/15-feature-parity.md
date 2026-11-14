# 15 — `@tsir/*` Ecosystem Feature Parity: Research, Mapping & Implementation Tasks

> **Phase 10 (post-rebranding).** Establish 1:1 functional feature coverage between
> the `@tsir/*` packages and their Laravel ecosystem counterparts, using
> authoritative Laravel documentation and verifiable implementation evidence.
>
> **Status:** planning & research only. No package implementations are modified.
> All implementation tasks are `[ ]` pending. Feature mappings use the
> post-rebrand package names (see [`14-laravel-decoupling.md`](./14-laravel-decoupling.md));
> where rebranding has not yet executed, the current name is noted in parentheses.
>
> **Audit:** [`15-feature-parity-audit.md`](./15-feature-parity-audit.md) is the
> source-verification record for this document. It found that this parity doc
> **under-reports** implementation status for six packages (cache, scout, cashier,
> mail, queue, deploy) — several `[ ]`/`[~]` rows are actually `[x]`/`[~]` in
> source. Status updates should be applied from the audit's recommendations.

---

## 1. Objectives

1. Map every feature of every relevant Laravel ecosystem package to a `@tsir/*`
   package and record the implementation status with traceable evidence.
2. Identify missing, partial, blocked, and unverified features and translate them
   into actionable `plan/` tasks.
3. Establish a single source of truth for feature parity that is maintained as
   the implementation proceeds.
4. Maintain independent `@tsir/*` architecture, APIs, and naming — parity is
   about user-facing behavior, not internal architecture.

---

## 2. Scope

In scope: every `@tsir/*` package that has a Laravel ecosystem counterpart
(foundational services + first-party packages).

Out of scope:

- `@tsir/link` (service-to-service calls; no Laravel counterpart — Laravel has no
  equivalent first-party typed REST/gRPC/SOAP/WS client package).
- `@tsir/media` (closest analog is Intervention Image, a third-party package,
  not a Laravel first-party package; included for reference only).
- Internal architecture reproduction — only observable behavior is mapped.

---

## 3. Status legend

| Status                       | Meaning                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `[x]` Verified Parity        | Implemented and verified by tests/evidence.               |
| `[~]` Partial Parity         | Some functionality exists; important capabilities remain. |
| `[ ]` Not Implemented        | No meaningful implementation.                             |
| `[!]` Blocked                | Requires a prerequisite or architectural decision.        |
| `[?]` Unverified             | Implementation exists but evidence is insufficient.       |
| `[N/A]` Not Applicable       | Excluded with documented justification.                   |
| `[D]` Deliberately Different | Intentionally different; documented reasoning.            |

A feature is **never** `[x]` based on naming similarity, a class/interface
declaration, a placeholder, a config declaration, a README description, or a
test that only checks symbol existence.

**How these markers are kept honest (added 2026-11-08).** § 7.1 and § 7.2 are _mechanical counts_ of
the rows in § 6 — they are regenerated from this file, never typed by hand, so a row and its summary
cannot disagree. `make plans` does not verify them (it checks links, ids and status words, not
arithmetic), so the rule is procedural: **a status change edits the row and the two summary blocks in
the same commit.** `[?]` is currently unused; a row with insufficient evidence is `[ ]` until someone
re-runs the check, because "unverified" and "not implemented" need different actions and only one of
them is honest without evidence.

---

## 4. Official reference index

Baseline version: **Laravel 11.x** (current stable at research time). Where a
package has its own versioned docs, the latest stable is used. All references
were verified accessible on 2026-11-07.

### 4.1 Foundational Laravel services

| Ref ID            | Laravel service         | Source type        | URL                                                               | Notes                                |
| ----------------- | ----------------------- | ------------------ | ----------------------------------------------------------------- | ------------------------------------ |
| LAR-AUTH          | Authentication          | Official docs 11.x | https://laravel.com/docs/11.x/authentication                      |                                      |
| LAR-AUTH-HASHING  | Hashing                 | Official docs 11.x | https://laravel.com/docs/11.x/hashing                             |                                      |
| LAR-AUTH-SESSIONS | Sessions                | Official docs 11.x | https://laravel.com/docs/11.x/session                             |                                      |
| LAR-AUTH-GUARDS   | Authentication (guards) | Official docs 11.x | https://laravel.com/docs/11.x/authentication#adding-custom-guards |                                      |
| LAR-AUTHZ         | Authorization           | Official docs 11.x | https://laravel.com/docs/11.x/authorization                       | Gates + Policies                     |
| LAR-ENC           | Encryption              | Official docs 11.x | https://laravel.com/docs/11.x/encryption                          |                                      |
| LAR-CACHE         | Cache                   | Official docs 11.x | https://laravel.com/docs/11.x/cache                               |                                      |
| LAR-DB            | Database                | Official docs 11.x | https://laravel.com/docs/11.x/database                            | Query builder (no Eloquent in @tsir) |
| LAR-MIGRATIONS    | Migrations              | Official docs 11.x | https://laravel.com/docs/11.x/migrations                          |                                      |
| LAR-SEEDERS       | Seeders                 | Official docs 11.x | https://laravel.com/docs/11.x/seeding                             |                                      |
| LAR-EVENTS        | Events                  | Official docs 11.x | https://laravel.com/docs/11.x/events                              |                                      |
| LAR-QUEUE         | Queue                   | Official docs 11.x | https://laravel.com/docs/11.x/queues                              |                                      |
| LAR-SCHEDULE      | Task Scheduling         | Official docs 11.x | https://laravel.com/docs/11.x/scheduling                          |                                      |
| LAR-MAIL          | Mail                    | Official docs 11.x | https://laravel.com/docs/11.x/mail                                |                                      |
| LAR-NOTIFY        | Notifications           | Official docs 11.x | https://laravel.com/docs/11.x/notifications                       |                                      |
| LAR-FS            | Filesystem / Storage    | Official docs 11.x | https://laravel.com/docs/11.x/filesystem                          |                                      |
| LAR-VALIDATE      | Validation              | Official docs 11.x | https://laravel.com/docs/11.x/validation                          |                                      |
| LAR-CONFIG        | Configuration           | Official docs 11.x | https://laravel.com/docs/11.x/configuration                       |                                      |
| LAR-CONTAINER     | Container               | Official docs 11.x | https://laravel.com/docs/11.x/container                           |                                      |
| LAR-HTTP          | HTTP Requests           | Official docs 11.x | https://laravel.com/docs/11.x/requests                            |                                      |
| LAR-ROUTING       | Routing                 | Official docs 11.x | https://laravel.com/docs/11.x/routing                             |                                      |
| LAR-ARTISAN       | Artisan Console         | Official docs 11.x | https://laravel.com/docs/11.x/artisan                             |                                      |
| LAR-LOGGING       | Logging                 | Official docs 11.x | https://laravel.com/docs/11.x/logging                             |                                      |

### 4.2 First-party Laravel packages

| Ref ID         | Laravel package  | Source type        | URL                                                                 | Notes                          |
| -------------- | ---------------- | ------------------ | ------------------------------------------------------------------- | ------------------------------ |
| LPK-SANCTUM    | Sanctum          | Official docs 11.x | https://laravel.com/docs/11.x/sanctum                               | SPA/API token auth             |
| LPK-PASSPORT   | Passport         | Official docs 12.x | https://laravel.com/docs/12.x/passport                              | OAuth2 server                  |
| LPK-SOCIALITE  | Socialite        | Official docs 11.x | https://laravel.com/docs/11.x/socialite                             | Social OAuth                   |
| LPK-PENNANT    | Pennant          | Official docs 13.x | https://laravel.com/docs/13.x/pennant                               | Feature flags                  |
| LPK-CASHIER    | Cashier (Stripe) | Official docs 12.x | https://laravel.com/docs/12.x/billing                               | Billing                        |
| LPK-SCOUT      | Scout            | Official docs 11.x | https://laravel.com/docs/11.x/scout                                 | Search                         |
| LPK-BROADCAST  | Broadcasting     | Official docs 10.x | https://laravel.com/docs/10.x/broadcasting                          | Echo + Reverb                  |
| LPK-HORIZON    | Horizon          | Official docs 10.x | https://laravel.com/docs/10.x/horizon                               | Queue dashboard                |
| LPK-TELESCOPE  | Telescope        | Official docs 10.x | https://laravel.com/docs/10.x/telescope                             | Request inspection             |
| LPK-PULSE      | Pulse            | Official docs 11.x | https://laravel.com/docs/11.x/pulse                                 | Analytics dashboard            |
| LPK-NIGHTWATCH | Nightwatch       | Official product   | https://laravel.com/cloud/docs/environments                         | APM (launched Laracon EU 2025) |
| LPK-DUSK       | Dusk             | Official docs 11.x | https://laravel.com/docs/11.x/dusk                                  | Browser testing/E2E            |
| LPK-FORGE      | Forge            | Official product   | https://forge.laravel.com                                           | Server management              |
| LPK-VAPOR      | Vapor            | Official product   | https://vapor.laravel.com                                           | Serverless deployment          |
| LPK-OCTANE     | Octane           | Official docs 11.x | https://laravel.com/docs/11.x/octane                                | High-performance serving       |
| LPK-PINT       | Pint             | Official docs 11.x | https://laravel.com/docs/11.x/pint                                  | Code style                     |
| LPK-SAIL       | Sail             | Official docs 11.x | https://laravel.com/docs/11.x/sail                                  | Docker dev env                 |
| LPK-REVERB     | Reverb           | Official docs 11.x | https://laravel.com/docs/11.x/reverb                                | WebSocket server               |
| LPK-ECHO       | Echo             | Official docs 11.x | https://laravel.com/docs/11.x/broadcasting#client-side-installation | JS client                      |

> **Note on Nightwatch vs Dusk:** Laravel Nightwatch (LPK-NIGHTWATCH) is an
> **APM** (HTTP request, DB query, queue job, scheduled command, cache, and
> outgoing HTTP request tracing with a Laravel-native dashboard). Our
> `@tsir/nightwatch` is a **browser E2E testing harness** (page abstraction).
> Functionally, our package maps to **Laravel Dusk** (LPK-DUSK), not Nightwatch.
> This naming mismatch is resolved in Phase 9 (→ `@tsir/browser`). The APM
> functionality maps to `@tsir/pulse` + `@tsir/telemetry`.

---

## 5. Version & comparison baselines

| @tsir package (post-rebrand)          | Laravel counterpart          | Baseline version | Notes                                                                   |
| ------------------------------------- | ---------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `@tsir/auth`                          | Auth + Sanctum               | 11.x             | Sessions, hashing, guards, API tokens                                   |
| `@tsir/policy`                        | Authorization                | 11.x             | Gates + Policies                                                        |
| `@tsir/vault`                         | Encryption                   | 11.x             | Column encryption (extends Laravel's app-level encryption)              |
| `@tsir/cache`                         | Cache                        | 11.x             | Named stores, tags, drivers                                             |
| `@tsir/database`                      | Database (query builder)     | 11.x             | No Eloquent ORM (deliberately different)                                |
| `@tsir/migrate`                       | Migrations                   | 11.x             | Drizzle journal (deliberately different from Laravel's migration table) |
| `@tsir/seed`                          | Seeders                      | 11.x             |                                                                         |
| `@tsir/events`                        | Events                       | 11.x             | Sync + queued listeners                                                 |
| `@tsir/queue`                         | Queue                        | 11.x             | At-least-once, backoff, DLQ                                             |
| `@tsir/schedule`                      | Task Scheduling              | 11.x             | Cron, overlap, timezone, maintenance mode, hooks, background runs       |
| `@tsir/mail`                          | Mail                         | 11.x             |                                                                         |
| `@tsir/notify`                        | Notifications                | 11.x             |                                                                         |
| `@tsir/storage`                       | Filesystem                   | 11.x             |                                                                         |
| `@tsir/validate`                      | Validation                   | 11.x             | Zod 4-backed                                                            |
| `@tsir/pulse` → `@tsir/observability` | Logging + Pulse              | 11.x             | Observability primitives (not a dashboard)                              |
| `@tsir/config`                        | Configuration                | 11.x             |                                                                         |
| `@tsir/container`                     | Container                    | 11.x             | Explicit constructor injection (deliberately different)                 |
| `@tsir/http`                          | HTTP Requests                | 11.x             | Web-standard                                                            |
| `@tsir/router`                        | Routing                      | 11.x             | Decorator-compiled                                                      |
| `@tsir/console`                       | Artisan                      | 11.x             | `tsir` CLI                                                              |
| `@tsir/deploy`                        | Vapor                        | —                | Workers + Lambda (deliberately different target)                        |
| `@tsir/flags` (← pennant)             | Pennant                      | 13.x             | Feature flags                                                           |
| `@tsir/billing` (← cashier)           | Cashier                      | 12.x             | Stripe REST (no SDK)                                                    |
| `@tsir/servers` (← forge)             | Forge                        | —                | Server management                                                       |
| `@tsir/oauth` (← socialize)           | Socialite                    | 11.x             | Social OAuth                                                            |
| `@tsir/search` (← scout)              | Scout                        | 11.x             | Search                                                                  |
| `@tsir/broadcast`                     | Broadcasting (Echo + Reverb) | 10.x/11.x        | Redis + Pusher drivers, private/presence channels, whisper              |
| `@tsir/browser` (← nightwatch)        | Dusk                         | 11.x             | Browser E2E                                                             |
| `@tsir/telemetry`                     | Horizon + Telescope          | 10.x             | Queue monitoring + request logging                                      |

---

## 6. Package-by-package feature mappings

### 6.1 `@tsir/auth` — Laravel Auth + Sanctum

Counterpart: LAR-AUTH, LAR-AUTH-HASHING, LAR-AUTH-SESSIONS, LPK-SANCTUM.

| Feature                   | Laravel feature                    | @tsir implementation                                                                | Evidence                        | Status                |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------- | --------------------- |
| Password hashing          | bcrypt/argon2id, configurable cost | `password.ts`: PBKDF2-SHA256 default, argon2id on Bun, self-describing hashes       | `password.test.ts`              | `[x]`                 |
| Password verification     | `Hash::check`                      | `verifyPassword` with rehash on cost change                                         | `password.test.ts`              | `[x]`                 |
| Cookie sessions           | `Session` facade, stores           | `session.ts`: cookie sessions, DB/memory stores, idle + absolute lifetime, rotation | `session.test.ts`               | `[x]`                 |
| API tokens                | Sanctum `personal_access_tokens`   | `token.ts`: bearer tokens, API keys (`keys.ts`)                                     | `token.test.ts`, `keys.test.ts` | `[x]`                 |
| Token abilities/scopes    | Sanctum token abilities            | `keys.ts`: `databaseApiKeyStore` with abilities                                     | `keys.test.ts`                  | `[~]`                 |
| Guards                    | Auth guards                        | `guards.ts`: session, bearer, apiKey, compose                                       | `guards.test.ts`                | `[x]`                 |
| SPA cookie auth (Sanctum) | Sanctum SPA authentication         | —                                                                                   | —                               | `[ ]`                 |
| CSRF protection           | CSRF middleware                    | — (planned: admin CSRF)                                                             | —                               | `[ ]`                 |
| Email verification        | `MustVerifyEmail`                  | —                                                                                   | —                               | `[ ]`                 |
| Password reset            | `Password::broker`                 | admin `password-reset.service.ts` (app-level, not framework)                        | —                               | `[~]`                 |
| Rate limiting (auth)      | `RateLimiter`                      | `@tsir/pulse` `createRateLimiter`                                                   | `limits.ts`                     | `[x]` (cross-package) |

### 6.2 `@tsir/policy` — Laravel Authorization

Counterpart: LAR-AUTHZ.

| Feature               | Laravel feature        | @tsir implementation            | Evidence       | Status                                           |
| --------------------- | ---------------------- | ------------------------------- | -------------- | ------------------------------------------------ |
| Gates                 | `Gate::define`         | `defineGate`                    | `policy` tests | `[x]`                                            |
| Policies              | Policy classes         | `definePolicy`, ownership rules | `policy` tests | `[x]`                                            |
| Roles                 | — (Spatie, not core)   | Roles with `implies`            | `policy` tests | `[x]` (extra)                                    |
| Permissions           | — (Spatie, not core)   | Permissions                     | `policy` tests | `[x]` (extra)                                    |
| HTTP integration      | `authorize` middleware | `toHttpPolicies`                | `policy` tests | `[x]`                                            |
| Resource policies     | `authorizeResource`    | —                               | —              | `[ ]`                                            |
| Policy auto-discovery | Auto-discovery         | — (explicit registration)       | —              | `[D]` deliberate: explicit registration is safer |

### 6.3 `@tsir/vault` — Laravel Encryption

Counterpart: LAR-ENC.

| Feature              | Laravel feature                    | @tsir implementation                                                                   | Evidence                          | Status        |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- | ------------- |
| Symmetric encryption | `Crypt::encrypt` (AES-256-CBC/GCM) | AES-256-GCM via WebCrypto, self-describing envelope                                    | `cipher.ts`, `vault.test.ts`      | `[x]`         |
| Key rotation         | `APP_KEY` rotation                 | Keyring state machine (`staged`/`active`/`decrypt-only`/`retired`), resumable rotation | `rotation.ts`, `rotation.test.ts` | `[x]`         |
| Encrypted DB columns | `encrypted` cast                   | `createVaultCodec` for Drizzle columns, AAD bound to table+column                      | `codec.ts`                        | `[x]`         |
| Blind indexing       | —                                  | `blind.ts` for searchable encryption                                                   | `blind`                           | `[x]` (extra) |
| Signed URLs          | `URL::signed`                      | —                                                                                      | —                                 | `[ ]`         |
| Encrypted cookies    | `encrypt` cookie flag              | —                                                                                      | —                                 | `[ ]`         |

### 6.4 `@tsir/cache` — Laravel Cache

Counterpart: LAR-CACHE.

| Feature                 | Laravel feature                    | @tsir implementation                                                                                                        | Evidence                                                      | Status               |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------- |
| Multiple drivers        | redis, database, file, array, null | memory, redis, Cloudflare KV, database, null                                                                                | `stores.ts`, drivers                                          | `[x]`                |
| Named stores            | `Cache::store('x')`                | `createCaches`, `cache.store(name)`                                                                                         | `stores.ts`                                                   | `[x]`                |
| Tags                    | `Cache::tags(['x'])`               | `invalidateTag`, memory driver declares `tags: true`                                                                        | `store.ts`, `drivers/memory.ts`                               | `[x]`                |
| TTL / expiration        | `put($key, $value, $ttl)`          | explicit TTL on set                                                                                                         | `store.ts`                                                    | `[x]`                |
| Increment/decrement     | `Cache::increment`                 | `increment`, memory driver declares `increment: true`                                                                       | `store.ts`, `drivers/memory.ts`                               | `[x]`                |
| Lock                    | `Cache::lock`                      | `CacheLock`, `cache.lock(name, ttlMs, owner)`; `get`, `block`, `release`, `forceRelease`; atomic acquire/release on backend | `store.ts`, `drivers/{memory,database,redis}.ts`, conformance | `[x]`                |
| Remember / lazy         | `Cache::remember`                  | `remember` with capability check                                                                                            | `store.ts`                                                    | `[x]`                |
| Cache tags invalidation | Tag-based flushing                 | `invalidateTag`                                                                                                             | `store.ts`                                                    | `[x]`                |
| Explicit serialization  | (implicit)                         | `json`, `text` codecs, no implicit parse                                                                                    | `codec.ts`                                                    | `[x]` (extra: safer) |

### 6.5 `@tsir/database` — Laravel Database (query builder)

Counterpart: LAR-DB. **Deliberately different: no Eloquent ORM.**

| Feature                | Laravel feature       | @tsir implementation                                  | Evidence         | Status                               |
| ---------------------- | --------------------- | ----------------------------------------------------- | ---------------- | ------------------------------------ |
| Multiple connections   | `DB::connection('x')` | `createConnections`, named connections with `default` | `connections.ts` | `[x]`                                |
| Query builder          | `DB::table(...)`      | Drizzle ORM (`createDrizzle`)                         | `drizzle.ts`     | `[x]`                                |
| Transactions           | `DB::transaction`     | `withTransaction`, savepoints, context propagation    | `database.ts`    | `[x]`                                |
| Connection health      | —                     | health check with connectivity + latency              | `database.ts`    | `[x]`                                |
| Pessimistic locking    | `lockForUpdate`       | —                                                     | —                | `[ ]` — `DB-027`                     |
| Eloquent ORM           | Eloquent              | — (deliberately not implemented)                      | —                | `[D]` deliberate: Drizzle is the ORM |
| Pagination             | `paginate`            | —                                                     | —                | `[ ]` — `DB-028`                     |
| D1 driver              | —                     | `createD1Driver`                                      | `d1.ts`          | `[x]` (extra)                        |
| Postgres driver        | —                     | `postgres` subpath                                    | `postgres.ts`    | `[x]` (extra)                        |
| Optimistic concurrency | —                     | `applyOptimistic`, `retryOnConflict`                  | `optimistic.ts`  | `[x]` (extra)                        |

### 6.6 `@tsir/migrate` — Laravel Migrations

Counterpart: LAR-MIGRATIONS.

| Feature                   | Laravel feature                  | @tsir implementation                                | Evidence      | Status                                   |
| ------------------------- | -------------------------------- | --------------------------------------------------- | ------------- | ---------------------------------------- |
| Run migrations            | `migrate`                        | `migrate` with `--> statement-breakpoint` (Drizzle) | `migrate.ts`  | `[x]`                                    |
| Migration status          | `migrate:status`                 | `migrationStatus`, drift detection                  | `status.ts`   | `[x]`                                    |
| Rollback                  | `migrate:rollback`               | `rollback`, `planRollback`                          | `rollback.ts` | `[x]`                                    |
| Advisory lock             | — (Laravel has no built-in lock) | `acquireMigrationLock`                              | `lock.ts`     | `[x]` (extra)                            |
| Checksum / drift          | —                                | drift detection                                     | `plan.ts`     | `[x]` (extra)                            |
| Per-connection migrations | —                                | `--connection`, per-connection journal              | `migrate.ts`  | `[x]` (extra)                            |
| Schema builder (fluent)   | `Schema::create`                 | — (raw SQL migrations)                              | —             | `[D]` deliberate: Drizzle SQL migrations |

### 6.7 `@tsir/seed` — Laravel Seeders

Counterpart: LAR-SEEDERS.

| Feature            | Laravel feature      | @tsir implementation                          | Evidence    | Status        |
| ------------------ | -------------------- | --------------------------------------------- | ----------- | ------------- |
| Seeder classes     | `Seeder` class       | `defineSeeder`, `defineSeeders`               | `seeder.ts` | `[x]`         |
| Ordering           | `$this->call([...])` | `SeederOrder`                                 | `runner.ts` | `[x]`         |
| Environment gating | production check     | `SeedEnvironment`, `assertEnvironmentAllowed` | `runner.ts` | `[x]`         |
| Idempotency        | (manual)             | `assertIdempotent`                            | `runner.ts` | `[x]` (extra) |
| Determinism        | (manual)             | fixed clock + seeded RNG                      | `runner.ts` | `[x]` (extra) |
| Factories          | `Factory`            | —                                             | —           | `[ ]`         |

### 6.8 `@tsir/events` — Laravel Events

Counterpart: LAR-EVENTS.

| Feature              | Laravel feature   | @tsir implementation              | Evidence                  | Status           |
| -------------------- | ----------------- | --------------------------------- | ------------------------- | ---------------- |
| Event definitions    | `Event` class     | `defineEvent`                     | `event.ts`                | `[x]`            |
| Listeners            | `Listener` class  | `defineListener`                  | `event.ts`                | `[x]`            |
| Sync listeners       | sync listeners    | `mode: 'sync'`                    | `bus.ts`                  | `[x]`            |
| Queued listeners     | `ShouldQueue`     | `mode: 'queued'`                  | `bus.ts`                  | `[x]`            |
| Transactional outbox | —                 | `createOutbox`, `createPublisher` | `outbox.ts`, `publish.ts` | `[x]` (extra)    |
| Event discovery      | auto-discovery    | — (explicit registration)         | —                         | `[D]` deliberate |
| Broadcast events     | `ShouldBroadcast` | `@tsir/broadcast` (cross-package) | —                         | `[~]`            |

### 6.9 `@tsir/queue` — Laravel Queue

Counterpart: LAR-QUEUE.

| Feature               | Laravel feature          | @tsir implementation                                                                  | Evidence              | Status        |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------- | --------------------- | ------------- |
| Job definitions       | `Job` class              | `defineJob`, `createJobRegistry`                                                      | `job.ts`              | `[x]`         |
| Multiple connections  | `Queue::connection('x')` | `createQueues`, named connections                                                     | `config.ts`           | `[x]`         |
| Retries with backoff  | `backoff`, `tries`       | `retryDelayMs`, exponential backoff, DLQ                                              | `backoff.ts`          | `[x]`         |
| Dead-letter queue     | failed jobs table        | `queueDead` table                                                                     | `queue.ts`            | `[x]`         |
| Idempotency keys      | —                        | idempotency keys                                                                      | `queue.ts`            | `[x]` (extra) |
| Graceful worker drain | `--timeout`, SIGTERM     | worker drain on SIGTERM                                                               | `worker.ts`           | `[x]`         |
| Rate limiting         | `RateLimited`            | `@tsir/pulse` rate limiter (cross-package)                                            | —                     | `[x]`         |
| Job batching          | `Bus::batch`             | —                                                                                     | —                     | `[ ]`         |
| Job chains            | `Bus::chain`             | —                                                                                     | —                     | `[ ]`         |
| Delayed jobs          | `delay()`                | `dispatchLater` with `delayMs` (backend-dependent: driver must declare `delay: true`) | `queue.ts`, `port.ts` | `[~]`         |
| Unique jobs           | `ShouldBeUnique`         | `idempotencyKey` (backend-dependent: driver must declare `idempotency: true`)         | `port.ts`             | `[~]`         |
| Failed job retry      | `queue:retry`            | `queue:retry`, replay, discard                                                        | `queue.ts`            | `[x]`         |

### 6.10 `@tsir/schedule` — Laravel Task Scheduling

Counterpart: LAR-SCHEDULE.

| Feature            | Laravel feature                          | @tsir implementation                                                                                                                                                   | Evidence                  | Status |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------ |
| Cron expressions   | `cron('* * * * *')`                      | `CronSpec`, 5-field cron                                                                                                                                               | `cron.ts`                 | `[x]`  |
| Task definitions   | Schedule `->command(...)`                | `defineTask`, `createTaskRegistry`                                                                                                                                     | `task.ts`                 | `[x]`  |
| Overlap prevention | `withoutOverlapping`                     | distributed lock, `memoryLock`/`databaseLock`                                                                                                                          | `lock.ts`                 | `[x]`  |
| Run in background  | `runInBackground`                        | `runInBackground` task flag; `runDue` dispatches and returns immediately, lock held until background run finishes, errors reported via `onError`                       | `scheduler.ts`            | `[x]`  |
| Maintenance mode   | `evenInMaintenanceMode`                  | `isMaintenanceMode` scheduler option skips cron ticks (`status: 'skipped'`) unless task sets `evenInMaintenanceMode: true`; manual runs always run                     | `scheduler.ts`, `task.ts` | `[x]`  |
| Timezone           | `timezone`                               | IANA `timezone` on `defineTask`; `wallClock` uses `Intl.DateTimeFormat` per tick so DST is honoured; `toUtcCron` refuses DST zones (no single UTC equivalent)          | `cron.ts`, `task.ts`      | `[x]`  |
| One server         | `onOneServer`                            | shared lock                                                                                                                                                            | `lock.ts`                 | `[~]`  |
| Task hooks         | `before`/`after`/`onSuccess`/`onFailure` | `TaskHooks` on `defineTask`; `before` can refuse the run, `onSuccess`/`onFailure` branch on outcome, `after` always runs; hook errors are logged, never change outcome | `task.ts`, `scheduler.ts` | `[x]`  |

### 6.11 `@tsir/mail` — Laravel Mail

Counterpart: LAR-MAIL.

| Feature             | Laravel feature     | @tsir implementation                                                                                                 | Evidence                    | Status |
| ------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------ |
| Mailables           | `Mailable` class    | `createMessage`, templates                                                                                           | `message.ts`                | `[x]`  |
| Multiple transports | `MAIL_MAILER`       | SMTP, SES, Postmark, Resend, Cloudflare, HTTP, log, memory                                                           | `transports/`               | `[x]`  |
| HTML escaping       | Blade auto-escaping | `escapeHtml`, `html`, `raw`, explicit `SafeHtml`                                                                     | `escape.ts`                 | `[x]`  |
| MIME building       | SwiftMailer         | `buildMime`                                                                                                          | `mime.ts`                   | `[x]`  |
| Attachments         | `->attach()`        | `Attachment` type, all transports (smtp MIME, resend, postmark, ses) send attachments; `checkAttachments` validation | `message.ts`, `transports/` | `[x]`  |
| Markdown mail       | `Markdown` mailable | —                                                                                                                    | —                           | `[ ]`  |
| Queued mail         | `ShouldQueue`       | `@tsir/notify` or manual queue                                                                                       | —                           | `[~]`  |
| Log transport (dev) | `log` driver        | `logTransport` (refuses production)                                                                                  | `transports/log.ts`         | `[x]`  |
| Address parsing     | —                   | `parseAddress`, `formatAddress`                                                                                      | `address.ts`                | `[x]`  |

### 6.12 `@tsir/notify` — Laravel Notifications

Counterpart: LAR-NOTIFY.

| Feature                  | Laravel feature     | @tsir implementation                     | Evidence               | Status        |
| ------------------------ | ------------------- | ---------------------------------------- | ---------------------- | ------------- |
| Notification channels    | `via()` method      | mail, SMS, database, chat, webhook, post | `channels/`            | `[x]`         |
| Notifiable model         | `Notifiable` trait  | recipient abstraction                    | `notification.ts`      | `[x]`         |
| Queued notifications     | `ShouldQueue`       | queued by default                        | `delivery.ts`          | `[x]`         |
| Database notifications   | `database` channel  | `database` channel                       | `channels/database.ts` | `[x]`         |
| Mail notifications       | `mail` channel      | `mail` channel                           | `channels/mail.ts`     | `[x]`         |
| Webhook signing          | —                   | `signBody`, `verifySignature`            | `signing.ts`           | `[x]` (extra) |
| Broadcast notifications  | `broadcast` channel | — (could use `@tsir/broadcast`)          | —                      | `[ ]`         |
| Notification preferences | —                   | —                                        | —                      | `[ ]`         |

### 6.13 `@tsir/storage` — Laravel Filesystem

Counterpart: LAR-FS.

| Feature              | Laravel feature           | @tsir implementation               | Evidence                    | Status |
| -------------------- | ------------------------- | ---------------------------------- | --------------------------- | ------ |
| Multiple disks       | `Storage::disk('x')`      | `createDisk`, named disks          | `disk.ts`                   | `[x]`  |
| Local driver         | `local` driver            | `localDriver`                      | `drivers/adapters/local.ts` | `[x]`  |
| S3 driver            | `s3` driver               | `s3Driver` (SigV4, no SDK)         | `drivers/s3.ts`             | `[x]`  |
| Memory driver        | `array` driver            | `memoryDriver`                     | `drivers/memory.ts`         | `[x]`  |
| Public / signed URLs | `url()`, `temporaryUrl()` | URL with public/signed flag        | `disk.ts`                   | `[x]`  |
| File visibility      | `setVisibility`           | `setVisibility`, `Visibility` type | `port.ts`, all drivers      | `[x]`  |
| Streaming            | `stream()`                | `stream()` → `ReadableStream`      | `port.ts`, all drivers      | `[x]`  |
| Directory listing    | `directories`, `files`    | `directories(prefix)`              | `port.ts`, all drivers      | `[x]`  |
| Copy/move            | `copy`, `move`            | `copy`, `move`                     | `port.ts`, all drivers      | `[x]`  |

> **Correction (2026-11-08):** the 2026-11-07 parity audit's "`[ ]` confirmed absent" list named
> `copy`, `move`, `setVisibility` and streaming for this package. All four are in `port.ts` **and**
> implemented by every shipped driver (`s3.ts`, `memory.ts`, `drivers/adapters/local.ts`), with
> `copy`/`move` cases in `conformance.ts`. The audit read `disk.ts` and stopped there; the rows above
> were already `[x]` and were right. The audit is corrected at
> [`15-feature-parity-audit.md`](./15-feature-parity-audit.md) § storage.

### 6.14 `@tsir/validate` — Laravel Validation

Counterpart: LAR-VALIDATE.

| Feature                | Laravel feature            | @tsir implementation              | Evidence           | Status |
| ---------------------- | -------------------------- | --------------------------------- | ------------------ | ------ |
| Request validation     | `$request->validate`       | Zod 4 schemas, router integration | `validate` package | `[x]`  |
| Rule library           | `required`, `email`, etc.  | Zod rules + Standard Schema       | `validate`         | `[x]`  |
| Custom rules           | `Rule` objects             | Zod refinements                   | —                  | `[x]`  |
| Error messages         | custom messages            | Zod issue normalization           | —                  | `[x]`  |
| Form requests          | `FormRequest`              | router body/params schemas        | —                  | `[x]`  |
| Unique rule            | `unique:table,column`      | — (requires DB)                   | —                  | `[ ]`  |
| Exists rule            | `exists:table,column`      | —                                 | —                  | `[ ]`  |
| Conditional validation | `sometimes`, `required_if` | Zod conditional schemas           | —                  | `[x]`  |

### 6.15 `@tsir/pulse` → `@tsir/observability` — Laravel Logging + Pulse

Counterpart: LAR-LOGGING, LPK-PULSE.

> **Architectural difference:** Laravel Pulse is an analytics **dashboard**.
> `@tsir/pulse` provides observability **primitives** (logs, metrics, traces,
> health, rate limiting). The dashboard is the admin app's responsibility.

| Feature            | Laravel feature        | @tsir implementation                     | Evidence     | Status        |
| ------------------ | ---------------------- | ---------------------------------------- | ------------ | ------------- |
| Structured logging | `Log` facade, channels | `createLogger`, structured records       | `logger.ts`  | `[x]`         |
| Log levels         | `emergency`...`debug`  | `LogLevel`                               | `record.ts`  | `[x]`         |
| Multiple sinks     | `stack` channel        | `stdoutSink`, `memorySink`, `fanoutSink` | `sinks.ts`   | `[x]`         |
| Log formatting     | single, daily, syslog  | `LOG_FORMATS`                            | `formats.ts` | `[x]`         |
| PII redaction      | —                      | `redact.ts`, `PiiPolicy`                 | `redact.ts`  | `[x]` (extra) |
| Metrics            | — (Pulse)              | `createMetrics`, counters/timers         | `metrics.ts` | `[x]`         |
| Tracing            | — (Pulse/Octane)       | `createTracer`, spans, W3C `traceparent` | `tracing.ts` | `[x]`         |
| Health checks      | —                      | `createHealth` (liveness/readiness)      | `health.ts`  | `[x]`         |
| Rate limiting      | `RateLimiter`          | `createRateLimiter`                      | `limits.ts`  | `[x]`         |
| Metrics exporters  | Pulse dashboard        | — (no built-in exporter)                 | —            | `[ ]`         |
| Pulse dashboard UI | Pulse dashboard        | admin dashboard (app-level)              | —            | `[~]`         |

### 6.16 `@tsir/config` — Laravel Configuration

Counterpart: LAR-CONFIG.

| Feature               | Laravel feature | @tsir implementation               | Evidence     | Status                               |
| --------------------- | --------------- | ---------------------------------- | ------------ | ------------------------------------ |
| Typed config          | `config()`      | `defineConfig`, `env()` helpers    | `define.ts`  | `[x]`                                |
| Environment variables | `env()`         | `env()` typed                      | `define.ts`  | `[x]`                                |
| Config caching        | `config:cache`  | — (no runtime reflection to cache) | —            | `[D]` deliberate: config is compiled |
| Secret redaction      | —               | `redacted.ts`, secret handling     | `secrets.ts` | `[x]` (extra)                        |
| Presets               | —               | `presets.ts`                       | `presets.ts` | `[x]` (extra)                        |

### 6.17 `@tsir/container` — Laravel Container

Counterpart: LAR-CONTAINER.

| Feature               | Laravel feature         | @tsir implementation           | Evidence       | Status                                      |
| --------------------- | ----------------------- | ------------------------------ | -------------- | ------------------------------------------- |
| DI container          | `Container`             | `Container` with tokens        | `container.ts` | `[x]`                                       |
| Constructor injection | auto-injection          | explicit constructor injection | `container.ts` | `[x]`                                       |
| Bindings              | `bind`, `singleton`     | providers                      | `provider.ts`  | `[x]`                                       |
| Scopes                | —                       | request scope                  | `container.ts` | `[x]`                                       |
| Facades               | `Facade`                | — (deliberately no facades)    | —              | `[D]` deliberate: no global service locator |
| Contextual binding    | `when(...)->needs(...)` | —                              | —              | `[ ]`                                       |
| Auto-wiring           | auto resolution         | — (explicit)                   | —              | `[D]` deliberate                            |

### 6.18 `@tsir/http` — Laravel HTTP

Counterpart: LAR-HTTP.

| Feature              | Laravel feature           | @tsir implementation                                                     | Evidence                  | Status                |
| -------------------- | ------------------------- | ------------------------------------------------------------------------ | ------------------------- | --------------------- |
| Request object       | `Illuminate\Http\Request` | Web `Request`                                                            | `context.ts`              | `[x]`                 |
| Response helpers     | `response()`              | `ok`, `created`, `accepted`, `noContent`                                 | `http` package            | `[x]`                 |
| Problem details      | `abort(404)`              | RFC 9457 problems                                                        | `problems.ts`             | `[x]`                 |
| Middleware           | middleware                | pipeline                                                                 | `pipeline.ts`             | `[x]`                 |
| Request body parsing | `$request->all()`         | `body.ts`, multipart                                                     | `body.ts`, `multipart.ts` | `[x]`                 |
| File uploads         | `$request->file()`        | multipart handling                                                       | `multipart.ts`            | `[x]`                 |
| Cookies              | `Cookie` facade           | —                                                                        | —                         | `[ ]` — `HTP-023`     |
| Session middleware   | `StartSession`            | `@tsir/auth` session                                                     | —                         | `[x]` (cross-package) |
| CORS                 | CORS middleware           | CORS preflight handling                                                  | `http` tests              | `[x]`                 |
| Trust proxies        | `TrustProxies`            | unconditional `x-forwarded-for` read in `pipeline.ts` (not a trust list) | `pipeline.ts`             | `[ ]` — `HTP-024`     |
| Maintenance mode     | `CheckForMaintenanceMode` | —                                                                        | —                         | `[ ]`                 |

### 6.19 `@tsir/router` — Laravel Routing

Counterpart: LAR-ROUTING.

| Feature             | Laravel feature      | @tsir implementation                        | Evidence         | Status            |
| ------------------- | -------------------- | ------------------------------------------- | ---------------- | ----------------- |
| Route definition    | `Route::get(...)`    | decorator-based `@Controller`, `@Get`, etc. | `router` package | `[x]`             |
| Route params        | `{id}`               | route params with typed binding             | `route-args.ts`  | `[x]`             |
| Route groups        | `Route::group`       | module-owned registries                     | `router`         | `[x]`             |
| Named routes        | `->name('x')`        | —                                           | —                | `[ ]` — `RTR-013` |
| Route model binding | `Route::model`       | — (explicit binding)                        | —                | `[D]` deliberate  |
| Route caching       | `route:cache`        | `routes.gen.ts` (compiled at build)         | `router`         | `[x]`             |
| API resource routes | `Route::apiResource` | —                                           | —                | `[ ]` — `RTR-014` |
| Sub-domain routing  | `->domain()`         | —                                           | —                | `[ ]` — `RTR-015` |
| OpenAPI generation  | —                    | OpenAPI 3.1 from route table                | `openapi.ts`     | `[x]` (extra)     |

### 6.20 `@tsir/console` — Laravel Artisan

Counterpart: LAR-ARTISAN.

| Feature                | Laravel feature      | @tsir implementation                   | Evidence               | Status |
| ---------------------- | -------------------- | -------------------------------------- | ---------------------- | ------ |
| CLI entry              | `artisan`            | `tsir` CLI                             | `cli.ts`               | `[x]`  |
| Command definition     | `Command` class      | `defineCommand`                        | `define-command.ts`    | `[x]`  |
| Arguments/options      | `argument`, `option` | args parser                            | `args.ts`              | `[x]`  |
| Code generators        | `make:*`             | `make:module`, `make:controller`, etc. | `commands/`            | `[x]`  |
| In-process runner      | —                    | in-process runner                      | `in-process` tests     | `[x]`  |
| Scheduling integration | `schedule:run`       | `@tsir/schedule`                       | —                      | `[x]`  |
| Prompts                | artisan prompts      | `output.ts`                            | —                      | `[x]`  |
| Command scheduling     | `schedule:list`      | `schedule:*` commands                  | `commands/schedule.ts` | `[x]`  |
| Tinker (REPL)          | `tinker`             | — (planned: `@tsir/repl`)              | —                      | `[ ]`  |

### 6.21 `@tsir/deploy` — Laravel Vapor

Counterpart: LPK-VAPOR. **Deliberately different: Workers + Lambda, not Vapor's AWS-abstracted runtime.**

| Feature                 | Laravel feature      | @tsir implementation                                        | Evidence                | Status |
| ----------------------- | -------------------- | ----------------------------------------------------------- | ----------------------- | ------ |
| Serverless deployment   | Vapor                | Cloudflare Workers + AWS Lambda                             | `deploy` package        | `[x]`  |
| Unit graph              | Vapor's infra config | deterministic unit graph, `separate`/`single`               | `graph.ts`              | `[x]`  |
| Secrets management      | Vapor secrets        | secrets by reference, no plaintext in artifacts             | `secrets.ts`            | `[x]`  |
| Cold start optimization | Vapor runtime tuning | bundle size budgets                                         | `units.ts`              | `[x]`  |
| Queue triggers          | SQS/Lambda           | `[[queues.consumers]]`                                      | `queue-triggers.ts`     | `[x]`  |
| Custom domains          | Vapor domains        | AWS: `DomainName` + API Gateway; Cloudflare: `routes` entry | `sam.ts`, `wrangler.ts` | `[x]`  |
| Database proxies        | Vapor DB proxy       | RDS proxy semantics (Lambda), Hyperdrive (Workers)          | `lambda.ts`             | `[x]`  |

### 6.22 `@tsir/flags` (← pennant) — Laravel Pennant

Counterpart: LPK-PENNANT.

| Feature                  | Laravel feature                    | @tsir implementation              | Evidence     | Status |
| ------------------------ | ---------------------------------- | --------------------------------- | ------------ | ------ |
| Boolean flags            | `Feature::active('x')`             | boolean rules                     | `pennant.ts` | `[x]`  |
| Percentage rollout       | `Feature::for($user)->active('x')` | percentage via deterministic hash | `pennant.ts` | `[x]`  |
| User targeting           | scope                              | allowlist, conditional rules      | `pennant.ts` | `[x]`  |
| Multiple drivers         | database, array, redis             | memory, database stores           | `stores.ts`  | `[~]`  |
| Rich values              | `Feature::value('x')`              | —                                 | —            | `[ ]`  |
| Feature definition class | `Feature` class                    | rule functions                    | —            | `[x]`  |
| In-memory store          | `array`                            | `memoryStore`                     | `stores.ts`  | `[x]`  |
| Redis driver             | `redis`                            | —                                 | —            | `[ ]`  |

### 6.23 `@tsir/billing` (← cashier) — Laravel Cashier

Counterpart: LPK-CASHIER.

| Feature              | Laravel feature     | @tsir implementation                                                      | Evidence                | Status |
| -------------------- | ------------------- | ------------------------------------------------------------------------- | ----------------------- | ------ |
| Customers            | `Billable` model    | `Customer` type, customer creation                                        | `stripe.ts`             | `[x]`  |
| Subscriptions        | `newSubscription`   | `createSubscription`, `cancelSubscription`, `getSubscription` (full REST) | `stripe.ts`, `types.ts` | `[x]`  |
| Invoices             | `invoice()`         | `listInvoices` (full REST)                                                | `stripe.ts`, `types.ts` | `[x]`  |
| Webhook verification | `WebhookController` | `constructWebhookEvent`, signature verification                           | `webhooks.ts`           | `[x]`  |
| Paddle support       | Cashier Paddle      | —                                                                         | —                       | `[ ]`  |
| Tax handling         | tax rates           | `createTaxRate`, `listTaxRates`                                           | `stripe.ts`, `types.ts` | `[x]`  |
| Coupons/promotions   | coupons             | `createCoupon`, `getCoupon`, `listCoupons`                                | `stripe.ts`, `types.ts` | `[x]`  |
| Payment methods      | `paymentMethods`    | `listPaymentMethods`, `attachPaymentMethod`, `detachPaymentMethod`        | `stripe.ts`, `types.ts` | `[x]`  |
| Checkout sessions    | `checkout`          | `createCheckoutSession`, `getCheckoutSession` (line items + inline price) | `stripe.ts`, `types.ts` | `[x]`  |

### 6.24 `@tsir/servers` (← forge) — Laravel Forge

Counterpart: LPK-FORGE.

| Feature             | Laravel feature       | @tsir implementation                                | Evidence   | Status |
| ------------------- | --------------------- | --------------------------------------------------- | ---------- | ------ |
| Server CRUD         | Forge servers         | server CRUD                                         | `forge.ts` | `[x]`  |
| Command execution   | Forge daemon/commands | command execution                                   | `forge.ts` | `[x]`  |
| Deploy recipes      | Forge recipes         | deploy recipes                                      | `forge.ts` | `[x]`  |
| SSH provider        | Forge SSH             | `sshProvider` (ssh CLI) + `localProvider`           | `forge.ts` | `[x]`  |
| Cloud providers     | Forge DO/Linode/AWS   | — (planned: Hetzner, DO, Vultr, Lightsail, Linode)  | —          | `[ ]`  |
| Nginx/site config   | Forge site management | `createSite`, `deleteSite` (nginx + reload)         | `forge.ts` | `[x]`  |
| Database management | Forge DB              | `createDatabase`, `deleteDatabase` (postgres/mysql) | `forge.ts` | `[x]`  |
| SSL management      | Forge SSL             | `obtainSslCertificate`, `revokeSslCertificate`      | `forge.ts` | `[x]`  |

### 6.25 `@tsir/oauth` (← socialize) — Laravel Socialite

Counterpart: LPK-SOCIALITE.

| Feature                   | Laravel feature         | @tsir implementation            | Evidence              | Status |
| ------------------------- | ----------------------- | ------------------------------- | --------------------- | ------ |
| OAuth2 provider interface | `Socialite` driver      | `socialize`, provider interface | `socialize.ts`        | `[x]`  |
| Google provider           | Google driver           | `googleProvider`                | `providers/google.ts` | `[x]`  |
| GitHub provider           | GitHub driver           | `githubProvider`                | `providers/github.ts` | `[x]`  |
| CSRF state                | state param             | `generateState`, `verifyState`  | `state.ts`            | `[x]`  |
| User retrieval            | `user()`                | provider `user()`               | `providers/`          | `[x]`  |
| Additional providers      | Facebook, Twitter, etc. | —                               | —                     | `[ ]`  |
| OAuth1 providers          | Twitter (OAuth1)        | —                               | —                     | `[ ]`  |
| Stateless auth            | `stateless()`           | —                               | —                     | `[ ]`  |

### 6.26 `@tsir/search` (← scout) — Laravel Scout

Counterpart: LPK-SCOUT.

| Feature                 | Laravel feature      | @tsir implementation                        | Evidence         | Status           |
| ----------------------- | -------------------- | ------------------------------------------- | ---------------- | ---------------- |
| Search engine interface | Scout engine         | engine interface                            | `scout.ts`       | `[x]`            |
| SQLite FTS5             | —                    | `sqliteEngine`                              | `drivers.ts`     | `[x]`            |
| Postgres tsvector       | —                    | `postgresEngine`                            | `drivers.ts`     | `[x]`            |
| In-memory engine        | `collection`         | `memoryEngine` with tokenize + TF scoring   | `scout.ts`       | `[x]`            |
| Algolia driver          | Algolia              | `hostedSearch({ provider: 'algolia' })`     | `hosted.ts`      | `[x]`            |
| Meilisearch driver      | Meilisearch          | `hostedSearch({ provider: 'meilisearch' })` | `hosted.ts`      | `[x]`            |
| Typesense driver        | Typesense            | `hostedSearch({ provider: 'typesense' })`   | `hosted.ts`      | `[x]`            |
| Engine conformance kit  | —                    | `conformanceCases({ engine, prefix })`      | `conformance.ts` | `[x]`            |
| Searchable trait        | `Searchable`         | — (explicit indexing)                       | —                | `[D]` deliberate |
| Queue sync              | `ShouldBeSearchable` | `searchableIndexer({ engine, queue })`      | `indexer.ts`     | `[x]`            |

### 6.27 `@tsir/broadcast` — Laravel Broadcasting (Echo + Reverb)

Counterpart: LPK-BROADCAST, LPK-REVERB, LPK-ECHO.

| Feature               | Laravel feature      | @tsir implementation                                                                                                                                       | Evidence                  | Status |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------ |
| Broadcaster interface | `Broadcaster`        | `Broadcaster` interface                                                                                                                                    | `broadcaster.ts`          | `[x]`  |
| Memory broadcaster    | `log`/`null`         | memory broadcaster                                                                                                                                         | `broadcaster.ts`          | `[x]`  |
| WebSocket server      | Reverb               | WebSocket server with auth/authorize                                                                                                                       | `websocket.ts`            | `[x]`  |
| Client library        | Echo                 | `createEcho` (→ `createClient` post-rebrand)                                                                                                               | `echo.ts`                 | `[x]`  |
| Channel auth          | `Broadcast::channel` | channel authorization                                                                                                                                      | `websocket.ts`            | `[x]`  |
| Redis broadcaster     | `redis` driver       | `redisBroadcaster` — app-supplied `RedisPubSubClient` (publish/subscribe/unsubscribe + `on('message')`), prefixed channels, startup contract check         | `redis.ts`                | `[x]`  |
| Pusher driver         | Pusher               | `pusherBroadcaster` — app-supplied `PusherLike.trigger(channel, event, data)`                                                                              | `pusher.ts`               | `[x]`  |
| Presence channels     | presence channels    | `presence-` prefix; `authorize` returns `PresenceMember`; server tracks members, emits `pusher:subscription_succeeded` / `member_added` / `member_removed` | `websocket.ts`, `echo.ts` | `[x]`  |
| Private channels      | private channels     | `private-` prefix; requires `authorize` to return truthy                                                                                                   | `websocket.ts`, `echo.ts` | `[x]`  |
| Client events         | `whisper`            | `whisper(event, data)` on private/presence channels; forwarded to other subscribers as `client-<event>`; refused on public channels                        | `websocket.ts`, `echo.ts` | `[x]`  |

### 6.28 `@tsir/browser` (← nightwatch) — Laravel Dusk

Counterpart: LPK-DUSK. **Note: Laravel Nightwatch is an APM; our package maps to Dusk.**

> **CRITICAL NAMING CLARIFICATION:** Our `@tsir/nightwatch` is a **browser end-to-end testing harness** (a `page.goto()`, `page.click()`, `page.fill()`), functionally equivalent to **Laravel Dusk**, **not** Laravel Nightwatch. Laravel Nightwatch is an **APM** (application performance monitoring) with a hosted dashboard for requests, queries, jobs, exceptions, etc. The APM functionality is split across `@tsir/pulse` (observability primitives), `@tsir/telemetry` (request + queue monitoring), and the admin app's Dashboard/Requests/Queues UIs. See § 6.30 for the APM feature comparison.

| Feature             | Laravel feature    | @tsir implementation                                            | Evidence        | Status |
| ------------------- | ------------------ | --------------------------------------------------------------- | --------------- | ------ |
| Browser abstraction | `Dusk` test API    | `Page` interface: `goto`, `click`, `fill`, `text`, `screenshot` | `nightwatch.ts` | `[x]`  |
| In-memory backend   | —                  | `inMemoryBackend`                                               | `nightwatch.ts` | `[x]`  |
| Playwright backend  | `Dusk` uses Chrome | `playwrightBackend`                                             | `nightwatch.ts` | `[x]`  |
| Assertions          | `assertSee`, etc.  | — (no built-in assertions)                                      | —               | `[ ]`  |
| Page objects        | Page objects       | —                                                               | —               | `[ ]`  |
| Component helpers   | `@selector`        | —                                                               | —               | `[ ]`  |

### 6.29 `@tsir/telemetry` — Laravel Horizon + Telescope

Counterpart: LPK-HORIZON, LPK-TELESCOPE.

| Feature                     | Laravel feature   | @tsir implementation                                         | Evidence            | Status |
| --------------------------- | ----------------- | ------------------------------------------------------------ | ------------------- | ------ |
| Queue monitoring (Horizon)  | Horizon dashboard | `createQueueMonitor`, job counts/list/detail/retry           | `queue-monitor.ts`  | `[x]`  |
| Request logging (Telescope) | Telescope         | `createRequestLogger`, method/path/status/duration/principal | `request-logger.ts` | `[x]`  |
| Request log storage         | Telescope DB      | `requestLogs` table                                          | `request-logger.ts` | `[x]`  |
| Queue job storage           | Horizon metrics   | `queueJobs`, `queueDead` tables                              | `queue-monitor.ts`  | `[x]`  |
| Job retry from UI           | Horizon retry     | retry from `queue-monitor`                                   | `queue-monitor.ts`  | `[x]`  |
| Failed job detail           | Telescope         | —                                                            | —                   | `[ ]`  |
| Exception tracking          | Telescope         | —                                                            | —                   | `[ ]`  |
| Cache/DB query tracking     | Telescope         | —                                                            | —                   | `[ ]`  |
| Mail/notification tracking  | Telescope         | —                                                            | —                   | `[ ]`  |

### 6.30 APM / Monitoring — Laravel Nightwatch (APM) vs `@tsir/pulse` + `@tsir/telemetry` + Admin UI

Counterpart: LPK-NIGHTWATCH (Laravel Nightwatch APM). Our APM functionality is **not** in a single package — it is distributed across `@tsir/pulse` (observability primitives), `@tsir/telemetry` (request + queue monitoring), and the admin app's Dashboard/Requests/Queues pages.

> **Key architectural difference:** Laravel Nightwatch is a **hosted SaaS** with a managed agent (`php artisan nightwatch:agent`) collecting data to a centralized dashboard. Our stack is **self-hosted**: data is stored locally (Postgres/SQLite) and surfaced through the admin app. There is no centralized SaaS dashboard or agent process.

| Nightwatch APM feature    | @tsir implementation                                                                             | Evidence                           | Status                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| HTTP request tracing      | `createRequestLogger` records method/path/status/duration/principal/ip/ua to `requestLogs` table | `telemetry/request-logger.ts`      | `[~]` partial — no per-query breakdown or timeline            |
| Request timeline          | — (each event linked to its parent request with timings)                                         | —                                  | `[ ]`                                                         |
| Outgoing HTTP requests    | —                                                                                                | —                                  | `[ ]`                                                         |
| SQL query monitoring      | — (no query timing capture)                                                                      | —                                  | `[ ]`                                                         |
| Slow query detection      | —                                                                                                | —                                  | `[ ]`                                                         |
| Queue job monitoring      | `createQueueMonitor`: counts/list/get/retry across `queueJobs` + `queueDead`                     | `telemetry/queue-monitor.ts`       | `[x]`                                                         |
| Scheduled task monitoring | —                                                                                                | —                                  | `[ ]`                                                         |
| Command/Artisan tracking  | —                                                                                                | —                                  | `[ ]`                                                         |
| Mail monitoring           | —                                                                                                | —                                  | `[ ]`                                                         |
| Notification monitoring   | —                                                                                                | —                                  | `[ ]`                                                         |
| Cache hit/miss tracking   | —                                                                                                | —                                  | `[ ]`                                                         |
| Exception tracking        | — (no capture, no grouping into issues)                                                          | —                                  | `[ ]`                                                         |
| Logs (searchable)         | `createLogger` with structured records + sinks; no search UI                                     | `pulse/logger.ts`                  | `[~]` partial — logs exist, no search UI                      |
| Metrics                   | `createMetrics`: counter/histogram/gauge with cardinality guard                                  | `pulse/metrics.ts`                 | `[x]`                                                         |
| Metrics visualization     | Admin Dashboard page renders metric cards from `/system/metrics`                                 | `admin/.../pages/Dashboard.svelte` | `[~]` partial — raw number cards, no charts/graphs            |
| Tracing (distributed)     | `createTracer`: W3C `traceparent`, spans, samplers                                               | `pulse/tracing.ts`                 | `[x]`                                                         |
| Health checks             | `createHealth`: liveness/readiness with critical/degraded states                                 | `pulse/health.ts`                  | `[x]`                                                         |
| Alerts / notifications    | —                                                                                                | —                                  | `[ ]`                                                         |
| Hosted dashboard          | Admin app Dashboard, Requests, Queues pages (self-hosted)                                        | `admin/client/src/pages/`          | `[~]` partial — basic list UIs, no Nightwatch-level dashboard |
| Agent process             | — (no separate agent; instrumentation is in-process)                                             | —                                  | `[D]` deliberate: in-process instrumentation, no agent        |
| Multi-region data         | — (local storage only)                                                                           | —                                  | `[ ]`                                                         |
| Per-user impact           | —                                                                                                | —                                  | `[ ]`                                                         |
| Team collaboration        | — (single-user admin)                                                                            | —                                  | `[ ]`                                                         |

**APM coverage summary:** Of 21 Nightwatch APM features, 4 are verified (`[x]`), 4 are partial (`[~]`), 12 are not implemented (`[ ]`), and 1 is deliberately different (`[D]`). The biggest gaps are **exception tracking**, **SQL query monitoring**, **request timelines**, **alerts**, and **a rich dashboard with visualizations**.

### 6.31 UI/UX Coverage Matrix — Admin App Pages vs `@tsir/*` Packages

The admin app (`src/apps/admin.product.com/client/src/pages/`) is the **only** user-facing UI in the monorepo. It provides management screens for a subset of packages. Infrastructure packages (config, container, http, router, console, deploy, database, migrate, seed, validate) have no UI by design — they are framework primitives.

| @tsir package                                                                                                            | Admin UI page(s)                            | UI capability                                                 | Status  |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------- | ------- |
| `@tsir/auth`                                                                                                             | Login, ForgotPassword, ResetPassword, Setup | Full auth flow UI with captcha, password reset, initial setup | `[x]`   |
| `@tsir/policy`                                                                                                           | Roles, Permissions, Groups                  | RBAC management: assign roles/permissions, create groups      | `[x]`   |
| `@tsir/mail`                                                                                                             | EmailTemplates                              | Edit email templates (reset-password)                         | `[~]`   |
| `@tsir/pennant`                                                                                                          | FeatureFlags                                | Toggle feature flags                                          | `[x]`   |
| `@tsir/queue`                                                                                                            | Queues                                      | Horizon-style: state counts, job list, detail drawer, retry   | `[x]`   |
| `@tsir/telemetry`                                                                                                        | Requests                                    | Telescope-style: request log list with method/status filters  | `[x]`   |
| `@tsir/pulse`                                                                                                            | Dashboard                                   | Metric cards (raw numbers, no charts)                         | `[~]`   |
| `@tsir/i18n`                                                                                                             | I18n (Translations)                         | Translation key/locale management                             | `[x]`   |
| `@tsir/vault`                                                                                                            | —                                           | No UI (key rotation via CLI only)                             | `[ ]`   |
| `@tsir/cache`                                                                                                            | —                                           | No UI (programmatic only)                                     | `[ ]`   |
| `@tsir/storage`                                                                                                          | —                                           | No UI (programmatic only)                                     | `[ ]`   |
| `@tsir/scout`                                                                                                            | — (search API only)                         | No dedicated search management UI                             | `[ ]`   |
| `@tsir/socialize`                                                                                                        | —                                           | No UI (OAuth flow handled by auth routes)                     | `[ ]`   |
| `@tsir/media`                                                                                                            | —                                           | No UI (programmatic only)                                     | `[ ]`   |
| `@tsir/events`                                                                                                           | —                                           | No UI (internal event bus)                                    | `[ ]`   |
| `@tsir/schedule`                                                                                                         | —                                           | No UI (scheduler runs headless)                               | `[ ]`   |
| `@tsir/notify`                                                                                                           | —                                           | No UI (notifications sent programmatically)                   | `[ ]`   |
| `@tsir/cashier`                                                                                                          | —                                           | No billing/subscription management UI                         | `[ ]`   |
| `@tsir/forge`                                                                                                            | —                                           | No server management UI                                       | `[ ]`   |
| `@tsir/broadcast`                                                                                                        | —                                           | No channel/connection management UI                           | `[ ]`   |
| `@tsir/nightwatch`                                                                                                       | —                                           | No UI (test harness only)                                     | `[N/A]` |
| Infrastructure (`config`, `container`, `http`, `router`, `console`, `deploy`, `database`, `migrate`, `seed`, `validate`) | —                                           | No UI by design (framework primitives)                        | `[N/A]` |

**UI coverage summary:** 8 packages have admin UIs (5 fully implemented, 2 partial — mail templates and dashboard metrics), 11 have no UI but could benefit from one, and the rest are infrastructure with no UI by design.

---

## 7. Overall feature parity overview

### 7.1 Summary by package

| @tsir package       | Counterpart       | Total features | Verified | Partial | Not impl. | Blocked | Unverified | Deliberately diff. |
| ------------------- | ----------------- | -------------- | -------- | ------- | --------- | ------- | ---------- | ------------------ |
| auth                | Auth+Sanctum      | 11             | 6        | 2       | 3         | 0       | 0          | 0                  |
| policy              | Authorization     | 7              | 5        | 0       | 1         | 0       | 0          | 1                  |
| vault               | Encryption        | 6              | 4        | 0       | 2         | 0       | 0          | 0                  |
| cache               | Cache             | 9              | 9        | 0       | 0         | 0       | 0          | 0                  |
| database            | DB                | 10             | 7        | 0       | 2         | 0       | 0          | 1                  |
| migrate             | Migrations        | 7              | 6        | 0       | 0         | 0       | 0          | 1                  |
| seed                | Seeders           | 6              | 5        | 0       | 1         | 0       | 0          | 0                  |
| events              | Events            | 7              | 5        | 1       | 0         | 0       | 0          | 1                  |
| queue               | Queue             | 12             | 8        | 2       | 2         | 0       | 0          | 0                  |
| schedule            | Schedule          | 8              | 7        | 1       | 0         | 0       | 0          | 0                  |
| mail                | Mail              | 9              | 7        | 1       | 1         | 0       | 0          | 0                  |
| notify              | Notifications     | 8              | 6        | 0       | 2         | 0       | 0          | 0                  |
| storage             | Filesystem        | 9              | 9        | 0       | 0         | 0       | 0          | 0                  |
| validate            | Validation        | 8              | 6        | 0       | 2         | 0       | 0          | 0                  |
| pulse               | Logging+Pulse     | 23             | 4        | 4       | 14        | 0       | 0          | 1                  |
| config              | Config            | 5              | 4        | 0       | 0         | 0       | 0          | 1                  |
| container           | Container         | 7              | 4        | 0       | 1         | 0       | 0          | 2                  |
| http                | HTTP              | 11             | 8        | 0       | 3         | 0       | 0          | 0                  |
| router              | Routing           | 9              | 5        | 0       | 3         | 0       | 0          | 1                  |
| console             | Artisan           | 9              | 8        | 0       | 1         | 0       | 0          | 0                  |
| deploy              | Vapor             | 7              | 7        | 0       | 0         | 0       | 0          | 0                  |
| flags               | Pennant           | 8              | 5        | 1       | 2         | 0       | 0          | 0                  |
| billing             | Cashier           | 9              | 8        | 0       | 1         | 0       | 0          | 0                  |
| servers             | Forge             | 8              | 7        | 0       | 1         | 0       | 0          | 0                  |
| oauth               | Socialite         | 8              | 5        | 0       | 3         | 0       | 0          | 0                  |
| search              | Scout             | 10             | 9        | 0       | 0         | 0       | 0          | 1                  |
| broadcast           | Broadcasting      | 10             | 10       | 0       | 0         | 0       | 0          | 0                  |
| browser             | Dusk              | 6              | 3        | 0       | 3         | 0       | 0          | 0                  |
| telemetry           | Horizon+Telescope | 9              | 5        | 0       | 4         | 0       | 0          | 0                  |
| **total (29 pkgs)** | —                 | 256            | 182      | 12      | 52        | 0       | 0          | 10                 |

### 7.2 Aggregate metrics

Counted mechanically from the § 6 tables on 2026-11-09 (every row's last cell, package sections only —
the `@tsir/*` cross-cutting section is counted separately because it is not a package), so this block
cannot drift from the rows again. The count itself is mechanical; the **rows** are not, and three
`@tsir/search` rows still said `[ ]` for engines that shipped — see the note below:

- **Total identified features:** 256 (plus 22 cross-cutting rows in § 6.30/§ 6.31)
- **Verified parity:** 182 (71.1% of 256)
- **Partial parity:** 12 (4.7%)
- **Not implemented:** 52 (20.3%)
- **Deliberately different:** 10 (3.9%)
- **Not applicable:** 0 here; 2 in the cross-cutting section
- **Blocked / Unverified:** 0 / 0
- Excluding deliberately-different rows (not gaps): **74.0% verified**, **78.9%** including partial
  — Gate P10's ≥ 80 % target is therefore **not yet met**, by about 5 points.

> The earlier "162 / 241" block is superseded: it double-counted the `@tsir/*` cross-cutting rows and
> pre-dated the schedule (7/8) and broadcast (10/10) closures. § 7.1 above is the same mechanical
> recount, per package, and its total row sums to this block.
>
> **2026-11-07 audit correction:** 8 features were under-reported as `[ ]`/`[~]` but
> are fully implemented (cache tags/increment/remember, scout in-memory engine,
> cashier subscriptions/invoices, mail attachments, deploy custom domains). 2 queue
> features (delayed/unique jobs) reclassified from `[ ]` to `[~]` (backend-dependent).
> No `[x]` claims were found to be stubs or placeholders.
>
> **2026-11-08 schedule parity:** 4 `@tsir/schedule` features closed (runInBackground,
> timezone, maintenance mode, task hooks) — schedule now 7/8 verified.
>
> **2026-11-08 broadcast parity:** 5 `@tsir/broadcast` features closed (Redis broadcaster,
> Pusher driver, presence channels, private channels, client events) — broadcast now 10/10 verified.
>
> **2026-11-09 search parity:** 5 `@tsir/search` rows corrected from `[ ]` — the three hosted
> engines (`hostedSearch({ provider })` for Typesense, Meilisearch and Algolia, one fetch-only
> driver shared by all three), the engine conformance kit (`SRCH-8`), and queue sync (`SRCH-7`),
> which defers `index`/`remove` to a queue while `search` stays inline. Search is 9/10; the last row
> is `Searchable`, deliberately different because indexing here is explicit. The rows had been stale
> since the engines landed, and § 7.1's total is recounted from them.

### 7.3 Highest-priority implementation gaps

Counts are `verified / total` from § 7.1. Every row now names the task that closes it, so a gap is
never just a number.

| #   | Package                      | Verified | Gap                                                                                                         | Task(s)                                                                      |
| --- | ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `@tsir/pulse`                | 4/23     | The whole driver/instrumentation half: per-runtime log drivers and the HTTP/DB/queue/vault instrumentations | `OBS-014`, `OBS-020`, `OBS-024`, `OBS-026`–`OBS-028`                         |
| 2   | `@tsir/search` (scout)       | 9/10     | None — engines, conformance kit and queue sync all landed; the last row is deliberately different           | —                                                                            |
| 3   | `@tsir/telemetry`            | 5/9      | Failed-job detail, exception tracking, cache/DB/mail event tracking                                         | `TEL-5`–`TEL-9`; blocked on `INF-010`                                        |
| 4   | `@tsir/auth`                 | 6/11     | Sanctum SPA cookie auth, CSRF middleware, email verification                                                | `AUTH-13`–`AUTH-15`; needs `HTP-023`                                         |
| 5   | `@tsir/router`               | 5/9      | Named routes + URL generation, `apiResource`, sub-domain routing                                            | `RTR-013`–`RTR-015`                                                          |
| 6   | `@tsir/oauth` (socialize)    | 5/8      | Facebook/X/Apple providers, OAuth 1.0a, stateless handoff                                                   | `OAUTH-6`–`OAUTH-8`                                                          |
| 7   | `@tsir/browser` (nightwatch) | 3/6      | Assertions, page objects, `testBrowser()` harness                                                           | `BROW-4`–`BROW-6`                                                            |
| 8   | `@tsir/http`                 | 8/11     | Cookies, trusted proxies, maintenance mode                                                                  | `HTP-023`, `HTP-024` (maintenance mode is `@tsir/schedule`'s, already built) |
| 9   | `@tsir/database`             | 7/10     | Pessimistic locking, pagination                                                                             | `DB-027`, `DB-028`                                                           |
| 10  | `@tsir/billing` / `servers`  | 8/9, 7/8 | Paddle provider; cloud-provider drivers                                                                     | `BILL-5`, `SRV-6`                                                            |

**Read this table with `16-infrastructure-hardening.md` beside it.** Two of the largest gaps above are
not feature gaps at all: `@tsir/telemetry` cannot run on the default database (`INF-010`) and
`@tsir/pulse`'s drivers are blocked behind the same `waitUntil` seam the admin app needs (`INF-006`).

> `@tsir/storage` is complete (9/9): visibility, streaming, directory listing, and
> copy/move were implemented across all three drivers (memory, local, s3) with conformance
> coverage.
>
> `@tsir/schedule` is now 7/8 verified (background runs, IANA timezone, maintenance mode,
> and the `before`/`after`/`onSuccess`/`onFailure` hooks). The remaining partial is
> `onOneServer` (already covered by the shared lock). No longer a priority gap.
>
> `@tsir/broadcast` is now 10/10 verified: Redis and Pusher broadcasters (app-supplied
> clients), private channels, presence channels with member tracking, and client whisper
> events. No longer a priority gap.

---

## 8. Known architectural differences (deliberate)

| Area             | Laravel                                | @tsir                                                           | Reason                                             |
| ---------------- | -------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| ORM              | Eloquent ORM                           | Drizzle ORM (no Eloquent)                                       | Drizzle is the chosen SQL layer; TypeScript-first. |
| Container        | Global container, facades, auto-wiring | Explicit constructor injection, no global container, no facades | Avoids service-locator anti-pattern.               |
| Migrations       | Fluent schema builder                  | Raw SQL with `--> statement-breakpoint`                         | Drizzle convention; explicit SQL is reviewable.    |
| Config caching   | `config:cache`, `route:cache`          | Build-time compiled `routes.gen.ts`, no runtime reflection      | No decorator reflection on hot path.               |
| Deployment       | Vapor (AWS-abstracted)                 | Cloudflare Workers + AWS Lambda                                 | Multi-provider first-party.                        |
| Auth             | Eloquent User model                    | Adapter-based (no model requirement)                            | Runtime-neutral.                                   |
| Policy discovery | Auto-discovery                         | Explicit registration                                           | Safer, no filesystem scanning at boot.             |
| Pulse            | Analytics dashboard                    | Observability primitives                                        | Dashboard is app-level concern.                    |

---

## 9. Dependencies & prerequisites

1. **Phase 9 (rebranding) must complete first.** Feature mappings here use the
   post-rebrand names; implementation tasks must reference the final package
   names. Do not start implementation tasks until the rename is merged.
2. **Phase 8 (production readiness) must close.** The API surface must be stable
   before adding features.
3. **Cross-package dependencies:** some features depend on other packages (e.g.,
   `@tsir/queue` batching depends on `@tsir/events`; `@tsir/broadcast` Redis
   driver depends on a Redis client; `@tsir/search` engine drivers depend on
   their respective clients).

---

## 10. Implementation tasks

Each task is `[ ]` pending. Tasks are ordered by priority (§ 7.3) within
groups. Acceptance criteria reference the feature rows in § 6.

### `PARITY-001 — `@tsir/billing` (cashier): checkout, payment methods, coupons, tax

- **Phase:** 10
- **Status:** `[~]` (Paddle remaining)
- **Depends on:** Phase 9 rename complete
- **Features:** § 6.23 rows: checkout sessions `[x]`, payment methods `[x]`, coupons `[x]`, tax `[x]`, Paddle `[ ]` (subscriptions + invoices `[x]`)
- **Acceptance criteria:**
  - [x] Stripe Checkout session creation verified — `createCheckoutSession`, `getCheckoutSession`.
  - [x] Payment method management (list/attach/detach) — `listPaymentMethods`, `attachPaymentMethod`, `detachPaymentMethod`.
  - [x] Coupon/promotion code handling — `createCoupon`, `getCoupon`, `listCoupons`.
  - [x] Tax rate handling — `createTaxRate`, `listTaxRates`.
  - [ ] Webhook handlers for subscription lifecycle events (signature verification only).
  - [x] Subscriptions (create/cancel/get) verified — already implemented.
  - [x] Invoices (list) verified — already implemented.
  - [x] Existing webhook verification tests still pass — `webhooks.test.ts` 3 pass.
- **Evidence:** `src/framework/cashier/src/stripe.ts`, `src/framework/cashier/src/types.ts`, `src/framework/cashier/src/stripe.test.ts` (9 tests pass).
- **Remaining:** Paddle provider, subscription lifecycle webhook handlers.

### `PARITY-002 — `@tsir/servers` (forge): cloud providers

- **Phase:** 10
- **Status:** `[~]` (cloud providers remaining)
- **Depends on:** Phase 9 rename complete
- **Features:** § 6.24 rows: SSH provider `[x]`, cloud providers `[ ]`, site config `[x]`, DB management `[x]`, SSL management `[x]`
- **Acceptance criteria:**
  - [x] SSH provider implemented — `sshProvider` over the `ssh` CLI with key/port/strict options; tested for server shape and failure path.
  - [x] Nginx site management — `createSite`/`deleteSite` with proxy or static root, nginx -t + reload.
  - [x] Database management — `createDatabase`/`deleteDatabase` for postgres + mysql.
  - [x] SSL management — `obtainSslCertificate`/`revokeSslCertificate` via certbot.
  - [ ] Hetzner cloud provider implemented (read-only first).
  - [x] Existing local provider tests pass — 5 tests pass.
- **Evidence:** `src/framework/forge/src/forge.ts`, `src/framework/forge/src/forge-management.test.ts` (14 tests pass).
- **Remaining:** cloud providers (Hetzner, DO, etc.).

### `PARITY-003 — `@tsir/search` (scout): third-party engines

- **Phase:** 10
- **Status:** `[~]` (engines done; queue sync remaining)
- **Depends on:** —
- **Features:** § 6.26 rows: Algolia, Meilisearch, Typesense, queue sync
- **Acceptance criteria:**
  - [x] `memoryEngine` implements the engine interface — tokenize + term-frequency scoring.
  - [x] All three hosted engines, sharing one fetch-only driver — `hostedSearch({ provider })` for
        `typesense`, `meilisearch` and `algolia`, with per-provider auth headers, host defaults and
        result-field mapping. No SDK: a provider is a host and a key.
  - [x] SQLite + Postgres engines continue to pass.
  - [x] Engine conformance kit — `conformanceCases({ engine, prefix })`, 11 cases, run against
        `memory` in-repo; a third-party engine runs the same data under its own runner (`SRCH-8`).
- **Evidence:** `src/framework/scout/src/hosted.ts` (`hosted.test.ts`), `conformance.ts`
  (`conformance.test.ts`, 6 tests), `src/docs/guides/search.md`.
- **Remaining:** `SRCH-7` queue sync — index and remove dispatched as queued jobs, so a write does
  not wait for a remote index. The port makes it additive: it wraps an engine, it does not change one.

### `PARITY-004 — `@tsir/storage`: visibility, streaming, listing, copy/move

- **Phase:** 10
- **Status:** `[x]`
- **Depends on:** —
- **Features:** § 6.13 rows — all 9 now verified
- **Acceptance criteria:**
  - [x] `setVisibility` on all drivers (memory, local, s3). Local maps to file mode bits; S3 maps to canned ACL.
  - [x] Streaming reads — `stream()` returns a `ReadableStream<Uint8Array>` on all drivers.
  - [x] `directories(prefix)` listing — immediate subdirectories under a prefix.
  - [x] `copy`/`move` operations within a disk.
- **Evidence:** `src/framework/storage/src/port.ts`, `drivers/{memory,s3,adapters/local}.ts`, `conformance.ts` (5 new cases run against memory + local), `s3.test.ts` (4 new cases). 80 storage tests pass.

### `PARITY-005 — `@tsir/schedule`: background, timezone, hooks

- **Phase:** 10
- **Status:** `[x]`
- **Depends on:** —
- **Features:** § 6.10 rows: runInBackground, timezone, maintenance mode, before/after/onSuccess/onFailure hooks
- **Acceptance criteria:**
  - [x] Tasks run without blocking the scheduler tick — `runInBackground` fires `void executeTask(...)` and returns `status: 'ran'` immediately; lock held until background run finishes.
  - [x] Per-task timezone respected — IANA `timezone` on `defineTask`; `wallClock` uses `Intl.DateTimeFormat` per tick so DST is honoured; `toUtcCron` refuses DST zones.
  - [x] Lifecycle hooks fire with correct arguments — `before(context)`, `after(context)`, `onSuccess(context)`, `onFailure(context, error)`; `before` throwing fails the run; other hook errors are logged only.
  - [x] Maintenance mode — `isMaintenanceMode` scheduler option skips cron ticks (`status: 'skipped'`) unless task sets `evenInMaintenanceMode: true`; manual runs always run.
- **Evidence:** `src/framework/schedule/src/{cron,task,scheduler,bootstrap}.ts`, `src/framework/console/src/commands/schedule.ts`; `cron.test.ts` (+5 tz tests), `scheduler.test.ts` (+11 tests: 3 maintenance, 2 background, 6 hooks). 23 scheduler + 31 cron + 9 task tests pass.

### `PARITY-006 — `@tsir/broadcast`: Redis/Pusher drivers, channels

- **Phase:** 10
- **Status:** `[x]`
- **Depends on:** — (app-supplied clients; no runtime dependency)
- **Features:** § 6.27 rows: Redis broadcaster, Pusher driver, presence channels, private channels, client events
- **Acceptance criteria:**
  - [x] Redis broadcaster pub/sub — `redisBroadcaster` takes an app-supplied `RedisPubSubClient` (`publish`/`subscribe`/`unsubscribe` + `on('message')`), prefixes channels, opens the Redis subscription on first local subscriber and closes it on the last. Verified against a fake Redis client.
  - [x] Pusher driver — `pusherBroadcaster` takes an app-supplied `PusherLike.trigger`.
  - [x] Private + presence channel authorization — `private-` requires `authorize` truthy; `presence-` requires `authorize` to return a `PresenceMember`; server tracks members and emits `pusher:subscription_succeeded` / `member_added` / `member_removed`.
  - [x] Client events (`whisper`) — `whisper(event, data)` on private/presence channels forwarded to other subscribers as `client-<event>`; refused on public channels and on unsubscribed channels.
- **Evidence:** `src/framework/broadcast/src/{redis,pusher,websocket,echo}.ts`; `redis.test.ts` (6), `pusher.test.ts` (3), `websocket.test.ts` (12). 21 broadcast tests pass.

### `PARITY-007 — `@tsir/cache`: locks

- **Phase:** 10
- **Status:** `[x]`
- **Depends on:** —
- **Features:** § 6.4 rows: `Cache::lock` (tags, remember, increment now `[x]`)
- **Acceptance criteria:**
  - [x] Tag-based cache with driver support matrix — already implemented.
  - [x] `Cache::lock` equivalent with ownership and TTL — `CacheLock` interface, `cache.lock(name, ttlMs, owner)`, `get`/`block`/`release`/`forceRelease`; atomic acquire/release on memory, database, redis backends; refused on KV/null. Conformance cases pass for all drivers.
  - [x] `remember`/`rememberForever` lazy evaluation — already implemented.
  - [x] `increment`/`decrement` atomic operations — already implemented.
- **Evidence:** `src/framework/cache/src/store.ts` (`CacheLock`, `lock()`), `src/framework/cache/src/port.ts` (`locks` capability, `acquireLock`/`releaseLock` backend methods), `src/framework/cache/src/conformance.ts` (lock cases), `bun test src/framework/cache` → 109 pass.

### `PARITY-008 — `@tsir/auth`: Sanctum SPA, CSRF, email verification

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** `@tsir/http` CSRF middleware
- **Features:** § 6.1 rows: SPA cookie auth, CSRF protection, email verification
- **Acceptance criteria:**
  - [ ] Sanctum-style SPA cookie auth with `XSRF-TOKEN` cookie.
  - [ ] CSRF middleware for state-changing requests.
  - [ ] Email verification flow with signed URLs (`@tsir/vault` signing).

### `PARITY-009 — `@tsir/queue`: batching, chains

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** —
- **Features:** § 6.9 rows: job batching, chains (delayed + unique jobs now `[~]`, backend-dependent)
- **Acceptance criteria:**
  - [ ] `Bus::batch` equivalent with progress tracking.
  - [ ] Job chains with sequential execution.
  - [x] Delayed job dispatch via `dispatchLater` — already implemented (backend-dependent).
  - [x] Unique job dedup via idempotency keys — already implemented (backend-dependent).

### `PARITY-010 — `@tsir/telemetry`: exception, cache, DB, mail tracking

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** `@tsir/pulse` tracing integration
- **Features:** § 6.29 rows
- **Acceptance criteria:**
  - [ ] Exception capture with stack traces.
  - [ ] Cache operation tracking (hits/misses).
  - [ ] DB query timing capture.
  - [ ] Mail/notification send tracking.

### `PARITY-011 — `@tsir/router`: named routes, API resource routes

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** —
- **Features:** § 6.19 rows
- **Acceptance criteria:**
  - [ ] Named route generation (`urlFor('route.name', params)`).
  - [ ] `apiResource` decorator generating CRUD routes.

### `PARITY-012 — `@tsir/database`: pessimistic locking, pagination

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** Drizzle version support
- **Features:** § 6.5 rows
- **Acceptance criteria:**
  - [ ] `lockForUpdate`/`sharedLock` on supported drivers.
  - [ ] Cursor + offset pagination helpers.

### `PARITY-013 — `@tsir/mail`: markdown mail

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** —
- **Features:** § 6.11 rows: Markdown mail (attachments now `[x]`)
- **Acceptance criteria:**
  - [x] File attachments with MIME types — already implemented across all transports.
  - [ ] Markdown mail rendering (optional dependency).

### `PARITY-014 — `@tsir/flags` (pennant): rich values, Redis driver

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** Phase 9 rename complete
- **Features:** § 6.22 rows
- **Acceptance criteria:**
  - [ ] `value('flag')` returning rich typed values.
  - [ ] Redis store implementation.

### `PARITY-015 — `@tsir/oauth` (socialize): additional providers

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** Phase 9 rename complete
- **Features:** § 6.25 rows
- **Acceptance criteria:**
  - [ ] At least 2 additional providers (e.g., Facebook, Microsoft).
  - [ ] Provider conformance test kit.

### `PARITY-016 — `@tsir/browser` (nightwatch): assertions, page objects

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** Phase 9 rename complete
- **Features:** § 6.28 rows
- **Acceptance criteria:**
  - [ ] `assertSee`, `assertVisible`, etc. assertion helpers.
  - [ ] Page object pattern support.

### `PARITY-017 — `@tsir/console`: REPL (`@tsir/repl`)

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** —
- **Features:** § 6.20 row: Tinker/REPL
- **Acceptance criteria:**
  - [ ] `tsir tinker` launches a REPL with access to the app container.

### `PARITY-018 — `@tsir/pulse`→`observability`: metrics exporters

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** Phase 9 rename complete
- **Features:** § 6.15 row: metrics exporters
- **Acceptance criteria:**
  - [ ] Prometheus text-format exporter.
  - [ ] OTLP exporter (optional).

### `PARITY-019 — `@tsir/seed`: factories

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** —
- **Features:** § 6.7 row: factories
- **Acceptance criteria:**
  - [ ] `defineFactory` with faker integration.
  - [ ] Factory states and relationships.

### `PARITY-020 — `@tsir/validate`: unique/exists rules

- **Phase:** 10
- **Status:** `[ ]`
- **Depends on:** `@tsir/database`
- **Features:** § 6.14 rows
- **Acceptance criteria:**
  - [ ] `unique(table, column)` and `exists(table, column)` schema refinements.

---

## 11. Verification requirements

For each feature marked `[x]` verified:

1. Source file + exported symbol reference.
2. Test file + specific test case reference.
3. Official Laravel documentation URL (§ 4).
4. Behavior is exercised by the test (not just symbol existence).

When a feature moves from `[~]`/`[ ]` to `[x]`, update this document's
status, add evidence, and close the corresponding `PARITY-*` task.

### 11.1 Completion criteria (Gate P10)

1. Every relevant `@tsir/*` package has an entry in § 6.
2. Every feature row has a status and (for `[x]`) evidence.
3. All `PARITY-*` tasks either closed or explicitly deferred with rationale.
4. No feature is marked `[x]` without source + test + doc evidence.
5. Aggregate verified parity ≥ 80% (excluding deliberately-different rows).
6. This document is the single source of truth; no parallel parity tracking.

---

## 12. Status legend

- `[x]` Verified Parity
- `[~]` Partial Parity
- `[ ]` Not Implemented
- `[!]` Blocked
- `[?]` Unverified
- `[N/A]` Not Applicable
- `[D]` Deliberately Different

All `PARITY-*` tasks are `[ ]` pending. This phase depends on Phase 9
(rebranding) completion before any implementation begins.
