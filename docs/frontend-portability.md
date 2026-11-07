# Frontend Portability Strategy

Tsir's `@tsir/*` packages are backend-first, but the admin app proves that the
framework also needs a frontend story. The goal: **every UI concern that more
than one app needs lives in a `@tsir/*` package and ships adapters for
React, Svelte 5, and Vue.** The admin app then becomes a thin consumer — it
composes framework components rather than reimplementing them.

## Principles

1. **Framework-agnostic core.** A `@tsir/ui` package exports component
   _specs_ (props, events, slots) as plain TypeScript interfaces — no JSX, no
   runes, no `<template>`. The core has zero framework dependencies.

2. **Per-framework adapters.** Subpath exports provide the runtime:

   ```
   @tsir/ui           → types + framework-agnostic logic
   @tsir/ui/react     → React components (JSX)
   @tsir/ui/svelte    → Svelte 5 components (runes)
   @tsir/ui/vue       → Vue components (SFC)
   ```

3. **Admin is a consumer, not a library.** Admin Svelte pages import from
   `@tsir/ui/svelte`. If an admin component is reused by a second app, it
   graduates into `@tsir/ui` and the admin re-imports it.

4. **Server components stay in the framework.** Data-fetching, guards, and
   state derivation live in `@tsir/*` server packages (e.g. `@tsir/telemetry`
   for request/queue inspection). The UI package only renders.

## Progress

- **`@tsir/telemetry` (done).** Admin's `request-logger.ts` and
  `queue-monitor.ts` are now 4-line thin wrappers around `createRequestLogger()`
  and `createQueueMonitor()` from `@tsir/telemetry`. The `requestLogs`,
  `queueJobs`, and `queueDead` schemas are imported from the framework package
  rather than defined locally in `modules/shared/schema.ts`. This is the first
  concrete example of the "admin as consumer" pattern — any Tsir app can now
  drop in Telescope/Horizon-style telemetry with one bootstrap call.

## Target frontends (priority order)

| Rank | Framework    | Rationale                                                           |
| ---- | ------------ | ------------------------------------------------------------------- |
| 1    | **Svelte 5** | Admin app is Svelte; runes map cleanly to framework-agnostic state. |
| 2    | **React**    | Largest ecosystem; hooks (`useSyncExternalStore`) bridge the core.  |
| 3    | **Vue 3**    | Composition API + `<script setup>`; lower priority until demand.    |

## What moves out of admin into `@tsir/*`

| Currently in admin                        | Promoted to       | Reason                                 |
| ----------------------------------------- | ----------------- | -------------------------------------- |
| `request-logger.ts` + `queue-monitor.ts`  | `@tsir/telemetry` | Telescope/Horizon logic any app wants. |
| `Requests.svelte`, `Queues.svelte` tables | `@tsir/ui/svelte` | Reusable telemetry views.              |
| `Dashboard.svelte` metric cards           | `@tsir/ui/svelte` | Metric card is a primitive.            |
| Login/Setup forms (eventually)            | `@tsir/ui/svelte` | Auth UI is cross-app.                  |

## Not in scope

- No SSR framework lock-in. `@tsir/ui` produces client components; the host
  app decides how to hydrate.
- No design system enforcement. Styling is CSS-variable based so each app can
  theme.
