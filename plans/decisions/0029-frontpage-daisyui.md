# ADR-0029 — Compiled DaisyUI themes for the public site

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Tsir maintainers
- **Scope:** `src/apps/frontpage`, static documentation renderer, development server
- **Related:** DOC-001–007, DOC-009; ADR-0012 (dependency policy), ADR-0028 (docs renderer)

## Context

The public site needs a clearer product hierarchy, a complete ecosystem directory and
consistent light/dark themes. The requested visual system is DaisyUI Silk for light and
Abyss for dark, with a Laravel-inspired arrangement of hero, code showcases, alternating
feature sections, ecosystem navigation and grouped footer. Laravel's branding, social proof
and product claims are not Tsir's and must not be copied.

The original page was already 69,643 bytes, above its aspirational 60 KiB limit. Adding two
authentic theme definitions, component CSS, accessible controls and all 24 packages cannot
fit that old limit without removing useful content or maintainability.

A CDN stylesheet would violate the offline contract. A runtime JavaScript component library
would add cost and contradict the static, dependency-free delivery model. Hand-copying theme
values would drift from DaisyUI and would not actually use its components.

## Decision

1. Pin `daisyui`, `tailwindcss` and `@tailwindcss/cli` as **root development dependencies**.
   They are classified in ADR-0012's build-time inventory. No framework package gains a
   runtime dependency, and no framework source imports them.
2. Compile only the used button, badge, card and input components with the unmodified Silk
   and Abyss theme definitions. Inline the resulting CSS and a small progressive-enhancement
   script into `src/apps/frontpage/public/index.html`. Keep SVG and the favicon inline.
3. Author the template, styles, client script and typed package inventory separately. Commit
   the generated HTML so the dev server and a source checkout do not need a client build step.
   `bun run frontpage:build` regenerates it; `bun run frontpage` checks byte-for-byte freshness,
   package coverage, truthfulness, local documentation links and the size budget.
4. Raise the **uncompressed homepage** ceiling to 128 KiB. The current artifact is about
   122 KiB. This is a measured delivery budget, not a framework bundle-size claim. The page
   still makes no external asset requests. Documentation is a separate static destination.
5. Silk is the light palette; Abyss is the dark palette. Initial theme follows the OS; an
   explicit choice is saved under `tsir-theme` and shared by the homepage and docs. Storage
   failure is non-fatal. Without JavaScript the page remains readable in Silk.
6. Reuse the compiled stylesheet and script in the docs renderer. Build docs at dev startup,
   serve them under `/docs/`, and include them beside the homepage in distribution. Package
   cards link to real reference pages; examples link to runnable repository tests.
7. Keep package statuses conservative and explain open work on partial cards. A visual
   redesign does not close a framework task or establish production readiness.

## Consequences

- The site uses authentic DaisyUI components and themes without a CDN, web font, analytics,
  client framework or runtime package dependency.
- The generated file must be rebuilt after source changes. CI detects stale output rather
  than silently serving an old design.
- The larger budget funds complete ecosystem coverage and two themes. It is enforced, and
  the original 60 KiB target is explicitly superseded rather than silently ignored.
- Build tools require the pinned Bun lockfile and Node for the native Tailwind CLI. The
  generated page itself needs neither runtime.
- Accessibility is checked in both themes and at narrow widths. Keyboard-operated tabs,
  visible focus, reduced motion, labelled controls and no-JS content are part of the contract.
- Third-party MIT license notices are embedded in the generated HTML.

## Verification

- `bun run frontpage:build && bun run frontpage`
- `bun test src/apps/frontpage/build.test.ts src/tools/docs-site.test.ts`
- Browser smoke checks: theme persistence, navigation, package search/category filters,
  empty state/reset, keyboard tabs, clipboard, docs links and no external asset requests.
- Viewports: 320, 375, 390, 768, 1024 and 1440 CSS pixels; no page-level horizontal overflow.
- Axe WCAG A/AA checks in Silk and Abyss, plus a JavaScript-disabled content check.

Browser QA is a release check, not a claim of exhaustive assistive-technology coverage.
