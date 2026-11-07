# Laravel → Tsir Service Audit

A complete mapping of Laravel's first-party services and packages to the Tsir
framework. Status: **implemented** (exists and complete), **partial** (exists but
missing features), **missing** (no equivalent yet).

## Placement decisions

Every Laravel service is mapped to either a `@tsir/*` framework package or an
admin app module. Framework packages are reusable across all Tsir apps; admin
modules are dashboard/tooling that belong in `admin.product.com`.

| Laravel Service                                   | Tsir Equivalent              | Placement |
| ------------------------------------------------- | ---------------------------- | --------- |
| Auth, Sessions, Hashing                           | `@tsir/auth`                 | framework |
| Authorization (Gates/Policies)                    | `@tsir/policy`               | framework |
| Encryption                                        | `@tsir/vault`                | framework |
| Cache                                             | `@tsir/cache`                | framework |
| Database                                          | `@tsir/database`             | framework |
| Migrations                                        | `@tsir/migrate`              | framework |
| Seeders                                           | `@tsir/seed`                 | framework |
| Events                                            | `@tsir/events`               | framework |
| Queue                                             | `@tsir/queue`                | framework |
| Scheduling                                        | `@tsir/schedule`             | framework |
| Mail                                              | `@tsir/mail`                 | framework |
| Notifications                                     | `@tsir/notify`               | framework |
| Storage                                           | `@tsir/storage`              | framework |
| Validation                                        | `@tsir/validate`             | framework |
| Logging / Metrics / Tracing / Health / Rate Limit | `@tsir/pulse`                | framework |
| Config                                            | `@tsir/config`               | framework |
| Container (DI)                                    | `@tsir/container`            | framework |
| HTTP                                              | `@tsir/http`                 | framework |
| Routing                                           | `@tsir/router`               | framework |
| Console (Artisan)                                 | `@tsir/console`              | framework |
| Deployment (Vapor)                                | `@tsir/deploy`               | framework |
| Socialite (social OAuth)                          | `@tsir/socialize`            | framework |
| Horizon (queue admin UI)                          | `@tsir/telemetry`            | framework |
| Telescope (request inspection)                    | `@tsir/telemetry`            | framework |
| Pulse (analytics dashboard)                       | admin `dashboard`            | admin     |
| Passport (OAuth2 server)                          | `@tsir/passport` _(planned)_ | framework |
| Sanctum (SPA/API tokens)                          | `@tsir/auth` (enhanced)      | framework |
| Broadcasting (Echo/Reverb)                        | `@tsir/broadcast`            | framework |
| Scout (search)                                    | `@tsir/scout`                | framework |
| Pennant (feature flags)                           | `@tsir/pennant`              | framework |
| Cashier (billing)                                 | `@tsir/cashier`              | framework |
| Tinker (REPL)                                     | `@tsir/tinker` _(planned)_   | framework |
| Forge (server management)                         | `@tsir/forge`                | framework |
| Nightwatch (E2E testing)                          | `@tsir/nightwatch`           | framework |
| Media processing                                  | `@tsir/media`                | framework |
| CSRF Protection                                   | `@tsir/http` (enhanced)      | framework |

## Core Framework Services

| Laravel Service                | Tsir Equivalent   | Status         | Notes                                                                                                                                                                                           |
| ------------------------------ | ----------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication (Auth)          | `@tsir/auth`      | ✅ implemented | Passwords (PBKDF2/argon2), sessions (cookie), API keys, bearer tokens, guards (session/bearer/apiKey/compose).                                                                                  |
| Authorization (Gates/Policies) | `@tsir/policy`    | ✅ implemented | Roles (with implies), permissions, policies (ownership rules), gates, HTTP integration (`toHttpPolicies`), `createPolicyBootstrap()`.                                                           |
| Hashing                        | `@tsir/auth`      | ✅ implemented | PBKDF2-SHA256 default, argon2id on Bun, self-describing hashes.                                                                                                                                 |
| Sessions                       | `@tsir/auth`      | ✅ implemented | Cookie sessions with database/memory stores, idle + absolute lifetime, rotation.                                                                                                                |
| Encryption                     | `@tsir/vault`     | ✅ implemented | AES-GCM cipher, keyring, envelope encryption, rotation, encrypted DB columns.                                                                                                                   |
| Cache                          | `@tsir/cache`     | ✅ implemented | Memory, Redis, Cloudflare KV, database, null drivers; `createCacheBootstrap()`.                                                                                                                 |
| Database (Eloquent)            | `@tsir/database`  | ✅ implemented | D1 + Postgres + SQLite, Drizzle ORM, transactions, connection registry, `createDatabaseBootstrap()`.                                                                                            |
| Migrations                     | `@tsir/migrate`   | ✅ implemented | Drizzle-style SQL migrations, journal, drift detection, `tsir migrate`.                                                                                                                         |
| Seeders                        | `@tsir/seed`      | ✅ implemented | Orderable, idempotent, environment-scoped seeders.                                                                                                                                              |
| Events                         | `@tsir/events`    | ✅ implemented | In-process + transactional outbox bus, event definitions, `createEventsBootstrap()`.                                                                                                            |
| Queue                          | `@tsir/queue`     | ✅ implemented | `defineJob`, registry, database/memory/sync drivers, retries, backoff, dead-letter, `createQueueBootstrap()`.                                                                                   |
| Scheduling                     | `@tsir/schedule`  | ✅ implemented | Cron-style scheduled jobs, distributed locking.                                                                                                                                                 |
| Mail                           | `@tsir/mail`      | ✅ implemented | SMTP, SES, Postmark, Resend, Cloudflare, HTTP, log, memory transports; `createMailerBootstrap()`.                                                                                               |
| Notifications                  | `@tsir/notify`    | ✅ implemented | Mail, SMS, database, chat, webhook, post channels; signed payloads.                                                                                                                             |
| Filesystem/Storage             | `@tsir/storage`   | ✅ implemented | Disk abstraction, local + S3/R2 drivers.                                                                                                                                                        |
| Validation                     | `@tsir/validate`  | ✅ implemented | Zod-based schema validation, integrated with router body/params.                                                                                                                                |
| Logging                        | `@tsir/pulse`     | ✅ implemented | Structured logs, redaction, rate limiting, multiple sinks (stdout, memory, fanout).                                                                                                             |
| Metrics                        | `@tsir/pulse`     | ✅ implemented | In-memory counters/timers, snapshot API.                                                                                                                                                        |
| Tracing                        | `@tsir/pulse`     | ✅ implemented | Spans, traceparent (W3C), sampling, exporters.                                                                                                                                                  |
| Health Checks                  | `@tsir/pulse`     | ✅ implemented | Liveness + readiness probes, `createHealth()`.                                                                                                                                                  |
| Rate Limiting                  | `@tsir/pulse`     | ✅ implemented | `createRateLimiter()`.                                                                                                                                                                          |
| Config                         | `@tsir/config`    | ✅ implemented | `defineConfig`, `env()` helpers, redaction, secrets, presets.                                                                                                                                   |
| Container (DI)                 | `@tsir/container` | ✅ implemented | Explicit constructor injection, tokens, providers, scopes.                                                                                                                                      |
| HTTP                           | `@tsir/http`      | ✅ implemented | Fetch handler, middleware, problems (RFC 7807), contracts.                                                                                                                                      |
| Routing                        | `@tsir/router`    | ✅ implemented | Decorator-based controllers, route modules, policy guards, OpenAPI generation.                                                                                                                  |
| Console (Artisan)              | `@tsir/console`   | ✅ implemented | `tsir` CLI, `make:*` generators, `defineCommand`, in-process runner.                                                                                                                            |
| Deployment (Vapor)             | `@tsir/deploy`    | ✅ implemented | Cloudflare Workers + AWS Lambda deploy graph, secrets management. VPS targets (Hetzner, DO, Vultr, Lightsail, Linode) planned — see [cloud-vps-compatibility.md](./cloud-vps-compatibility.md). |

## Newly Implemented Services

| Laravel Service                 | Tsir Equivalent    | Status         | Notes                                                                                                                                                                                                            |
| ------------------------------- | ------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Socialite                       | `@tsir/socialize`  | ✅ implemented | OAuth2 provider interface, Google + GitHub providers, CSRF state tokens, `createSocializeBootstrap()`.                                                                                                           |
| Pennant (feature flags)         | `@tsir/pennant`    | ✅ implemented | Boolean, percentage (deterministic hash), allowlist, conditional rules; memory + database stores; `createPennantBootstrap()`.                                                                                    |
| Scout (search)                  | `@tsir/scout`      | ✅ implemented | In-memory, SQLite FTS5, Postgres tsvector engines; `createScoutBootstrap()`.                                                                                                                                     |
| Echo + Reverb (broadcasting)    | `@tsir/broadcast`  | ✅ implemented | Pub/sub broadcaster (memory), WebSocket server with auth/authorize, Echo-style client; `createBroadcastBootstrap()`. Redis broadcaster planned (see [cloud-vps-compatibility.md](./cloud-vps-compatibility.md)). |
| Cashier (billing)               | `@tsir/cashier`    | ✅ implemented | Stripe REST API (no SDK), customers/subscriptions/invoices, webhook signature verification; `createCashierBootstrap()`.                                                                                          |
| Forge (server management)       | `@tsir/forge`      | ✅ implemented | Server CRUD, command execution, deploy recipes; local provider. SSH + Hetzner/DO/Vultr/Lightsail/Linode providers planned (see [cloud-vps-compatibility.md](./cloud-vps-compatibility.md)).                      |
| Nightwatch (E2E)                | `@tsir/nightwatch` | ✅ implemented | Page abstraction (goto/click/fill/text/screenshot), in-memory + Playwright backends; `createNightwatchBootstrap()`.                                                                                              |
| Media processing                | `@tsir/media`      | ✅ implemented | `MediaAdapter` interface; sharp (images), ffmpeg (video), Cloudflare Images/Stream, Cloudinary, ImageKit adapters; `createMediaBootstrap()`.                                                                     |
| Telemetry (Horizon + Telescope) | `@tsir/telemetry`  | ✅ implemented | `requestLogs`, `queueJobs`, `queueDead` schemas; `createRequestLogger()`, `createQueueMonitor()`, `createTelemetryBootstrap()`. Admin's queue-monitor + request-logger are thin wrappers.                        |

## Admin App Tooling (admin.product.com)

| Laravel Tool            | Admin Module        | Status         | Notes                                                                                                     |
| ----------------------- | ------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| Horizon                 | `queue-monitor`     | ✅ implemented | Thin wrapper over `@tsir/telemetry`'s `createQueueMonitor()`; job counts, list, detail, retry.            |
| Telescope               | `request-logs`      | ✅ implemented | Thin wrapper over `@tsir/telemetry`'s `createRequestLogger()`; method, path, status, duration, principal. |
| Nova (admin panel)      | `admin.product.com` | ✅ implemented | Users, roles, permissions, groups, mail templates, i18n.                                                  |
| Pulse (analytics)       | `dashboard`         | ✅ implemented | Metrics cards from `@tsir/pulse`, quick links to telemetry.                                               |
| Pennant (feature flags) | `feature-flags`     | ✅ implemented | Lists all flags + current state via `@tsir/pennant`.                                                      |
| Scout (search)          | `search`            | ✅ implemented | Search endpoint backed by `@tsir/scout`.                                                                  |

## Still Planned

| Laravel Service          | Tsir Equivalent  | Priority | Plan                                                                                                                     |
| ------------------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Passport (OAuth2 server) | `@tsir/passport` | P1       | OAuth2 authorization server: access/refresh tokens, client credentials, authorization code flow. Builds on `@tsir/auth`. |
| Tinker (REPL)            | `@tsir/tinker`   | P2       | Interactive REPL with access to the app container — `tsir tinker`.                                                       |
| Sanctum enhancement      | `@tsir/auth`     | P1       | SPA cookie-based token auth + token abilities/scopes UI.                                                                 |
| CSRF Protection          | `@tsir/http`     | P1       | CSRF token middleware for state-changing requests.                                                                       |

## `@tsir/media` Adapter Summary

| Adapter             | Kind  | Notes                                                                                |
| ------------------- | ----- | ------------------------------------------------------------------------------------ |
| `sharpAdapter`      | image | Local image optimization via `sharp` (resize, format, quality). Optional dependency. |
| `ffmpegAdapter`     | video | Local video transcoding via `ffmpeg` binary (H.264, CRF, preset).                    |
| `cloudflareAdapter` | image | Cloudflare Images API: upload + variant/dimension delivery.                          |
| `cloudinaryAdapter` | image | Cloudinary unsigned upload + transformation URL.                                     |
| `imagekitAdapter`   | image | ImageKit upload + URL-based transformations.                                         |

## Coverage Summary

- **Implemented framework packages**: 34 (auth, policy, vault, cache, database, migrate, seed, events, queue, schedule, mail, notify, storage, validate, pulse, config, container, http, router, console, deploy, socialize, pennant, scout, broadcast, cashier, forge, nightwatch, media, telemetry, link, testing, core)
- **Implemented admin modules**: 8 (users, rbac, i18n, mail, auth, setup, system/telemetry, feature-flags, search)
- **Planned**: 4 (passport, tinker, sanctum enhancement, CSRF)
