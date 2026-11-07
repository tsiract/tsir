# Tsir public site

A static, single-file homepage with compiled DaisyUI **Silk** (light) and **Abyss** (dark).
The content and package statuses are Tsir's. See ADR-0029 for the dependency and delivery decision.

## Edit and build

```sh
bun install
bun run frontpage:build
bun run dev
```

- `template.html`: page structure and inline SVG symbols.
- `styles.css`: Tailwind/DaisyUI input and responsive layout.
- `packages.ts`: typed inventory of all 24 packages, statuses and remaining-work notes.
- `client.js`: optional theme, navigation, tabs, clipboard and ecosystem-filter enhancement.
- `public/index.html`: committed generated artifact. Do not edit directly.

`bun run frontpage` checks artifact freshness, package truthfulness, reference links and the
128 KiB uncompressed homepage budget. `bun run dist` also includes the static documentation.
The dev server builds docs at startup and serves them at `/docs/`.

The homepage makes no external asset requests. It uses system fonts, inline SVG, inline CSS
and inline JavaScript. All content remains readable without JavaScript. Theme preference is
stored locally when storage is available; no analytics or remote service is used.

## Verify

```sh
bun test src/apps/frontpage/build.test.ts src/tools/docs-site.test.ts
bun run frontpage
bun run typecheck
bun run lint
```

Browser release checks should cover both themes, 320–1440px widths, keyboard navigation,
search/filter reset, copy feedback, docs navigation and JavaScript-disabled rendering.
