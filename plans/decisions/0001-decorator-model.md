# ADR-0001 — Standard ECMAScript Decorators; Binder Metadata Instead of Parameter Decorators

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/router`, `@tsir/http`, `@tsir/container`, all generated code

---

## Context

The project brief illustrates routing with **parameter decorators**:

```ts
@Get('/:id')
async findOne(@Param('id', IntParam) id: number): Promise<UserResponse>
```

TypeScript supports two incompatible decorator models:

| Model                                   | Parameter decorators | Metadata reflection                   | Status                                                                                                                                  |
| --------------------------------------- | -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy (`experimentalDecorators: true`) | ✅                   | `emitDecoratorMetadata` (design:type) | Deprecated direction; conflicts with `useDefineForClassFields`, requires a transform, and TS 5.x standard decorators cannot mix with it |
| Standard (TC39, TS 5.0+)                | ❌                   | none (and design:type is discouraged) | What TypeScript is standardizing on; what Bun transpiles natively                                                                       |

The brief also mandates: "Do not silently mix decorator models", "Do not require consumers to rely on emitted design-time type metadata", and "Follow TypeScript standards instead of inventing an alternative language or type system."

## Decision

1. Tsir uses **standard ECMAScript decorators only**. `experimentalDecorators` is off; `emitDecoratorMetadata` is off.
2. Decorators decorate **classes and methods** and write immutable metadata to a registry. They never mutate the class, wrap methods, or define hidden runtime behavior.
3. Request binding is expressed as **route metadata**, giving the same types and a comparable call shape:

```ts
@Route({ method: 'GET', path: '/:id', params: { id: IntParam } })
async findOne({ params }: Ctx<{ id: number }>): Promise<UserResponse> { … }
```

4. Dependency injection uses **explicit `inject` arrays** that mirror constructor parameters; no reflected parameter types.
5. All metadata is compiled into a generated route table at build time; production boot performs no reflection at all.

## Consequences

**Positive**

- Native Bun/TypeScript support with no transform, no `reflect-metadata` runtime, no metadata-emit penalty at load, and full compatibility with standard class fields and `useDefineForClassFields`.
- Metadata is inspectable data, which makes compilation, diagnostics, OpenAPI, and deploy-unit attribution straightforward.
- The published docs cannot claim compile-time magic TypeScript does not provide.

**Negative / costs**

- The developer-facing API differs from the brief's illustration and from frameworks such as NestJS or Laravel-style attribute trainers. This must be documented prominently (done in `04-http.md § 1`).
- Handler signatures favour a single destructured context object. Multi-argument handlers are supported but must be declared (`args: [...]`).
- DI requires an explicit `inject` array, which is more verbose than reflected constructor types. Mitigation: a typed provider builder (open question Q10).

## Alternatives considered

| Alternative                                                        | Why rejected                                                                                                                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy decorators + `emitDecoratorMetadata`                        | Ties the framework to a deprecated model, requires `reflect-metadata`, breaks with `useDefineForClassFields` semantics, and violates the brief's "no design-time type metadata as sole type source" rule |
| Custom compile-time transformer (like tsyringe/InversifyJS macros) | The brief forbids inventing an alternative language/type system; also breaks `bun build` single-pass transpilation                                                                                       |
| Runtime reflection over method parameter names                     | Fragile under minification and violates "no magic parameter injection based on parameter names"                                                                                                          |

## Revisit conditions

If TC39 advances a parameter-decorator proposal that ships in TypeScript **and** Bun, and the ecosystem adopts it, add support behind the same metadata registry as a second surface, with a new ADR. Existing metadata stays valid.
