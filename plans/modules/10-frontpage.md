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

1. **Zero runtime dependencies.** One HTML file, inline CSS, inline SVG. No CDN, no web fonts, no analytics. This is both a branding statement ("we don't ship a frontend framework") and a practical one: the page must work in an offline container, in a sandboxed iframe, and on a plane.
2. **No external assets.** All icons are inline SVG; all gradients are CSS.
3. **Progressive enhancement only.** Live data (version, port, config summary) is rendered server-side by the Bun dev server via token replacement; with JavaScript disabled the page still reads correctly, with the tokens replaced by static defaults.
4. **Accessible.** WCAG 2.2 AA contrast for text, visible focus rings, semantic landmarks, `prefers-reduced-motion` respected, no keyboard traps.
5. **Honest branding.** Sections for unbuilt features are labeled `planned` — never presented as present tense capabilities.

---

## 3. Information architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  header:  tsir ◧   Docs  Ecosystem  Examples  GitHub     [v0.0.0]    │
├──────────────────────────────────────────────────────────────────────┤
│  hero:    "The backend framework that shows its work."               │
│           Strictly typed · Bun · Drizzle · Postgres · Edge-ready     │
│           $ bun run tsir dev        [ copy button ]                  │
│           status chips:  runtime bun 1.x · env development           │
│                          port 3000 · config tsir.js ✓                │
├──────────────────────────────────────────────────────────────────────┤
│  ecosystem grid (cards, grouped in 4 rows):                          │
│    Foundation:  Core · Container · Config · Validate                 │
│    HTTP:        Router · HTTP · Console                              │
│    Data:        Database · Migrate · Seed · Vault                    │
│    Interop:     Link (REST/gRPC/SOAP/WS)                             │
│    Deploy:      Deploy (Workers/Lambda)                              │
│    Capabilities (planned): Auth · Policy · Cache · Queue · Events    │
│                            Schedule · Mail · Notify · Storage·Pulse  │
├──────────────────────────────────────────────────────────────────────┤
│  principles strip:  no global locator · compiled routes ·           │
│                     fail-closed crypto · explicit transactions        │
├──────────────────────────────────────────────────────────────────────┤
│  next steps:  1. create a controller   2. add a migration           │
│               3. describe deployment   4. read the source            │
├──────────────────────────────────────────────────────────────────────┤
│  footer:  Tsir v<version> · Bun <bun> · Node <node> · <os> ·        │
│           docs · changelog · security policy                         │
└──────────────────────────────────────────────────────────────────────┘
```

Each ecosystem card contains: name (`@tsir/core`), one-line purpose, a status badge (`shipping` when implemented in the current phase, `planned` otherwise), and a `data-src` path into the package directory that backs the claim.

---

## 4. Visual language

| Token      | Value                                                        | Rationale                                          |
| ---------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Background | `#0a0c10` with a subtle radial wash                          | Dark, low-glare, familiar to backend tooling       |
| Surface    | `#11151c`, border `#1e2632`                                  | Card separation without shadows                    |
| Text       | `#e6ebf2` primary, `#93a1b3` secondary                       | AA contrast on both surfaces                       |
| Accent     | `#7dd3a0` (mint, "explicit/correct")                         | Distinct from Laravel red, Nest red, Adonis purple |
| Accent-2   | `#7aa2f7` (blue, links/commands)                             | Command blocks and links                           |
| Type       | `ui-monospace` for commands and names; system sans for prose | No web fonts                                       |

Grid rules: 4-column card grid ≥ 1100 px, 2-column ≥ 720 px, 1-column below. The `Link` and `Deploy` cards are visually wider (they are the differentiators called out in the brief).

Motion: one 120 ms fade-in on load; no parallax, no marquee. `prefers-reduced-motion: reduce` disables it.

**Theming.** Dark is the default; `prefers-color-scheme: light` switches to a re-derived palette (not an
inversion) whose accent hues are darkened so tinted surfaces keep ≥ 4.5:1 text contrast. Inline SVGs use
presentation attributes that are remapped through CSS custom properties, so both themes are contrast-checked
in one place. There is no manual theme toggle: the OS preference is the only input.

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

This makes the page a genuine **health/orientation screen**, not a static brochure. In production builds (`tsir build`), tokens are baked once at build time.

---

## 6. Content rules

- Every command shown is **runnable in the repository as it stands**. A command that does not exist yet is not shown on the page. (The page currently shows `make dev`, `make kill`, `make check`, `bun run tsir`.)
- Status badges must match the repository. Changing a badge is a docs change and requires a task update — `src/tools/check-frontpage.ts` parses the HTML for `data-status` and `data-src` attributes and compares the claim against the package directory on disk.
- No superlatives ("fastest", "most secure", "better than Laravel") without a committed benchmark or review: `DOC` test greps for the banned-claims list.
- Ecosystem names use the proposed `Tsir <Module>` labels from the brief; `@tsir/*` package names appear in monospace so users can copy them once published. Until publication, cards point at the package directory, not at npm.

---

## 7. Failure modes

| Failure                                   | Behavior                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `index.html` missing                      | Dev server serves a minimal built-in fallback with the same tokens resolved            |
| Token unresolved                          | Rendered as `—` (em dash), never a raw `__TSIR_*__` string                             |
| Port already in use                       | `make dev` runs `make kill` first; if still occupied, fails with `make kill: PID` hint |
| Page served outside the workspace preview | Fully functional — no external requests, no absolute URLs                              |
| JavaScript disabled                       | All content visible; copy buttons hidden via `<noscript>` styling                      |

---

## 8. Acceptance criteria

1. Single file, ≤ 60 KiB uncompressed, zero network requests after load (verified by an offline test).
2. Lighthouse: performance ≥ 95 on a throttled profile (static page, so this is a guard, not a boast).
3. Colour contrast checked programmatically in CI (`axe` run over the built page).
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
| `Q5` | Docs framework for `apps/docs` — a static pipeline shared with this page? Defined in [`00-foundation.md § 6`](../roadmap/00-foundation.md#6-open-questions).                             | Phase 6 |

---

## 11. Task index

[`tasks/09-frontpage.md`](../tasks/09-frontpage.md) — `DOC-001` … `DOC-014`.
