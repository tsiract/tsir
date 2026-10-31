# `apps/docs/`

The documentation site. `make docs-site` renders the Markdown under [`src/docs/`](../../docs) to
HTML under `build/docs-site/`. The output has no scripts, stylesheets or fonts from outside, so it
reads offline. The renderer is `marked`, a build-time dependency (ADR-0028).

## What is on the site

- One reference page per framework package, in `src/docs/packages/`. Each page has the install line,
  a worked example that is run in tests, the package's failure modes, its security notes, and the
  error codes it owns. `make docs-packages` checks that every package has a current page.
  - The generated parts (install line, public surface, error codes) come from the code. The three
    prose sections (Example, Failure modes, Security notes) are written by hand in
    `src/docs/packages/prose/<package>.md`. `make docs-packages-write` regenerates the pages.
- The error-code reference, generated from the code registries, in `src/docs/errors.md`.
- The compatibility page, the dependency policy, the migration runbook and the API snapshot in
  `src/docs/`.

## Planned shape

- Static output, built by the same pipeline as the frontpage (no docs SPA, no client-side framework).
- The protocol and target capability matrix, generated from a single source of truth (`DOC-012`).
- Versioned: each released minor gets a frozen page set; `latest` points at the newest release.

Documentation is a merge requirement, not a follow-up: a public API change without a docs diff
fails review.
