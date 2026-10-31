# ADR-0013 — `zod/mini` is a first-class entry, and `@tsir/config` runs on it

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `src/framework/validate` (new `./mini` export), `src/framework/config` (internals), `src/tools/verify-dist.ts`
- **Related:** ADR-0003 (Standard Schema, Zod 4), ADR-0010 (`@tsir/validate` is a thin wrapper), ADR-0012 (dependency policy), Q35

---

## Context

`@tsir/validate` was a thin wrapper over Zod 4, re-exporting `z` and adding `validate`/
`validateSync` with a Tsir-shaped `ValidationError`. That is the right default: Zod's chainable
API (`z.string().min(3)`) is what people know, and full Zod is what an application developer
wants when they are shaping request bodies.

Config is a different shape of problem. `tsir.js` is the _first_ thing that runs, and on Workers
it is the code that decides whether the bundle fits under the platform limit at all. Every field
in a config schema needs three things — a type, an optional default, an optional coercion — and
that is it. Nothing in the config path needs `.transform()` chains, unions of objects, `superRefine`
with path surgery, or the error map. Measured on the built `dist/` tree, the difference was not
marginal:

| probe                      | full Zod  | `zod/mini`   |
| -------------------------- | --------- | ------------ |
| config-only bundle         | 75,151 B  | **21,457 B** |
| Workers handler (edge-app) | 104,402 B | **38,812 B** |

A Worker's free-tier limit is 3 MiB gzipped and the paid limit is 10 MiB, so 65 KiB is not fatal
on its own. But it is a 3.5× multiplier on the _entire_ baseline that every subsequent feature
inherits, and it is paid by every app whether or not it ever parses a request body. The
tree-shaking requirement (ADR-0012) exists so that this kind of cost can be removed rather than
argued about — so remove it.

## Decision

**1. `zod/mini` ships as its own entry point: `@tsir/validate/mini`.**

```ts
import * as m from '@tsir/validate/mini';
```

It is a re-export of `zod/mini`, not a wrapper: same schemas, same types, same `~standard`
interface. `@tsir/validate` remains the only package that declares `zod` as a dependency
(ADR-0012), so `zod` is never duplicated across the graph and an app can use the full entry, the
mini entry, or both without version skew.

**2. `@tsir/config` is built on `zod/mini`.**

`defineConfig`'s field helpers (`env.string`, `env.required`, `env.secret`, `env.int`, `env.bool`,
`env.enum`) construct mini schemas. The mini API is functional, so declarations read as:

```ts
DATABASE_URL: env.required(m.string().check(m.minLength(1))),
```

This is deliberately _not_ re-exported to users as "the config API". Field builders are the API;
the schema inside is an implementation detail that any Standard Schema validator can replace
(see below).

**3. `env.custom()` keeps accepting any Standard Schema validator.**

Zod, Zod mini, Valibot, and ArkType all implement `~standard`. A user who already owns a Valibot
schema for a config value should not have to rewrite it in Zod mini. The config layer therefore
depends on the _interface_, not the library — which is the same rule ADR-0003 applies everywhere
else in Tsir.

**4. Fallback behaviour is preserved, not re-derived.**

Zod mini has no `.default()` method; `m._default(schema, value)` is a wrapper. Because the
declaration-time check in `defineConfig` validates defaults eagerly (`CFG_INVALID_DEFAULT`), the
config layer stores the default in its **input** form (`defaultInput`) and validates it at boot
like any other value. Storing the parsed form instead broke numeric and boolean defaults: a
numeric default emitted as `"5432"` by `process.env` would then be re-validated as a string. The
input form is what both paths agree on.

## Consequences

- Apps that never touch request validation do not pay for full Zod. `config-only` is budgeted at
  28,000 B (measured 21,457 B) and fails the build if it regresses.
- `verify-dist.ts` now runs six probes, including `edge-app-zod` (130,000 B) as the explicit
  counter-example: apps that _do_ want full Zod at the edge stay well inside the platform limit,
  and the delta between the two is a documented, measured number rather than a guess.
- **`ZodError` is not a forbidden substring for `config-only`.** `$ZodError` is part of the mini
  core; only the budget protects that probe. The comment in `BUDGETS` says so, so nobody deletes
  the budget thinking the substring check covers it.
- Config field errors still carry `CFG_INVALID_DEFAULT` / `VLD_ASYNC_SCHEMA` codes. Moving to
  mini changed the size, not the error surface — zod v4 message text was already unstable and
  tests assert on codes and keys.
- Two Zod APIs now exist in the ecosystem. The mitigation is that the boundary is explicit and
  documented in `src/framework/validate/src/mini.ts`, rather than a hidden internal choice that
  leaks out as "why does my `.default()` not exist".

## Alternatives rejected

- **Use `zod/mini` everywhere.** Rejected: it is measurably less comfortable for application code
  (functional `.check()` chains, `_default`), and the edge bundle that _does_ parse request bodies
  measured 104,402 B with full Zod — comfortable against a 3 MiB limit. Optimise the baseline, not
  everyone's hands.
- **Keep full Zod internally and accept 75 KiB.** Rejected: the cost is universal and permanent,
  the benefit is zero for the config path, and ADR-0012 exists precisely to make this trade
  exchangeable.
- **Re-implement the needed subset of Zod's API.** Rejected: a homegrown validator is a security
  liability (ADR-0012), and the whole point of ADR-0010 is that Tsir does not own validation.
- **Re-export mini under the plain `@tsir/validate` name.** Rejected: it would silently change the
  API for everyone importing `z`, and it makes the size story invisible instead of explicit.
