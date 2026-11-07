# Admin App — Remaining Follow-up Tasks

> **Created:** 2026-11-08
> **App:** `src/apps/admin.product.com`
> **Context:** Follow-up items from the end-to-end admin completion session. All
> critical paths (RBAC, auth, i18n, mail, feature flags, requests, queues) are
> implemented and the primary flows are verified. These items are edge cases,
> secondary actions, or polish that did not block acceptance.

---

## 1. Queue job retry (no failed jobs to test against)

- **ID:** `ADM-001`
- **Status:** `[ ]`
- **Why open:** The `DELETE /api/queues/:id/retry` endpoint and the UI Retry
  button exist, but there are no failed jobs in the dev database to exercise
  them. The queues page renders correctly with an empty state.
- **Acceptance criteria:**
  - [ ] Enqueue a job that fails (e.g. throw in a test job), confirm it appears
        in the queues table under "Failed" state.
  - [ ] Click Retry in the UI; confirm the job is re-queued and removed from the
        failed list.
  - [ ] `DELETE /api/queues/:id/retry` returns 200 for a real failed job id and
        404 for a non-existent id.

## 2. I18n key create & delete (edit was verified)

- **ID:** `ADM-002`
- **Status:** `[ ]`
- **Why open:** Editing an existing translation (`PATCH
/api/i18n/keys/:id/translations/:locale`) works end-to-end. The create-key
  (`+ New key`) and delete-key flows were not exercised this session.
- **Acceptance criteria:**
  - [ ] `+ New key` creates a key with namespace; it appears in the table.
  - [ ] Delete key removes it and its translations.
  - [ ] Creating a duplicate key returns a 409/validation error.

## 3. Email template delete (create & edit verified)

- **ID:** `ADM-003`
- **Status:** `[~]`
- **Why open:** Create and edit (subject/text/html) are verified. Delete was
  verified in a prior session but not re-confirmed this session.
- **Acceptance criteria:**
  - [ ] Delete template removes it from the list.
  - [ ] Deleting a non-existent template returns 404.

## 4. User delete via UI confirm dialog

- **ID:** `ADM-004`
- **Status:** `[ ]`
- **Why open:** `DELETE /api/users/:id` returns 204 (verified via API in e2e).
  The UI confirm-dialog flow (ConfirmDialog component) was tested for
  permissions but not for users specifically.
- **Acceptance criteria:**
  - [ ] Delete a user from `/users`; confirm the dialog, user disappears, API
        returns 204.
  - [ ] Cancelling the dialog leaves the user in place.

## 5. User create with role assignment

- **ID:** `ADM-005`
- **Status:** `[ ]`
- **Why open:** The create-user form exists; creating a bare user works.
  Assigning roles at creation time (`roleIds` in `CreateUser`) was not tested.
- **Acceptance criteria:**
  - [ ] Create a user with one or more roles checked; `GET
/api/users/:id/roles` returns those roles.

## 6. Normal-user denial on write actions

- **ID:** `ADM-006`
- **Status:** `[ ]`
- **Why open:** The `superAdmin` guard blocks normal users from list endpoints
  (verified: all return 401). Write actions (POST/PATCH/DELETE) were not
  individually re-tested as a normal user.
- **Acceptance criteria:**
  - [ ] Normal user POST `/api/users`, `/api/roles`, `/api/permissions`,
        `/api/groups`, `/api/email-templates` all return 401.
  - [ ] Normal user PATCH `/api/users/:id`, `/api/roles/:id` return 401.
  - [ ] Normal user DELETE on any admin resource returns 401.

## 7. Dashboard cards show real backend data

- **ID:** `ADM-007`
- **Status:** `[ ]`
- **Why open:** The dashboard renders cards for Requests, Queues, Translations,
  Metrics. The cards are present but the live data wiring was not confirmed
  against actual API responses during this session.
- **Acceptance criteria:**
  - [ ] Each dashboard card fetches from its endpoint (e.g. `/api/requests`,
        `/api/queues/counts`, `/api/i18n/keys`) and displays a real count.
  - [ ] A card that errors shows a graceful error/empty state, not a broken
        layout.

## 8. Feature flag create & delete (toggle verified)

- **ID:** `ADM-008`
- **Status:** `[ ]`
- **Why open:** `PATCH /api/features/:name` toggle works. The feature flags
  page may only support toggle (not create/delete) — confirm the intended scope
  and verify whatever actions exist.
- **Acceptance criteria:**
  - [ ] Confirm whether create/delete are intended for feature flags.
  - [ ] If supported, verify they work; if not, document the decision.

## 9. Search page (`/api/search`)

- **ID:** `ADM-009`
- **Status:** `[ ]`
- **Why open:** `/api/search?q=` returns 200 (verified in prior e2e). The UI
  search page (if any) and its rendering of cross-resource results was not
  verified this session.
- **Acceptance criteria:**
  - [ ] If a search page exists in the router, load it and confirm results
        render.
  - [ ] If no UI search page, confirm the sidebar does not link to one.

---

## Notes

- All items assume the dev server is running (`make dev`) with the admin at
  `http://localhost:3001`.
- Test credentials: super-admin `admin@tsir.local` / `supersecret123`, normal
  user `normal@tsir.local` / `normalpass123`.
- After any backend change, restart the dev server (backend is not hot-reloaded).
  After any `.svelte` change, run `bun run build:client`.
