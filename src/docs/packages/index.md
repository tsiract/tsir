# Package reference

Every framework package, one page each: what it supports, what it refuses, and the failure modes
it has. A package page is generated from the package itself — its `package.json`, its exported
surface, and its prose — so it cannot describe a version that no longer exists.

Looking for which driver a capability uses on your target? That is
[services, drivers, and defaults](../guides/drivers.md).

## Foundations

- [`@tsir/core`](./core.md): Application lifecycle, module registry, manifest, error surface. Small on purpose: no capability modules, no service locator.
- [`@tsir/container`](./container.md): Explicit constructor-based dependency injection for Tsir. Leaf package: no @tsir dependencies.
- [`@tsir/config`](./config.md): Typed, validated, redacted configuration. Field schemas are Zod schemas re-exported through @tsir/validate, so the workspace has exactly one validator.
- [`@tsir/console`](./console.md): The tsir CLI: lifecycle, diagnostics, generators, configuration automation.
- [`@tsir/tui`](./tui.md): The terminal interface shared by Tsir commands. The root entrypoint is the dependency-free reporting path, so a command that only prints facts never loads a renderer or a native binary; the renderer, prompts and session live behind ./ui.

## HTTP and validation

- [`@tsir/http`](./http.md): Web-standard request pipeline: matching, bindings, validation, guards, policies, serialization, problem responses. No node: or bun: imports outside the adapter subpaths.
- [`@tsir/router`](./router.md): Decorator-driven route declaration compiled into an immutable route table. Standard ECMAScript decorators only — no parameter decorators, no design:type, no per-request reflection.
- [`@tsir/validate`](./validate.md): Zod 4-backed validation at every trust boundary. Exposes the Standard Schema interface so Valibot or ArkType also work, normalizes issues, and is the single owner of the zod dependency in the workspace.
- [`@tsir/policy`](./policy.md): Guards, policies and rate limits: one place for the decisions an action needs before it runs, expressed as data rather than branches in the controller.
- [`@tsir/link`](./link.md): Service-to-service calls over REST, gRPC, SOAP and WebSocket, sharing one CallContext.

## Data

- [`@tsir/database`](./database.md): D1-first database layer: a thin driver contract with explicit capabilities, Drizzle-bound queries, atomic batch writes, health and disposal. Postgres is a subpath with an application-supplied client (ADR-0009). No ORM of its own.
- [`@tsir/migrate`](./migrate.md): Migration applier for Drizzle journals: advisory locks, checksums, drift, guarded rollback.
- [`@tsir/seed`](./seed.md): Deterministic, idempotent seeders with ordering, environment gating and production refusal.
- [`@tsir/vault`](./vault.md): Versioned, authenticated column encryption with an explicit key-state machine. AES-256-GCM through WebCrypto, a self-describing envelope, AAD bound to table and column, and rotation that is resumable because it is a ledger, not a script.

## Background work

- [`@tsir/queue`](./queue.md): @tsir/queue — named job connections over one port: at-least-once delivery, exponential backoff, a dead-letter table, idempotency keys and a drain that survives SIGTERM.
- [`@tsir/schedule`](./schedule.md): @tsir/schedule — cron tasks with overlap prevention: a task is a name, a five-field cron and a handler, and a distributed lock keeps a slow run from stacking on the next tick.
- [`@tsir/events`](./events.md): @tsir/events — typed events and the transactional outbox: a listener runs inline or as a job, and a queued delivery is written in the same batch as the write that caused it.
- [`@tsir/pulse`](./pulse.md): Health, readiness and metrics endpoints for a running app: one probe surface that a platform can call and an operator can read.
- [`@tsir/telemetry`](./telemetry.md): Telescope-style request logging and Horizon-style queue monitoring for any Tsir app.

## Services

- [`@tsir/cache`](./cache.md): @tsir/cache — named cache stores over one port: explicit serialization, per-store capabilities, and no silent fallback.
- [`@tsir/storage`](./storage.md): @tsir/storage — named object-storage disks over one port: bytes in, bytes out, explicit content types, and a URL that says whether it is public or signed.
- [`@tsir/mail`](./mail.md): @tsir/mail — compose and send mail over one transport port: typed templates with an explicit escaping boundary, no implicit queuing, and a log transport that refuses to boot in production.
- [`@tsir/notify`](./notify.md): Notifications over channels: mail, database inbox and webhooks, queued by default, with nothing expensive enabled by default.
- [`@tsir/scout`](./scout.md): Full-text search abstraction over SQLite FTS5, Postgres tsvector, and in-memory drivers.
- [`@tsir/broadcast`](./broadcast.md): Real-time broadcasting: WebSocket server + client channels (Echo/Reverb equivalent).
- [`@tsir/media`](./media.md): Media processing: image (sharp), video (ffmpeg), and 3rd-party (Cloudflare, Cloudinary, ImageKit) adapters.

## Identity and commerce

- [`@tsir/auth`](./auth.md): Authentication: sessions and API keys as first-class records, password hashing, and guards that refuse rather than default to allowing.
- [`@tsir/socialize`](./socialize.md): social OAuth authentication (Google, GitHub, and custom providers)
- [`@tsir/cashier`](./cashier.md): Billing abstraction: customers, subscriptions, invoices, and webhook handling (Stripe-compatible).
- [`@tsir/pennant`](./pennant.md): Feature flags with in-memory, database, and Redis stores; percentage rollouts and user targeting.

## Deployment and testing

- [`@tsir/deploy`](./deploy.md): One application, compiled into deployable units: a deterministic unit graph, per-target bindings, and emitters for Cloudflare Workers and AWS Lambda.
- [`@tsir/testing`](./testing.md): Test harness for Tsir applications: boots the real app, deterministic clock and randomness, typed assertions.
- [`@tsir/nightwatch`](./nightwatch.md): End-to-end testing harness (Nightwatch/Playwright equivalent) for Tsir apps.
- [`@tsir/forge`](./forge.md): Server management: deployment, provisioning, and SSH helpers (Forge equivalent).
