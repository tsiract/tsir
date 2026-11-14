# Tasks — Documentation inventory (Phase 0, alongside `17-dx-data-layer.md`)

> Stale documentation is a defect with no error message. This file makes it countable: every claim
> below was produced by `bun src/tools/doc-inventory.ts` (or the tool named in the acceptance
> column), not by reading and guessing. Re-run the tool before starting a row — the numbers move.
>
> **Plan:** [`10-frontpage.md`](../modules/10-frontpage.md) · **Tools:**
> [`doc-inventory.ts`](../../src/tools/doc-inventory.ts), [`task-status.ts`](../../src/tools/task-status.ts) ·
> **Priority:** P0, after `17-dx-data-layer.md`.

**Status: open.** The inventory is a measurement, not a guess. Measured 2026-11-14 at the commit that
added this file:

| Measure                                                 | Value | Where the number comes from                     |
| ------------------------------------------------------- | ----- | ----------------------------------------------- |
| Packages with a generated reference page                | 34/34 | `docs-packages` — every package, generated      |
| Packages with hand-written prose (Example/Failures/Sec) | 26/34 | `doc-inventory.ts`                              |
| Error codes with no prose naming them                   | 25    | `docs-packages` (`Failure modes do not name …`) |
| Guides                                                  | 9     | `doc-inventory.ts`                              |
| Runnable guide examples (executed by `guides.test.ts`)  | 24    | `doc-inventory.ts`                              |
| Guides with no runnable example                         | 2     | `make.md`, `providers.md`                       |
| Empty sections in guides                                | 0     | `doc-inventory.ts`                              |
| Task rows with a status but **no id** (uncitable)       | 251   | `task-status.ts`                                |
| Task rows using the retired `✅` notation               | 28    | `task-status.ts`                                |

---

## 1. The documentation state we are in

The `src/docs` set is generated where it can be and written where it must be. The generated half is
honest by construction and gated on every `make check`:

| Artefact                  | Generated from                                   | Gate                                |
| ------------------------- | ------------------------------------------------ | ----------------------------------- |
| `packages/<name>.md` × 34 | `package.json`, `api-surface.json`, `prose/*.md` | `make docs-packages`                |
| `errors.md`               | the `*ErrorCode` unions in every package         | `make error-codes`                  |
| `capabilities.md`         | the `CAPABILITIES` registry                      | `make docs-packages`                |
| `api-surface.json`        | every public export of every package             | `make surface-write` / `make check` |
| `llms.txt`                | the docs tree and the plan index                 | `make llms-check`                   |
| README counts             | a real `bun test` run                            | `make readme-check`                 |

The written half — nine guides, eight root documents, the frontpage — has no equivalent gate. Its
examples are executed (`guides.test.ts`) and its links are checked (`check-links.ts`), and that is
where the mechanical coverage stops. A guide can therefore describe a command that was renamed, an
option that no longer exists, or a package that has since gained a second entrypoint, and every gate
stays green.

**The frontpage is the same story, one layer out.** `check-frontpage.ts` proves
`data-status`/`data-src` agree with `src/framework/`, and nothing proves that what a card _says_ is
still true. That is `DOCS-008`.

---

## 2. The rules this file introduces

1. **A document that describes the framework is owned by a task.** If no task owns it, the next
   change will not update it, and the only thing keeping it true is luck.
2. **A claim that can be measured is measured, not asserted.** `doc-inventory.ts` exists so "a lot of
   stale documentation" is a number with a diff, not an adjective.
3. **Docs land with the change or the change is not finished.** `check-docs-in-pr.ts` covers public
   API diffs; `DOCS-011` extends it to a renamed or removed config key, command or error code.
4. **A generated artefact must not describe what it does not index.** This is already the standing
   rule; the failures it caught (`llms.txt` naming a plan that had been renumbered) are why it is
   repeated here.

---

## 3. Tasks

### 3.1 Coverage — the pages that do not exist

The eight packages below have a generated reference page and no prose. `docs-packages` requires the
`Failure modes` section to name every error code the package can throw, so each missing page also
leaves codes undescribed.

| ID         | Task                                                     | Status | Depends   | Acceptance                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCS-001` | Prose for `@tsir/broadcast` (34 exports)                 | `[ ]`  | —         | `prose/broadcast.md` with Example, Failure modes and Security notes. The Example is executed by `package-examples.test.ts` and prints. Every broadcast error code is named. Real providers (`redis`, `pusher`, `durable-object`) appear in the page.                         |
| `DOCS-002` | Prose for `@tsir/media` (28 exports, 8 codes)            | `[ ]`  | —         | Same shape. The page states which drivers transform where (Cloudflare Images vs `sharp` vs `ffmpeg`) and what each refuses. The 8 undocumented codes are named in `Failure modes`.                                                                                           |
| `DOCS-003` | Prose for `@tsir/pennant` (28 exports, 6 codes)          | `[ ]`  | `INF-011` | Same shape. Documents the `placeholder`/`engine` option and the MySQL refusal, which is the behaviour `INF-011` established.                                                                                                                                                 |
| `DOCS-004` | Prose for `@tsir/socialize` (17 exports, 5 codes)        | `[ ]`  | —         | Same shape. OAuth 1.0a vs 2.0, state/PKCE, and what the stateless mode refuses are stated explicitly.                                                                                                                                                                        |
| `DOCS-005` | Prose for `@tsir/forge` (21 exports, 1 code)             | `[ ]`  | —         | Same shape. SSH/local/cloud providers named, and the credential handling stated in Security notes.                                                                                                                                                                           |
| `DOCS-006` | Prose for `@tsir/cashier` (15 exports, 5 codes)          | `[ ]`  | —         | Same shape. Stripe vs Paddle as named drivers, webhook verification, and idempotency keys covered under Security notes.                                                                                                                                                      |
| `DOCS-007` | Prose for `@tsir/nightwatch` (7 exports) and `@tsir/tui` | `[ ]`  | —         | Same shape, both packages. Neither throws a code of its own, which the page says rather than leaving the section empty.                                                                                                                                                      |
| `DOCS-008` | The frontpage's claims are checked against the code      | `[ ]`  | —         | Extend `check-frontpage.ts`: every driver, engine or default named on the page must appear in a `DRIVER_DEFAULTS`/`CAPABILITIES` registry, and every capability card links to a page that exists. A claim the page can make and the code cannot back fails `make frontpage`. |

### 3.2 Guides — executed, linked, and not thin

| ID         | Task                                                        | Status | Depends  | Acceptance                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCS-009` | A runnable example in every guide                           | `[ ]`  | —        | `make.md` and `providers.md` gain at least one ```ts block that `guides.test.ts` executes and that prints. The gate changes from "examples that exist are executed" to "every guide has one", asserted by `doc-inventory.ts`.                               |
| `DOCS-010` | A guide for the data layer, written after `DX-004`/`DX-006` | `[ ]`  | `DX-006` | `guides/models.md`: `defineModel`, `Users.find`, a relation with `with()`, and the four strictness rules stated as things that will not compile — each one shown as a `@ts-expect-error` case in the example's test. Linked from `index.md` and `llms.txt`. |
| `DOCS-011` | Docs-in-PR catches renamed config, commands and error codes | `[ ]`  | —        | `check-docs-in-pr.ts` fails when a public API diff renames/removes a `tsir.js` key, a CLI command or an error code and no document changed. Today it only reacts to export changes.                                                                         |
| `DOCS-012` | A guide for capability resolution, written after `DX-012`   | `[ ]`  | `DX-012` | `guides/capabilities.md`: the one resolution rule, `cacheFor('sessions')`, what refuses at boot and what the refusal says. Its example constructs two capabilities from one config record.                                                                  |

### 3.3 The ledger itself — every row is a task

| ID         | Task                                             | Status | Depends    | Acceptance                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------ | ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCS-013` | Give the parity ledger's 245 feature rows ids    | `[x]`  | —          | Done: all 249 rows in § 6 of the parity ledger carry a `PARITY-NNN` id, and `bun src/tools/task-status.ts --parity` recounts § 7.2 from them — 176 verified, 11 partial, 62 open, 75.1 % including partial. The ledger went from 702 countable tasks to 931.                                                               |
| `DOCS-014` | Retire the `✅` notation in 28 rows              | `[x]`  | —          | Done: 28 `✅` cells became `[x]` across `01-foundation.md` and `21-frontpage.md`. `task-status.ts` reads `✅` as done and fails a new one, checking only the status cell — `DOCS-014`'s own title names the notation rather than using it.                                                                                 |
| `DOCS-015` | `plans/tasks/STATUS.md` is generated and gated   | `[x]`  | —          | Done: `make tasks` writes `STATUS.md`; `make check` runs `tasks-check` and fails when it is stale. Totals, per-file counts, id-prefix counts, and every open task by id — 931 tasks, 732 done. Linked from the task index and from `llms.txt`.                                                                             |
| `DOCS-016` | An acceptance note in every open task            | `[ ]`  | —          | `task-status.ts` fails on an open/partial/blocked row with an empty acceptance cell. Rows currently passing on a title alone are filled in or deleted.                                                                                                                                                                     |
| `DOCS-017` | Read the frontpage as a stranger and as an agent | `[ ]`  | `DOCS-008` | Two recorded passes over `src/apps/frontpage/public/index.html`: one as someone deciding whether to use the framework (can they get to a running app in one command?), one as an agent (can they find the gate list, the commit scope enum and the file map?). Disagreements become rows in this file, not edits to prose. |

---

## 4. Sequencing

`DOCS-013`/`DOCS-014`/`DOCS-015`/`DOCS-016` first: they make the rest of this file and every other
task file countable, and they are what "everything must be task-based so we do not hallucinate"
needs in order to be true rather than a promise.

Then `DOCS-001`…`DOCS-008` in size order (smallest package first, so the shape is agreed before the
34-export ones), then `DOCS-009`/`DOCS-011`, then the guides that depend on the data-layer work.

---

## 5. Failure modes this file exists to prevent

| Failure                                                              | Which task catches it                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A package page whose `Failure modes` section names none of its codes | `DOCS-001`…`DOCS-007`, and `docs-packages` fails until it does        |
| A guide example that no longer runs                                  | `guides.test.ts` (already) and `DOCS-009` for the two with no example |
| A frontpage card describing a driver that was renamed                | `DOCS-008`                                                            |
| A renamed config key shipped with the docs unchanged                 | `DOCS-011`                                                            |
| A task counted as done because nobody re-read its row                | `DOCS-015` — the count is generated                                   |
| A "status" that is a sentence, not a marker                          | `DOCS-014` — `task-status.ts` reports any row it cannot parse         |
