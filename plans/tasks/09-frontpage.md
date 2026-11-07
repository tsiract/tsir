# Tasks — Docs & Frontpage (Phases 0, 6, 8)

> Welcome page, docs site, ecosystem naming checks.

**Plan:** [`../10-frontpage.md`](../modules/10-frontpage.md)

---

## Frontpage

| ID        | Title                                                              | Status | Depends | Acceptance criteria (summary)                          |
| --------- | ------------------------------------------------------------------ | ------ | ------- | ------------------------------------------------------ |
| `DOC-001` | Frontpage HTML (single file, inline CSS/SVG, no external requests) | ✅     | —       | Loads offline; zero network requests                   |
| `DOC-002` | Ecosystem grid with `data-status` badges                           | ✅     | DOC-001 | Every proposed module has a card                       |
| `DOC-003` | Token injection by dev server                                      | ✅     | FND-005 | Version/runtime/env/port shown live                    |
| `DOC-004` | `data-status` ↔ repository consistency test                        | ✅     | DOC-002 | Mismatch fails CI                                      |
| `DOC-005` | Banned-claims grep ("fastest", "most secure", …)                   | ✅     | DOC-002 | CI fails on superlatives without evidence link         |
| `DOC-006` | Accessibility pass (axe, keyboard, contrast)                       | `[x]`  | DOC-001 | Nord/Abyss axe checks and keyboard smoke tests pass    |
| `DOC-007` | Offline/no-JS verification test                                    | `[x]`  | DOC-001 | No external assets; all cards/code readable without JS |
| `DOC-008` | `tsir welcome:route` generator (optional in-app page)              | `[ ]`  | CLI-009 | Opt-in route serves same page                          |

### Design refresh verification (2026-10-31)

ADR-0029 adds DaisyUI Nord/Abyss, a persisted theme switch, 24 linked package cards and static
`/docs/` navigation. Chromium checks covered 320/375/390/768/1024/1440px layouts, theme persistence,
mobile navigation, search/category/reset, keyboard code tabs, clipboard and documentation links.
Axe reported no violations for the homepage in either theme or the HTTP reference in Abyss.
JavaScript-disabled checks kept all package cards and code examples visible. These are recorded
smoke checks, not exhaustive assistive-technology certification. DOC-008 remains optional/open.

## Docs site

| ID        | Title                                                                   | Status | Depends | Acceptance criteria (summary)           |
| --------- | ----------------------------------------------------------------------- | ------ | ------- | --------------------------------------- |
| `DOC-009` | `src/docs` skeleton + static build                                      | `[x]`  | FND-013 | Built docs deployable as static files   |
| `DOC-010` | One page per public package (install, example, failure modes, security) | `[x]`  | DOC-009 | Lint: every package has a page          |
| `DOC-011` | Error-code reference generated from code registries                     | `[x]`  | ERR-004 | Every code documented, none stale       |
| `DOC-012` | Capability matrix page generated from `07-link.md § 8` + deploy probes  | `[x]`  | DPL-003 | Single source of truth                  |
| `DOC-013` | Upgrade guide + compatibility policy page                               | `[x]`  | FND-011 | SemVer + deprecation process documented |
| `DOC-014` | API reference extraction from `.d.ts`                                   | `[x]`  | DOC-009 | Public surface only; no internals       |

## Naming & legal

| ID        | Title                                                     | Status | Depends | Acceptance criteria (summary)                                                                                 |
| --------- | --------------------------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------- |
| `DOC-015` | Package-name availability check (`@tsir/*`, npm registry) | `[ ]`  | —       | Report committed to `plans/decisions/`                                                                        |
| `DOC-016` | Trademark / project-confusion search for "Tsir"           | `[ ]`  | —       | Written findings; blockers flagged                                                                            |
| `DOC-017` | LICENSE + third-party attributions                        | `[x]`  | FND-017 | `LICENSE` (MIT) committed and enforced by `make license`; lockfile attributions in `src/docs/attributions.md` |

---

## Notes

- `DOC-001`–`DOC-003` are satisfied by the current milestone; the file exists at `src/apps/frontpage/public/index.html` and is served by `make dev`.
- `DOC-004` and `DOC-005` exist to keep the page honest as phases land — they are the cheapest guard against marketing drift.
- No npm publish happens before `DOC-015` and `DOC-016` are complete.
- The license is MIT (decided 2026-10-27) and is **not** blocked by the naming review: a
  rename of the `@tsir` scope does not change the terms anything published so far was under.
  Trademark availability of the "Tsir" name is still open (`Q7`, `DOC-015`).
- DOC-010: 24 package pages carry written prose (install, example, failure modes, security notes). Examples run in the harness and every owned error code is covered. Security notes were checked against source and tests on 2026-10-30: mail header injection and production refusal, notify signing and allowlist, database parameter and literal scrubbing, seed environment refusal, and the deploy private-route and secret scan are all covered by tests. Still partly evidenced: mail never writes provider keys into a message (keys are read from the environment and checked at boot; no test proves the rendered message is clean). Seed fake-data advice is guidance, not a property. See `tasks/manual-verification.md`.
