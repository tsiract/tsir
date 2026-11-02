# 10 — Framework Frontpage

> `src/apps/frontpage` — the welcome screen Tsir serves when a project is created, in the spirit of Laravel's welcome page: a fast, dependency-free page that orients a developer in ten seconds and advertises the ecosystem honestly.

**Status:** implemented at [`src/apps/frontpage/public/index.html`](../../src/apps/frontpage/public/index.html) and served by `make dev`.

---

## 1. Goals

| Goal                                                              | Non-goal                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Orient a developer who just ran `tsir new` / `make dev`           | Be a marketing microsite with animation for its own sake    |
| Show the ecosystem as a coherent map, with honest status          | Claim capabilities that are not implemented                 |
| Confirm the runtime is alive and configured (env, port, versions) | Replace documentation                                       |
| Look like a serious backend framework, not a JS demo              | Use a frontend framework (explicitly excluded by the brief) |

---

## 2. Constraints

1. **Zero runtime dependencies.** One homepage HTML file with compiled inline CSS, JavaScript and SVG. No CDN, web font, analytics or client framework (ADR-0029).
2. **No external assets.** Icons and favicon are inline; gradients are CSS. Documentation is a separate static destination, included in distribution.
3. **Progressive enhancement.** Runtime facts are injected server-side. All package cards, code examples and section links remain readable without JavaScript. Optional controls are hidden until their handlers are installed.
4. **Accessible.** WCAG 2.2 AA contrast, visible focus, semantic landmarks, keyboard-operated tabs, labelled search/filters, reduced motion and no keyboard traps.
5. **Honest branding.** Package statuses are conservative. Partial cards explain remaining work; a visual refresh never closes a framework task.
6. **Measured delivery.** The uncompressed homepage is at most **128 KiB**, enforced by the build and claims gate. ADR-0029 explicitly supersedes the old 60 KiB target, which the previous 69,643-byte page already exceeded.

## 3. Information architecture

Laravel-inspired hierarchy, not Laravel branding or unsupported claims:

1. Compact header: framework, ecosystem, documentation, examples, GitHub, theme switch.
2. Centered headline, pre-alpha disclosure, two actions and a runnable start command.
3. Tested code tabs: HTTP, validation and database examples from the package prose suite.
4. Alternating framework, data/secrets and deploy-unit showcases.
5. Complete 24-package ecosystem with search, category filters, honest statuses and docs links.
6. Principles, two runnable example applications and a three-step getting-started path.
7. Expandable live runtime facts, roadmap and measured bundle sizes.
8. Closing action and grouped framework/package/project footer.

Each package card has a unique `@tsir/*` name, `data-status`, `data-phase`, a real `data-src`,
a purpose, a reference link and, when partial, an explicit remaining-work note. The typed
inventory lives in `src/apps/frontpage/packages.ts`; the claims gate checks complete coverage.

### Source and delivery

```
src/apps/frontpage/
├── template.html       semantic structure and inline SVG
├── styles.css          Tailwind input, DaisyUI themes and responsive layout
├── client.js           optional browser enhancement
├── packages.ts         typed package inventory
├── build.ts            compile/inline; --check detects stale output
├── build.test.ts       reproducibility, coverage, escaping and offline checks
├── public/index.html   committed single-file artifact
└── package.json        private static app
```

`bun run frontpage:build` regenerates the artifact. `bun run frontpage` checks freshness and
claims. The dev server builds the Markdown docs at startup and serves them under `/docs/`.
`bun run dist` includes those docs beside the homepage so relative links work in both places.

## 4. Visual language

- **Light:** authentic DaisyUI **Nord** theme definitions.
- **Dark:** authentic DaisyUI **Abyss** theme definitions.
- Initial theme follows the OS. The explicit toggle persists `tsir-theme` in local storage;
  the preference is shared with docs. Storage failure is non-fatal; no-JS fallback is Nord.
- Semantic text/border aliases are derived from the active theme. Code windows retain a
  readable dark treatment in both modes. Small labels use a stronger contrast mix.
- System sans for prose, system monospace for code. No downloaded fonts.
- Spacious centered hero, alternating product sections, three-column package grid on desktop,
  two on tablet and one on mobile. Inline SVG diagrams illustrate actual framework boundaries.
- Motion is limited to short hover/focus feedback and is disabled by `prefers-reduced-motion`.

DaisyUI, Tailwind and its CLI are pinned root **development** dependencies, classified under
ADR-0012. Their MIT notices are embedded in the generated HTML. No framework source imports
them and no consumer bundle contains them. See [ADR-0029](../decisions/0029-frontpage-daisyui.md).

---

## 5. Dynamic content injected by the dev server

The dev server (`src/tools/dev.ts`) replaces `__TSIR_*__` tokens **on each request** (it does not write to disk):

| Token              | Source                            | Fallback      |
| ------------------ | --------------------------------- | ------------- |
| `__TSIR_VERSION__` | root `package.json` version       | `0.0.0`       |
| `__TSIR_BUN__`     | `Bun.version`                     | `unknown`     |
| `__TSIR_NODE__`    | `process.versions.node`           | `unknown`     |
| `__TSIR_OS__`      | `os.platform() + ' ' + os.arch()` | `unknown`     |
| `__TSIR_ENV__`     | `APP_ENV` or `development`        | `development` |
| `__TSIR_PORT__`    | bound port                        | `3000`        |
| `__TSIR_STARTED__` | boot timestamp (ISO)              | —             |

This makes the page a genuine **health/orientation screen**, not a static brochure. In production builds (`bun run dist`), tokens are baked once at build time. Unmeasured sizes say `not measured`; run `make verify-dist` to obtain measurements.

---

## 6. Content rules

- Every command shown is **runnable in the repository as it stands**. A command that does not exist yet is not shown on the page. (Examples include `make install`, `make dev`, `make doctor`, `make deploy-plan` and the two example test commands.)
- Status badges must match the repository. Changing a badge is a docs change and requires a task update — `src/tools/check-frontpage.ts` parses the HTML for `data-status` and `data-src` attributes and compares the claim against the package directory on disk.
- No superlatives ("fastest", "most secure", "better than Laravel") without a committed benchmark or review: `DOC` test greps for the banned-claims list.
- Ecosystem names use the proposed `Tsir <Module>` labels from the brief; `@tsir/*` package names appear in monospace so users can copy them once published. Until publication, cards link to local reference pages, not at npm.

---

## 7. Failure modes

| Failure                                   | Behavior                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `index.html` missing                      | Dev server serves a minimal built-in fallback with the same tokens resolved            |
| Token unresolved at distribution time     | Build fails rather than inventing a value                                              |
| Port already in use                       | `make dev` runs `make kill` first; if still occupied, fails with `make kill: PID` hint |
| Page served outside the workspace preview | Fully functional — no external requests, no absolute URLs                              |
| JavaScript disabled                       | All content visible; enhancement-only controls stay hidden                             |

---

## 8. Acceptance criteria

1. Single homepage file, ≤ 128 KiB uncompressed, zero external asset requests (build gate and browser smoke test).
2. Lighthouse performance ≥ 95 remains an optional release target, not a measured claim in this refresh.
3. Axe checks in both themes, keyboard smoke checks and 320–1440px overflow checks. The recorded 2026-10-31 pass is in the task ledger; CI automation of browser QA remains separate from the deterministic build tests.
4. All ecosystem cards present, with `data-status` values matching the plans.
5. `make dev` serves it in < 500 ms after start; token values reflect the running environment.

---

## 9. Security considerations

The page is served by the framework's own dev server, and in a created project it is a static
file. Three rules follow:

- **No network at render time.** No web fonts, no analytics, no CDN script, no remote image. A
  page that phones home on load tells a third party who is evaluating the framework, and it
  fails the one-file contract (`DOC-004`).
- **Tokens are substituted server-side, never by client templating.** The `__TSIR_*`
  placeholders are replaced by `src/tools/dev.ts` before the bytes leave the process, so no
  token value is ever handed to a browser as data to interpolate. The values substituted are
  versions and build facts — the mechanism is string replacement, so a secret that reached it
  would be visible in `view-source`.
- **The page is in `make check`.** `check-frontpage.ts` fails the build on a banned superlative,
  a status claim with no backing package directory, or a `data-src` that does not exist. That is
  a _claims_ gate, not a security control: it stops the project from lying about itself and
  defends against nothing else.

---

## 10. Open questions

| #    | Question                                                                                                                                                                                 | Blocks  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Q27  | Should the page be reachable at `/` in _user applications_ (opt-in `tsir welcome` route) or only in the frontpage app? Current: frontpage app + optional `tsir welcome:route` generator. | Phase 2 |
| Q28  | Add a "what this app contains" panel (module list from the resolved config) via a JSON endpoint?                                                                                         | Phase 2 |
| `Q5` | Docs framework for `src/docs` — a static pipeline shared with this page? Defined in [`00-foundation.md § 6`](../roadmap/00-foundation.md#6-open-questions).                              | Phase 6 |

---

## 11. Task index

[`tasks/09-frontpage.md`](../tasks/09-frontpage.md) — `DOC-001` … `DOC-014`.

## 12. Application-first entry point

The landing page introduces the distribution's `tsir` command, then links to an installation-first
manual. Repository Make targets remain contributor build and test tools, not the application
workflow. Pre-alpha and unpublished-package limitations stay visible; do not imply cloud resources
are provisioned automatically.
