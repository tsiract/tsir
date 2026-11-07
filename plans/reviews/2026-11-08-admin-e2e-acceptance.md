# Admin App — End-to-End Acceptance Testing

> **Date:** 2026-11-08
> **App:** `src/apps/admin.product.com`
> **Scope:** Full E2E QA — setup, auth lifecycle, authorization, all admin
> interfaces, UI (themes/sidebar/routing/404), database integrity, security.
> **Result:** All critical issues found and fixed. 8/8 e2e tests, 16/16 unit
> tests pass. Typecheck clean.

---

## 1. Summary

The admin app was exercised end-to-end against a fresh SQLite database. Three
critical defects were discovered and fixed:

| #   | Severity   | Issue                                                                                 | Fix                                                                                       |
| --- | ---------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | **HIGH**   | No super-admin guard — any authenticated user could access all admin endpoints        | Added `superAdmin` guard; applied `guards: ['session', 'superAdmin']` to all admin routes |
| 2   | **HIGH**   | `principal` undefined on routes that use it but don't declare `principal: true` → 500 | Added `principal: true` to all affected routes                                            |
| 3   | **MEDIUM** | `isSuperAdmin` returned SQLite integer (1/0) instead of boolean                       | Coerced with `=== 1` in auth service and `me` endpoint                                    |
| 4   | **MEDIUM** | Logout handler destructured `request` (undefined) → 500                               | Changed to `ctx.request` per `RouteArgs` contract                                         |
| 5   | **LOW**    | Frontend `class:w-64` shorthand on `<aside>` threw `ReferenceError: w is not defined` | Moved `w-64` to static `class` string                                                     |
| 6   | **MEDIUM** | User search used PostgreSQL-only `ilike` → 500 on SQLite                              | Changed to `like` (SQLite `LIKE` is already case-insensitive)                             |
| 7   | **HIGH**   | Feature flag toggle 500 — controller received `{ params }` object, not bare `name`    | Changed `toggle({ params })` signature, `decodeURIComponent(params.name)`                 |
| 8   | **HIGH**   | Auth race condition — `installed` set before `user` fetched → direct nav redirected   | Added `auth.bootstrapped` flag set in `finally`; App waits for `bootstrapped`             |
| 9   | **MEDIUM** | Feature toggle button stayed disabled — `Set<string>` mutations not Svelte 5 reactive | Changed `toggling` to `Record<string, boolean>`                                           |
| 10  | **LOW**    | Requests page "Invalid Date" — `createdAt` is ISO string, treated as number           | Changed to `new Date(v as string \| number)`                                              |
| 11  | **HIGH**   | Roles/Groups Edit buttons navigated to unregistered routes                            | Replaced route navigation with inline edit forms                                          |
| 12  | **LOW**    | Component styles silently dropped — `compile()` without `css: 'injected'`             | Pass `css: 'injected'` to `compile()` in `build.ts`                                       |

All fixes are verified by automated and manual tests.

---

## 2. Test Environment

- **Database:** Local SQLite (`.tsir/admin.db`), reset via `--reset-db`
- **Server:** `bun serve.ts --port 4173 --reset-db`
- **Migrations:** `0000_init`, `0001_request_logs`, `0002_queue_tables` — all apply cleanly
- **CAPTCHA:** Disabled in dev (`CAPTCHA_DISABLED=true`)
- **Tests:** Playwright (e2e), Bun test (unit), `tsc --noEmit` (typecheck)

---

## 3. Setup & Installation

| ID  | Scenario                                                                          | Expected                | Actual                  | Status |
| --- | --------------------------------------------------------------------------------- | ----------------------- | ----------------------- | ------ |
| S1  | Fresh DB: `GET /api/auth/setup` returns `installed: false`                        | `{installed: false}`    | `{installed:false}`     | ✅     |
| S2  | `POST /api/auth/setup` with valid email + password (≥8) creates first super-admin | 201 `{ok:true, userId}` | 201 with userId         | ✅     |
| S3  | After setup: `GET /api/auth/setup` returns `installed: true`                      | `{installed: true}`     | `{installed:true}`      | ✅     |
| S4  | Duplicate `POST /api/auth/setup` rejected                                         | 409 `already_installed` | 409 `already_installed` | ✅     |
| S5  | Setup with password < 8 chars rejected                                            | 422 validation error    | 422                     | ✅     |
| S6  | Setup with invalid email rejected                                                 | 422 validation error    | 422                     | ✅     |

---

## 4. Authentication Lifecycle

| ID  | Scenario                                      | Expected                                          | Actual               | Status |
| --- | --------------------------------------------- | ------------------------------------------------- | -------------------- | ------ |
| A1  | Login with valid credentials                  | 200 + session cookie                              | 200 `{ok:true}`      | ✅     |
| A2  | Login with wrong password                     | 401 (no user enumeration)                         | 401                  | ✅     |
| A3  | Login with non-existent email                 | 401 (same as wrong password)                      | 401                  | ✅     |
| A4  | `GET /api/auth/me` with valid session         | 200 + user object, `isSuperAdmin: true` (boolean) | `isSuperAdmin: true` | ✅     |
| A5  | `GET /api/auth/me` without session            | 401                                               | 401                  | ✅     |
| A6  | `POST /api/auth/logout` with valid session    | 200 + clears cookie                               | 200 `{ok:true}`      | ✅     |
| A7  | After logout, `GET /api/auth/me`              | 401                                               | 401                  | ✅     |
| A8  | Normal user `isSuperAdmin` is boolean `false` | `false`                                           | `false`              | ✅     |

---

## 5. Authorization (Super-Admin Enforcement)

The `superAdmin` guard chains after `session`. It reads `ctx.principal.data.isSuperAdmin`
and returns `null` (→ 401) when false. Applied to all admin endpoints.

| ID  | Scenario                                                             | Expected        | Actual | Status |
| --- | -------------------------------------------------------------------- | --------------- | ------ | ------ |
| Z1  | Normal user `GET /api/users`                                         | 401             | 401    | ✅     |
| Z2  | Normal user `POST /api/users` (create)                               | 401             | 401    | ✅     |
| Z3  | Normal user `GET /api/roles`                                         | 401             | 401    | ✅     |
| Z4  | Normal user `GET /api/permissions`                                   | 401             | 401    | ✅     |
| Z5  | Normal user `GET /api/groups`                                        | 401             | 401    | ✅     |
| Z6  | Normal user `GET /api/i18n/keys`                                     | 401             | 401    | ✅     |
| Z7  | Normal user `GET /api/email-templates`                               | 401             | 401    | ✅     |
| Z8  | Normal user `GET /api/requests`                                      | 401             | 401    | ✅     |
| Z9  | Normal user `GET /api/queues/counts`                                 | 401             | 401    | ✅     |
| Z10 | Normal user `GET /api/features`                                      | 401             | 401    | ✅     |
| Z11 | Super admin `GET /api/users`                                         | 200 + user list | 200    | ✅     |
| Z12 | Super admin `POST /api/users` (create)                               | 201             | 201    | ✅     |
| Z13 | Super admin `POST /api/roles` (create)                               | 201             | 201    | ✅     |
| Z14 | Super admin `POST /api/permissions` (create)                         | 201             | 201    | ✅     |
| Z15 | Unauthenticated `GET /api/users`                                     | 401             | 401    | ✅     |
| Z16 | Normal user `POST /api/auth/logout` still works (session-only route) | 200             | 200    | ✅     |

---

## 6. Admin Interfaces (Pages)

All 10 pages load without JS errors and render expected content:

| ID  | Page                | URL                | Expected                                                        | Actual            | Status |
| --- | ------------------- | ------------------ | --------------------------------------------------------------- | ----------------- | ------ |
| P1  | Dashboard           | `/`                | Welcome message, cards for Requests/Queues/Translations/Metrics | Renders all cards | ✅     |
| P2  | Users               | `/users`           | Table with users, search, pagination, New/Edit/Delete           | Renders           | ✅     |
| P3  | Roles               | `/roles`           | Table, search, New role                                         | Renders (empty)   | ✅     |
| P4  | Permissions         | `/permissions`     | Table, search, New permission                                   | Renders (empty)   | ✅     |
| P5  | Groups              | `/groups`          | Table, New group                                                | Renders           | ✅     |
| P6  | Translations (i18n) | `/i18n`            | Keys table                                                      | Renders           | ✅     |
| P7  | Email templates     | `/email-templates` | Templates table                                                 | Renders (empty)   | ✅     |
| P8  | Request Logs        | `/requests`        | Request audit table                                             | Renders           | ✅     |
| P9  | Queue Monitor       | `/queues`          | Queue counts / jobs                                             | Renders           | ✅     |
| P10 | Feature Flags       | `/features`        | Feature flag list                                               | Renders 3 flags   | ✅     |
| P11 | User Detail         | `/users/:id`       | User edit form + effective permissions                          | Renders           | ✅     |

---

## 6a. RBAC & Authorization Management (Detailed)

All RBAC features were verified end-to-end in the browser. Every mutation
was confirmed by re-fetching the resource from the API.

### Roles

| ID  | Scenario                                          | Result                                       | Status |
| --- | ------------------------------------------------- | -------------------------------------------- | ------ |
| R1  | Create role "editor" with no permissions          | 201                                          | ✅     |
| R2  | Edit role — assign "users.view" permission        | 200, `GET /api/roles/:id` returns permission | ✅     |
| R3  | Edit form pre-checks existing permissions on load | Checkbox reflects DB state                   | ✅     |
| R4  | Delete role                                       | 204                                          | ✅     |

### Permissions

| ID  | Scenario                           | Result | Status |
| --- | ---------------------------------- | ------ | ------ |
| PM1 | Create permission "roles.create"   | 201    | ✅     |
| PM2 | Delete permission (confirm dialog) | 204    | ✅     |

### Groups

| ID  | Scenario                                              | Result                                  | Status |
| --- | ----------------------------------------------------- | --------------------------------------- | ------ |
| G1  | Create group "editors" with user `normal@tsir.local`  | 201, `GET /api/groups/:id` returns user | ✅     |
| G2  | Edit group — assign "editor" role                     | 200, `GET /api/groups/:id` returns role | ✅     |
| G3  | Edit form pre-checks existing users/roles/permissions | Checkboxes reflect DB state             | ✅     |

### User Authorization

| ID  | Scenario                                               | Result                                                        | Status |
| --- | ------------------------------------------------------ | ------------------------------------------------------------- | ------ |
| UZ1 | Assign "editor" role to normal user via User Detail    | 200                                                           | ✅     |
| UZ2 | User Detail shows effective permissions (computed)     | `users.view` badge rendered                                   | ✅     |
| UZ3 | Effective permissions resolve through group→role chain | Normal user in "editors" group → "editor" role → "users.view" | ✅     |

### New endpoint: `GET /api/users/:id/permissions`

Uses `RbacService.resolvePermissions()` which unions:

- direct user permissions (`user_permissions`)
- permissions from user's roles (`user_roles` → `role_permissions`)
- permissions from user's groups (`group_users` → `group_permissions`)
- permissions from group roles (`group_roles` → `role_permissions`)

Super-admins receive every permission name.

---

## 7. UI / UX

| ID  | Scenario                                           | Expected                                                  | Actual        | Status |
| --- | -------------------------------------------------- | --------------------------------------------------------- | ------------- | ------ |
| U1  | Abyss (dark) theme is default                      | `data-theme="abyss"`                                      | abyss         | ✅     |
| U2  | Theme toggle switches to Silk (light)              | `data-theme="silk"`, icon changes                         | silk          | ✅     |
| U3  | Theme toggle switches back to Abyss                | `data-theme="abyss"`                                      | abyss         | ✅     |
| U4  | Sidebar collapse button                            | `lg:w-16` applied, `collapsed=true` in localStorage       | Applied       | ✅     |
| U5  | Sidebar expand button                              | `lg:w-64` applied, `collapsed=false`                      | Applied       | ✅     |
| U6  | Sidebar nav has 10 items                           | All 10 links present                                      | 10 links      | ✅     |
| U7  | Breadcrumbs show current path                      | Home > Users etc.                                         | Renders       | ✅     |
| U8  | User menu shows email                              | `admin@tsir.local` in dropdown trigger                    | Shows email   | ✅     |
| U9  | URL query param `?search=` populates search box    | Input value = query param                                 | Input = query | ✅     |
| U10 | Typing in search updates URL                       | `?search=value&page=1` in address bar                     | Updated       | ✅     |
| U11 | Search finds matching users                        | `admin` → 1 result                                        | 1 result      | ✅     |
| U12 | Search with no match returns empty                 | `xyz` → 0 results                                         | 0 results     | ✅     |
| U13 | Search is case-insensitive                         | `ADMIN` → 1 result                                        | 1 result      | ✅     |
| U14 | 404 for unknown route                              | "404 Page not found."                                     | Renders       | ✅     |
| U15 | Public routes accessible without auth              | `/login`, `/setup`, `/forgot-password`, `/reset-password` | Accessible    | ✅     |
| U16 | Authenticated user redirected from `/login` to `/` | Redirect to `/`                                           | Redirects     | ✅     |

---

## 8. API Endpoints (Super-Admin)

| ID   | Endpoint                                  | Method | Expected                 | Actual       | Status |
| ---- | ----------------------------------------- | ------ | ------------------------ | ------------ | ------ |
| E1   | `/api/users`                              | GET    | 200, paginated user list | 200          | ✅     |
| E2   | `/api/users`                              | POST   | 201, created user        | 201          | ✅     |
| E3   | `/api/users/:id`                          | GET    | 200, single user         | 200          | ✅     |
| E4   | `/api/users/:id`                          | PATCH  | 200, updated user        | 200          | ✅     |
| E5   | `/api/users/:id`                          | DELETE | 204                      | 204          | ✅     |
| E6   | `/api/users/:id/roles`                    | GET    | 200, user's roles        | 200          | ✅     |
| E6a  | `/api/users/:id/permissions`              | GET    | 200, effective perms     | 200          | ✅     |
| E7   | `/api/roles`                              | GET    | 200                      | 200          | ✅     |
| E7a  | `/api/roles/:id`                          | GET    | 200, role + permissions  | 200          | ✅     |
| E7b  | `/api/roles/:id`                          | PATCH  | 200, update role+perms   | 200          | ✅     |
| E8   | `/api/roles`                              | POST   | 201                      | 201          | ✅     |
| E9   | `/api/permissions`                        | GET    | 200                      | 200          | ✅     |
| E10  | `/api/permissions`                        | POST   | 201                      | 201          | ✅     |
| E10a | `/api/permissions/:id`                    | DELETE | 204                      | 204          | ✅     |
| E11  | `/api/groups`                             | GET    | 200                      | 200          | ✅     |
| E11a | `/api/groups/:id`                         | GET    | 200, group+members       | 200          | ✅     |
| E11b | `/api/groups/:id`                         | PATCH  | 200, update members      | 200          | ✅     |
| E12  | `/api/i18n/keys`                          | GET    | 200, seeded keys         | 200, 24 keys | ✅     |
| E12a | `/api/i18n/keys/:id/translations/:locale` | PATCH  | 200, update translation  | 200          | ✅     |
| E13  | `/api/i18n/dictionary`                    | GET    | 200 (public)             | 200          | ✅     |
| E14  | `/api/email-templates`                    | GET    | 200                      | 200          | ✅     |
| E14a | `/api/email-templates/:name`              | PATCH  | 200, update template     | 200          | ✅     |
| E15  | `/api/requests`                           | GET    | 200, request logs        | 200          | ✅     |
| E16  | `/api/queues/counts`                      | GET    | 200, queue counts        | 200          | ✅     |
| E17  | `/api/features`                           | GET    | 200, feature flags       | 200          | ✅     |
| E17a | `/api/features/:name`                     | PATCH  | 200, toggle flag         | 200          | ✅     |
| E18  | `/api/search?q=`                          | GET    | 200, search results      | 200          | ✅     |

---

## 9. Security Assessment

| ID   | Check                                               | Result                                                 | Status |
| ---- | --------------------------------------------------- | ------------------------------------------------------ | ------ |
| SEC1 | No auth bypass on admin endpoints                   | All return 401 for non-super-admin                     | ✅     |
| SEC2 | No privilege escalation via frontend                | Server-side guard checks `principal.data.isSuperAdmin` | ✅     |
| SEC3 | Setup endpoint locked after first install           | 409 on duplicate POST                                  | ✅     |
| SEC4 | No user enumeration on login                        | Same 401 for wrong email and wrong password            | ✅     |
| SEC5 | Session cookie cleared on logout                    | `Max-Age=0` Set-Cookie                                 | ✅     |
| SEC6 | SQL injection — search uses parameterized query     | Drizzle `like` with bound param                        | ✅     |
| SEC7 | XSS — user input rendered with Svelte auto-escaping | Svelte escapes by default                              | ✅     |
| SEC8 | Password hashing                                    | `@tsir/auth` hasher (never stored plaintext)           | ✅     |
| SEC9 | `isSuperAdmin` not client-trustworthy               | Derived from DB row in session principal               | ✅     |

---

## 10. Files Changed

### Backend (authorization + bug fixes)

- `modules/auth/services/auth.service.ts` — added `createSuperAdminGuard()`, `is_super_admin` type `number` + boolean coercion
- `modules/auth/http/auth.controller.ts` — `principal: true` on logout, `ctx.request` fix, `isSuperAdmin: === 1` in `me`
- `app.ts` — registered `superAdmin` guard in `createFetchHandler`
- `modules/users/http/users.controller.ts` — `guards: ['session','superAdmin']`, `principal: true`, `ilike` → `like`, **added `GET /:id/permissions` endpoint** using `RbacService`
- `modules/users/routes.ts` — injected `rbacServiceToken` into `UsersController` provider
- `modules/rbac/http/roles.controller.ts` — `guards: ['session','superAdmin']`, `principal: true` on create/update/delete
- `modules/rbac/http/groups.controller.ts` — `guards: ['session','superAdmin']`, `principal: true`
- `modules/i18n/http/i18n.controller.ts` — `guards: ['session','superAdmin']`, `principal: true`
- `modules/mail/http/mail.controller.ts` — `guards: ['session','superAdmin']`, `principal: true`
- `modules/system/http/request-log.controller.ts` — `guards: ['session','superAdmin']`
- `modules/system/http/queue.controller.ts` — `guards: ['session','superAdmin']`
- `modules/system/http/feature-flags.controller.ts` — `guards: ['session','superAdmin']`, fixed `toggle({ params })` signature
- `modules/system/http/search.controller.ts` — `guards: ['session','superAdmin']`

### Frontend

- `client/src/components/Layout.svelte` — fixed `class:w-64` shorthand → moved to static class string
- `client/src/lib/auth.svelte.ts` — added `bootstrapped` flag to fix auth race condition
- `client/src/App.svelte` — wait for `auth.bootstrapped` before redirect checks
- `client/src/pages/Roles.svelte` — inline edit form with permission checkboxes
- `client/src/pages/Groups.svelte` — inline edit form with user/role/permission checkboxes
- `client/src/pages/Permissions.svelte` — create + delete (confirm dialog)
- `client/src/pages/UserDetail.svelte` — role assignment + **effective permissions display**
- `client/src/pages/EmailTemplates.svelte` — inline edit form (subject/text/html)
- `client/src/pages/FeatureFlags.svelte` — `Record<string, boolean>` for reactive toggle state
- `client/src/pages/Requests.svelte` — fixed `createdAt` date parsing (ISO string)
- `client/build.ts` — `css: 'injected'` option to preserve component styles

### Tests

- `e2e/03-authorization.spec.ts` — new regression test for super-admin enforcement

### Built artifacts

- `public/app.js` — rebuilt after Layout fix

---

## 11. Test Results

### E2E (Playwright)

```
Running 8 tests using 1 worker
········
  8 passed (6.4s)
```

- `01-setup.spec.ts` — 2 tests (setup page, first admin creation)
- `02-auth.spec.ts` — 3 tests (login page, valid login, invalid login)
- `03-authorization.spec.ts` — 3 tests (super admin creates user, normal user denied all endpoints, normal user can logout)

### Unit (Bun test)

```
 16 pass
 0 fail
Ran 16 tests across 7 files.
```

### Typecheck

```
bun x tsc --noEmit -p tsconfig.json
→ exit 0, no errors
```

---

## 12. Final Acceptance Status

**ACCEPTED** — all critical and medium-severity issues have been fixed and
verified. The admin app is functionally complete, authorization-enforced, and
free of the discovered defects.

### Legend

- `[x]` / ✅ — passed
- `[ ]` — not tested
- `[!]` — failed (blocking)
- `[?]` — needs investigation

All items in this report are ✅.
