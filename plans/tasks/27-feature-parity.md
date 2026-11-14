# 15 — `@tsir/*` Ecosystem Feature Parity: Research, Mapping & Implementation Tasks

> **Phase 10 (post-rebranding).** Establish 1:1 functional feature coverage between
> the `@tsir/*` packages and their Laravel ecosystem counterparts, using
> authoritative Laravel documentation and verifiable implementation evidence.
>
> **Status:** planning & research only. No package implementations are modified.
> All implementation tasks are `[ ]` pending. Feature mappings use the
> post-rebrand package names (see [`26-laravel-decoupling.md`](./26-laravel-decoupling.md));
> where rebranding has not yet executed, the current name is noted in parentheses.
>
> **Audit:** [`27-feature-parity-audit.md`](./27-feature-parity-audit.md) is the
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

| Id           | Feature                   | Laravel feature                    | @tsir implementation                                                                | Evidence                        | Status                |
| ------------ | ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------- | --------------------- |
| `PARITY-001` | Password hashing          | bcrypt/argon2id, configurable cost | `password.ts`: PBKDF2-SHA256 default, argon2id on Bun, self-describing hashes       | `password.test.ts`              | `[x]`                 |
| `PARITY-002` | Password verification     | `Hash::check`                      | `verifyPassword` with rehash on cost change                                         | `password.test.ts`              | `[x]`                 |
| `PARITY-003` | Cookie sessions           | `Session` facade, stores           | `session.ts`: cookie sessions, DB/memory stores, idle + absolute lifetime, rotation | `session.test.ts`               | `[x]`                 |
| `PARITY-004` | API tokens                | Sanctum `personal_access_tokens`   | `token.ts`: bearer tokens, API keys (`keys.ts`)                                     | `token.test.ts`, `keys.test.ts` | `[x]`                 |
| `PARITY-005` | Token abilities/scopes    | Sanctum token abilities            | `keys.ts`: `databaseApiKeyStore` with abilities                                     | `keys.test.ts`                  | `[~]`                 |
| `PARITY-006` | Guards                    | Auth guards                        | `guards.ts`: session, bearer, apiKey, compose                                       | `guards.test.ts`                | `[x]`                 |
| `PARITY-007` | SPA cookie auth (Sanctum) | Sanctum SPA authentication         | —                                                                                   | —                               | `[ ]`                 |
| `PARITY-008` | CSRF protection           | CSRF middleware                    | — (planned: admin CSRF)                                                             | —                               | `[ ]`                 |
| `PARITY-009` | Email verification        | `MustVerifyEmail`                  | —                                                                                   | —                               | `[ ]`                 |
| `PARITY-010` | Password reset            | `Password::broker`                 | admin `password-reset.service.ts` (app-level, not framework)                        | —                               | `[~]`                 |
| `PARITY-011` | Rate limiting (auth)      | `RateLimiter`                      | `@tsir/pulse` `createRateLimiter`                                                   | `limits.ts`                     | `[x]` (cross-package) |

### 6.2 `@tsir/policy` — Laravel Authorization

Counterpart: LAR-AUTHZ.

| Id           | Feature               | Laravel feature        | @tsir implementation            | Evidence       | Status                                           |
| ------------ | --------------------- | ---------------------- | ------------------------------- | -------------- | ------------------------------------------------ |
| `PARITY-012` | Gates                 | `Gate::define`         | `defineGate`                    | `policy` tests | `[x]`                                            |
| `PARITY-013` | Policies              | Policy classes         | `definePolicy`, ownership rules | `policy` tests | `[x]`                                            |
| `PARITY-014` | Roles                 | — (Spatie, not core)   | Roles with `implies`            | `policy` tests | `[x]` (extra)                                    |
| `PARITY-015` | Permissions           | — (Spatie, not core)   | Permissions                     | `policy` tests | `[x]` (extra)                                    |
| `PARITY-016` | HTTP integration      | `authorize` middleware | `toHttpPolicies`                | `policy` tests | `[x]`                                            |
| `PARITY-017` | Resource policies     | `authorizeResource`    | —                               | —              | `[ ]`                                            |
| `PARITY-018` | Policy auto-discovery | Auto-discovery         | — (explicit registration)       | —              | `[D]` deliberate: explicit registration is safer |

### 6.3 `@tsir/vault` — Laravel Encryption

Counterpart: LAR-ENC.

| Id           | Feature              | Laravel feature                    | @tsir implementation                                                                   | Evidence                          | Status        |
| ------------ | -------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- | ------------- |
| `PARITY-019` | Symmetric encryption | `Crypt::encrypt` (AES-256-CBC/GCM) | AES-256-GCM via WebCrypto, self-describing envelope                                    | `cipher.ts`, `vault.test.ts`      | `[x]`         |
| `PARITY-020` | Key rotation         | `APP_KEY` rotation                 | Keyring state machine (`staged`/`active`/`decrypt-only`/`retired`), resumable rotation | `rotation.ts`, `rotation.test.ts` | `[x]`         |
| `PARITY-021` | Encrypted DB columns | `encrypted` cast                   | `createVaultCodec` for Drizzle columns, AAD bound to table+column                      | `codec.ts`                        | `[x]`         |
| `PARITY-022` | Blind indexing       | —                                  | `blind.ts` for searchable encryption                                                   | `blind`                           | `[x]` (extra) |
| `PARITY-023` | Signed URLs          | `URL::signed`                      | —                                                                                      | —                                 | `[ ]`         |
| `PARITY-024` | Encrypted cookies    | `encrypt` cookie flag              | —                                                                                      | —                                 | `[ ]`         |

### 6.4 `@tsir/cache` — Laravel Cache

Counterpart: LAR-CACHE.

| Id           | Feature                 | Laravel feature                    | @tsir implementation                                                                                                        | Evidence                                                      | Status               |
| ------------ | ----------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------- |
| `PARITY-025` | Multiple drivers        | redis, database, file, array, null | memory, redis, Cloudflare KV, database, null                                                                                | `stores.ts`, drivers                                          | `[x]`                |
| `PARITY-026` | Named stores            | `Cache::store('x')`                | `createCaches`, `cache.store(name)`                                                                                         | `stores.ts`                                                   | `[x]`                |
| `PARITY-027` | Tags                    | `Cache::tags(['x'])`               | `invalidateTag`, memory driver declares `tags: true`                                                                        | `store.ts`, `drivers/memory.ts`                               | `[x]`                |
| `PARITY-028` | TTL / expiration        | `put($key, $value, $ttl)`          | explicit TTL on set                                                                                                         | `store.ts`                                                    | `[x]`                |
| `PARITY-029` | Increment/decrement     | `Cache::increment`                 | `increment`, memory driver declares `increment: true`                                                                       | `store.ts`, `drivers/memory.ts`                               | `[x]`                |
| `PARITY-030` | Lock                    | `Cache::lock`                      | `CacheLock`, `cache.lock(name, ttlMs, owner)`; `get`, `block`, `release`, `forceRelease`; atomic acquire/release on backend | `store.ts`, `drivers/{memory,database,redis}.ts`, conformance | `[x]`                |
| `PARITY-031` | Remember / lazy         | `Cache::remember`                  | `remember` with capability check                                                                                            | `store.ts`                                                    | `[x]`                |
| `PARITY-032` | Cache tags invalidation | Tag-based flushing                 | `invalidateTag`                                                                                                             | `store.ts`                                                    | `[x]`                |
| `PARITY-033` | Explicit serialization  | (implicit)                         | `json`, `text` codecs, no implicit parse                                                                                    | `codec.ts`                                                    | `[x]` (extra: safer) |

### 6.5 `@tsir/database` — Laravel Database (query builder)

Counterpart: LAR-DB. **Deliberately different: no Eloquent ORM.**

| Id           | Feature                | Laravel feature       | @tsir implementation                                  | Evidence         | Status                               |
| ------------ | ---------------------- | --------------------- | ----------------------------------------------------- | ---------------- | ------------------------------------ |
| `PARITY-034` | Multiple connections   | `DB::connection('x')` | `createConnections`, named connections with `default` | `connections.ts` | `[x]`                                |
| `PARITY-035` | Query builder          | `DB::table(...)`      | Drizzle ORM (`createDrizzle`)                         | `drizzle.ts`     | `[x]`                                |
| `PARITY-036` | Transactions           | `DB::transaction`     | `withTransaction`, savepoints, context propagation    | `database.ts`    | `[x]`                                |
| `PARITY-037` | Connection health      | —                     | health check with connectivity + latency              | `database.ts`    | `[x]`                                |
| `PARITY-038` | Pessimistic locking    | `lockForUpdate`       | —                                                     | —                | `[ ]` — `DB-027`                     |
| `PARITY-039` | Eloquent ORM           | Eloquent              | — (deliberately not implemented)                      | —                | `[D]` deliberate: Drizzle is the ORM |
| `PARITY-040` | Pagination             | `paginate`            | —                                                     | —                | `[ ]` — `DB-028`                     |
| `PARITY-041` | D1 driver              | —                     | `createD1Driver`                                      | `d1.ts`          | `[x]` (extra)                        |
| `PARITY-042` | Postgres driver        | —                     | `postgres` subpath                                    | `postgres.ts`    | `[x]` (extra)                        |
| `PARITY-043` | Optimistic concurrency | —                     | `applyOptimistic`, `retryOnConflict`                  | `optimistic.ts`  | `[x]` (extra)                        |

### 6.6 `@tsir/migrate` — Laravel Migrations

Counterpart: LAR-MIGRATIONS.

| Id           | Feature                   | Laravel feature                  | @tsir implementation                                | Evidence      | Status                                   |
| ------------ | ------------------------- | -------------------------------- | --------------------------------------------------- | ------------- | ---------------------------------------- |
| `PARITY-044` | Run migrations            | `migrate`                        | `migrate` with `--> statement-breakpoint` (Drizzle) | `migrate.ts`  | `[x]`                                    |
| `PARITY-045` | Migration status          | `migrate:status`                 | `migrationStatus`, drift detection                  | `status.ts`   | `[x]`                                    |
| `PARITY-046` | Rollback                  | `migrate:rollback`               | `rollback`, `planRollback`                          | `rollback.ts` | `[x]`                                    |
| `PARITY-047` | Advisory lock             | — (Laravel has no built-in lock) | `acquireMigrationLock`                              | `lock.ts`     | `[x]` (extra)                            |
| `PARITY-048` | Checksum / drift          | —                                | drift detection                                     | `plan.ts`     | `[x]` (extra)                            |
| `PARITY-049` | Per-connection migrations | —                                | `--connection`, per-connection journal              | `migrate.ts`  | `[x]` (extra)                            |
| `PARITY-050` | Schema builder (fluent)   | `Schema::create`                 | — (raw SQL migrations)                              | —             | `[D]` deliberate: Drizzle SQL migrations |

### 6.7 `@tsir/seed` — Laravel Seeders

Counterpart: LAR-SEEDERS.

| Id           | Feature            | Laravel feature      | @tsir implementation                          | Evidence    | Status        |
| ------------ | ------------------ | -------------------- | --------------------------------------------- | ----------- | ------------- |
| `PARITY-051` | Seeder classes     | `Seeder` class       | `defineSeeder`, `defineSeeders`               | `seeder.ts` | `[x]`         |
| `PARITY-052` | Ordering           | `$this->call([...])` | `SeederOrder`                                 | `runner.ts` | `[x]`         |
| `PARITY-053` | Environment gating | production check     | `SeedEnvironment`, `assertEnvironmentAllowed` | `runner.ts` | `[x]`         |
| `PARITY-054` | Idempotency        | (manual)             | `assertIdempotent`                            | `runner.ts` | `[x]` (extra) |
| `PARITY-055` | Determinism        | (manual)             | fixed clock + seeded RNG                      | `runner.ts` | `[x]` (extra) |
| `PARITY-056` | Factories          | `Factory`            | —                                             | —           | `[ ]`         |

### 6.8 `@tsir/events` — Laravel Events

Counterpart: LAR-EVENTS.

| Id           | Feature              | Laravel feature   | @tsir implementation              | Evidence                  | Status           |
| ------------ | -------------------- | ----------------- | --------------------------------- | ------------------------- | ---------------- |
| `PARITY-057` | Event definitions    | `Event` class     | `defineEvent`                     | `event.ts`                | `[x]`            |
| `PARITY-058` | Listeners            | `Listener` class  | `defineListener`                  | `event.ts`                | `[x]`            |
| `PARITY-059` | Sync listeners       | sync listeners    | `mode: 'sync'`                    | `bus.ts`                  | `[x]`            |
| `PARITY-060` | Queued listeners     | `ShouldQueue`     | `mode: 'queued'`                  | `bus.ts`                  | `[x]`            |
| `PARITY-061` | Transactional outbox | —                 | `createOutbox`, `createPublisher` | `outbox.ts`, `publish.ts` | `[x]` (extra)    |
| `PARITY-062` | Event discovery      | auto-discovery    | — (explicit registration)         | —                         | `[D]` deliberate |
| `PARITY-063` | Broadcast events     | `ShouldBroadcast` | `@tsir/broadcast` (cross-package) | —                         | `[~]`            |

### 6.9 `@tsir/queue` — Laravel Queue

Counterpart: LAR-QUEUE.

| Id           | Feature               | Laravel feature          | @tsir implementation                                                                  | Evidence              | Status        |
| ------------ | --------------------- | ------------------------ | ------------------------------------------------------------------------------------- | --------------------- | ------------- |
| `PARITY-064` | Job definitions       | `Job` class              | `defineJob`, `createJobRegistry`                                                      | `job.ts`              | `[x]`         |
| `PARITY-065` | Multiple connections  | `Queue::connection('x')` | `createQueues`, named connections                                                     | `config.ts`           | `[x]`         |
| `PARITY-066` | Retries with backoff  | `backoff`, `tries`       | `retryDelayMs`, exponential backoff, DLQ                                              | `backoff.ts`          | `[x]`         |
| `PARITY-067` | Dead-letter queue     | failed jobs table        | `queueDead` table                                                                     | `queue.ts`            | `[x]`         |
| `PARITY-068` | Idempotency keys      | —                        | idempotency keys                                                                      | `queue.ts`            | `[x]` (extra) |
| `PARITY-069` | Graceful worker drain | `--timeout`, SIGTERM     | worker drain on SIGTERM                                                               | `worker.ts`           | `[x]`         |
| `PARITY-070` | Rate limiting         | `RateLimited`            | `@tsir/pulse` rate limiter (cross-package)                                            | —                     | `[x]`         |
| `PARITY-071` | Job batching          | `Bus::batch`             | —                                                                                     | —                     | `[ ]`         |
| `PARITY-072` | Job chains            | `Bus::chain`             | —                                                                                     | —                     | `[ ]`         |
| `PARITY-073` | Delayed jobs          | `delay()`                | `dispatchLater` with `delayMs` (backend-dependent: driver must declare `delay: true`) | `queue.ts`, `port.ts` | `[~]`         |
| `PARITY-074` | Unique jobs           | `ShouldBeUnique`         | `idempotencyKey` (backend-dependent: driver must declare `idempotency: true`)         | `port.ts`             | `[~]`         |
| `PARITY-075` | Failed job retry      | `queue:retry`            | `queue:retry`, replay, discard                                                        | `queue.ts`            | `[x]`         |

### 6.10 `@tsir/schedule` — Laravel Task Scheduling

Counterpart: LAR-SCHEDULE.

| Id           | Feature            | Laravel feature                          | @tsir implementation                                                                                                                                                   | Evidence                  | Status |
| ------------ | ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------ |
| `PARITY-076` | Cron expressions   | `cron('* * * * *')`                      | `CronSpec`, 5-field cron                                                                                                                                               | `cron.ts`                 | `[x]`  |
| `PARITY-077` | Task definitions   | Schedule `->command(...)`                | `defineTask`, `createTaskRegistry`                                                                                                                                     | `task.ts`                 | `[x]`  |
| `PARITY-078` | Overlap prevention | `withoutOverlapping`                     | distributed lock, `memoryLock`/`databaseLock`                                                                                                                          | `lock.ts`                 | `[x]`  |
| `PARITY-079` | Run in background  | `runInBackground`                        | `runInBackground` task flag; `runDue` dispatches and returns immediately, lock held until background run finishes, errors reported via `onError`                       | `scheduler.ts`            | `[x]`  |
| `PARITY-080` | Maintenance mode   | `evenInMaintenanceMode`                  | `isMaintenanceMode` scheduler option skips cron ticks (`status: 'skipped'`) unless task sets `evenInMaintenanceMode: true`; manual runs always run                     | `scheduler.ts`, `task.ts` | `[x]`  |
| `PARITY-081` | Timezone           | `timezone`                               | IANA `timezone` on `defineTask`; `wallClock` uses `Intl.DateTimeFormat` per tick so DST is honoured; `toUtcCron` refuses DST zones (no single UTC equivalent)          | `cron.ts`, `task.ts`      | `[x]`  |
| `PARITY-082` | One server         | `onOneServer`                            | shared lock                                                                                                                                                            | `lock.ts`                 | `[~]`  |
| `PARITY-083` | Task hooks         | `before`/`after`/`onSuccess`/`onFailure` | `TaskHooks` on `defineTask`; `before` can refuse the run, `onSuccess`/`onFailure` branch on outcome, `after` always runs; hook errors are logged, never change outcome | `task.ts`, `scheduler.ts` | `[x]`  |

### 6.11 `@tsir/mail` — Laravel Mail

Counterpart: LAR-MAIL.

| Id           | Feature             | Laravel feature     | @tsir implementation                                                                                                 | Evidence                    | Status |
| ------------ | ------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------ |
| `PARITY-084` | Mailables           | `Mailable` class    | `createMessage`, templates                                                                                           | `message.ts`                | `[x]`  |
| `PARITY-085` | Multiple transports | `MAIL_MAILER`       | SMTP, SES, Postmark, Resend, Cloudflare, HTTP, log, memory                                                           | `transports/`               | `[x]`  |
| `PARITY-086` | HTML escaping       | Blade auto-escaping | `escapeHtml`, `html`, `raw`, explicit `SafeHtml`                                                                     | `escape.ts`                 | `[x]`  |
| `PARITY-087` | MIME building       | SwiftMailer         | `buildMime`                                                                                                          | `mime.ts`                   | `[x]`  |
| `PARITY-088` | Attachments         | `->attach()`        | `Attachment` type, all transports (smtp MIME, resend, postmark, ses) send attachments; `checkAttachments` validation | `message.ts`, `transports/` | `[x]`  |
| `PARITY-089` | Markdown mail       | `Markdown` mailable | —                                                                                                                    | —                           | `[ ]`  |
| `PARITY-090` | Queued mail         | `ShouldQueue`       | `@tsir/notify` or manual queue                                                                                       | —                           | `[~]`  |
| `PARITY-091` | Log transport (dev) | `log` driver        | `logTransport` (refuses production)                                                                                  | `transports/log.ts`         | `[x]`  |
| `PARITY-092` | Address parsing     | —                   | `parseAddress`, `formatAddress`                                                                                      | `address.ts`                | `[x]`  |

### 6.12 `@tsir/notify` — Laravel Notifications

Counterpart: LAR-NOTIFY.

| Id           | Feature                  | Laravel feature     | @tsir implementation                     | Evidence               | Status        |
| ------------ | ------------------------ | ------------------- | ---------------------------------------- | ---------------------- | ------------- |
| `PARITY-093` | Notification channels    | `via()` method      | mail, SMS, database, chat, webhook, post | `channels/`            | `[x]`         |
| `PARITY-094` | Notifiable model         | `Notifiable` trait  | recipient abstraction                    | `notification.ts`      | `[x]`         |
| `PARITY-095` | Queued notifications     | `ShouldQueue`       | queued by default                        | `delivery.ts`          | `[x]`         |
| `PARITY-096` | Database notifications   | `database` channel  | `database` channel                       | `channels/database.ts` | `[x]`         |
| `PARITY-097` | Mail notifications       | `mail` channel      | `mail` channel                           | `channels/mail.ts`     | `[x]`         |
| `PARITY-098` | Webhook signing          | —                   | `signBody`, `verifySignature`            | `signing.ts`           | `[x]` (extra) |
| `PARITY-099` | Broadcast notifications  | `broadcast` channel | — (could use `@tsir/broadcast`)          | —                      | `[ ]`         |
| `PARITY-100` | Notification preferences | —                   | —                                        | —                      | `[ ]`         |

### 6.13 `@tsir/storage` — Laravel Filesystem

Counterpart: LAR-FS.

| Id           | Feature              | Laravel feature           | @tsir implementation               | Evidence                    | Status |
| ------------ | -------------------- | ------------------------- | ---------------------------------- | --------------------------- | ------ |
| `PARITY-101` | Multiple disks       | `Storage::disk('x')`      | `createDisk`, named disks          | `disk.ts`                   | `[x]`  |
| `PARITY-102` | Local driver         | `local` driver            | `localDriver`                      | `drivers/adapters/local.ts` | `[x]`  |
| `PARITY-103` | S3 driver            | `s3` driver               | `s3Driver` (SigV4, no SDK)         | `drivers/s3.ts`             | `[x]`  |
| `PARITY-104` | Memory driver        | `array` driver            | `memoryDriver`                     | `drivers/memory.ts`         | `[x]`  |
| `PARITY-105` | Public / signed URLs | `url()`, `temporaryUrl()` | URL with public/signed flag        | `disk.ts`                   | `[x]`  |
| `PARITY-106` | File visibility      | `setVisibility`           | `setVisibility`, `Visibility` type | `port.ts`, all drivers      | `[x]`  |
| `PARITY-107` | Streaming            | `stream()`                | `stream()` → `ReadableStream`      | `port.ts`, all drivers      | `[x]`  |
| `PARITY-108` | Directory listing    | `directories`, `files`    | `directories(prefix)`              | `port.ts`, all drivers      | `[x]`  |
| `PARITY-109` | Copy/move            | `copy`, `move`            | `copy`, `move`                     | `port.ts`, all drivers      | `[x]`  |

> **Correction (2026-11-08):** the 2026-11-07 parity audit's "`[ ]` confirmed absent" list named
> `copy`, `move`, `setVisibility` and streaming for this package. All four are in `port.ts` **and**
> implemented by every shipped driver (`s3.ts`, `memory.ts`, `drivers/adapters/local.ts`), with
> `copy`/`move` cases in `conformance.ts`. The audit read `disk.ts` and stopped there; the rows above
> were already `[x]` and were right. The audit is corrected at
> [`27-feature-parity-audit.md`](./27-feature-parity-audit.md) § storage.

### 6.14 `@tsir/validate` — Laravel Validation

Counterpart: LAR-VALIDATE.

| Id           | Feature                | Laravel feature            | @tsir implementation              | Evidence           | Status |
| ------------ | ---------------------- | -------------------------- | --------------------------------- | ------------------ | ------ |
| `PARITY-110` | Request validation     | `$request->validate`       | Zod 4 schemas, router integration | `validate` package | `[x]`  |
| `PARITY-111` | Rule library           | `required`, `email`, etc.  | Zod rules + Standard Schema       | `validate`         | `[x]`  |
| `PARITY-112` | Custom rules           | `Rule` objects             | Zod refinements                   | —                  | `[x]`  |
| `PARITY-113` | Error messages         | custom messages            | Zod issue normalization           | —                  | `[x]`  |
| `PARITY-114` | Form requests          | `FormRequest`              | router body/params schemas        | —                  | `[x]`  |
| `PARITY-115` | Unique rule            | `unique:table,column`      | — (requires DB)                   | —                  | `[ ]`  |
| `PARITY-116` | Exists rule            | `exists:table,column`      | —                                 | —                  | `[ ]`  |
| `PARITY-117` | Conditional validation | `sometimes`, `required_if` | Zod conditional schemas           | —                  | `[x]`  |

### 6.15 `@tsir/pulse` → `@tsir/observability` — Laravel Logging + Pulse

Counterpart: LAR-LOGGING, LPK-PULSE.

> **Architectural difference:** Laravel Pulse is an analytics **dashboard**.
> `@tsir/pulse` provides observability **primitives** (logs, metrics, traces,
> health, rate limiting). The dashboard is the admin app's responsibility.

| Id           | Feature            | Laravel feature        | @tsir implementation                     | Evidence     | Status        |
| ------------ | ------------------ | ---------------------- | ---------------------------------------- | ------------ | ------------- |
| `PARITY-118` | Structured logging | `Log` facade, channels | `createLogger`, structured records       | `logger.ts`  | `[x]`         |
| `PARITY-119` | Log levels         | `emergency`...`debug`  | `LogLevel`                               | `record.ts`  | `[x]`         |
| `PARITY-120` | Multiple sinks     | `stack` channel        | `stdoutSink`, `memorySink`, `fanoutSink` | `sinks.ts`   | `[x]`         |
| `PARITY-121` | Log formatting     | single, daily, syslog  | `LOG_FORMATS`                            | `formats.ts` | `[x]`         |
| `PARITY-122` | PII redaction      | —                      | `redact.ts`, `PiiPolicy`                 | `redact.ts`  | `[x]` (extra) |
| `PARITY-123` | Metrics            | — (Pulse)              | `createMetrics`, counters/timers         | `metrics.ts` | `[x]`         |
| `PARITY-124` | Tracing            | — (Pulse/Octane)       | `createTracer`, spans, W3C `traceparent` | `tracing.ts` | `[x]`         |
| `PARITY-125` | Health checks      | —                      | `createHealth` (liveness/readiness)      | `health.ts`  | `[x]`         |
| `PARITY-126` | Rate limiting      | `RateLimiter`          | `createRateLimiter`                      | `limits.ts`  | `[x]`         |
| `PARITY-127` | Metrics exporters  | Pulse dashboard        | — (no built-in exporter)                 | —            | `[ ]`         |
| `PARITY-128` | Pulse dashboard UI | Pulse dashboard        | admin dashboard (app-level)              | —            | `[~]`         |

### 6.16 `@tsir/config` — Laravel Configuration

Counterpart: LAR-CONFIG.

| Id           | Feature               | Laravel feature | @tsir implementation               | Evidence     | Status                               |
| ------------ | --------------------- | --------------- | ---------------------------------- | ------------ | ------------------------------------ |
| `PARITY-129` | Typed config          | `config()`      | `defineConfig`, `env()` helpers    | `define.ts`  | `[x]`                                |
| `PARITY-130` | Environment variables | `env()`         | `env()` typed                      | `define.ts`  | `[x]`                                |
| `PARITY-131` | Config caching        | `config:cache`  | — (no runtime reflection to cache) | —            | `[D]` deliberate: config is compiled |
| `PARITY-132` | Secret redaction      | —               | `redacted.ts`, secret handling     | `secrets.ts` | `[x]` (extra)                        |
| `PARITY-133` | Presets               | —               | `presets.ts`                       | `presets.ts` | `[x]` (extra)                        |

### 6.17 `@tsir/container` — Laravel Container

Counterpart: LAR-CONTAINER.

| Id           | Feature               | Laravel feature         | @tsir implementation           | Evidence       | Status                                      |
| ------------ | --------------------- | ----------------------- | ------------------------------ | -------------- | ------------------------------------------- |
| `PARITY-134` | DI container          | `Container`             | `Container` with tokens        | `container.ts` | `[x]`                                       |
| `PARITY-135` | Constructor injection | auto-injection          | explicit constructor injection | `container.ts` | `[x]`                                       |
| `PARITY-136` | Bindings              | `bind`, `singleton`     | providers                      | `provider.ts`  | `[x]`                                       |
| `PARITY-137` | Scopes                | —                       | request scope                  | `container.ts` | `[x]`                                       |
| `PARITY-138` | Facades               | `Facade`                | — (deliberately no facades)    | —              | `[D]` deliberate: no global service locator |
| `PARITY-139` | Contextual binding    | `when(...)->needs(...)` | —                              | —              | `[ ]`                                       |
| `PARITY-140` | Auto-wiring           | auto resolution         | — (explicit)                   | —              | `[D]` deliberate                            |

### 6.18 `@tsir/http` — Laravel HTTP

Counterpart: LAR-HTTP.

| Id           | Feature              | Laravel feature           | @tsir implementation                                                     | Evidence                  | Status                |
| ------------ | -------------------- | ------------------------- | ------------------------------------------------------------------------ | ------------------------- | --------------------- |
| `PARITY-141` | Request object       | `Illuminate\Http\Request` | Web `Request`                                                            | `context.ts`              | `[x]`                 |
| `PARITY-142` | Response helpers     | `response()`              | `ok`, `created`, `accepted`, `noContent`                                 | `http` package            | `[x]`                 |
| `PARITY-143` | Problem details      | `abort(404)`              | RFC 9457 problems                                                        | `problems.ts`             | `[x]`                 |
| `PARITY-144` | Middleware           | middleware                | pipeline                                                                 | `pipeline.ts`             | `[x]`                 |
| `PARITY-145` | Request body parsing | `$request->all()`         | `body.ts`, multipart                                                     | `body.ts`, `multipart.ts` | `[x]`                 |
| `PARITY-146` | File uploads         | `$request->file()`        | multipart handling                                                       | `multipart.ts`            | `[x]`                 |
| `PARITY-147` | Cookies              | `Cookie` facade           | —                                                                        | —                         | `[ ]` — `HTP-023`     |
| `PARITY-148` | Session middleware   | `StartSession`            | `@tsir/auth` session                                                     | —                         | `[x]` (cross-package) |
| `PARITY-149` | CORS                 | CORS middleware           | CORS preflight handling                                                  | `http` tests              | `[x]`                 |
| `PARITY-150` | Trust proxies        | `TrustProxies`            | unconditional `x-forwarded-for` read in `pipeline.ts` (not a trust list) | `pipeline.ts`             | `[ ]` — `HTP-024`     |
| `PARITY-151` | Maintenance mode     | `CheckForMaintenanceMode` | —                                                                        | —                         | `[ ]`                 |

### 6.19 `@tsir/router` — Laravel Routing

Counterpart: LAR-ROUTING.

| Id           | Feature             | Laravel feature      | @tsir implementation                        | Evidence         | Status            |
| ------------ | ------------------- | -------------------- | ------------------------------------------- | ---------------- | ----------------- |
| `PARITY-152` | Route definition    | `Route::get(...)`    | decorator-based `@Controller`, `@Get`, etc. | `router` package | `[x]`             |
| `PARITY-153` | Route params        | `{id}`               | route params with typed binding             | `route-args.ts`  | `[x]`             |
| `PARITY-154` | Route groups        | `Route::group`       | module-owned registries                     | `router`         | `[x]`             |
| `PARITY-155` | Named routes        | `->name('x')`        | —                                           | —                | `[ ]` — `RTR-013` |
| `PARITY-156` | Route model binding | `Route::model`       | — (explicit binding)                        | —                | `[D]` deliberate  |
| `PARITY-157` | Route caching       | `route:cache`        | `routes.gen.ts` (compiled at build)         | `router`         | `[x]`             |
| `PARITY-158` | API resource routes | `Route::apiResource` | —                                           | —                | `[ ]` — `RTR-014` |
| `PARITY-159` | Sub-domain routing  | `->domain()`         | —                                           | —                | `[ ]` — `RTR-015` |
| `PARITY-160` | OpenAPI generation  | —                    | OpenAPI 3.1 from route table                | `openapi.ts`     | `[x]` (extra)     |

### 6.20 `@tsir/console` — Laravel Artisan

Counterpart: LAR-ARTISAN.

| Id           | Feature                | Laravel feature      | @tsir implementation                   | Evidence               | Status |
| ------------ | ---------------------- | -------------------- | -------------------------------------- | ---------------------- | ------ |
| `PARITY-161` | CLI entry              | `artisan`            | `tsir` CLI                             | `cli.ts`               | `[x]`  |
| `PARITY-162` | Command definition     | `Command` class      | `defineCommand`                        | `define-command.ts`    | `[x]`  |
| `PARITY-163` | Arguments/options      | `argument`, `option` | args parser                            | `args.ts`              | `[x]`  |
| `PARITY-164` | Code generators        | `make:*`             | `make:module`, `make:controller`, etc. | `commands/`            | `[x]`  |
| `PARITY-165` | In-process runner      | —                    | in-process runner                      | `in-process` tests     | `[x]`  |
| `PARITY-166` | Scheduling integration | `schedule:run`       | `@tsir/schedule`                       | —                      | `[x]`  |
| `PARITY-167` | Prompts                | artisan prompts      | `output.ts`                            | —                      | `[x]`  |
| `PARITY-168` | Command scheduling     | `schedule:list`      | `schedule:*` commands                  | `commands/schedule.ts` | `[x]`  |
| `PARITY-169` | Tinker (REPL)          | `tinker`             | — (planned: `@tsir/repl`)              | —                      | `[ ]`  |

### 6.21 `@tsir/deploy` — Laravel Vapor

Counterpart: LPK-VAPOR. **Deliberately different: Workers + Lambda, not Vapor's AWS-abstracted runtime.**

| Id           | Feature                 | Laravel feature      | @tsir implementation                                        | Evidence                | Status |
| ------------ | ----------------------- | -------------------- | ----------------------------------------------------------- | ----------------------- | ------ |
| `PARITY-170` | Serverless deployment   | Vapor                | Cloudflare Workers + AWS Lambda                             | `deploy` package        | `[x]`  |
| `PARITY-171` | Unit graph              | Vapor's infra config | deterministic unit graph, `separate`/`single`               | `graph.ts`              | `[x]`  |
| `PARITY-172` | Secrets management      | Vapor secrets        | secrets by reference, no plaintext in artifacts             | `secrets.ts`            | `[x]`  |
| `PARITY-173` | Cold start optimization | Vapor runtime tuning | bundle size budgets                                         | `units.ts`              | `[x]`  |
| `PARITY-174` | Queue triggers          | SQS/Lambda           | `[[queues.consumers]]`                                      | `queue-triggers.ts`     | `[x]`  |
| `PARITY-175` | Custom domains          | Vapor domains        | AWS: `DomainName` + API Gateway; Cloudflare: `routes` entry | `sam.ts`, `wrangler.ts` | `[x]`  |
| `PARITY-176` | Database proxies        | Vapor DB proxy       | RDS proxy semantics (Lambda), Hyperdrive (Workers)          | `lambda.ts`             | `[x]`  |

### 6.22 `@tsir/flags` (← pennant) — Laravel Pennant

Counterpart: LPK-PENNANT.

| Id           | Feature                  | Laravel feature                    | @tsir implementation              | Evidence     | Status |
| ------------ | ------------------------ | ---------------------------------- | --------------------------------- | ------------ | ------ |
| `PARITY-177` | Boolean flags            | `Feature::active('x')`             | boolean rules                     | `pennant.ts` | `[x]`  |
| `PARITY-178` | Percentage rollout       | `Feature::for($user)->active('x')` | percentage via deterministic hash | `pennant.ts` | `[x]`  |
| `PARITY-179` | User targeting           | scope                              | allowlist, conditional rules      | `pennant.ts` | `[x]`  |
| `PARITY-180` | Multiple drivers         | database, array, redis             | memory, database stores           | `stores.ts`  | `[~]`  |
| `PARITY-181` | Rich values              | `Feature::value('x')`              | —                                 | —            | `[ ]`  |
| `PARITY-182` | Feature definition class | `Feature` class                    | rule functions                    | —            | `[x]`  |
| `PARITY-183` | In-memory store          | `array`                            | `memoryStore`                     | `stores.ts`  | `[x]`  |
| `PARITY-184` | Redis driver             | `redis`                            | —                                 | —            | `[ ]`  |

### 6.23 `@tsir/billing` (← cashier) — Laravel Cashier

Counterpart: LPK-CASHIER.

| Id           | Feature              | Laravel feature     | @tsir implementation                                                      | Evidence                | Status |
| ------------ | -------------------- | ------------------- | ------------------------------------------------------------------------- | ----------------------- | ------ |
| `PARITY-185` | Customers            | `Billable` model    | `Customer` type, customer creation                                        | `stripe.ts`             | `[x]`  |
| `PARITY-186` | Subscriptions        | `newSubscription`   | `createSubscription`, `cancelSubscription`, `getSubscription` (full REST) | `stripe.ts`, `types.ts` | `[x]`  |
| `PARITY-187` | Invoices             | `invoice()`         | `listInvoices` (full REST)                                                | `stripe.ts`, `types.ts` | `[x]`  |
| `PARITY-188` | Webhook verification | `WebhookController` | `constructWebhookEvent`, signature verification                           | `webhooks.ts`           | `[x]`  |
| `PARITY-189` | Paddle support       | Cashier Paddle      | —                                                                         | —                       | `[ ]`  |
| `PARITY-190` | Tax handling         | tax rates           | `createTaxRate`, `listTaxRates`                                           | `stripe.ts`, `types.ts` | `[x]`  |
| `PARITY-191` | Coupons/promotions   | coupons             | `createCoupon`, `getCoupon`, `listCoupons`                                | `stripe.ts`, `types.ts` | `[x]`  |
| `PARITY-192` | Payment methods      | `paymentMethods`    | `listPaymentMethods`, `attachPaymentMethod`, `detachPaymentMethod`        | `stripe.ts`, `types.ts` | `[x]`  |
| `PARITY-193` | Checkout sessions    | `checkout`          | `createCheckoutSession`, `getCheckoutSession` (line items + inline price) | `stripe.ts`, `types.ts` | `[x]`  |

### 6.24 `@tsir/servers` (← forge) — Laravel Forge

Counterpart: LPK-FORGE.

| Id           | Feature             | Laravel feature       | @tsir implementation                                | Evidence   | Status |
| ------------ | ------------------- | --------------------- | --------------------------------------------------- | ---------- | ------ |
| `PARITY-194` | Server CRUD         | Forge servers         | server CRUD                                         | `forge.ts` | `[x]`  |
| `PARITY-195` | Command execution   | Forge daemon/commands | command execution                                   | `forge.ts` | `[x]`  |
| `PARITY-196` | Deploy recipes      | Forge recipes         | deploy recipes                                      | `forge.ts` | `[x]`  |
| `PARITY-197` | SSH provider        | Forge SSH             | `sshProvider` (ssh CLI) + `localProvider`           | `forge.ts` | `[x]`  |
| `PARITY-198` | Cloud providers     | Forge DO/Linode/AWS   | — (planned: Hetzner, DO, Vultr, Lightsail, Linode)  | —          | `[ ]`  |
| `PARITY-199` | Nginx/site config   | Forge site management | `createSite`, `deleteSite` (nginx + reload)         | `forge.ts` | `[x]`  |
| `PARITY-200` | Database management | Forge DB              | `createDatabase`, `deleteDatabase` (postgres/mysql) | `forge.ts` | `[x]`  |
| `PARITY-201` | SSL management      | Forge SSL             | `obtainSslCertificate`, `revokeSslCertificate`      | `forge.ts` | `[x]`  |

### 6.25 `@tsir/oauth` (← socialize) — Laravel Socialite

Counterpart: LPK-SOCIALITE.

| Id           | Feature                   | Laravel feature         | @tsir implementation            | Evidence              | Status |
| ------------ | ------------------------- | ----------------------- | ------------------------------- | --------------------- | ------ |
| `PARITY-202` | OAuth2 provider interface | `Socialite` driver      | `socialize`, provider interface | `socialize.ts`        | `[x]`  |
| `PARITY-203` | Google provider           | Google driver           | `googleProvider`                | `providers/google.ts` | `[x]`  |
| `PARITY-204` | GitHub provider           | GitHub driver           | `githubProvider`                | `providers/github.ts` | `[x]`  |
| `PARITY-205` | CSRF state                | state param             | `generateState`, `verifyState`  | `state.ts`            | `[x]`  |
| `PARITY-206` | User retrieval            | `user()`                | provider `user()`               | `providers/`          | `[x]`  |
| `PARITY-207` | Additional providers      | Facebook, Twitter, etc. | —                               | —                     | `[ ]`  |
| `PARITY-208` | OAuth1 providers          | Twitter (OAuth1)        | —                               | —                     | `[ ]`  |
| `PARITY-209` | Stateless auth            | `stateless()`           | —                               | —                     | `[ ]`  |

### 6.26 `@tsir/search` (← scout) — Laravel Scout

Counterpart: LPK-SCOUT.

| Id           | Feature                 | Laravel feature      | @tsir implementation                        | Evidence         | Status           |
| ------------ | ----------------------- | -------------------- | ------------------------------------------- | ---------------- | ---------------- |
| `PARITY-210` | Search engine interface | Scout engine         | engine interface                            | `scout.ts`       | `[x]`            |
| `PARITY-211` | SQLite FTS5             | —                    | `sqliteEngine`                              | `drivers.ts`     | `[x]`            |
| `PARITY-212` | Postgres tsvector       | —                    | `postgresEngine`                            | `drivers.ts`     | `[x]`            |
| `PARITY-213` | In-memory engine        | `collection`         | `memoryEngine` with tokenize + TF scoring   | `scout.ts`       | `[x]`            |
| `PARITY-214` | Algolia driver          | Algolia              | `hostedSearch({ provider: 'algolia' })`     | `hosted.ts`      | `[x]`            |
| `PARITY-215` | Meilisearch driver      | Meilisearch          | `hostedSearch({ provider: 'meilisearch' })` | `hosted.ts`      | `[x]`            |
| `PARITY-216` | Typesense driver        | Typesense            | `hostedSearch({ provider: 'typesense' })`   | `hosted.ts`      | `[x]`            |
| `PARITY-217` | Engine conformance kit  | —                    | `conformanceCases({ engine, prefix })`      | `conformance.ts` | `[x]`            |
| `PARITY-218` | Searchable trait        | `Searchable`         | — (explicit indexing)                       | —                | `[D]` deliberate |
| `PARITY-219` | Queue sync              | `ShouldBeSearchable` | `searchableIndexer({ engine, queue })`      | `indexer.ts`     | `[x]`            |

### 6.27 `@tsir/broadcast` — Laravel Broadcasting (Echo + Reverb)

Counterpart: LPK-BROADCAST, LPK-REVERB, LPK-ECHO.

| Id           | Feature               | Laravel feature      | @tsir implementation                                                                                                                                       | Evidence                  | Status |
| ------------ | --------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------ |
| `PARITY-220` | Broadcaster interface | `Broadcaster`        | `Broadcaster` interface                                                                                                                                    | `broadcaster.ts`          | `[x]`  |
| `PARITY-221` | Memory broadcaster    | `log`/`null`         | memory broadcaster                                                                                                                                         | `broadcaster.ts`          | `[x]`  |
| `PARITY-222` | WebSocket server      | Reverb               | WebSocket server with auth/authorize                                                                                                                       | `websocket.ts`            | `[x]`  |
| `PARITY-223` | Client library        | Echo                 | `createEcho` (→ `createClient` post-rebrand)                                                                                                               | `echo.ts`                 | `[x]`  |
| `PARITY-224` | Channel auth          | `Broadcast::channel` | channel authorization                                                                                                                                      | `websocket.ts`            | `[x]`  |
| `PARITY-225` | Redis broadcaster     | `redis` driver       | `redisBroadcaster` — app-supplied `RedisPubSubClient` (publish/subscribe/unsubscribe + `on('message')`), prefixed channels, startup contract check         | `redis.ts`                | `[x]`  |
| `PARITY-226` | Pusher driver         | Pusher               | `pusherBroadcaster` — app-supplied `PusherLike.trigger(channel, event, data)`                                                                              | `pusher.ts`               | `[x]`  |
| `PARITY-227` | Presence channels     | presence channels    | `presence-` prefix; `authorize` returns `PresenceMember`; server tracks members, emits `pusher:subscription_succeeded` / `member_added` / `member_removed` | `websocket.ts`, `echo.ts` | `[x]`  |
| `PARITY-228` | Private channels      | private channels     | `private-` prefix; requires `authorize` to return truthy                                                                                                   | `websocket.ts`, `echo.ts` | `[x]`  |
| `PARITY-229` | Client events         | `whisper`            | `whisper(event, data)` on private/presence channels; forwarded to other subscribers as `client-<event>`; refused on public channels                        | `websocket.ts`, `echo.ts` | `[x]`  |

### 6.28 `@tsir/browser` (← nightwatch) — Laravel Dusk

Counterpart: LPK-DUSK. **Note: Laravel Nightwatch is an APM; our package maps to Dusk.**

> **CRITICAL NAMING CLARIFICATION:** Our `@tsir/nightwatch` is a **browser end-to-end testing harness** (a `page.goto()`, `page.click()`, `page.fill()`), functionally equivalent to **Laravel Dusk**, **not** Laravel Nightwatch. Laravel Nightwatch is an **APM** (application performance monitoring) with a hosted dashboard for requests, queries, jobs, exceptions, etc. The APM functionality is split across `@tsir/pulse` (observability primitives), `@tsir/telemetry` (request + queue monitoring), and the admin app's Dashboard/Requests/Queues UIs. See § 6.30 for the APM feature comparison.

| Id           | Feature             | Laravel feature    | @tsir implementation                                            | Evidence        | Status |
| ------------ | ------------------- | ------------------ | --------------------------------------------------------------- | --------------- | ------ |
| `PARITY-230` | Browser abstraction | `Dusk` test API    | `Page` interface: `goto`, `click`, `fill`, `text`, `screenshot` | `nightwatch.ts` | `[x]`  |
| `PARITY-231` | In-memory backend   | —                  | `inMemoryBackend`                                               | `nightwatch.ts` | `[x]`  |
| `PARITY-232` | Playwright backend  | `Dusk` uses Chrome | `playwrightBackend`                                             | `nightwatch.ts` | `[x]`  |
| `PARITY-233` | Assertions          | `assertSee`, etc.  | — (no built-in assertions)                                      | —               | `[ ]`  |
| `PARITY-234` | Page objects        | Page objects       | —                                                               | —               | `[ ]`  |
| `PARITY-235` | Component helpers   | `@selector`        | —                                                               | —               | `[ ]`  |

### 6.29 `@tsir/telemetry` — Laravel Horizon + Telescope

Counterpart: LPK-HORIZON, LPK-TELESCOPE.

| Id           | Feature                     | Laravel feature   | @tsir implementation                                         | Evidence            | Status |
| ------------ | --------------------------- | ----------------- | ------------------------------------------------------------ | ------------------- | ------ |
| `PARITY-236` | Queue monitoring (Horizon)  | Horizon dashboard | `createQueueMonitor`, job counts/list/detail/retry           | `queue-monitor.ts`  | `[x]`  |
| `PARITY-237` | Request logging (Telescope) | Telescope         | `createRequestLogger`, method/path/status/duration/principal | `request-logger.ts` | `[x]`  |
| `PARITY-238` | Request log storage         | Telescope DB      | `requestLogs` table                                          | `request-logger.ts` | `[x]`  |
| `PARITY-239` | Queue job storage           | Horizon metrics   | `queueJobs`, `queueDead` tables                              | `queue-monitor.ts`  | `[x]`  |
| `PARITY-240` | Job retry from UI           | Horizon retry     | retry from `queue-monitor`                                   | `queue-monitor.ts`  | `[x]`  |
| `PARITY-241` | Failed job detail           | Telescope         | —                                                            | —                   | `[ ]`  |
| `PARITY-242` | Exception tracking          | Telescope         | —                                                            | —                   | `[ ]`  |
| `PARITY-243` | Cache/DB query tracking     | Telescope         | —                                                            | —                   | `[ ]`  |
| `PARITY-244` | Mail/notification tracking  | Telescope         | —                                                            | —                   | `[ ]`  |

### 6.30 APM / Monitoring — Laravel Nightwatch (APM) vs `@tsir/pulse` + `@tsir/telemetry` + Admin UI

Counterpart: LPK-NIGHTWATCH (Laravel Nightwatch APM). Our APM functionality is **not** in a single package — it is distributed across `@tsir/pulse` (observability primitives), `@tsir/telemetry` (request + queue monitoring), and the admin app's Dashboard/Requests/Queues pages.

> **Key architectural difference:** Laravel Nightwatch is a **hosted SaaS** with a managed agent (`php artisan nightwatch:agent`) collecting data to a centralized dashboard. Our stack is **self-hosted**: data is stored locally (Postgres/SQLite) and surfaced through the admin app. There is no centralized SaaS dashboard or agent process.

| Id           | Nightwatch APM feature    | @tsir implementation                                                                             | Evidence                           | Status                                                        |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| `PARITY-245` | HTTP request tracing      | `createRequestLogger` records method/path/status/duration/principal/ip/ua to `requestLogs` table | `telemetry/request-logger.ts`      | `[~]` partial — no per-query breakdown or timeline            |
| `PARITY-246` | Request timeline          | — (each event linked to its parent request with timings)                                         | —                                  | `[ ]`                                                         |
| `PARITY-247` | Outgoing HTTP requests    | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-248` | SQL query monitoring      | — (no query timing capture)                                                                      | —                                  | `[ ]`                                                         |
| `PARITY-249` | Slow query detection      | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-250` | Queue job monitoring      | `createQueueMonitor`: counts/list/get/retry across `queueJobs` + `queueDead`                     | `telemetry/queue-monitor.ts`       | `[x]`                                                         |
| `PARITY-251` | Scheduled task monitoring | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-252` | Command/Artisan tracking  | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-253` | Mail monitoring           | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-254` | Notification monitoring   | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-255` | Cache hit/miss tracking   | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-256` | Exception tracking        | — (no capture, no grouping into issues)                                                          | —                                  | `[ ]`                                                         |
| `PARITY-257` | Logs (searchable)         | `createLogger` with structured records + sinks; no search UI                                     | `pulse/logger.ts`                  | `[~]` partial — logs exist, no search UI                      |
| `PARITY-258` | Metrics                   | `createMetrics`: counter/histogram/gauge with cardinality guard                                  | `pulse/metrics.ts`                 | `[x]`                                                         |
| `PARITY-259` | Metrics visualization     | Admin Dashboard page renders metric cards from `/system/metrics`                                 | `admin/.../pages/Dashboard.svelte` | `[~]` partial — raw number cards, no charts/graphs            |
| `PARITY-260` | Tracing (distributed)     | `createTracer`: W3C `traceparent`, spans, samplers                                               | `pulse/tracing.ts`                 | `[x]`                                                         |
| `PARITY-261` | Health checks             | `createHealth`: liveness/readiness with critical/degraded states                                 | `pulse/health.ts`                  | `[x]`                                                         |
| `PARITY-262` | Alerts / notifications    | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-263` | Hosted dashboard          | Admin app Dashboard, Requests, Queues pages (self-hosted)                                        | `admin/client/src/pages/`          | `[~]` partial — basic list UIs, no Nightwatch-level dashboard |
| `PARITY-264` | Agent process             | — (no separate agent; instrumentation is in-process)                                             | —                                  | `[D]` deliberate: in-process instrumentation, no agent        |
| `PARITY-265` | Multi-region data         | — (local storage only)                                                                           | —                                  | `[ ]`                                                         |
| `PARITY-266` | Per-user impact           | —                                                                                                | —                                  | `[ ]`                                                         |
| `PARITY-267` | Team collaboration        | — (single-user admin)                                                                            | —                                  | `[ ]`                                                         |

**APM coverage summary:** Of 21 Nightwatch APM features, 4 are verified (`[x]`), 4 are partial (`[~]`), 12 are not implemented (`[ ]`), and 1 is deliberately different (`[D]`). The biggest gaps are **exception tracking**, **SQL query monitoring**, **request timelines**, **alerts**, and **a rich dashboard with visualizations**.

### 6.31 UI/UX Coverage Matrix — Admin App Pages vs `@tsir/*` Packages

The admin app (`src/apps/admin.product.com/client/src/pages/`) is the **only** user-facing UI in the monorepo. It provides management screens for a subset of packages. Infrastructure packages (config, container, http, router, console, deploy, database, migrate, seed, validate) have no UI by design — they are framework primitives.

| Id           | @tsir package                                                                                                            | Admin UI page(s)                            | UI capability                                                 | Status  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------- | ------- |
| `PARITY-268` | `@tsir/auth`                                                                                                             | Login, ForgotPassword, ResetPassword, Setup | Full auth flow UI with captcha, password reset, initial setup | `[x]`   |
| `PARITY-269` | `@tsir/policy`                                                                                                           | Roles, Permissions, Groups                  | RBAC management: assign roles/permissions, create groups      | `[x]`   |
| `PARITY-270` | `@tsir/mail`                                                                                                             | EmailTemplates                              | Edit email templates (reset-password)                         | `[~]`   |
| `PARITY-271` | `@tsir/pennant`                                                                                                          | FeatureFlags                                | Toggle feature flags                                          | `[x]`   |
| `PARITY-272` | `@tsir/queue`                                                                                                            | Queues                                      | Horizon-style: state counts, job list, detail drawer, retry   | `[x]`   |
| `PARITY-273` | `@tsir/telemetry`                                                                                                        | Requests                                    | Telescope-style: request log list with method/status filters  | `[x]`   |
| `PARITY-274` | `@tsir/pulse`                                                                                                            | Dashboard                                   | Metric cards (raw numbers, no charts)                         | `[~]`   |
| `PARITY-275` | `@tsir/i18n`                                                                                                             | I18n (Translations)                         | Translation key/locale management                             | `[x]`   |
| `PARITY-276` | `@tsir/vault`                                                                                                            | —                                           | No UI (key rotation via CLI only)                             | `[ ]`   |
| `PARITY-277` | `@tsir/cache`                                                                                                            | —                                           | No UI (programmatic only)                                     | `[ ]`   |
| `PARITY-278` | `@tsir/storage`                                                                                                          | —                                           | No UI (programmatic only)                                     | `[ ]`   |
| `PARITY-279` | `@tsir/scout`                                                                                                            | — (search API only)                         | No dedicated search management UI                             | `[ ]`   |
| `PARITY-280` | `@tsir/socialize`                                                                                                        | —                                           | No UI (OAuth flow handled by auth routes)                     | `[ ]`   |
| `PARITY-281` | `@tsir/media`                                                                                                            | —                                           | No UI (programmatic only)                                     | `[ ]`   |
| `PARITY-282` | `@tsir/events`                                                                                                           | —                                           | No UI (internal event bus)                                    | `[ ]`   |
| `PARITY-283` | `@tsir/schedule`                                                                                                         | —                                           | No UI (scheduler runs headless)                               | `[ ]`   |
| `PARITY-284` | `@tsir/notify`                                                                                                           | —                                           | No UI (notifications sent programmatically)                   | `[ ]`   |
| `PARITY-285` | `@tsir/cashier`                                                                                                          | —                                           | No billing/subscription management UI                         | `[ ]`   |
| `PARITY-286` | `@tsir/forge`                                                                                                            | —                                           | No server management UI                                       | `[ ]`   |
| `PARITY-287` | `@tsir/broadcast`                                                                                                        | —                                           | No channel/connection management UI                           | `[ ]`   |
| `PARITY-288` | `@tsir/nightwatch`                                                                                                       | —                                           | No UI (test harness only)                                     | `[N/A]` |
| `PARITY-289` | Infrastructure (`config`, `container`, `http`, `router`, `console`, `deploy`, `database`, `migrate`, `seed`, `validate`) | —                                           | No UI by design (framework primitives)                        | `[N/A]` |

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

**Recount it, do not retype it.** Every row in § 6 now carries a `PARITY-NNN` id, so the summary is
one command:

```bash
bun src/tools/task-status.ts --parity
```

That reads the `[x]`/`[~]`/`[ ]` in the last cell of each `PARITY-*` row and prints the counts below.
The figures here were generated that way on 2026-11-14 (they previously drifted because they were
typed). The **rows** are still adjudicated by a person — the tool counts what the rows say, and says
nothing about whether a row is right.

Measured 2026-11-14 by `bun src/tools/task-status.ts --parity` (249 rows carry a `PARITY-*` id; the
cross-cutting sections are counted separately because they are not a package):

- **Total identified features:** 249 (§ 6.1–§ 6.29), plus the cross-cutting rows in § 6.30/§ 6.31
- **Verified parity:** 176 (70.7 %)
- **Partial parity:** 11 (4.4 %)
- **Not implemented:** 62 (24.9 %)
- **Deliberately different:** counted inside the rows it applies to, marked in § 7.1
- **Blocked / Unverified:** 0 / 0
- Including partial: **75.1 %** — Gate P10's ≥ 80 % target is therefore **not yet met**, by about
  5 points. `make tasks` reports the same numbers, so this block cannot drift from the rows again.

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
