# 16 — Admin Frontend (SPA)

> `src/apps/admin.product.com/client` — the Svelte 5 + DaisyUI administration SPA that powers
> user management, RBAC, i18n, mail templates, request auditing, queue monitoring and feature
> flags. It is the reference frontend for a generated Tsir app's admin console.
>
> **Status (2026-11-08):** implemented — modernized shell (collapsible sidebar, top bar,
> breadcrumbs, theme toggle, user menu), `/users/:id` detail page, reusable component kit
> (DataTable, Toast, EmptyState, LoadingState, ErrorState, PageHeader, ConfirmDialog), and
> query-parameter-synced listing pages across all tables. Abyss (dark) / Silk (light) DaisyUI
> themes with localStorage persistence. Typecheck, build and all checks pass.
> Full E2E acceptance report: [`reviews/2026-11-08-admin-e2e-acceptance.md`](../reviews/2026-11-08-admin-e2e-acceptance.md).

---

## 1. Goals

| Goal                                                           | Non-goal                                   |
| -------------------------------------------------------------- | ------------------------------------------ |
| Polished, accessible SaaS-style admin console                  | Introduce a third-party router library     |
| Consistent theme system shared with the frontpage (Abyss/Silk) | Rewrite backend API contracts              |
| Reusable component kit for listing/CRUD patterns               | Add new features beyond existing endpoints |
| URL-stateful tables (search/filter/page survive refresh)       | Convert the frontpage to a SPA             |
| Detail pages for entity management (e.g. `/users/:id`)         | Publish to npm                             |

---

## 2. Constraints

1. **Svelte 5 runes.** Components use `$state`, `$derived`, `$effect`; shared reactive
   modules use `.svelte.ts` with the **container-object pattern** (never reassign an
   exported `$state`/`$derived`).
2. **Custom router only.** `lib/router.svelte.ts` wraps the History API with reactive
   `pathname`, `search`, `query` and `current` (matched route + params). No
   `svelte-spa-router`, `@sveltejs/kit` or other routing dependency.
3. **DaisyUI official themes only.** Abyss (dark) and Silk (light). No custom color
   palettes. Tailwind v4 (browser CDN build) + DaisyUI v5 (CDN) are loaded from
   `public/index.html`; no client bundling of CSS.
4. **No new runtime dependencies.** `svelte@5.57.3` is the only dev dependency of the
   client. esbuild (transitive, via Bun) bundles the compiled components.
5. **No `process.env` in client code.** The base path is injected by the server as
   `window.__TSIR_BASE_PATH__`; everything else uses relative paths.

---

## 3. Architecture

### Source layout

```
src/apps/admin.product.com/client/
├── src/
│   ├── App.svelte              route table, auth redirects, public vs Layout shell
│   ├── main.ts                 entry: bootstrap auth, mount #app
│   ├── components/             Layout, DataTable, Toast, PageHeader, ConfirmDialog,
│   │                            EmptyState, LoadingState, ErrorState
│   ├── lib/
│   │   ├── router.svelte.ts    History API router + query params + View Transitions
│   │   ├── auth.svelte.ts      session bootstrap, user state, logout
│   │   ├── theme.svelte.ts     theme container-object, setTheme/toggleTheme/isDark
│   │   ├── toast.svelte.ts     global toast queue (success/error/info)
│   │   └── api.ts              fetch wrapper with JSON + error handling
│   └── pages/                  Dashboard, Users, UserDetail, Roles, Permissions,
│                                Groups, I18n, EmailTemplates, Requests, Queues,
│                                FeatureFlags, Login, Setup, ForgotPassword, ResetPassword
└── build.ts                    compile Svelte → esbuild bundle → public/app.js
```

### Theme system

- `lib/theme.svelte.ts` exports `theme = $state({ value })`, `setTheme()`, `toggleTheme()`,
  `isDark()`. The active theme is written to `<html data-theme>`.
- `public/index.html` runs an inline pre-paint script that reads `localStorage.tsir-admin-theme`
  (abyss/silk) and falls back to `prefers-color-scheme`, preventing a flash of the wrong theme.
- Persistence key: `tsir-admin-theme`.

### Layout shell (`Layout.svelte`)

- **Sidebar:** 10 nav items with inline stroke SVG icons, labels, active-route highlight.
  Collapsible (icons-only); state persisted to `localStorage.tsir-admin-sidebar-collapsed`.
  Becomes a drawer below the `lg` breakpoint.
- **Top bar:** breadcrumbs derived from `router.pathname` + `router.current.path` (dynamic
  `:id` segments render as "Detail"), page title, theme toggle (sun/moon icon via
  `isDark()`), and a user avatar dropdown showing the signed-in email with a sign-out
  action.
- Mounts `<Toast />` globally so any page can push toasts via `toast.success(...)`.

### Routing

- `registerRoutes([...])` in `App.svelte` defines the route table (flat + dynamic).
- `router.current.params` holds `:id` etc. for detail pages.
- `router.query` is a reactive `URLSearchParams`; `setQuery(updater)` uses `replaceState`
  to keep the URL in sync without polluting history.
- Public routes (`/login`, `/setup`, `/forgot-password`, `/reset-password`) render outside
  the `Layout` shell; authenticated routes render inside it.

---

## 4. Reusable component kit

| Component       | Purpose                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `DataTable`     | Columns with optional `render(value, row): string` (HTML via `{@html}`), optional `actions` snippet, `onRowClick`, `onPageChange` pagination. |
| `Toast`         | Global toast container; `toast.success/error/info(msg)` push items that auto-dismiss after 4 s.                                               |
| `PageHeader`    | Title + optional `actions` snippet (passed as a `Snippet` prop).                                                                              |
| `ConfirmDialog` | DaisyUI modal; escape/backdrop cancel; `confirm`/`cancel` callbacks. Replaces native `confirm()`.                                             |
| `EmptyState`    | Centered icon + message for zero-row tables.                                                                                                  |
| `LoadingState`  | Spinner + message for pending fetches.                                                                                                        |
| `ErrorState`    | Error message + retry action.                                                                                                                 |

### Snippets pattern

This Svelte version (5.57.3) does not support `$props.snippets()`. Snippets are declared as
regular props typed with `Snippet` from `svelte`:

```ts
import type { Snippet } from 'svelte';
let { actions } = $props<{ actions?: Snippet<[Row]> }>();
```

---

## 5. Page patterns

### Listing pages (Users, Roles, Permissions, Groups, Requests, Queues)

- Fetch from the corresponding `/api/*` endpoint.
- **Query-param sync:** search, filters (method, status, state) and pagination are stored
  in `router.query` and read back on mount, so refresh/bookmark/share preserve the view.
- Rendered via `DataTable`; destructive actions use `ConfirmDialog`; success/failure uses
  `toast`.
- Row-level interaction (`onRowClick`) opens detail drawers or navigates.

### Detail page (`UserDetail.svelte`)

- Reads `router.current.params.id`, fetches `/api/users/:id`, `/api/roles`,
  `/api/users/:id/roles`.
- Edit form: email, display name, password (optional), super-admin toggle, role
  checkboxes. PATCHes on save; toasts on success/failure.

---

## 6. Build pipeline

`client/build.ts`:

1. Walks `src/` for `.svelte` and `.svelte.ts` files.
2. Compiles each with `svelte/compiler` (`compile` / `compileModule`).
3. Prepends a keep-imports shim so esbuild does not tree-shake components referenced only
   in templates; type-only imports (`import type ...` and inline `type Foo`) are skipped.
4. Bundles with esbuild into `public/app.js` (single file, source map).
5. Static assets (`index.html`, `favicon.svg`, `logo.svg`) are served as-is.

Run `bun client/build.ts` (or `bun run build:client` from the app).

---

## 7. Acceptance criteria

1. `bun x tsc --noEmit -p tsconfig.json` passes (strict settings including
   `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`,
   `verbatimModuleSyntax`).
2. `bun src/apps/admin.product.com/client/build.ts` produces `public/app.js`.
3. `bun run check` (typecheck, lint, boundaries, deps, license, links, surface, version,
   format) passes.
4. All 16 admin tests pass.
5. Manual verification: theme toggle persists, sidebar collapses, breadcrumbs reflect the
   route, user menu signs out, `/users/:id` loads and saves, DataTables reflect URL query
   params after refresh, ConfirmDialog replaces native confirm, toasts appear on actions.

---

## 8. Failure modes

The admin app is a normal Tsir application: every failure below is the framework's failure, reported
the framework's way, and the SPA's job is to render it rather than hide it.

| Failure                                   | Why it happens                                                          | How it is reported                                                      | What the caller can do                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `public/app.js` is missing                | the client build was not run before the server started                  | the SPA route serves `index.html` with no bundle — a blank page, no 500 | run `bun client/build.ts`; the server-side asset check names the path          |
| A stale bundle is served                  | `app.js` is built once and served from disk (`INF-016`)                 | no error — this is the dangerous case                                   | rebuild in the deploy step; the assets binding (`INF-016`) removes the class   |
| `401` on every admin route                | the session cookie is not `__Host-` in a non-HTTPS local origin         | `401` with an RFC 9457 problem document                                 | run over HTTPS or use the documented local cookie exception                    |
| `403` on a route a super-admin needs      | the route is missing `guards: ['session','superAdmin']`                 | `403` with `policy` in the problem body                                 | add the guard; the E2E acceptance review records the three that were missing   |
| `500` from a route that reads `principal` | `principal: true` was not declared on the route                         | `500` naming `principal` as undefined                                   | declare `principal: true` (review finding 2 in the E2E acceptance review)      |
| A list page loses its filters             | query params were kept in component state rather than `router.query`    | no error — the view resets on refresh                                   | the pattern in § 5 is the acceptance test for every listing page               |
| Dialect drift on a Postgres admin         | `ilike` and SQLite `1/0` booleans in application queries (`INF-011`)    | a driver error, or a silently wrong filter                              | `INF-011`; the pattern is to build the predicate from the connection's dialect |
| A request log row never appears           | `requestLogger.record` fired without `waitUntil` (`INF-006`, `INF-016`) | **not reported** — Workers cancels it after the response                | `INF-006`; until then, await the write on routes where it matters              |

## 9. Security considerations

- **The guard is the boundary, not the SPA.** Every `/api/*` admin route declares
  `guards: ['session', 'superAdmin']`; the Svelte client hides nothing it could not show, and
  hiding a button is never the control. The E2E acceptance review
  ([`../reviews/2026-11-08-admin-e2e-acceptance.md`](../reviews/2026-11-08-admin-e2e-acceptance.md))
  records that this was missing and is now enforced route by route.
- **`principal: true` is a correctness control.** A route that reads `principal` without declaring
  it produced a `500`; the same mistake in a route that reads a tenant id would be a cross-tenant
  read. The declaration is therefore a review checklist item, not a convenience.
- **`__Host-` cookies, hashed identifiers.** Sessions and API keys are `@tsir/auth`'s
  responsibility and are covered there; the admin app must not invent its own token handling, and
  the API client sends credentials only to same-origin paths.
- **Uploads are validated server-side.** Admin surfaces accept images and CSV; MIME is sniffed and
  route limits applied (`VLD-006`), and a filename from the client is never used as a storage key.
- **Asset serving is not authentication.** `public/` is served without a guard because a bundle is
  public by definition; anything that must not be public does not go in `public/`. The current
  runtime `node:fs` path (`INF-016`) additionally means a path-traversal bug would be ours rather
  than the platform's — the assets binding removes that class of bug.
- **What this does not defend against:** a super-admin account takeover (the blast radius is every
  route), a compromised dependency in the SPA bundle, or clickjacking against a misconfigured
  embed. Those belong to [`../operations/14-security.md`](../operations/14-security.md).

## 10. Open questions

| #   | Question                                                                                                           | Decides              |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Q66 | Should the admin SPA ship as a platform asset binding (`INF-016`) or as a separately deployed static site?         | `INF-016`, § 6       |
| Q67 | Is the admin app the place to prove the `[PLANNED]` `ctx.waitUntil` seam, or should a smaller app prove it first?  | `INF-006`, `INF-016` |
| Q68 | Do admin tables read from a read replica once `Q63` is answered, given the freshness trade-off on a management UI? | `Q63`, `INF-019`     |

## 11. Task index

- [`tasks/admin-followups.md`](../tasks/admin-followups.md) — `ADM-001`…`ADM-009`, the remaining
  edge-case verifications.
- [`tasks/16-infrastructure-hardening.md`](../tasks/16-infrastructure-hardening.md) — `INF-016`
  makes this app edge-native; `INF-006` supplies the `waitUntil` it needs; `INF-011` covers the
  dialect drift in its queries.
- [`reviews/2026-11-08-admin-e2e-acceptance.md`](../reviews/2026-11-08-admin-e2e-acceptance.md) —
  the acceptance run that found the three critical defects.
