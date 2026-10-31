# ADR-0006 — `tsir.js` as Canonical, Governed Project Configuration

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/config`, `@tsir/console`, `@tsir/deploy`, generators

---

## Context

The brief requires "a `tsir.js` configuration, where we have our own default coded configuration in it, and they can do an automated configuration… like a bootstrap for all, like for http, console, deploy."

Requirements implied:

1. One canonical file must exist (the brief names it).
2. It must work out of the box (defaults provided by presets).
3. Tooling must be able to update it automatically (bootstrap, generators, deploy plan) without destroying user edits.
4. It must be typed enough to validate, and dynamic enough to support environment differences.

## Decision

1. **`tsir.js` is canonical.** Resolution order: `tsir.config.js` → `tsir.js` → `tsir.mjs`. Ambiguity is an error, never a guess.
2. Shape: `export default defineConfig({ preset, modules, http, database, vault, console, deploy, … })`.
3. **Presets** supply defaults (`preset.standard()`, `preset.edge()`, …). The generated file always includes the preset call, so defaults are visible, not hidden.
4. **No secrets in `tsir.js`.** Any value that must vary by environment is declared `{ fromEnv: 'NAME', secret?: true }` and resolved at boot. The validator actively rejects inlined secrets.
5. **Governed file.** Tooling may only rewrite delimited `// ── managed:<id>:start/end` regions. Unmanaged text is never modified; malformed markers are a hard error.
6. **`tsir bootstrap`** is the automation entry point: detect → plan (diff) → validate → apply → write `.tsir/manifest.json`. A plan that fails validation is never applied, and non-interactive application requires `--yes`.
7. The file is **synchronous and static**. Anything async or dynamic belongs in env vars or a preset, because config is loaded before any I/O is allowed.

## Consequences

**Positive**

- A single reviewable artifact describes the app: modules, HTTP behavior, console commands, deploy topology/targets.
- Automation is safe: users keep ownership of their file, tools keep ownership of their regions.
- Environments differ via env vars only — no `tsir.production.js` variants, no config drift between environments in git.
- Deploy topology is explicit in the file (supports ADR-0005's "visible default").

**Negative / costs**

- Two sources of truth for values (file + env) require clear precedence rules and good error messages. Documented in `03-core.md § 4.1`.
- Managed regions add a concept users must learn; mitigated by never failing silently and printing every rewrite.
- Fetching a preset from a third party executes code at config load; documented, and bootstrap never installs anything automatically.

## Alternatives considered

| Alternative                                           | Why rejected                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tsir.json` / TOML                                    | No comments-in-place tooling, no `fromEnv` semantics, weaker typing, and cannot express presets without a mini-language      |
| `tsir.config.ts` canonical                            | Works with Bun, but excludes editors/tools that don't transpile; `.ts` is tolerated, not canonical (`09-tsir-config.md` Q24) |
| Environment-only configuration (Twelve-Factor purist) | Cannot express structural choices (which units, which targets) that belong in the repo                                       |
| Convention-only, no file (infer everything)           | Violates "explicit" and "predictable"; topology would change silently                                                        |

## Revisit conditions

If a standard project-config format for Bun emerges and is broadly adopted, add a loader rather than replace `tsir.js`.
