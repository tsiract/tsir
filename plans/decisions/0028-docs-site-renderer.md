# ADR-0028 — The docs site is rendered from Markdown with `marked`, a build-time dependency

- **Status:** Accepted
- **Date:** 2026-10-30
- **Affects:** the root `package.json`, `src/apps/docs/`, `Makefile` (`docs-site`)
- **Related:** [ADR-0012](./0012-dependency-policy.md) (dependency policy), [ADR-0002](./0002-web-standard-http.md) (no library where the platform already has the feature)

---

## Context

Phase 8 requires a docs site that covers every public package and every error code (DOC-009,
DOC-010). The source is Markdown: `src/docs/` already holds the generated reference pages, and each
package has its prose. Turning Markdown into HTML needs a renderer. The platform does not provide one,
and writing a correct Markdown parser is not a good use of the project.

The site is built, not shipped. The renderer runs at build time, on the developer's machine or in CI,
and never inside a Worker or a Lambda bundle. ADR-0012's constraint on tree-shaking and bundle cost
applies to what a consumer imports, and the renderer is not imported by any consumer.

## Decision

1. **Use `marked`** (18.1.2, MIT) as a root **dev** dependency, pinned to the exact version.
   Its properties, checked against the registry on the date above: no runtime dependencies,
   ESM-only (`"type": "module"`), requires Node 20 or later.
2. **It is a build-time tool, not a runtime dependency.** `make deps` already exempts build-time
   dependencies, and this decision keeps it that way. It is never added to a `src/framework/*`
   manifest.
3. **The site is static output.** `make docs-site` writes HTML under `build/docs-site/`. There is no
   client-side framework, and the output works without JavaScript.
4. **Updating `marked`** is a deliberate change: bump the pin, rebuild the site, and check the diff of
   the generated pages.

## Consequences

- The Markdown is the source, so a page cannot drift from the file it was written in.
- Anyone who wants a different renderer later can replace it with a decision of their own. Nothing
  else in the repository depends on `marked`'s API.
- Only the framework's own build uses it, so the audit surface stays small.
