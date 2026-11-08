# Architectural Decision Records

One file per decision. Format: **Status / Context / Decision / Consequences / Alternatives**.

| ADR                                                      | Title                                                                               | Status   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| [`0001`](./0001-decorator-model.md)                      | Standard ECMAScript decorators; binder metadata instead of parameter decorators     | Accepted |
| [`0002`](./0002-web-standard-http.md)                    | Web-standard `Request`/`Response` HTTP core with runtime adapters                   | Accepted |
| [`0003`](./0003-validation-library.md)                   | Standard Schema interface, Zod 4 as the default implementation                      | Accepted |
| [`0004`](./0004-link-package-shape.md)                   | One `@tsir/link` package with per-protocol entrypoints                              | Accepted |
| [`0005`](./0005-deploy-topology-default.md)              | Deploy topology defaults to `separate` units                                        | Accepted |
| [`0006`](./0006-tsir-js-config.md)                       | `tsir.js` as canonical, governed project configuration                              | Accepted |
| [`0007`](./0007-migrations-over-drizzle.md)              | Drizzle's migration journal stays authoritative                                     | Accepted |
| [`0008`](./0008-vault-key-state.md)                      | Key ids in envelopes; keyring manifest carries state                                | Accepted |
| [`0009`](./0009-postgres-transport.md)                   | One Postgres client (`postgres.js`), supplied by the app; target pool ceilings      | Accepted |
| [`0010`](./0010-validate-is-a-thin-wrapper.md)           | `@tsir/validate` is a thin interoperability layer, not a re-export                  | Accepted |
| [`0011`](./0011-src-and-dist-layout.md)                  | Authored code in `src/`, generated tree in gitignored `dist/`                       | Accepted |
| [`0012`](./0012-dependency-policy.md)                    | Dependencies must be tree-shakeable, established, and few                           | Accepted |
| [`0013`](./0013-zod-mini.md)                             | `zod/mini` as a first-class entry; `@tsir/config` built on it                       | Accepted |
| [`0014`](./0014-release-artifacts.md)                    | Every release ships the `dist/` tree _and_ per-package tarballs                     | Accepted |
| [`0015`](./0015-capability-drivers.md)                   | Capabilities are drivers behind one contract; closed set, no plugin registry        | Accepted |
| [`0016`](./0016-cloudflare-first-and-d1.md)              | Workers + D1 default; Postgres selectable; local dev follows the target             | Accepted |
| [`0017`](./0017-error-and-log-sinks.md)                  | One error/log record, formatter + driver adapters, Cloudflare-first delivery        | Accepted |
| [`0018`](./0018-http-layer.md)                           | Own the router and pipeline; interop only at the fetch boundary                     | Accepted |
| [`0019`](./0019-multi-connection.md)                     | Named connections for database, cache and queue; selected per call                  | Accepted |
| [`0020`](./0020-mysql-engine.md)                         | MySQL/MariaDB as a third engine; transport-scoped capabilities, implicit DDL commit | Accepted |
| [`0021`](./0021-next-key-writes.md)                      | `APP_KEY_NEXT` is the writing key; version-style key ids                            | Accepted |
| [`0022`](./0022-subpath-dependency-scope.md)             | A dependency may be scoped to a subpath entrypoint, proven by the import graph      | Accepted |
| [`0023`](./0023-soap-xml-subset.md)                      | SOAP parses XML with a bounded reader we own, not a general parser                  | Accepted |
| [`0024`](./0024-wsdl-compiled-at-build-time.md)          | A WSDL is compiled at build time; the module is committed and `--check`-gated       | Accepted |
| [`0025`](./0025-rooms-are-durable-object-shaped.md)      | Rooms model the Durable Object API's shape; the binding stays in deploy             | Accepted |
| [`0026`](./0026-deploy-graph-is-an-artefact.md)          | The deploy shape is a committed artefact: resolved, validated, diffed               | Accepted |
| [`0027`](./0027-capability-drivers.md)                   | Capability drivers: app-supplied clients, subpaths, per-store registries (Q36–Q38)  | Accepted |
| [`0028`](./0028-docs-site-renderer.md)                   | The docs site is rendered from Markdown with `marked`, a build-time dependency      | Accepted |
| [`0029`](./0029-frontpage-daisyui.md)                    | Compiled DaisyUI Nord/Abyss for the static public site                              | Accepted |
| [`0030`](./0030-hybrid-cloud-and-workload-substrates.md) | Five deployment profiles over seven runtime seams; hybrid is first-class            | Accepted |
| [`0031`](./0031-terminal-ui.md)                          | One shared terminal UI layer; OpenTUI behind it, Bubble Tea's shape as the model    | Accepted |

## Lifecycle

`Proposed` → `Accepted` (maintainer) or `Rejected` (kept for history). `Superseded by NNNN` when replaced. Never deleted.

## When an ADR is required

- A new runtime dependency.
- A public API that will be hard to change (naming, shape, semantics).
- A boundary decision between packages.
- Anything in the "Explicitly excluded" list that we are considering.
- Security-relevant defaults.
