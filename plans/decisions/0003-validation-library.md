# ADR-0003 — Standard Schema Interface; Zod 4 as Default Implementation

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/validate`, `@tsir/http`, `@tsir/config`, `@tsir/link`

---

## Context

The brief requires runtime validation at every trust boundary and prefers established libraries over in-house engines. It does not mandate a specific library.

Candidate libraries: Zod (v4), Valibot, ArkType, TypeBox.

## Decision

1. Tsir accepts any validator implementing the **Standard Schema** interface (`~standard.validate` / `~standard.types`). Our APIs are typed against that interface, not against a vendor.
2. **Zod 4 is the default** shipped and documented by Tsir (`@tsir/validate` re-exports it as `z` for apps that want zero extra setup).
3. `@tsir/validate` adds only: HTTP-shaped helpers (`IntParam`, `PageQuery`, `Multipart`), issue normalization, and problem-response mapping. It does not wrap or hide the validator API.
4. Config schemas use the same interface, so a project on Valibot validates env vars with Valibot too.

## Rationale for Zod 4 as default

- Largest installed base and documentation surface — the least surprising choice for the target user.
- Zod 4 ships a native JSON Schema converter, which we need for OpenAPI 3.1 generation without a second toolchain.
- Good inference quality for the binder typing that `Ctx<...>` depends on.
- Standard Schema is Zod's own proposal, so the adapter is trivial and stable.

## Consequences

**Positive**

- No lock-in: a project can use Valibot or ArkType without changing framework code.
- One normalization layer (`Issues`) keeps error responses consistent regardless of validator.
- JSON Schema export covers OpenAPI, gRPC-ish descriptors, and docs.

**Negative / costs**

- Standard Schema standardizes _validation_, not _introspection_ — some helpers (e.g. deriving query-string coercers, multipart semantics) must be implemented against Zod first and feature-detected for others.
- A project mixing validators gets consistent errors but not consistent performance characteristics.
- Bundle size: Zod 4 is not tiny; it is a dependency of `@tsir/validate`, not `@tsir/core`, and only pulled by units that use HTTP/link validation.

## Alternatives considered

| Alternative                                      | Trade-off                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Build a Tsir validation engine                   | Forbidden by the brief without a compelling reason; enormous maintenance cost                                              |
| Depend directly on Zod everywhere (no interface) | Simpler internals, but excludes other libraries and contradicts "prefer established libraries, avoid lock-in"              |
| TypeBox/Ajv                                      | Fast, JSON-Schema native, but weaker TS inference ergonomics for the `Ctx<...>` model and less familiar to the target user |

## Revisit conditions

If Standard Schema adoption stalls or a successor interface emerges, add an adapter; user schemas remain untouched.
