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
