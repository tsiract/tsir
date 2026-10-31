# ADR-0012 — Third-party dependencies must be tree-shakeable, established, and few

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** every `src/framework/*` manifest, `src/tools/check-deps.ts`, `src/tools/verify-dist.ts`
- **Related:** ADR-0003 (Standard Schema, Zod 4), ADR-0007 (Drizzle owns migrations), ADR-0011 (`dist/`)
- **Amended by:** [ADR-0022](./0022-subpath-dependency-scope.md) — a dependency may be scoped to a subpath entrypoint, proven by the import graph

---

## Context

Tsir targets Cloudflare Workers (where a Worker is a single bundled module with a hard size
limit) and AWS Lambda (where cold-start time scales with what must be parsed and initialised). On
both, "how much code did this import cost me" is a product property, not an optimisation detail.

The maintainer's constraint is explicit:

> no third-party libraries that don't support tree shaking … and the modules should follow the top
> projects in their domain, like Zod and Drizzle.

Two failure modes follow from ignoring it:

- **A CJS-only dependency.** No consumer bundler can tree-shake CommonJS reliably. One such
  dependency silently pins the whole package into every bundle.
- **A dependency without `sideEffects`.** Without the declaration a bundler must assume importing
  any module runs something, so nothing can be dropped. The package works, and it is fat forever.

Relying on reputation ("they're popular, they must be fine") has the same problem as any other
unverified claim: it is true until it is not, and nobody notices when it stops being true.

## Decision

### 1. Build on the established library; never re-implement it

| Domain            | Choice                       | Why this one                                                                                                                                                         |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema validation | **Zod 4** (ADR-0003)         | The de-facto TypeScript standard and the author of Standard Schema. `@tsir/validate` sits on top of it and is the **only** package that names `zod` as a dependency. |
| SQL / migrations  | **Drizzle ORM** (ADR-0007)   | SQL-shaped, no runtime schema engine, per-dialect entry points so unused drivers stay out of the bundle. Phase 3.                                                    |
| HTTP primitives   | **Web standards** (ADR-0002) | `Request`/`Response` exist on Bun, Workers and Lambda. No library can beat zero bytes.                                                                               |

A package that wraps one of these must expose its native API rather than hiding it behind a
private abstraction — the wrapper exists for Tsir-specific concerns (issue normalization, trust
boundaries), not to invent a dialect.

### 2. Every runtime dependency passes four mechanical checks

Enforced by `make deps` (`src/tools/check-deps.ts`) on the file system, not on trust:

1. **Allowlisted.** Unknown runtime dependency → build failure. The allowlist entry records the
   rationale, the phase it arrived, and the expected tree-shaking characteristics.
2. **Native ESM.** `type: "module"`, a `module` field, or an `exports` entry with an `import`
   condition. CJS-only is rejected outright.
3. **Declared purity.** `sideEffects: false`, or an explicit array naming the few files that do
   have side effects (Zod declares exactly three).
4. **One version.** Two copies of a validator means two sets of schema identities and two
   `instanceof` failures waiting to happen.

### 3. The framework's own output follows the same rules

`dist/` is per-file ESM with `sideEffects: false` (ADR-0011). `make verify-dist` measures the
result rather than asserting it:

| Probe                                      | Measured (minified) | Budget   |
| ------------------------------------------ | ------------------- | -------- |
| one symbol from `@tsir/container`          | 0.1 KiB             | 1.5 KiB  |
| `@tsir/core` lifecycle, no validator       | 13.8 KiB            | 19.5 KiB |
| Workers handler (core + config + validate) | 99.6 KiB            | 127 KiB  |
| Lambda handler, `node` target              | 86.7 KiB            | 107 KiB  |

Budgets are **measured baseline plus headroom**. Their job is to fail when a change doubles the
payload, not to express a wish. When a bundle legitimately grows, the number in this table is
updated in the same commit — with the measurement that justified it.

### 4. No backward-compatibility debt before v1

The project is `0.0.0` and unpublished. A dependency that turns out to be wrong is removed, not
shimmed; a public API that was a mistake is changed, not aliased. Compatibility promises begin at
`v1.0.0` and not a day earlier, and there is no deprecation machinery to maintain before then.

## Consequences

**Positive**

- "Supports tree shaking" is a build failure, not a code-review opinion.
- The dependency budget is small and visible: today the framework ships one runtime dependency.
- Because `@tsir/validate` owns Zod, an application cannot end up with two Zod versions through
  Tsir's packages.

**Negative / costs**

- A genuinely useful library that ships only CJS is unusable — including as a transitive
  dependency. This will occasionally mean writing twenty lines instead of installing a package.
- The budgets need maintenance: a deliberate size increase requires editing a table, which is
  friction by design but friction nonetheless.
- Zod dominates the Workers/Lambda payload (~82 of ~100 KiB). That is acceptable on Workers
  (3 MB limit) and for Lambda cold start, but it is why the framework is careful to never import
  `@tsir/config` from `@tsir/container`: an app that does not use typed config does not pay for it.

## Alternatives rejected

- **Trust package reputation instead of checking.** Rejected: the checks are cheap, deterministic,
  and catch the exact failure the maintainer called out.
- **Accept CJS dependencies and rely on interop.** Rejected: interop keeps the code _working_
  while making it un-shakeable — the worst combination, because nothing looks broken.
- **Write a "small" validator / query builder in-house.** Rejected twice over: the brief forbids
  re-implementing solved problems, and a homegrown validator is a security liability.
- **Cap only the total bundle size.** Rejected: a single aggregate number lets one package grow
  while another shrinks. Per-probe budgets keep the signal attributable.
