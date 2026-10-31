# `src/apps/examples/`

Runnable example applications. **None exist yet** — each arrives with the phase whose features it demonstrates.

| Example         | Demonstrates                                                    | Phase | Packages it exercises                                       |
| --------------- | --------------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| `minimal/`      | core + http only: one controller, one route, one validated body | 2     | `@tsir/core`, `@tsir/http`, `@tsir/router`                  |
| `saas-api/`     | auth + policy + queue + events on Postgres                      | 7     | `@tsir/auth`, `@tsir/policy`, `@tsir/queue`, `@tsir/events` |
| `edge-service/` | Cloudflare Workers units, `@tsir/link` REST + gRPC              | 5–6   | `@tsir/deploy`, `@tsir/link`                                |

Rules for examples:

- They are **workspace members**, so `make typecheck` covers them and they cannot rot silently.
- They are runnable with `make dev` from their own directory and have an end-to-end test in CI.
- They never import from `@tsir/*/src/*` — only public entry points.
- Each one's `README.md` states which phase gate it validates.
