# ADR-0010 — `@tsir/validate` is a thin interoperability layer, not a re-export

- **Status:** Accepted
- **Date:** 2026-10-27
- **Resolves:** Q2 in [`../00-foundation.md`](../roadmap/00-foundation.md) — "is `@tsir/validate` a wrapper package at all, or just a re-export of the Standard Schema adapter?"
- **Affects:** `@tsir/validate`, `@tsir/http`, `@tsir/router`, `@tsir/link`, `@tsir/console`, `@tsir/testing`

---

## Context

ADR-0003 settled _which_ validator Tsir accepts (any Standard Schema implementation, Zod 4 as the default) but left open what the `@tsir/validate` package itself contains. Two candidates were on the table:

1. **Re-export.** `export * from 'zod'` plus the Standard Schema types. Minimal surface, zero new logic, zero new bugs.
2. **Thin wrapper.** A small package that owns the pieces Tsir needs regardless of validator: the schema _interface_, issue normalization, sync-vs-async discipline, and the mapping from issues to the error codes each boundary speaks.

The deciding question is not "how little code can we write" but "which behaviour must be identical on every boundary". A 422 from `@tsir/http`, a `ValidationError` from `@tsir/console` parsing `tsir.js`, and an `INVALID_ARGUMENT` from a gRPC handler must describe the same rejection the same way. That behaviour has to live somewhere the routers and links can depend on without depending on each other.

## Decision

`@tsir/validate` is a **thin wrapper**, and its scope is bounded to four responsibilities:

| Responsibility    | What it owns                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interface**     | Vendored `StandardSchemaV1` types (`standard.ts`). No dependency on any validator to _accept_ one.                                                    |
| **Normalization** | `normalizeIssues()` → `ValidationIssue[]` with `{ path: string[], message, code }`, identical across Zod, Valibot, ArkType, and hand-written schemas. |
| **Discipline**    | `validate()` (async-safe) and `validateSync()` (refuses async validators with `VLD_ASYNC_SCHEMA` instead of returning a promise nobody awaited).      |
| **Error surface** | `ValidationError` carries `issues` as a first-class property — not stuffed into `context`, which is scalar-only and log-serialized.                   |

Explicitly **out of scope** for this package:

- Hiding or wrapping the validator API. Handlers import `z` (re-exported per ADR-0003) or Valibot directly and use it natively.
- Coercion. A schema that wants `"3"` → `3` must declare it; nothing is converted behind the caller's back.
- HTTP-shaped helpers (`IntParam`, `PageQuery`, `Multipart`) and `Issues → problem+json` mapping. Those depend on the HTTP layer and ship in Phase 2 (VLD-003…008).
- Serialization concerns beyond truncation: an issue message longer than 500 characters is cut, so a validator that embeds the offending value cannot grow a response body.

## Consequences

**Positive**

- One rejection shape on every boundary; the HTTP mapper, the CLI, the SOAP fault writer, and the gRPC status mapper all read `error.issues`.
- No transitive dependency for users who bring Valibot or ArkType — the package _accepts_ their schemas without importing their runtime.
- `validateSync()` makes the async-validator mistake impossible to ship silently; this is the class of bug that costs a day to find in production.

**Negative / costs**

- ~200 lines of code that a re-export would not need, plus the maintenance of the vendored interface (it is versioned: `version: 1`).
- Two entry points (`validate`, `validateSync`) instead of one; a caller must choose. The choice is explicit and tested.
- Issue `code` classification is heuristic (message pattern matching), because Standard Schema standardizes _validation_, not _diagnosis_. The heuristics are tested against real Zod output and are only used for status mapping and i18n, never for control flow that depends on exact wording.

## Alternatives rejected

- **Pure re-export of Zod.** Rejected: it makes Zod the framework's validation _engine_ rather than its default, contradicting ADR-0003, and it would force every boundary to re-implement issue normalization.
- **Adopt the validators' own issue types.** Rejected: `path` in Zod is `(string | number)[]`, in Valibot it is a nested array, and in ArkType it is a string. A framework contract cannot change shape with a dependency.
- **A custom validation engine.** Rejected outright: the brief forbids re-implementing solved problems, and a homegrown validator is a security liability.
