# Tasks — Modularity

> Module ownership, boundaries that are enforced, and the developer experience that
> makes the boundaries the cheapest path rather than the correct one.
> **Plan:** [`../16-modularity.md`](../architecture/16-modularity.md)

---

## Module structure

| ID        | Title                                                     | Status | Depends | Acceptance criteria (summary)                                                |
| --------- | --------------------------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| `MOD-001` | Modular monolith vocabulary in the plans                  | `[x]`  | —       | `16-modularity.md` defines owner, surface, seam; `00-foundation.md` links it |
| `MOD-002` | Module-owned route registries (`routeModule`)             | `[x]`  | RTR-003 | Two modules in one process do not share a table; the CLI sees both           |
| `MOD-003` | `check-modules`: deep imports and self-imports rejected   | `[x]`  | MOD-002 | A module importing another's internals fails `make check`                    |
| `MOD-004` | Registry reset assertion in `@tsir/testing`               | `[x]`  | MOD-002 | A disposed app leaves no controllers behind; parallel suites cannot bleed    |
| `MOD-005` | `tsir make:module` scaffolds registry + controller + test | `[x]`  | MOD-002 | Generated module boots and appears in `route:list`                           |
| `MOD-006` | `createTestApp(app, { only: ['billing'] })`               | `[x]`  | MOD-002 | A module boots alone; its dependencies are explicit                          |
| `MOD-007` | Reference modular app (http example split into modules)   | `[x]`  | MOD-002 | Two modules, one with its own deploy `unit`, without touching the runtime    |
| `MOD-008` | Module graph in `tsir doctor` and boot diagnostics        | `[ ]`  | MOD-003 | `tsir doctor` prints modules, providers and required capabilities            |

## What each closed row produced

So the next reader does not have to reconstruct it from the diff:

| Task      | Evidence                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `MOD-002` | `src/framework/router/src/module.ts`; `route:list`/`route:compile` read `collectRouteEntries()`; module `unit` applied centrally  |
| `MOD-003` | `src/tools/check-modules.ts` + `make modules` inside `make check`; 12 tests over the pure rule function                           |
| `MOD-004` | `createTestApp` snapshots controllers before boot; `dispose()` throws `TEST_ROUTE_LEAK` naming the late ones                      |
| `MOD-006` | `createTestApp(app, { only })` filters what the app declares; `harness.routes('users')` returns one module's table                |
| `MOD-007` | `src/apps/examples/http/src/modules/{users,media}` — `media` carries `unit: 'media'`, visible in `route:list` and `routes.gen.ts` |

Notes:

- `MOD-005` is `[x]`: `make:module` writes the house layout (`routes.ts` with a
  `RouteRegistry` and `routeModule`, `<name>.controller.ts`, `index.ts`, and
  `<name>.test.ts`). Evidence: generator tests (11 pass), and a generated module
  was booted with `createTestApp` in the example app and its test passed.
- `MOD-008` is deferred: `tsir doctor` exists, but printing the module graph is
  only worth doing once `MOD-005` makes modules cheap to create.
- `removeRouteModule(module)` replaced a "reset everything" helper during
  implementation. Test files share one process, so a global reset drops modules
  another test file imported — and the failure mode is silent until a later suite
  reads an empty registry.
