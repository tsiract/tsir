# Tasks — Testing (Phases 1–8)

> Test harness, deterministic environment, negative matrices, concurrency.

**Plan:** [`../12-testing.md`](../operations/12-testing.md)

---

## Harness (`@tsir/testing`)

| ID        | Title                                                     | Status | Depends | Acceptance criteria (summary)        |
| --------- | --------------------------------------------------------- | ------ | ------- | ------------------------------------ |
| `TST-001` | `createTestApp` (real bootstrap, config overrides)        | `[x]`  | APP-002 | Uses production code path only       |
| `TST-002` | In-process HTTP client (`request/get/post`)               | `[x]`  | HTP-001 | No sockets; < 1 ms overhead measured |
| `TST-003` | Container overrides + `container.get` (test-only surface) | `[x]`  | CTN-009 | Not exported by production packages  |
| `TST-004` | `createTestDatabase` with schema isolation                | `[x]`  | DB-016  | Parallel suites isolated             |
| `TST-005` | `fixedClock`, `seededRandom`, `IdGenerator`               | `[x]`  | APP-002 | Same seed → identical fixtures       |
| `TST-006` | `expectProblem` / `expectTsirError` assertions            | `[x]`  | ERR-001 | Asserts on code, not message         |
| `TST-007` | Handle-leak detection on dispose                          | `[x]`  | APP-006 | Leaked timer fails the suite         |
| `TST-008` | Network block in unit tests (`TEST_NETWORK_BLOCKED`)      | `[x]`  | TST-001 | Accidental fetch fails loudly        |

## Type-level & contract tests

| ID        | Title                                  | Status | Depends | Acceptance criteria (summary)    |
| --------- | -------------------------------------- | ------ | ------- | -------------------------------- |
| `TST-009` | Type-test runner (`tsc -b type-tests`) | `[x]`  | FND-002 | `@ts-expect-error` must error    |
| `TST-010` | Binder → handler typing tests          | `[~]`  | RTR-004 | Params/body inference asserted   |
| `TST-011` | Token/container typing tests           | `[x]`  | CTN-013 | Cross-type assignment rejected   |
| `TST-012` | Config inference tests                 | `[x]`  | CFG-001 | Env names → typed fields         |
| `TST-013` | Job/event payload typing tests         | `[x]`  | CLI-013 | Payload mismatch is a type error |

## Matrices & concurrency

| ID        | Title                                                                    | Status | Depends | Acceptance criteria (summary)                 |
| --------- | ------------------------------------------------------------------------ | ------ | ------- | --------------------------------------------- |
| `TST-014` | Negative matrix runner (per module table from plans)                     | `[~]`  | TST-006 | Missing row → task cannot be marked done      |
| `TST-015` | Concurrency suite (container, tx, migration, rotation, queue, scheduler) | `[~]`  | TST-004 | Seeded and repeatable                         |
| `TST-016` | Deploy conformance suite (3 targets)                                     | `[ ]`  | DPL-024 | Identical assertions                          |
| `TST-017` | Coverage gates per package                                               | `[x]`  | FND-010 | Thresholds from `12-testing.md § 7`           |
| `TST-018` | Flake quarantine workflow (label, owner, 7 days)                         | `[x]`  | FND-010 | Overdue flake fails CI                        |
| `TST-019` | Bench harness integration (`make bench`)                                 | `[x]`  | FND-019 | Baseline comparison with regression threshold |
| `TST-020` | Mutation testing pilot on `vault` + `container`                          | `[ ]`  | TST-017 | Report committed; decision ADR                |

---

## Gate notes

- `TST-001` must be available from Gate P1 so later modules never invent their own harness.
- A module that ships without its negative-matrix rows (`TST-014`) is not done, regardless of coverage.

## Evidence and open reasons

Evidence is what was run, not what was intended. Commands are from the repo root.

- **TST-001** `createTestApp` boots through `app.createApp` (production path). `src/framework/testing/src/index.test.ts`.
- **TST-002** `createTestClient` builds a `Request` and calls the handler directly, no socket. `client.test.ts` (8 tests).
- **TST-003** `TestApp.get` and `createTestDatabase` live only in `@tsir/testing`; no production package exports them. The `overrides` option of `createApp` is public and documented for tests and the CLI.
- **TST-004** `createTestDatabase` isolates each suite in its own schema (random suffix). `database.test.ts`.
- **TST-005** `fixedClock`, `seededRandom`, and `seededIds` (`IdGenerator`: same seed gives the same ids; `reset()`). `helpers.test.ts` (14 tests).
- **TST-006** `expectProblem` checks `application/problem+json`, status, and code; `expectTsirError` asserts on the code. `client.test.ts`, `helpers.test.ts`.
- **TST-007** `beginHandleTracking` (`handles.ts`) records referenced timers started during an app's life; `dispose` throws `TEST_HANDLE_LEAK` if any are still running. `handles.test.ts` (7 tests), including an app that leaks an interval.
- **TST-008** `installNetworkGuard` blocks non-loopback fetch by default, installed by `[test] preload`. `network.test.ts`.
- **TST-009** `tsconfig.json` includes `src/**/*.ts`, so every `type-tests/` folder runs under `make typecheck`; an unused `@ts-expect-error` is a compile error.
- **TST-010 partial.** Router type tests cover the declarative surface (`router.types.ts`). Handler argument inference from `params` and `body` does not exist: `RouteMeta` holds runtime schemas, so there is nothing to type-test yet. Open until the router gains a typed binder.
- **TST-011** Container type tests (`src/framework/container/type-tests`).
- **TST-012** Config type tests (`src/framework/config/type-tests`).
- **TST-013** Queue and events payload types. `defineJob` keeps `__payload`, and dispatch takes `NoInfer<Payload>`, so a mismatched payload is a compile error (this was not true before; the fix is in `queue/src/port.ts`, `queue/src/job.ts`, and `events/src/bus.ts`). `queue/type-tests`, `events/type-tests`.
- **TST-014 partial.** Each package has its own negative cases (10 files). The per-module matrix lives in `plans/`, which tools may not read, so no runner checks for missing rows. Needs a committed matrix before a runner can enforce it.
- **TST-015 partial.** Concurrency tests exist in container, queue, vault, migrate, database, cache, and others, but there is no shared seeded suite covering the six named areas. Scheduler and rotation under concurrency are not covered.
- **TST-016 open.** Blocked on DPL-024 (deploy conformance across three targets).
- **TST-017** Per-package gate: `src/framework/testing` and `src/framework/console` are now gated. Console holds a 80% line bar (85% functions unchanged), set in `src/tools/coverage-gate.ts` with the reason in the source. The user approved this bar. Fixture and scratch-directory rows no longer count.
- **TST-018** `make flakes` and the quarantine registry (`flakes.json`, 7 tests).
- **TST-019** `make bench` exits 0 against the committed `bench/baseline.json` (2× tolerance).
- **TST-020 open.** Mutation testing needs a new dependency and an ADR; neither is in scope yet.
