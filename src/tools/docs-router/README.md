# `src/tools/docs-router/`

The client-side router for the documentation site. It is compiled by
[`docs-site.ts`](../docs-site.ts) (Svelte 5 → esbuild → minified IIFE) and
inlined into every generated page so the docs stay dependency-free at runtime.

The router powers client-side navigation with the View Transition API and
persists the sidebar scroll position between pages. It has no visible DOM of
its own — it only wires up click handlers for internal links.

The documentation *content* lives in [`src/docs/`](../../docs); the build
pipeline is in [`src/tools/docs-site.ts`](../docs-site.ts). This directory
contains only the router source.
