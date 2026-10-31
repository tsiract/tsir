# 12 — Testing Strategy

> `@tsir/testing` plus repository-wide rules. Security-sensitive modules require negative tests; infrastructure requires concurrency tests.

---

## 1. Test taxonomy

| Layer                | Tool                                    | Where                                             | Runs in CI                                |
| -------------------- | --------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Unit                 | `bun test`                              | `src/framework/*/src/**/*.test.ts`                | Every PR                                  |
| Type-level           | `tsc` + `expectTypeOf`-style assertions | `src/framework/*/type-tests/*.ts`                 | Every PR                                  |
| HTTP integration     | `@tsir/testing` in-process harness      | `src/framework/http/test/*.test.ts`               | Every PR                                  |
| Database integration | Ephemeral Postgres (Docker)             | `src/framework/database/test`, `migrate`, `vault` | Every PR (service container)              |
| Deploy conformance   | Shared suite against each adapter       | `src/framework/deploy/test`                       | Every PR (mock adapters) + nightly (real) |
| End-to-end           | Example apps via built artifacts        | `src/apps/examples/*/e2e`                         | `main` only                               |
| Security negative    | Explicit matrices                       | `src/framework/vault`, `auth`, `link/soap`        | Every PR                                  |
| Performance          | `bun` microbench + budget assertions    | `src/bench/`                                      | Nightly, with committed baselines         |

---

## 2. `@tsir/testing` public surface

```ts
// app harness
export function createTestApp(options?: {
  readonly modules?: readonly string[];
  readonly config?: Partial<EnvRecord>;
  readonly overrides?: readonly ProviderOverride[];
  readonly clock?: Clock;
  readonly random?: Random;
}): Promise<TestApp>;

export interface TestApp {
  readonly app: App;
  readonly http: {
    request(input: RequestInput): Promise<TestResponse>;
    get(path: string, init?: RequestInit): Promise<TestResponse>;
    post(path: string, body: unknown, init?: RequestInit): Promise<TestResponse>;
  };
  readonly container: {
    get<T>(token: Token<T>): T; // allowed in tests only
    has(token: Token<unknown>): boolean;
  };
  dispose(): Promise<void>;
}

// database harness
export function createTestDatabase(options?: {
  readonly migrations?: boolean;
  readonly seeder?: readonly string[];
}): Promise<TestDatabase>;

// deterministic environment
export function fixedClock(at?: string): Clock;
export function seededRandom(seed: number): Random;

// assertions
export function expectProblem(res: TestResponse, code: string, status: number): void;
export function expectTsirError(fn: () => Promise<unknown>, code: string): Promise<TsirError>;
```

Design rules:

- The harness starts a **real** application through the same `bootstrap()` as production — no test-only code path in the framework.
- `container.get` exists here and **only** here; the production container does not expose it. That is the whole point of `@tsir/testing` taking a dependency on container internals.
- HTTP tests run in-process against the Web-standard handler (no sockets, no port collisions, fast).
- `dispose()` is called by `afterEach` via a helper; leaked handles fail the suite (`--bail` with handle detection in Bun).

---

## 3. Determinism

| Source of nondeterminism    | Replacement                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `Date.now()` / `new Date()` | `Clock` injected; `fixedClock` in tests; lint-restricted in `src/framework/*` outside adapters |
| `Math.random()`             | `Random` injected; `seededRandom` in tests                                                     |
| `crypto.randomUUID`         | `IdGenerator` (v7 UUIDs with injected clock/random)                                            |
| Network                     | Forbidden in unit tests; integration tests use local containers or recorded fixtures           |
| Postgres sequences          | Reset helper per test schema                                                                   |
| Timezones                   | All tests run `TZ=UTC` (CI enforces)                                                           |

---

## 4. Required negative tests by module

| Module       | Must test                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Container    | missing provider, cycle, duplicate, resolve-after-dispose, override for unknown token, transient leak warning                            |
| Config       | missing required, wrong type, secret in `tsir.js`, unknown key (strict), ambiguous config file                                           |
| Router       | duplicate route, arity mismatch, unknown guard token, invalid status, path with reserved chars                                           |
| HTTP         | 404/405/406/413/415/422/500, body too large, wrong content type, timeout, client abort, prototype-pollution keys, malformed JSON         |
| Validation   | extra keys (strip/strict), type coercion boundaries (`"01"`, `" 1"`, `"1e3"`), multipart oversize, MIME mismatch                         |
| Database     | bad URL, auth fail, tx timeout, savepoint rollback, retry exhaustion, migration drift, concurrent migration lock, read-only violation    |
| Vault        | full matrix in [`06-vault.md § 8`](../modules/06-vault.md#8-test-matrix)                                                                 |
| Link         | timeout, cancellation, TLS failure, XXE/billion-laughs (SOAP), oversized payload, WS malformed frame, retry on non-idempotent (must not) |
| Deploy       | capability missing, missing binding, secret leak in artifact, empty unit, graph drift                                                    |
| Events/Queue | duplicate delivery, retry backoff, DLQ after exhaustion, graceful drain, outbox replay                                                   |

A module cannot be marked `[x]` in its task file without the corresponding rows implemented and linked.

---

## 5. Concurrency & infrastructure tests

These are the tests that catch the bugs that only appear in production:

| Target           | Test                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Container scope  | 1 000 concurrent scopes, no cross-contamination, all disposed                                           |
| Transaction pool | 200 concurrent transactions with random failures, no connection leak (`pg_stat_activity` count stable)  |
| Migration lock   | Two runners started simultaneously, exactly one applies, the other reports in-progress                  |
| Vault rotation   | Rotation running while writers insert/update; every row ends on the active key; no row double-processed |
| Vault nonce      | 1e6 encryptions, zero nonce collisions, per-key check                                                   |
| Queue drain      | Shutdown during processing finishes in-flight jobs and re-queues nothing twice                          |
| Scheduler lock   | Two schedulers, one execution per tick                                                                  |
| Link breaker     | Open/half-open transitions under load; no leaked timers                                                 |

Concurrency tests use a fixed seed where randomness is involved so failures are reproducible, and run `--repeat=3` in CI to catch flakes.

---

## 6. Type-level testing

TypeScript is a first-class part of the contract; type tests are therefore not optional.

```ts
// src/framework/http/type-tests/binders.test-d.ts
import { expectTypeOf } from '@tsir/testing';
import type { Ctx, RouteMeta } from '@tsir/http';

type Route = RouteMetaWith<{ id: typeof IntParam }>;
expectTypeOf<Ctx<Route>['params']['id']>().toEqualTypeOf<number>();
// @ts-expect-error — body schema output is not a string
expectTypeOf<Ctx<CreateUserRoute>['body']>().toEqualTypeOf<string>();
```

Coverage targets: binders→argument types, config inference (`InferConfig`), container token typing (`Token<T>` rejects `Token<U>`), policy resource typing, queue job payload typing, link client method signatures.

Run with `tsc -b src/framework/*/type-tests` in CI; `@ts-expect-error` lines must actually error (a mismatch fails the build).

---

## 7. Coverage policy

| Scope                                                  | Line     | Branch   | Notes                              |
| ------------------------------------------------------ | -------- | -------- | ---------------------------------- |
| `src/framework/container`, `config`, `router`, `vault` | ≥ 90 %   | ≥ 85 %   | Security- and correctness-critical |
| `src/framework/http`, `database`, `link`               | ≥ 85 %   | ≥ 75 %   | I/O heavy; integration counts      |
| `src/framework/deploy`                                 | ≥ 80 %   | ≥ 70 %   | + snapshot tests                   |
| Generated code (`*.gen.ts`)                            | excluded | excluded | Covered via its consumers          |
| Adapters                                               | ≥ 75 %   | —        | Conformance suite is the real gate |

Coverage is a floor, not a goal; the task file must also link the failure-mode tests.

---

## 8. Failure modes (of the test suite itself)

| Risk                                 | Mitigation                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Flaky concurrency tests              | Seeded RNG, `--repeat=3`, quarantine label with an owner and 7-day fix deadline                     |
| Slow CI                              | Split unit/integration jobs; Postgres service container; per-package parallelism                    |
| Tests that pass for the wrong reason | Negative tests asserted on error **code**, not message text                                         |
| Hidden global state between tests    | Each `createTestApp` builds a fresh container; module-level registries are reset by the harness     |
| Real network leakage                 | `fetch` mocked at the harness level; a test that hits the network fails with `TEST_NETWORK_BLOCKED` |

---

## 9. Security considerations

Tests are the evidence behind every security claim the project makes, which makes the test
suite itself part of the security surface:

- **Negative tests are mandatory, not optional.** A module that handles credentials, parses
  untrusted input or enforces authorisation has a negative matrix beside it (vault, `auth`,
  `link/soap`, `policy`). A positive test proves a feature works; only a negative test proves it
  refuses.
- **Fixtures contain no real secrets.** Keys in tests are generated per-run or fixed throwaway
  values, and `check-crypto` fails on a prohibited primitive anywhere in `src/` — a test that
  invents its own crypto is as much a finding as production code that does.
- **Concurrency tests exist because the failure is silent.** A lock, an outbox, or an atomic
  `increment` that is only tested single-threaded is a primitive that will fail in production
  with no test to point at.
- **The coverage gate is a floor, not a claim.** 90 % lines does not mean the remaining 10 % is
  safe; it means it is visible. A security-relevant branch with no test is a review finding
  regardless of the percentage.

---

## 10. Open questions

| #     | Question                                                                                                                                  | Blocks  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `Q13` | `PGlite` fast path vs always-real Postgres. Defined in [`05-database.md`](../modules/05-database.md); this module owns the CI-cost half.  | Phase 3 |
| Q32   | Mutation testing (Stryker) on `vault` and `container`? Worth the CI minutes or not?                                                       | Phase 8 |
| Q33   | Do we publish `@tsir/testing` before `1.0`? It is the package users depend on most in their own tests. Current: yes, from `v0.1.0-alpha`. | Phase 2 |

---

## 11. Task index

[`tasks/10-testing.md`](../tasks/10-testing.md) — `TST-001` … `TST-020`.
