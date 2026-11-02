# Tasks — Core (Phase 1)

> Container, configuration, lifecycle, errors, `tsir.js` loading.

**Plans:** [`../03-core.md`](../modules/03-core.md), [`../09-tsir-config.md`](../operations/09-tsir-config.md)

---

## Container (`@tsir/container`)

| ID        | Title                                                                         | Status | Depends     | Acceptance criteria (summary)                                  |
| --------- | ----------------------------------------------------------------------------- | ------ | ----------- | -------------------------------------------------------------- |
| `CTN-001` | `Token<T>` branded type + `token()`/`contract()` constructors                 | `[x]`  | FND-002     | `Token<A>` not assignable to `Token<B>` (type test)            |
| `CTN-002` | Provider descriptors (`class`/`factory`/`value`) with explicit `inject` array | `[x]`  | CTN-001     | Arity mismatch of `inject` vs constructor is a type error      |
| `CTN-003` | Lifetimes: `singleton`, `transient`                                           | `[x]`  | CTN-002     | Singleton identity stable; transient returns new instances     |
| `CTN-004` | Scoped lifetime + `Scope` creation/disposal                                   | `[x]`  | CTN-003     | `scoped` outside scope → `CTN_NO_SCOPE`                        |
| `CTN-005` | Async factory support + concurrent single-flight                              | `[x]`  | CTN-003     | 100 parallel resolves of one async singleton instantiate once  |
| `CTN-006` | Cycle detection with full path                                                | `[x]`  | CTN-002     | `CTN_CYCLE` message contains `A → B → C → A`                   |
| `CTN-007` | Missing provider diagnostics                                                  | `[x]`  | CTN-002     | Error lists token description + requesting chain + source file |
| `CTN-008` | Duplicate registration detection                                              | `[x]`  | CTN-002     | Duplicate → `CTN_DUPLICATE` at composition                     |
| `CTN-009` | Test overrides (`overrides` array) with unknown-token guard                   | `[x]`  | CTN-002     | Overriding unknown token → `CTN_OVERRIDE_UNKNOWN`              |
| `CTN-010` | Disposal registry, reverse order, per-item timeout                            | `[x]`  | CTN-003     | Slow disposable logs a warning; others still run               |
| `CTN-011` | Transient-leak heuristic                                                      | `[x]`  | CTN-003     | > 100 instances of a transient inside a singleton logs once    |
| `CTN-012` | `maxResolutionDepth` + guard                                                  | `[x]`  | CTN-002     | Depth 33 → clear error                                         |
| `CTN-013` | Type-level tests for tokens/providers                                         | `[x]`  | CTN-001     | `tsc -b` on `type-tests/`                                      |
| `CTN-014` | Coverage ≥ 90 % line / 85 % branch                                            | `[x]`  | CTN-001…013 | `bun test --coverage` gate                                     |

**Gate note:** `CTN-004` ships in Phase 2 together with the first real scope (HTTP request). Until then `scoped` may exist but is untested by consumers; if it cannot be exercised, it is deferred (`Q11`).

---

## Configuration (`@tsir/config`)

| ID        | Title                                                                          | Status | Depends | Acceptance criteria (summary)                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------ | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CFG-001` | `defineConfig(schema)` + `InferConfig<T>`                                      | `[x]`  | FND-002 | Inferred type matches schema output (type test)                                                                                                                                                                                                     |
| `CFG-002` | Env source: `Bun.env`/`process.env` read in one place                          | `[~]`  | CFG-001 | Lint bans `Bun.env` outside this package                                                                                                                                                                                                            |
| `CFG-003` | All-issues collection (no fail-fast)                                           | `[x]`  | CFG-002 | Three bad vars → three issues in one report                                                                                                                                                                                                         |
| `CFG-004` | `.secret()` redaction in errors, logs, `toJSON`, `inspect`                     | `[x]`  | CFG-001 | Serializing config never contains the secret (test)                                                                                                                                                                                                 |
| `CFG-005` | Pattern-based redaction net for unannotated secrets                            | `[x]`  | CFG-004 | `FOO_PASSWORD` redacted even without `.secret()`                                                                                                                                                                                                    |
| `CFG-006` | Deep-freeze resolved config                                                    | `[x]`  | CFG-001 | Mutation attempt throws in strict mode / is silently rejected                                                                                                                                                                                       |
| `CFG-007` | Formatted boot-failure report with source locations                            | `[x]`  | CFG-003 | Matches the sample in `03-core.md § 4.3`                                                                                                                                                                                                            |
| `CFG-008` | Environment-specific defaults (`development`/`test`/`production`)              | `[x]`  | CFG-001 | `APP_ENV=production` requires secrets present                                                                                                                                                                                                       |
| `CFG-009` | Required vs optional vs defaulted semantics                                    | `[x]`  | CFG-001 | Missing required → `CFG_INVALID` exit 1                                                                                                                                                                                                             |
| `CFG-010` | `overridable` flag + `strictEnv` mode                                          | `[x]`  | CFG-002 | Non-overridable env override warns (rejects in strict)                                                                                                                                                                                              |
| `CFG-011` | Clock/Random injection points wired into config consumers                      | `[x]`  | CFG-001 | Tests can fix time                                                                                                                                                                                                                                  |
| `CFG-012` | `tsir.js` loader (resolution order, ESM, sync requirement)                     | `[x]`  | CFG-001 | Ambiguous files → `CFG_AMBIGUOUS_CONFIG_FILE`                                                                                                                                                                                                       |
| `CFG-013` | `{ fromEnv, default, secret }` reference resolution                            | `[x]`  | CFG-012 | Env wins over file; missing → issue with path                                                                                                                                                                                                       |
| `CFG-014` | Presets (`minimal`, `standard`, `api`, `worker`, `edge`, `serverless`, `full`) | `[x]`  | CFG-012 | Each preset produces a valid config for a sample app — delivered as `CFG-102` in [`08-dx.md`](./08-dx.md); seven presets boot a fixture to `ready`                                                                                                                                                                                                |
| `CFG-015` | Managed regions parser + atomic writer                                         | `[x]`  | CFG-012 | Malformed markers → `CFG_MANAGED_REGION_INVALID` — delivered as `CFG-104` in [`08-dx.md`](./08-dx.md); two runs are byte-identical                                                                                                                                                                                                    |
| `CFG-016` | Inlined-secret detector (`CFG_SECRET_INLINED`)                                 | `[x]`  | CFG-012 | 32-byte base64 in `database.url` → error with remediation — Detector in `secrets.ts`: a 32-byte base64 key or a URL with a literal password is refused at load (`CFG_SECRET_INLINED`), and the value is never printed. Tested in `secrets.test.ts`. |

---

## Application lifecycle (`@tsir/core`)

| ID        | Title                                                    | Status | Depends          | Acceptance criteria (summary)                           |
| --------- | -------------------------------------------------------- | ------ | ---------------- | ------------------------------------------------------- |
| `APP-001` | `AppState` discriminated union + transitions             | `[x]`  | CTN-002          | Illegal transition is a type error                      |
| `APP-002` | `bootstrap()` pipeline per `03-core.md § 2`              | `[x]`  | CTN-002, CFG-001 | Each stage observable in debug log                      |
| `APP-003` | Module declaration (`defineModule`) + registry           | `[x]`  | APP-002          | Duplicate module names fail                             |
| `APP-004` | `AppManifest` type + loader + staleness detection        | `[x]`  | APP-003          | Stale manifest → `APP_MANIFEST_STALE`                   |
| `APP-005` | Lifecycle hooks (`onStart`, `onReady`, `onStop`) ordered | `[x]`  | APP-003          | Order asserted by test                                  |
| `APP-006` | Shutdown: drain → flush → dispose, bounded               | `[x]`  | CTN-010          | Timeout path logs remaining disposables, exit 1         |
| `APP-007` | Idempotent shutdown (same promise)                       | `[x]`  | APP-006          | Two calls, one execution                                |
| `APP-008` | Abort during bootstrap disposes partial build            | `[x]`  | APP-002          | No leaked resources (registry empty)                    |
| `APP-009` | Typed app context passed to adapters                     | `[x]`  | APP-001          | Adapter cannot compile against a non-ready app          |
| `APP-010` | `defineCapabilityRequirement` + boot capability probes   | `[x]`  | APP-002          | Missing capability → `DPL_CAPABILITY_MISSING` (Phase 6) |
| `APP-011` | No-graph test: boot with decorator metadata deleted      | `[–]`  | APP-004          | Passes — proves no reflection at boot                   |
| `APP-012` | Logger contract (interface only, no implementation)      | `[x]`  | —                | `@tsir/core` has no logging dependency                  |

---

## Errors

| ID        | Title                                                            | Status | Acceptance criteria                          |
| --------- | ---------------------------------------------------------------- | ------ | -------------------------------------------- |
| `ERR-001` | `TsirError` base + `code`/`kind`/`hint`/`cause`/`context`        | `[x]`  | `cause` preserved; not serialized by default |
| `ERR-002` | Central error-code registry per package, append-only check       | `[x]`  | Removing/renaming a code fails CI            |
| `ERR-003` | Lint rule: no `throw new Error(` inside `src/framework/*`        | `[x]`  | Violation fails lint                         |
| `ERR-004` | Docs test: every code has a docs entry                           | `[x]`  | Missing entry fails CI                       |
| `ERR-005` | Formatters: dev (colour, stack), prod (one line, correlation id) | `[x]`  | Snapshot-tested                              |
| `ERR-006` | HTTP/job/CLI mappers registered per boundary                     | `[x]`  | Each mapper has a table test                 |

---

## `tsir.js` project config

Task ids `CFG-101`…`CFG-120` live in [`08-dx.md`](./08-dx.md) because they are delivered with the CLI (`tsir bootstrap`, `tsir doctor`).

---

## Gate P1 checklist

- [x] `tsir dev` boots a sample app with validated config and a resolved graph (`src/apps/examples/minimal`).
- [x] Missing provider / cycle / invalid env each produce distinct codes + hints (`CTN_NO_PROVIDER` / `CTN_CYCLE` / `CFG_INVALID`, all asserted).
- [x] Container and config coverage thresholds met — `make coverage`: container 91.16 %, config 99.57 % lines; core 95.42 %, validate 100 %.
      Enforced per package by `src/tools/coverage-gate.ts` (a single global threshold would hide a poorly covered package).
- [x] `make check` green with zero lint suppressions (typecheck + eslint + boundaries + prettier).
- [~] `tsir.js` presets resolve to a normalized `ResolvedProjectConfig` — the loader, schema validation and presets are **not** implemented yet (CFG-012…016); `tsir.js` is currently read for `app.name`/`app.entry` only.

### Status note (2026-10-27)

Everything above marked `[x]` is implemented and covered by `bun test` (124 tests, 7 files).
The `[~]` items are deliberate: they belong to `09-tsir-config.md` and land with the
`tsir bootstrap` work, not with the container/config core. `[ ]` items are untouched.

`CFG-005` (pattern-based redaction for unannotated keys) is partial: secrets are redacted
only when declared with `env.secret()`. A `FOO_PASSWORD` read through `env.string()` is
**not** masked — the schema is the registry of secrets, and guessing from names is the
kind of magic this framework rejects. If the pattern net is kept, it will be a _warning_
that a suspicious key is not declared secret, not silent masking.

Notes on the closing batch:

- `CFG-005` is `[x]`: `isSecretName` (`secrets.ts`) redacts keys whose last word is a secret word (`FOO_PASSWORD`, `API_TOKEN`). Tests in `secrets.test.ts` and `config.test.ts`.
- `CFG-008` is `[x]`: a required secret with no value fails in production, with its key named. Tests in `config.test.ts`. Secret fields cannot carry a default in this API, so no default can slip through.
- `CFG-012` is `[x]` for the ambiguity criterion: two config files in one directory fail with `CFG_AMBIGUOUS_CONFIG_FILE` (`find-config.test.ts`).
- `CFG-002` stays `[~]`: `Bun.env` is now banned outside tests and the framework packages (`eslint.config.mjs`, probe-tested). `Bun.env` had no reads outside config. 24 non-test files still read `process.env`; that ban needs those reads moved behind the config package first.
- `CFG-011` is `[x]`: the config-driven consumers take an injected clock. `runRotation` (`now`, vault) and `acquireMigrationLock` (`now`, migrate) were the two that read `Date.now()` directly; both now take `now` and are tested with a fixed clock. Random IDs already take `newId` in events and mail, or are injectable in link and rooms.
- `CFG-013` is `[x]`: precedence is override, then environment, then default (`config.test.ts`). A missing required reference is reported under its key. `{ fromEnv }` missing-variable messages are tested in storage, mail, and notify.
