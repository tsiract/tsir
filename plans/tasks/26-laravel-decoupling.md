# 14 — Laravel Ecosystem Decoupling & `@tsir/*` Rebranding

> **Phase 9 (final).** A deliberate, ecosystem-wide rebranding and decoupling
> initiative to remove Laravel-derived names, terminology, branding, and
> unnecessary conceptual dependencies from the Tsir framework.
>
> **Status:** planning only. All tasks below are `[ ]` pending. No package,
> symbol, import, or documentation reference is changed until Phase 8 (production readiness) has
> closed and this phase is explicitly started.

---

## 1. Objectives

1. Establish an independent TypeScript ecosystem under the `@tsir/*` namespace with
   no Laravel-ecosystem naming, terminology, or branding.
2. Replace every Laravel-inspired package name with a name that describes the
   package's actual functionality.
3. Replace Laravel-specific terminology in public APIs, internal symbols,
   comments, package descriptions, docs, and UI copy with independent,
   functionally accurate terminology.
4. Preserve all existing functionality. Breaking changes are limited to
   package names and symbol names only; behavior is unchanged.
5. Leave generic industry-standard terms (cache, queue, events, auth, etc.) untouched.

---

## 2. Scope

In scope:

- `@tsir/*` package names derived from Laravel ecosystem packages.
- Public and internal symbols named after Laravel concepts (`createEcho`,
  `EchoChannel`, `Nightwatch*`, etc.).
- Package descriptions, comments, JSDoc, migration headers, UI copy, and docs that
  describe features as "X-style" where X is a Laravel package.
- `docs/laravel-service-audit.md` and any docs that frame Tsir as a Laravel
  reimplementation.

Out of scope (generic terms that are industry-standard and not Laravel-specific:

- `auth`, `policy`, `cache`, `database`, `migrate`, `seed`, `events`, `queue`,
  `schedule`, `mail`, `notify`, `storage`, `validate`, `config`, `container`,
  `http`, `router`, `console`, `deploy`, `vault`, `media`, `core`, `link`,
  `testing`.
- "facade" in the project's own DI rule ("no facades"), which is a general
  software-engineering term, not Laravel's Facade pattern.
- "Lightsail" — all occurrences are Amazon Lightsail, not Laravel Sail.

---

## 3. Inventory of Laravel references

### 3.1 Package names (real, implemented)

| Current package    | Laravel origin                                           | Actual functionality                                                                                                                                |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tsir/nightwatch` | Laravel Nightwatch (E2E testing)                         | Browser page abstraction (`goto`/`click`/`fill`/`text`/`screenshot`) with in-memory + Playwright backends; E2E testing harness.                     |
| `@tsir/pennant`    | Laravel Pennant (feature flags)                          | Feature flags: boolean, percentage (deterministic hash), allowlist, conditional rules; memory + database stores.                                    |
| `@tsir/cashier`    | Laravel Cashier (billing)                                | Billing: customers, subscriptions, invoices, Stripe REST (no SDK), webhook signature verification.                                                  |
| `@tsir/forge`      | Laravel Forge (server management)                        | Server CRUD, command execution, deploy recipes; local provider (SSH + cloud providers planned).                                                     |
| `@tsir/socialize`  | Laravel Socialite (social OAuth)                         | OAuth2 provider interface; Google + GitHub providers; CSRF state tokens.                                                                            |
| `@tsir/scout`      | Laravel Scout (search)                                   | Full-text search abstraction: in-memory, SQLite FTS5, Postgres tsvector engines.                                                                    |
| `@tsir/broadcast`  | Laravel Broadcasting (Echo/Reverb)                       | Pub/sub broadcaster (memory), WebSocket server with auth/authorize, Echo-style client.                                                              |
| `@tsir/telemetry`  | Laravel Horizon (queue) + Telescope (request inspection) | Request logging + queue monitoring: `requestLogs`, `queueJobs`, `queueDead` schemas; `createRequestLogger()`, `createQueueMonitor()`.               |
| `@tsir/pulse`      | Laravel Pulse (analytics dashboard)                      | Observability primitives: structured logging, redaction, metrics (counters/timers), tracing (spans, W3C traceparent), health checks, rate limiting. |

### 3.2 Planned packages (not yet implemented)

| Planned name     | Laravel origin                   | Actual planned functionality                                                                     |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@tsir/passport` | Laravel Passport (OAuth2 server) | OAuth2 authorization server: access/refresh tokens, client credentials, authorization code flow. |
| `@tsir/tinker`   | Laravel Tinker (REPL)            | Interactive REPL with access to the app container (`tsir tinker`).                               |

### 3.3 Public/internal symbols

| Symbol                                                                           | Location                                     | Laravel origin                     |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| `createEcho`, `EchoChannel`, `EchoOptions`, `EchoInstance`                       | `src/framework/broadcast/src/echo.ts`        | Laravel Echo (broadcasting client) |
| `createNightwatchBootstrap`, `NightwatchBootstrap`, `NightwatchBootstrapOptions` | `src/framework/nightwatch/src/bootstrap.ts`  | Laravel Nightwatch                 |
| `inMemoryBackend`, `playwrightBackend`, `BrowserBackend`, `Page` (nightwatch)    | `src/framework/nightwatch/src/nightwatch.ts` | — (backend names are generic)      |

### 3.4 Descriptions, comments, docs

| Reference                                       | Location                                                                | Type                  |
| ----------------------------------------------- | ----------------------------------------------------------------------- | --------------------- |
| "Telescope-style request logging"               | `telemetry/package.json`, `telemetry/src/index.ts`, `request-logger.ts` | description + comment |
| "Horizon-style queue monitoring"                | `telemetry/package.json`, `telemetry/src/index.ts`, `queue-monitor.ts`  | description + comment |
| "Echo + Reverb equivalent"                      | `broadcast/src/broadcaster.ts`, `broadcast/src/websocket.ts`            | comment               |
| "Echo-style helper"                             | `broadcast/src/echo.ts`                                                 | comment               |
| "Nightwatch/Playwright equivalent"              | `nightwatch/package.json`, `nightwatch/src/index.ts`                    | description + comment |
| "Horizon-style queue dashboard"                 | `admin.product.com/config/queue.ts`                                     | comment               |
| "-- Horizon-style queue tables."                | `admin.product.com/migrations/0002_queue_tables.sql`                    | migration header      |
| "-- Telescope-style request log."               | `admin.product.com/migrations/0001_request_logs.sql`                    | migration header      |
| "Telescope + Horizon-style"                     | `admin.product.com/modules/shared/schema.ts`                            | comment               |
| "Horizon-style queue monitoring endpoints."     | `admin.product.com/modules/system/http/queue.controller.ts`             | comment               |
| "Horizon-style queue monitor"                   | `admin.product.com/modules/system/services/queue-monitor.ts`            | comment               |
| "Telescope-style request log endpoints."        | `admin.product.com/modules/system/http/request-log.controller.ts`       | comment               |
| "Telescope-style request logger"                | `admin.product.com/modules/system/services/request-logger.ts`           | comment               |
| "Telescope-style request audit"                 | `admin.product.com/client/src/pages/Dashboard.svelte`                   | UI copy               |
| "Horizon-style job monitoring"                  | `admin.product.com/client/src/pages/Dashboard.svelte`                   | UI copy               |
| "Telescope-style audit of HTTP requests"        | `admin.product.com/client/src/pages/Requests.svelte`                    | UI copy               |
| "Horizon-style view of jobs"                    | `admin.product.com/client/src/pages/Queues.svelte`                      | UI copy               |
| "the counterpart of `php artisan`"              | `console/src/commands/project-command.ts`                               | comment               |
| "the Laravel-style split: one file per concern" | `examples/http/tsir.js`                                                 | comment               |
| "Telescope/Horizon-style telemetry"             | `docs/frontend-portability.md`                                          | doc                   |
| `@tsir/nightwatch` compatibility row            | `docs/cloud-vps-compatibility.md`                                       | doc                   |
| Full Laravel→Tsir mapping table                 | `docs/laravel-service-audit.md`                                         | doc (entire file)     |

### 3.5 Compiled/generated artifacts (must be regenerated, not hand-edited)

- `admin.product.com/client/.build/**` (compiled Svelte)
- `admin.product.com/public/app.js`, `app.js.map` (bundled client)
- `admin.product.com/routes.gen.ts` (route compiler output — may embed package names)
- `admin.product.com/unit-graph.json` (deploy graph)

---

## 4. Package naming — current → proposed

### 4.1 Naming principles

1. Use the `@tsir/*` namespace.
2. Concise, descriptive, recognizable.
3. Consistent with the `@tsir` ecosystem (lowercase, no unnecessary abbreviations.
4. No Laravel-specific terminology.
5. No names copied from other frameworks/ecosystems.
6. Names describe actual functionality, not a vague analogy.
7. Accommodate future functionality without becoming misleading.

### 4.2 Recommended renames

| Current            | Recommended                | Alternatives considered                   | Reasoning                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tsir/nightwatch` | **`@tsir/browser`**        | `@tsir/e2e`, `@tsir/web-test`             | The package provides a browser page abstraction for testing. "browser" is concise and describes what it drives; "e2e" describes the use case but the package is also usable for non-test browser automation. "browser" accommodates both.                                                          |
| `@tsir/pennant`    | **`@tsir/flags`**          | `@tsir/feature-flags`                     | "flags" is the standard industry term for feature flags. Concise and unambiguous.                                                                                                                                                                                                                  |
| `@tsir/cashier`    | **`@tsir/billing`**        | `@tsir/subscriptions`                     | The package covers customers, subscriptions, and invoices; "billing" is the broadest accurate term.                                                                                                                                                                                                |
| `@tsir/forge`      | **`@tsir/servers`**        | `@tsir/provision`, `@tsir/infrastructure` | "servers" directly describes server management (CRUD, commands, recipes). "infrastructure" is broader than current scope.                                                                                                                                                                          |
| `@tsir/socialize`  | **`@tsir/oauth`**          | `@tsir/social-auth`, `@tsir/social`       | The package implements the OAuth2 protocol for social login. "oauth" names the actual technology.                                                                                                                                                                                                  |
| `@tsir/scout`      | **`@tsir/search`**         | —                                         | "search" is the accurate and standard.                                                                                                                                                                                                                                                             |
| `@tsir/broadcast`  | **keep `@tsir/broadcast`** | —                                         | "broadcast" is a generic industry term (pub/sub, WebSocket broadcasting) and not Laravel-specific. Only the internal `Echo` API and "Reverb" references need renaming.                                                                                                                             |
| `@tsir/telemetry`  | **keep `@tsir/telemetry`** | —                                         | "telemetry" is a generic industry term. Only the "Telescope-style"/"Horizon-style" descriptions need rewording.                                                                                                                                                                                    |
| `@tsir/pulse`      | **`@tsir/observability`**  | keep `@tsir/pulse`                        | Laravel Pulse is a well-known analytics-dashboard package. Our package provides observability primitives (logs, metrics, traces, health, rate limit), not an analytics dashboard. "observability" removes the collision and is functionally accurate. **Decision: rename to `@tsir/observability`. |

### 4.3 Planned package renames

| Planned          | Recommended              | Reasoning                                                                                                                                                                                                          |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@tsir/passport` | **`@tsir/oauth-server`** | Distinguishes the OAuth2 authorization server from `@tsir/oauth` (client-side social login). Could be consolidated into `@tsir/oauth` if both client and server concerns are implemented in one package; see § 10. |
| `@tsir/tinker`   | **`@tsir/repl`**         | "repl" is the standard term for an interactive read-eval-print loop.                                                                                                                                               |

### 4.4 Symbol renames within kept packages

| Package           | Current symbol | Proposed symbol  |
| ----------------- | -------------- | ---------------- |
| `@tsir/broadcast` | `createEcho`   | `createClient`   |
| `@tsir/broadcast` | `EchoChannel`  | `Channel`        |
| `@tsir/broadcast` | `EchoOptions`  | `ClientOptions`  |
| `@tsir/broadcast` | `EchoInstance` | `Client`         |
| `@tsir/broadcast` | file `echo.ts` | file `client.ts` |

---

## 5. Terminology migration

| Existing term                      | Proposed term                          | Type                | Affected                                 |
| ---------------------------------- | -------------------------------------- | ------------------- | ---------------------------------------- |
| "Telescope-style"                  | "request logging" / "request audit"    | doc/comment/UI      | `telemetry`, admin modules, client pages |
| "Horizon-style"                    | "queue monitoring" / "queue dashboard" | doc/comment/UI      | `telemetry`, admin modules, client pages |
| "Echo-style"                       | "broadcast client" / "channel client"  | comment/API         | `broadcast`                              |
| "Reverb equivalent"                | "WebSocket server"                     | comment             | `broadcast`                              |
| "Nightwatch/Playwright equivalent" | "browser testing harness"              | description/comment | `nightwatch`                             |
| "Forge equivalent"                 | "server management"                    | description/comment | `forge`                                  |
| "the counterpart of `php artisan`" | "the Tsir CLI entry point"             | comment             | `console`                                |
| "Laravel-style split"              | "one file per concern"                 | comment             | `examples/http/tsir.js`                  |

Generic terms to **keep**: broadcast, telemetry, observability, browser, flags, billing, servers, oauth, search, repl.

---

## 6. Affected files & components

### 6.1 Package directories (rename)

- `src/framework/nightwatch/` → `src/framework/browser/`
- `src/framework/pennant/` → `src/framework/flags/`
- `src/framework/cashier/` → `src/framework/billing/`
- `src/framework/forge/` → `src/framework/servers/`
- `src/framework/socialize/` → `src/framework/oauth/`
- `src/framework/scout/` → `src/framework/search/`
- `src/framework/pulse/` → `src/framework/observability/`

### 6.2 Package manifests (name + description)

- Each renamed package's `package.json`: `"name"` and `"description"`.
- `src/apps/admin.product.com/package.json`: dependency list.
- `src/apps/examples/http/package.json`, `src/apps/examples/minimal/package.json` (if applicable).
- Root `package.json` (workspace glob — no change needed).

### 6.3 Source files

- Renamed package internals (`bootstrap.ts`, `index.ts`, main module files): import paths of dependencies.
- `src/framework/broadcast/src/echo.ts` → `client.ts`: symbol renames.
- `src/framework/broadcast/src/index.ts`: re-export updated.
- `src/framework/broadcast/src/broadcaster.ts`, `websocket.ts`: comment rewording.
- `src/framework/telemetry/src/index.ts`, `request-logger.ts`, `queue-monitor.ts`: comment rewording.
- `src/framework/nightwatch/src/**`: symbol renames (`Nightwatch*` → `Browser*`).
- All admin app modules: service wrappers (`pennant.ts`, `scout.ts`, `socialize.ts`, `queue-monitor.ts`, `request-logger.ts`): import path + symbol renames.
- Admin client pages (`Dashboard.svelte`, `Requests.svelte`, `Queues.svelte`): UI copy rewording.
- Admin migrations (`0001_request_logs.sql`, `0002_queue_tables.sql`): header comments.
- Admin `modules/shared/schema.ts`: comment.
- Admin `config/queue.ts`: comment.
- `examples/http/tsir.js`: comment.
- `console/src/commands/project-command.ts`: comment.

### 6.4 Docs

- `docs/laravel-service-audit.md`: rewrite as a Tsir service catalog (remove Laravel framing, or keep as a historical migration note marked superseded).
- `docs/cloud-vps-compatibility.md`: `@tsir/nightwatch` → `@tsir/browser`.
- `docs/frontend-portability.md`: "Telescope/Horizon-style" → "request logging and queue monitoring".
- `src/docs/packages/**`: any package pages added in this phase.
- `src/apps/frontpage/packages.ts`: icon name (if any — currently only "broadcast" icon, no rename needed).

### 6.5 Tests

- All `*.test.ts` inside renamed packages: import paths, describe blocks, symbol names.
- Admin `modules/system/services/*.test.ts` (if any).
- `src/tools/dist.ts`, `verify-dist.ts`: package name lists if they enumerate packages.

### 6.6 Generated artifacts (regenerate)

- `admin.product.com/routes.gen.ts` — run `tsir route:compile`.
- `admin.product.com/unit-graph.json` — run `tsir deploy:plan`.
- `admin.product.com/client/.build/**`, `public/app.js*` — run `bun run build:client`.
- `src/docs/api-surface.json` — regenerate.

---

## 7. Dependencies & prerequisites

1. **Phase 8 (production readiness) must close first.** Rebranding is a final-phase work; doing it before the API surface is stable creates churn.
2. **No in-flight PRs touching renamed packages must land first.**
3. **A decision on `@tsir/oauth` vs `@tsir/oauth-server` consolidation** (§ 10) before implementing the server package.
4. **A decision on `docs/laravel-service-audit.md`**: rewrite vs. keep as historical note. Recommendation: rewrite as `docs/service-catalog.md` with the Laravel column removed; keep the old file as a one-paragraph historical note pointing to the new catalog.

---

## 8. Breaking changes & compatibility strategy

- **Package rename = major-version breaking.** All consumers importing `@tsir/nightwatch` etc. must update imports.
- **Symbol rename = breaking** within `@tsir/broadcast` (`createEcho` → `createClient`).
- **Compatibility aliases (optional, one minor version):** publish the old package names as deprecated re-export shims for one minor version to ease migration. Decision: **do not ship shims** unless a real external consumers exist at `v1.0`. The framework is pre-1.0; a clean break is acceptable. Document the rename in the release notes.
- **Error codes are append-only** (cross-cutting constraint). No error codes are renamed by this phase; only package and symbol names.
- **Public API surface** (`api-surface.json`) is regenerated; the diff is the migration record.

---

## 9. Migration sequence

1. **Inventory & confirm.** Freeze the inventory above; confirm no additional Laravel references via a repository-wide search (§ 11).
2. **Rename package directories.** `nightwatch`→`browser`, `pennant`→`flags`, `cashier`→`billing`, `forge`→`servers`, `socialize`→`oauth`, `scout`→`search`, `pulse`→`observability`.
3. **Update each package manifests** `package.json` `"name"` and `"description"`.
4. **Update internal imports** within each renamed package and the framework's own files.
5. **Rename `broadcast/echo.ts` → `client.ts`** and rename symbols.
6. **Update all consuming imports** across the repo (admin app, examples, tools, tests).
7. **Reword comments, descriptions, UI copy, migration headers.**
8. **Update docs** (`laravel-service-audit.md`, `cloud-vps-compatibility.md`, `frontend-portability.md`).
9. **Regenerate artifacts** (`routes.gen.ts`, `unit-graph.json`, client build, `api-surface.json`).
10. **Run full verification** (§ 11).
11. **Final repository-wide search** for any remaining Laravel terms (§ 11.2).

Each step is one PR-sized. Steps 2–5 can be batched per package; step 6 is one PR.

---

## 10. Open decisions

- **`@tsir/oauth` consolidation.** Should the planned OAuth2 server (`@tsir/passport` → `@tsir/oauth-server`) be a separate package or merged into `@tsir/oauth`? Recommendation: **separate** (`@tsir/oauth` for social-login clients, `@tsir/oauth-server` for the authorization server), because the concerns (consumer vs. server) are distinct and the server has no dependency on social providers. Revisit when the server package is implemented.
- **`docs/laravel-service-audit.md` fate.** Recommendation: rewrite as `docs/service-catalog.md` (Tsir-native, no Laravel column), keep the original as a short historical note. Confirm before starting this phase.

---

## 11. Verification requirements

### 11.1 Per-step verification

- `bun run typecheck` — zero errors.
- `bun run lint` — zero errors.
- `bun test` — all tests pass.
- `bun run boundaries` — package boundaries still valid.
- `bun run route:compile` (admin) — `routes.gen.ts` unchanged except package-name diffs.
- `bun run build:client` (admin) — client builds.
- `make check` — full workspace check passes.

### 11.2 Final repository-wide search

After all changes, run a case-insensitive search for:

`Laravel|Nightwatch|Eloquent|Artisan|Illuminate|Horizon|Telescope|Sanctum|Passport|Octane|Pint|Sail|Inertia|Livewire|Blade|Pennant|Cashier|Forge|Socialite|Scout|Reverb|Vapor|Nova|Tinker`

Each remaining hit must be reviewed individually. Allowed survivors:

- Historical migration notes explicitly marked as such.
- Third-party attribution in `docs/attributions.md`.
- Generic terms that are not Laravel-specific (e.g. "Lightsail" = Amazon Lightsail).
- The `plans/` directory (this plan and the historical audit).

### 11.3 Completion criteria

1. No Laravel-specific branding or terminology remains in source, docs (except explicitly historical notes), config, or UI.
2. All Laravel-inspired `@tsir/*` package names replaced with approved names.
3. Package imports, exports, and dependencies consistent.
4. Public APIs and internal naming consistent.
5. Documentation, examples, comments, config references updated.
6. Package publishing and CI configs use new identities.
7. Existing functionality preserved (tests pass).
8. Compatibility and migration requirements documented.
9. Final repository-wide search conducted; remaining references reviewed.

---

## 12. Task list

### `RBR-001 — Confirm inventory & open decisions

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** Phase 8 close
- **Acceptance criteria:**
  - [ ] Inventory in § 3 reviewed against a fresh repository-wide search.
  - [ ] Open decisions in § 10 resolved.
  - [ ] `docs/laravel-service-audit.md` fate decided.

### `RBR-002 — Rename `@tsir/nightwatch`→`@tsir/browser`

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] Directory `src/framework/nightwatch/` → `src/framework/browser/`.
  - [ ] `package.json` name + description updated.
  - [ ] `Nightwatch*` symbols renamed to `Browser*` (`createNightwatchBootstrap` → `createBrowserBootstrap`, etc.).
  - [ ] All imports across repo updated.
  - [ ] Tests pass.

### `RBR-003 — Rename `@tsir/pennant`→`@tsir/flags`

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] Directory + manifest renamed.
  - [ ] `createPennantBootstrap` → `createFlagsBootstrap` (and all `Pennant*` symbols).
  - [ ] All imports updated; tests pass.

### `RBR-004 — Rename `@tsir/cashier`→`@tsir/billing`

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] Directory + manifest renamed.
  - [ ] `createCashierBootstrap` → `createBillingBootstrap`.
  - [ ] All imports updated; tests pass.

### `RBR-005 — Rename `@tsir/forge`→`@tsir/servers`

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] Directory + manifest renamed.
  - [ ] `createForgeBootstrap` → `createServersBootstrap`.
  - [ ] All imports updated; tests pass.

### `RBR-006 — Rename `@tsir/socialize`→`@tsir/oauth`

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] Directory + manifest renamed.
  - [ ] `createSocializeBootstrap` → `createOAuthBootstrap`.
  - [ ] All imports updated; tests pass.

### `RBR-007 — Rename `@tsir/scout`→`@tsir/search`

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] Directory + manifest renamed.
  - [ ] `createScoutBootstrap` → `createSearchBootstrap`.
  - [ ] All imports updated; tests pass.

### `RBR-008 — Rename `@tsir/pulse`→`@tsir/observability`

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] Directory + manifest renamed.
  - [ ] `createPulseBootstrap` → `createObservabilityBootstrap` (and all `Pulse*` symbols).
  - [ ] All imports updated; tests pass.

### `RBR-009 — Rename `broadcast` Echo symbols

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] `echo.ts` → `client.ts`.
  - [ ] `createEcho` → `createClient`, `EchoChannel` → `Channel`, `EchoOptions` → `ClientOptions`, `EchoInstance` → `Client`.
  - [ ] Comments "Echo/Reverb" reworded.
  - [ ] All imports updated; tests pass.

### `RBR-010 — Reword telemetry & admin descriptions/comments/UI

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-001`
- **Acceptance criteria:**
  - [ ] "Telescope-style" → "request logging"/"request audit".
  - [ ] "Horizon-style" → "queue monitoring"/"queue dashboard".
  - [ ] Migration headers, schema comments, config comments, UI copy updated.
  - [ ] `telemetry/package.json` description reworded.

### `RBR-011 — Update docs

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-002`…`RBR-010`
- **Acceptance criteria:**
  - [ ] `docs/laravel-service-audit.md` rewritten per `RBR-001` decision.
  - [ ] `docs/cloud-vps-compatibility.md` package name updated.
  - [ ] `docs/frontend-portability.md` terminology updated.
  - [ ] `src/docs/packages/**` pages added for renamed packages.

### `RBR-012 — Regenerate artifacts & final verification

- **Phase:** 9
- **Status:** `[ ]`
- **Depends on:** `RBR-002`…`RBR-011`
- **Acceptance criteria:**
  - [ ] `routes.gen.ts`, `unit-graph.json`, client build, `api-surface.json` regenerated.
  - [ ] `make check` passes.
  - [ ] Final repository-wide search (§ 11.2) conducted; survivors reviewed.
  - [ ] Completion criteria (§ 11.3) met.

---

## 13. Status legend

- `[x]` Completed
- `[ ]` Pending
- `[!]` Blocked
- `[/]` In progress
- `[~]` Branch exists, not merged

All tasks in this phase are `[ ]` pending until Phase 8 closes.
