# 03 — Core: Lifecycle, Container, Configuration, Errors

> `@tsir/core`, `@tsir/container`, `@tsir/config`. The smallest surface in the framework and the one everything else assumes is correct.

---

## 1. Responsibility split

| Package           | Owns                                                                                    | Explicitly does **not** own         |
| ----------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `@tsir/container` | Tokens, provider registration, lifetimes, scopes, diagnostics, disposal                 | Config loading, HTTP, global access |
| `@tsir/config`    | Env parsing, schema validation, `tsir.js` loading, presets, redaction                   | Reading `process.env` at call sites |
| `@tsir/core`      | Module system, registries, bootstrap/shutdown, error base, lifecycle hooks, app context | Service location, request handling  |

Dependency direction: `config → container`, `core → container`, `core → config`. No cycles.

---

## 2. Application lifecycle

```
loadConfig()  →  validateConfig()  →  buildContainer()  →  loadModules()
   → compileRegistries()  →  validateRegistries()  →  startAdapters()
   →  [ running ]  →  stopAdapters()  →  disposeContainer()
```

### 2.1 States

`created → configured → composed → ready → stopping → stopped`, plus `failed`. Every transition is recorded with a timestamp and the reason; `app.state` is a discriminated union so adapters cannot act on a partially built app.

```ts
export type AppState =
  | { readonly kind: 'configured'; readonly config: ResolvedConfig }
  | { readonly kind: 'composed'; readonly config: ResolvedConfig; readonly container: Container }
  | {
      readonly kind: 'ready';
      readonly config: ResolvedConfig;
      readonly container: Container;
      readonly registries: Registries;
    }
  | { readonly kind: 'stopping'; readonly reason: ShutdownReason }
  | { readonly kind: 'stopped'; readonly reason: ShutdownReason }
  | { readonly kind: 'failed'; readonly error: TsirError };
```

### 2.2 Bootstrap contract

```ts
export interface BootstrapOptions {
  /** Absolute path to the app root (where tsir.js lives). */
  readonly root: string;
  /** Resolved at build time; production never scans. */
  readonly manifest: AppManifest;
  /** Explicit overrides for tests only. */
  readonly overrides?: readonly ProviderOverride[];
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export async function bootstrap(options: BootstrapOptions): Promise<App>;
```

`AppManifest` is **generated** (`tsir build`) and contains module names, provider descriptors, compiled route table, listener/job tables, and migration discovery results. This is the mechanism that makes "no reflection in production" real: `bootstrap` consumes data, never class metadata.

### 2.3 Shutdown

| Property        | Value                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Triggers        | `SIGINT`, `SIGTERM`, adapter-initiated (Lambda `SIGSTOP`-less freeze is handled by unit adapters, not by signal)         |
| Order           | Stop accepting work → drain in-flight (bounded) → flush queue/telemetry → dispose container (reverse registration order) |
| Default timeout | 10 000 ms, configurable per unit via `lifecycle.shutdownTimeoutMs`                                                       |
| On timeout      | Log remaining disposables by name, force exit code `1`                                                                   |
| Idempotency     | Repeated shutdown calls return the same promise                                                                          |

Disposal registry: every package that acquires a resource registers a `Disposable` (`{ name, dispose(): Promise<void> }`). Tests assert that the registry is empty after shutdown — no leaked timers, sockets, or pool clients.

---

## 3. Container

### 3.1 Public surface

```ts
// token.ts — the only sanctioned token constructors
export const token: <T>(description: string) => Token<T>; // branded unique symbol
export const contract: <T>(description: string) => ContractToken<T>; // for interfaces

// provider.ts
export type Lifetime = 'singleton' | 'transient' | 'scoped';

export interface ClassProvider<T> {
  readonly kind: 'class';
  readonly token: Token<T>;
  readonly use: Class<T>;
  readonly lifetime: Lifetime;
  readonly inject: readonly Token<unknown>[]; // explicit; never inferred from metadata
}
export interface FactoryProvider<T> {
  readonly kind: 'factory';
  readonly token: Token<T>;
  readonly use: (deps: readonly unknown[], scope: Scope) => T | Promise<T>;
  readonly inject: readonly Token<unknown>[];
  readonly lifetime: Lifetime;
}
export interface ValueProvider<T> {
  readonly kind: 'value';
  readonly token: Token<T>;
  readonly use: T;
}
```

Constructor injection happens through `inject` arrays that mirror constructor parameters **positionally and by count**. This is deliberate: `emitDecoratorMetadata` is not used, and DI must not depend on reflected parameter types ([ADR-0001](../decisions/0001-decorator-model.md)). A type-level test asserts `inject.length === ConstructorParameters<typeof use>['length']` where the class is concrete.

### 3.2 Resolution rules

1. Resolution only happens at **defined boundaries**: bootstrap, request scope creation, job execution, CLI command, scheduled task.
2. `container.resolve()` is `internal` in the type system — app code cannot import it. Boundary helpers return a typed facade.
3. Missing provider → `TsirError` `CTN_NO_PROVIDER` listing the token description, the requesting provider chain, and the file where the chain originated (from the manifest).
4. Circular dependency → `CTN_CYCLE` with the full cycle path (`A → B → C → A`).
5. Ambiguous registration (same token twice without `{ override: true }`) → `CTN_DUPLICATE` at composition time, not at first resolution.
6. `transient` inside `singleton` is allowed but logged at debug after 100 instances (leak heuristic).

### 3.3 Scopes

`Scope` is created per request/job and carries `{ id, kind, signal, container }`. `scoped` providers are cached per scope and disposed when the scope ends. Scopes never outlive the unit of work; a `scoped` provider resolved outside a scope throws `CTN_NO_SCOPE`.

### 3.4 Test overrides

```ts
const app = await bootstrap({
  ...base,
  overrides: [{ token: UserRepositoryToken, use: new FakeUserRepository() }],
});
```

Overrides are applied before singleton instantiation and cannot target tokens that do not exist (typo protection: `CTN_OVERRIDE_UNKNOWN`).

### 3.5 Options for advanced composition

```ts
export interface ContainerOptions {
  readonly allowTransientInSingleton?: boolean; // default true, logs
  readonly maxResolutionDepth?: number; // default 32
  readonly revealChain?: boolean; // include provider chain in errors, default true
}
```

---

## 4. Configuration

### 4.1 Three layers, one result

```
process.env / Bun.env  ──┐
tsir.js (presets)      ──┼──►  createConfig(schema, sources)  ──►  ResolvedConfig (typed, frozen)
explicit overrides     ──┘
```

Precedence: **explicit overrides > env > `tsir.js` > schema defaults**. Env wins over `tsir.js` for values an operator must be able to change at deploy time without editing code (marked `overridable: true` in the schema; attempting to override a non-overridable value logs a warning and is rejected in `strictEnv` mode).

### 4.2 Schema declaration

```ts
import { defineConfig } from '@tsir/config';
import { z } from 'zod';

export const schema = defineConfig({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_KEY_NOW: z.string().min(1).secret(), // .secret() marks redaction
  DATABASE_URL: z.url().secret(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export type AppConfig = InferConfig<typeof schema>;
```

Rules:

- All values arrive as strings; coercion is **explicit** in the schema (`z.coerce`), never implicit in the loader.
- `.secret()` values are redacted in errors, logs, `toJSON()`, and `inspect` output.
- Validation errors are collected **all at once**, not fail-fast, so a misconfigured deploy reports every problem in one boot.
- `AppConfig` is `Readonly<DeepReadonly<…>>` and injected — app code never touches `Bun.env` (lint rule bans it outside `@tsir/config`).

### 4.3 Boot failure output

```
✗ Configuration invalid (CFG_INVALID)
  HTTP_PORT      expected int 1..65535, got "eighty"          .env.example:12
  DATABASE_URL   required                                      tsir.js:34 (preset "production")
  APP_KEY_NOW    must decode to 32 bytes (base64url)           env
  ↳ fix the above and restart; no partial boot is attempted.
```

### 4.4 `tsir.js`

Specified fully in [`09-tsir-config.md`](../operations/09-tsir-config.md). From core's perspective, `tsir.js` contributes: preset names, module list, unit topology, and non-secret defaults. It is loaded by `@tsir/config`'s project loader and must not contain secrets.

---

## 5. Error model

### 5.1 Shape

```ts
export interface TsirErrorShape {
  readonly code: string; // stable, append-only, SCREAMING_SNAKE
  readonly kind:
    | 'config'
    | 'container'
    | 'http'
    | 'database'
    | 'vault'
    | 'link'
    | 'deploy'
    | 'capability'
    | 'internal';
  readonly message: string; // safe to log; never contains secrets
  readonly hint?: string; // remediation guidance
  readonly cause?: unknown; // preserved, never serialized to clients
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}
export class TsirError extends Error {
  /* … */
}
```

### 5.2 Rules

- Framework code throws only `TsirError` subclasses. `throw new Error()` is banned by lint inside `src/framework/*`.
- Codes are declared in a central `error-codes.ts` per package; a docs test asserts every code has a documentation entry.
- `cause` chains are preserved for debugging but **stripped** before HTTP serialization.
- Internal errors never leak stack traces to clients unless `APP_ENV=development` and `http.exposeDebug=true`.

### 5.3 Boundaries

| Boundary       | Behavior                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| Bootstrap      | Fail fast, print formatted report, exit `1`                              |
| HTTP request   | Map to problem response via `@tsir/http` mapper; log with correlation id |
| Job            | Mark failed, apply retry policy, record in DLQ after exhaustion          |
| CLI            | Print human-readable message + hint, exit non-zero                       |
| Worker isolate | Fail the request/event; never crash the isolate silently                 |

---

## 6. Public surface

```ts
export { bootstrap } from './bootstrap';
export { defineModule } from './module';
export { token, contract } from '@tsir/container';
export { TsirError } from './errors';
export type { App, AppState, AppManifest, BootstrapOptions } from './types';
```

No `container` export, no `get<T>()`, no `app.resolve()`. Anything that needs a dependency receives it in a constructor from the composition root.

---

## 7. Failure modes

| Code                   | Cause                               | Behavior                  | Remediation hint printed                      |
| ---------------------- | ----------------------------------- | ------------------------- | --------------------------------------------- |
| `CTN_NO_PROVIDER`      | Token not registered                | Boot fails                | "register in module X; imported by Y"         |
| `CTN_CYCLE`            | A→B→A                               | Boot fails with path      | "break the cycle with a factory or an event"  |
| `CTN_DUPLICATE`        | Token registered twice              | Composition fails         | "use `override: true` in test overrides only" |
| `CTN_NO_SCOPE`         | `scoped` resolved at boot           | Boot fails                | "move resolution into the request handler"    |
| `CTN_DISPOSED`         | Resolve after shutdown              | Throws                    | "app already stopped"                         |
| `CFG_INVALID`          | Schema mismatch                     | Boot fails, all issues    | Points at source + line                       |
| `CFG_MISSING_SECRET`   | `.secret()` unset in production     | Boot fails                | Shows env var name only                       |
| `CFG_UNKNOWN_KEY`      | Unknown env var with prefix `TSIR_` | Warning (error in strict) | Lists known keys                              |
| `APP_MANIFEST_STALE`   | Manifest built from older source    | Boot fails                | "run `tsir build`"                            |
| `APP_SHUTDOWN_TIMEOUT` | Disposals exceeded budget           | Logs remaining, exits 1   | Names the disposables                         |

---

## 8. Security considerations

- Config redaction is default-deny for anything marked `.secret()`; the loader also redacts values whose key matches `/(SECRET|KEY|TOKEN|PASSWORD|DSN|URL)/` **unless** explicitly marked `.redactable()` — a defense-in-depth net for forgotten annotations.
- Error serialization strips `cause` and `stack` outside dev; correlation ids are logged instead.
- `APP_KEY_NOW`/`APP_KEY_NEXT` are validated for length and encoding at boot, never printed, and never included in the manifest.
- The container has no global instance, so there is nothing for a compromised dependency to reach through a well-known symbol.

---

## 9. Lifecycle & cleanup

- `dispose()` runs in reverse registration order with a per-disposable timeout (default 5 s, sum bounded by § 2.3).
- Timers created by core (shutdown watchdog) are `unref`'d where the runtime supports it.
- `bootstrap` accepts an `AbortSignal`; aborting during composition disposes whatever was built and throws `APP_BOOTSTRAPPED_ABORTED`.

---

## 10. Open questions

| #   | Question                                                                                                                                                                   | Blocks  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Q10 | Positional `inject` arrays are safe but noisy. Do we add a typed `ProviderBuilder` DSL (`defineProvider(X).inject(a, b)`) to reduce drift?                                 | Phase 1 |
| Q11 | Should `scoped` providers exist before Phase 2 (HTTP) has a scope to bind to? If not, container ships with `singleton`/`transient` only, and `scoped` is added in Phase 2. | Phase 1 |
| Q12 | Is a `@Inject()` parameter decorator worth the legacy-decorator dependency? (Current answer: no — ADR-0001.)                                                               | —       |

---

## 11. Task index

[`tasks/02-core.md`](../tasks/02-core.md) — `CTN-001` … `CTN-014`, `CFG-001` … `CFG-016`, `APP-001` … `APP-012`, `ERR-001` … `ERR-006`.
