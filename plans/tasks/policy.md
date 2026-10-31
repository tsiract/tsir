# Tasks — `@tsir/policy` (Phase 7)

> A permission check that only exists inside a controller is a permission check that link, jobs and
> RPC all skip. This package is the one `authorize()` that every caller uses, with no HTTP in it.
>
> **Plan:** [`04-http.md § 8`](../modules/04-http.md) · [`14-security.md § 2`](../operations/14-security.md) ·
> **Related:** [`12-security.md`](./12-security.md) (`SEC-2xx`), [`auth.md`](./auth.md) (who the
> principal is), [`03-http.md`](./03-http.md) (guards and the 403).

**Status: complete — 2026-10-29.** Six modules, two test files, one type-test file. Tests: **26**,
and the coverage gate reports **92.96 % lines / 88.61 % functions**. Dependency set:
`@tsir/container` only — the package has no idea what a request is.

## Tasks

| ID      | Task                                                                | Status | Depends         | Acceptance                                                                                                                                   |
| ------- | ------------------------------------------------------------------- | ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POL-1` | Permission strings — `resource.action`, split at the last dot       | `[x]`  | —               | `post:update` is the reference form; `splitPermission`/`joinPermission` round-trip, and a string with no dot is refused with the fix in hand |
| `POL-2` | `defineRole` + `createRoleGraph` — implications, cycles, duplicates | `[x]`  | `POL-1`         | Depth-first resolution; a cycle is refused **with the closing path**; an unknown `implies` target and a duplicate name are refused at build  |
| `POL-3` | `Decision` — `{ allowed }` plus `source` and `reason`               | `[x]`  | —               | A denial cannot be written without a reason; `source` answers "why was this allowed?" and never reaches the client                           |
| `POL-4` | `authorize()` — the fixed order, and no `after` hook                | `[x]`  | `POL-2`,`POL-3` | unauthenticated → deny gates → allow gates → declared policy → role permission → default deny. A policy sees `data`; nothing else does       |
| `POL-5` | `require()` — the variant a job can call                            | `[x]`  | `POL-4`         | Throws `POL_NO_PRINCIPAL` / `POL_FORBIDDEN`; a decision object a caller forgets to check is the bug this removes                             |
| `POL-6` | `toHttpPolicies()` — one policy per declared ref                    | `[x]`  | `POL-4`         | Every `registry.refs` entry gets a policy, which closes `@tsir/http`'s fail-open skip for an unknown ref                                     |
| `POL-7` | `refs`, `missing(refs)`, `matrix()`, `can()`, `permissionsOf()`     | `[x]`  | `POL-4`         | `missing()` names the routes that would have failed open; `matrix()` is declaration order so a generated docs page is stable                 |
| `POL-8` | Per-call role narrowing                                             | `[x]`  | `POL-4`         | `authorize({ roles })` narrows a token to a subset and can never widen it; an unknown role grants nothing                                    |
| `POL-9` | Type tests                                                          | `[x]`  | `POL-3`,`POL-4` | A denial without a reason, a bare boolean decision and a mistyped principal all fail to compile                                              |

## As built: the order, and why it is not configurable

```
principal? ──no──▶ deny  (unauthenticated)
     │yes
     ▼
deny gates ──decided──▶ deny            a suspended account stays suspended
     │no
     ▼
allow gates ──decided──▶ allow          superadmin: the only bypass, and it is named
     │no
     ▼
policy for `resource:action` ──decided──▶ the answer   the only step that sees `data`
     │none declared
     ▼
role permission ──granted──▶ allow
     │no
     ▼
deny  (default, fail closed)
```

Four decisions the package makes rather than documents:

- **No `after` hook.** A callback that can overturn a denial is how a policy bug becomes a breach.
  The one bypass is an `allowGate` somebody declared by name, which is visible in the file and in
  `matrix()`.
- **`source` is not forwarded.** Telling a client that the reason was "no role grants
  `invoice.void`" is free reconnaissance. `source` is for the audit record and the log line.
- **A non-decision is a denial, not a crash.** A policy that returns `undefined` throws
  `POL_INVALID_DECISION` and fails **closed** — a broken rule must not become an open door.
- **A bare `{ allowed }` is accepted** from a policy written for `@tsir/http`, and labelled
  `source: 'policy'` so the audit trail still says which rule decided.

## As built: roles are a graph, and the graph is checked

`defineRole({ name, implies, permissions })` and `createRoleGraph` refuse, at construction: a
duplicate name, an `implies` that names nothing, and a cycle — the last one **with the closing path
in the message** (`admin → editor → admin`), because "there is a cycle somewhere" is not a fix.

Resolution is depth-first with a visited set, so a diamond (`admin → editor`, `admin → publisher`,
both → `author`) grants `author` once. `permissionsOf` returns a **copy** of the set: `Object.freeze`
does not stop `Set.add`, and a caller mutating an effective-permission set is a privilege-escalation
primitive with a friendly name.

`refs` is every `resource:action` a route may name: declared policies first, then role permissions.
`toHttpPolicies(registry, { data })` emits a policy for **every** ref, which is what closes
`@tsir/http`'s behaviour of allowing a route whose policy ref nothing answers. `missing(refs)` is the
same fact as a diagnostic: given what the routes declared, which refs would fail open?

## Files

| File              | What it is                                                           |
| ----------------- | -------------------------------------------------------------------- |
| `src/errors.ts`   | `POL_*` codes: no principal, forbidden, invalid decision, bad role   |
| `src/role.ts`     | Permission strings, `defineRole`, `createRoleGraph`, the cycle check |
| `src/decision.ts` | `Decision`, `PolicyAnswer`, `allow`, `deny`, `isDecision`            |
| `src/registry.ts` | `createRegistry`, `authorize`, `require`, gates, `matrix`, `missing` |
| `src/http.ts`     | `toHttpPolicies`, `authorizeService` — the `@tsir/http` adapter      |
| `src/index.ts`    | The public surface                                                   |

## Tests

`src/role.test.ts` (permission splitting and regex, implication, diamond, cycle path, unknown and
duplicate roles, immutability, `matrix()` order) and `src/registry.test.ts` (authorize order, gates
against roles, per-call narrowing, non-decision throws, `require`, `refs`/`missing`/`matrix`/`can`,
a custom `rolesOf`, and `toHttpPolicies` for every ref) — **26 tests**. The type tests in
`type-tests/policy.types.ts` are compiled by `make typecheck`.
