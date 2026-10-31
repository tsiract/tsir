# ADR-0022 — A dependency may be scoped to a subpath entrypoint, and the import graph proves it

- **Status:** Accepted
- **Date:** 2026-10-28
- **Affects:** `src/tools/check-deps.ts`, `src/tools/dependency-policy.ts`, `src/tools/import-graph.ts`, `src/tools/readme-badges.ts`, `src/tools/verify-dist.ts`, `@tsir/link`
- **Amends:** [ADR-0012](./0012-dependency-policy.md) (dependency policy)

---

## Context

ADR-0012 says every runtime dependency must be allowlisted, ESM, tree-shakeable and
declared pure, and `make deps` enforces it mechanically. It has served well: two
dependencies carry the whole framework.

Phase 5 introduces four protocols in one package (ADR-0004). Two of them cannot be built
honestly without third-party code:

- **gRPC** needs HTTP/2 framing, HPACK and a protobuf runtime. Re-implementing that is not
  "no dependency", it is "a worse dependency with no maintainers".
- **SOAP** needs a hardened XML parser. Hand-rolling one is precisely the class of code
  that produces XXE and billion-laughs vulnerabilities.

The policy as written has no vocabulary for this. A dependency is either allowed — in
which case the badge says every consumer carries it — or it is not, and the protocol
cannot be shipped. That is a false dichotomy: a REST client never imports gRPC, and a
Workers bundle never imports an XML parser. If the bundler cannot see the difference, the
packaging is wrong; if it can, the policy is.

## Decision

**A dependency may declare the subpath entrypoints allowed to import it. The proof is the
package's own import graph, checked on every `make deps`.**

```ts
// src/tools/dependency-policy.ts
'@grpc/grpc-js': {
  rationale: 'gRPC transport (HTTP/2, HPACK, protobuf). ADR-0004 keeps it out of every other entrypoint.',
  phase: 'P5',
  shaking: 'ESM; only reachable through @tsir/link/grpc',
  scope: ['@tsir/link/grpc'],
},
```

### What is enforced

1. **The scope must name a real entrypoint.** `@tsir/link/grpc` must exist in that
   package's `exports`; a scope pointing at `./grpc` that was renamed or deleted fails.
2. **The root closure must not mention the dependency.** `check-deps` starts at
   `exports['.']`, follows relative imports transitively (`import`, `export … from`,
   `import()`), and fails if the dependency appears — naming the file that imports it.
3. **The closure must be complete.** A relative import that does not resolve is a
   failure, not a warning: an incomplete graph cannot prove a negative.
4. **The allowlist rules still apply unchanged.** ESM entry, `sideEffects` declared, one
   version per dependency, documented rationale and phase.
5. **The count in the README stays honest.** `readme-badges` publishes
   `2 (+2 adapters)`: what every consumer carries, plus what only an optional entrypoint
   pulls in. One number for both would tell a REST user they pay for a gRPC runtime.

### 2. The Node-only exception, and why it is narrow

`@grpc/grpc-js` is CommonJS and declares no `sideEffects`. Under ADR-0012 alone that is an
automatic rejection — and it is also, by a wide margin, the most-used gRPC implementation
in JavaScript, the one other libraries are tested against.

A dependency may therefore declare `nodeOnly: { why }` in the policy, which turns the ESM
and purity failures into recorded notes **only when all of the following hold**:

1. it also declares an explicit `scope`, so the exception cannot become a root dependency
   by editing one line;
2. the runtime it needs is one our Node/Lambda targets have and Workers do not, stated in
   `why`;
3. a bundle proof in `verify-dist` shows it inside a Node bundle and absent from a browser
   one.

`@bufbuild/protobuf` — the protobuf runtime, ESM and `sideEffects: false` — goes through
the ordinary scoped path with no exception at all. Keeping them separate is the point:
"needs Node" and "needs an exception" are different claims.

### What is deliberately _not_ enforced here

The import graph is static text analysis, not a bundler. It cannot see a plugin that
injects an import at build time. That risk is covered from the other side by a bundle
proof: `verify-dist` gains an entry per adapter that imports one entrypoint and asserts
the other adapters' dependencies are absent from the emitted bytes. Two independent
checks — one cheap and total over the source, one expensive and exact over the output.

## Consequences

**Positive**

- gRPC and SOAP become possible inside the existing packaging (one package, four
  entrypoints) without making REST users pay.
- The claim "importing `@tsir/link` costs nothing extra" is now mechanical rather than a
  sentence in a plan.
- The rule generalises: any future optional adapter (tracing exporters, compression,
  image codecs) has a home.

**Negative / costs**

- Two more lists to keep true: the scope in the policy file and the `exports` map in the
  package manifest. Both fail the build when they disagree.
- The badge grows a qualifier. Slightly less pretty, considerably less misleading.
- `check-deps` now reads source files, not only manifests, so a dangling relative import
  anywhere in a scoped package's root closure is a build failure. That is the intended
  behaviour, and it is the first time this tool has an opinion about source.

## Alternatives considered

| Alternative                               | Why rejected                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Allow the dependency unscoped             | Every consumer carries a gRPC runtime or an XML parser. Violates the constraint that started ADR-0012.                     |
| Four packages instead of four entrypoints | Duplicates 60–70 % of the shared core — the reason ADR-0004 exists.                                                        |
| `peerDependencies` only                   | Moves the decision to the application without any check that it is absent where it should be.                              |
| Rely on bundler tree-shaking alone        | Works until someone writes `import * as grpc` in a shared file; the failure is a size regression nobody notices in review. |
| A dynamic `import()` at call time         | Turns a missing dependency into a runtime error instead of an install-time one, and hides the cost from the graph.         |
