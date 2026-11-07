# 16 — Modularity: a modular monolith, with extraction as a config change

> The promise this document makes: **one deployable to start, every module
> extractable later, and neither of those facts changing the application code that
> is not being extracted.** Everything below exists to make that true rather than
> aspirational.

---

## 1. What "modular monolith" means here

Most frameworks offer two shapes and make you choose at the start:

| Shape                | Development experience                                                      | Failure mode                                                       |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Monolith             | one repo, one process, refactor freely                                      | becomes a ball of mud; extraction is a rewrite                     |
| Microservices        | independent deploys, clear ownership                                        | network boundaries, distributed transactions, N repos for 3 people |
| **Modular monolith** | one process and one deploy, **explicit module boundaries enforced in code** | the boundaries are only as real as the tooling that checks them    |

Tsir targets the third, because it is the only one that matches a **small team
with zero budget**: you cannot afford distributed systems before product-market
fit, and you cannot afford to rewrite on the day you need one.

A module is the unit of **ownership**, not the unit of deployment. Deployment is
a separate decision (`08-deploy.md`, ADR-0005), taken per module and changed
without touching module code.

### What a module owns

| Owns                      | How it is expressed                                   |
| ------------------------- | ----------------------------------------------------- |
| Its routes                | its own `RouteRegistry` → `routeModule()` (§ 4)       |
| Its providers             | `providers: [...]` in the module definition           |
| Its lifecycle             | `onStart` / `onReady` / `onStop`                      |
| Its capability needs      | `requires: [{ interactiveTx: true }]` (`DB-007`)      |
| Its tables and migrations | a table prefix + its own migration folder (`MIG-001`) |
| Its public surface        | one `index.ts` per module — and nothing else          |

A module **does not** own: the process lifecycle, configuration loading, the
route table assembly, or another module's data.

---

## 2. The three rules

1. **A module is reachable only through its public surface.** `modules/users/index.ts`
   exports what other modules may use; anything else under `modules/users/` is
   private. Deep imports are a build error (§ 5), because a boundary that is only a
   naming convention is a boundary that lasts until the first deadline.
2. **Cross-module calls are typed contracts, not class imports.** Two modules talk
   through a `contract()` token resolved from the container, or through a domain
   event. Importing `UsersService`'s implementation couples you to its constructor,
   its lifetime and its test double.
3. **Extraction is a topology change.** Moving a module into its own deploy unit is
   `tsir.js` + a deploy entry, not a refactor: its routes already declare a unit
   (`RTR-011`), its providers are already registered in isolation, and its contract
   is already an interface rather than a class.

---

## 3. Why this is a DX decision, not an architecture diagram

Segregation of concerns usually costs developer experience: the "clean" version
means ten files and a container lookup to add one endpoint. Tsir's stance is that
the modular structure must be the **fastest** path, not the most correct one:

| Task                     | Target    | Mechanism                                                    |
| ------------------------ | --------- | ------------------------------------------------------------ |
| Add a module             | 1 command | `tsir make:module billing` — folder, module, registry, test  |
| Add an endpoint          | 1 method  | decorator on a controller the module already owns            |
| See who owns a route     | 1 command | `tsir route:list` prints the module and the unit (`RTR-011`) |
| Test a module alone      | 1 call    | `createTestApp(app, { only: ['billing'] })`                  |
| Find out why boot failed | 1 line    | every hook failure names the module (`APP_HOOK_FAILED`)      |
| Extract a module         | 1 config  | `tsir.js` unit topology; code unchanged                      |

The rule that follows from this table: **if a boundary cannot be crossed with one
line, the boundary will be crossed by copying code instead.** Ergonomics is
therefore part of the design, not decoration.

---

## 4. Module-owned routes (`MOD-002`)

Today a controller self-registers into a process-global registry at import time
(`@tsir/router`'s `routeRegistry`). That is fine for one app in one process and
wrong for a modular one:

- two modules cannot be assembled, tested or reused independently;
- the route table cannot be attributed to a module, so "extract this module" has
  no mechanical meaning;
- any app in the same process (tests, the CLI, a second app) shares one table.

The fix keeps declaration-time registration (it is what makes decorators work
without reflection) and removes the _single_ table:

```ts
// modules/users/routes.ts
export const registry = new RouteRegistry();
export const users = routeModule({ name: 'users', registry, unit: 'http' });

// modules/users/index.ts — the public surface, and the only importable path
export { users } from './routes.ts';
```

- `routeModule()` returns `{ module, registry, unit?, routes() }`: a normal
  `ModuleDefinition` plus the compiled, memoised table for **that** module.
- The module's `unit` is applied to every controller that did not declare one.
  That happens in `collectRouteEntries()` too, not only in `routes()`, so
  `route:list`, `route:compile` and the runtime all attribute a route to the same
  unit — one place decides, every reader agrees.
- `collectRouteEntries()` returns every entry from the global default registry
  **and** from every declared module, de-duplicated by controller class, so the
  CLI (`route:list`, `route:compile`) keeps working with no app-specific code.
  It takes an optional `scope` for callers that know which modules they mean
  (`@tsir/testing` passes the app's own modules, so two suites that both declare
  a `users` module cannot collide in one process).
- The global registry stays for the zero-ceremony case (one module, one app) and
  is documented as _app-global_, not _module-local_.

Registries are **declaration-time** state: written while modules are imported,
read once at boot, then never mutated. That is the only global state the
framework allows. `MOD-004` turns that sentence into an assertion: `createTestApp`
snapshots the registered controllers before boot and fails `dispose()` with
`TEST_ROUTE_LEAK` if boot registered another one.

Cleanup in tests is **per module** (`removeRouteModule(module)`), never
"clear all". A test file shares one process with every other test file, so a
global reset silently disarms whichever suite imported a real application first —
which is exactly what happened the first time this was implemented.

---

## 5. Enforcement

Boundaries that are not checked are suggestions. Four checks, all in `make check`:

| Check                   | What it rejects                                                        | Where  |
| ----------------------- | ---------------------------------------------------------------------- | ------ |
| `check-boundaries`      | a framework package importing one it is not allowed to (`02-monorepo`) | exists |
| `check-modules`         | an application module deep-importing another module's internals        | new    |
| `check-frontpage`       | a marketing claim with no implementation behind it                     | exists |
| `route:compile --check` | a stale generated table after a route change                           | exists |

`check-modules` also rejects two things that are modularity bugs rather than
style: a module importing **itself** through its `index.ts` (a cycle the build
resolves but the reader cannot), and a `shared/` folder that turns into an
unowned second application — shared code must live in a named module with a
public surface.

Scope and exemptions, stated so the check is not a mystery:

- it walks `src/apps/**/src/modules/` and `src/apps/**/src/shared/`; an app with
  no `modules/` directory is skipped, so adopting modules is opt-in per app;
- `*.gen.ts` is exempt — `routes.gen.ts` imports every controller on purpose;
- `*.test.ts` is exempt — a test may reach into its own module's internals;
- only relative specifiers are judged; bare specifiers are `check-boundaries`'
  job (and `@tsir/*` deep imports are already rejected there).

---

## 6. Failure modes

| Failure                         | Why it happens                            | The guard                                                                  |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| The ball of mud returns         | nothing checks cross-module imports       | `check-modules` (§ 5)                                                      |
| Circular module dependency      | two modules import each other's contracts | import graph check; contracts are tokens, resolved lazily                  |
| Shared mutable global           | a cache or registry module-level `let`    | review rule: module state is a provider, never a module-level binding      |
| Extraction turns into a rewrite | direct class imports instead of contracts | rule 2 (§ 2) + `createTestApp({ only })` proves a module boots alone       |
| Config bleed between modules    | one giant config spec for the whole app   | config slices per module (`CFG-` tasks); a module reads only its own slice |
| "Temporary" cross-module query  | the other module's tables are right there | tables carry a module prefix; a foreign prefix is a review rejection       |
| Dev-experience regression       | each boundary adds a ceremony step        | the § 3 table is the acceptance test for every new rule                    |

---

## 7. What the code does today (audit)

Verified against the tree at `0.0.0` (Phase 3):

| Area                      | State                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Module type               | ✅ `defineModule` — frozen data: providers, `requires`, three lifecycle hooks            |
| Modules in the app        | ✅ `defineApp({ modules })`, factory form for typed config; duplicate names rejected     |
| Module failure reporting  | ✅ hook failures become `APP_HOOK_FAILED` naming the module                              |
| Module-owned **routes**   | ✅ `routeModule()` + per-module `RouteRegistry`; `collectRouteEntries()` unions them     |
| Per-module test isolation | ✅ `createTestApp({ only })`, `harness.routes('users')`, `TEST_ROUTE_LEAK` assertion     |
| Cross-module enforcement  | ✅ `make modules` — deep imports, self-imports, `shared/` importing a module             |
| Module scaffolding        | ⚠️ `make:module` writes a bare `defineModule` with no registry, route or test            |
| Module → deploy unit      | ⚠️ module-level `unit` is applied to routes; no deploy planner consumes it yet (Phase 6) |

The audit rows that were ⛔ are closed by `MOD-002`, `MOD-003`, `MOD-004` and
`MOD-006`. What remains is scaffolding (`MOD-005`) and consumption of the unit by
the deploy planner, which is Phase 6 work — the metadata is already uniform.

---

## 8. Security considerations

A module boundary is a **permission boundary** only in the sense that it constrains what code
can reach what — it is not an authorisation mechanism, and nothing here should be read as one.
The three security-relevant rules:

- **`check-modules` rejects deep imports across modules.** A module that cannot import another
  module's internals cannot read its tables, its providers or its secrets by accident or by
  convenience. This is the same argument as the package DAG (§ 5), one level down.
- **A foreign table prefix is a review rejection, not a runtime check.** The guard is
  `check-modules` plus the naming rule; there is no database-level grant separating modules in
  one connection. Two modules sharing one Postgres role can read each other's rows — the
  boundary is a design convention enforced by review and tooling, and the honest mitigation for
  a real trust boundary is a separate connection (`ADR-0019`), not a module.
- **`createTestApp({ only })` is a security test as well as a convenience.** A module that boots
  with half the others absent is a module that does not silently depend on their providers,
  including the ones that hold credentials.

Authorisation itself lives in `@tsir/policy` and `@tsir/auth`; a module is not a security
boundary and must not be described as one.

---

## 9. Open questions

| #   | Question                                                                                                        | Decides         |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------- |
| Q41 | Should a module declare its **own** config slice, or read from the app's typed config by convention?            | Phase 5 (`CFG`) |
| Q42 | Do module tables get a prefix automatically (`billing_invoices`) or explicitly? Migrations drift without a rule | Phase 3 (`MIG`) |
| Q43 | Is a module allowed to expose more than one contract, or exactly one public surface per module?                 | review          |

## 10. Task index

See [`tasks/13-modularity.md`](../tasks/13-modularity.md). Order:

1. `MOD-001` — this document, and the vocabulary in `00-foundation.md`.
2. `MOD-002` — module-owned route registries + `collectRouteEntries()` (closes
   the biggest ⛔).
3. `MOD-003` — `check-modules`: deep imports and self-imports rejected in
   `make check`.
4. `MOD-004` — registry reset assertion in `@tsir/testing`.
5. `MOD-005` — `tsir make:module` scaffolds a module with a registry, a
   controller, a test and a `unit`.
6. `MOD-006` — `createTestApp(app, { only })`.
7. `MOD-007` — the reference modular app. **Decided during implementation:** the
   reference is the existing `src/apps/http`, split into `users` and
   `media` modules with module-owned units, rather than a seventh example app.
   A new example would have duplicated the HTTP surface to demonstrate a
   five-line difference; splitting the reference app proves the seam on the code
   people actually read, and keeps `make check`'s app count honest.
