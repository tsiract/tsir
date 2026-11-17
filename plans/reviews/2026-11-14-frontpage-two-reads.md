# Two reads of the frontpage (`DOCS-017`)

Two recorded passes over `src/apps/frontpage/public/index.html`, at `b29d180`. One as a person
deciding whether to use the framework; one as an agent told to work in this repository. Every claim
in the "found" column was checked against the code or a gate, not against memory — the check is
named in the "how it was verified" column, and a finding that cannot be verified is not a finding.

The rule for the pass: **a disagreement becomes a task row, not an edit to the prose.** Two of the
findings here were edits to the page because the page was factually wrong about a link; the rest are
rows in [`../tasks/28-docs-inventory.md`](../tasks/28-docs-inventory.md).

---

## 1. As a stranger: "can I get to a running app in one command?"

| Step             | What the page says                                                    | What the reader has to work out                                                                    | Verdict |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| Install          | "Install Bun and follow the distribution setup guide."                | Which guide. The link went to `docs/`, the documentation index, not `docs/installation.html`.      | Fixed   |
| Create           | `tsir new hello`                                                      | Where `tsir` comes from. It is the **built** distribution (`make dist`), and no package is on npm. | Row     |
| Start            | `tsir dev`                                                            | Nothing — this is the one right way, and it is correct.                                            | Fine    |
| Build something  | "…and explore the guides", linking `docs/`.                           | The page stops at the docs index exactly where the reader wants the next command.                  | Fixed   |
| Try the examples | `bun test src/apps/frontpage` · `bun test src/apps/admin.product.com` | Both commands run from a checkout, and both pass. Nothing to work out.                             | Fine    |

**The honest summary of this pass.** The page answers "what is this" and "why would I care" well. It
does not answer "how do I get a working `tsir` binary", because the answer is currently "build the
distribution from a git checkout", which is a sentence a marketing page does not enjoy writing. That
is a real gap and it is `DOCS-020` below, not a wording problem.

**Verified:**

```sh
bun test src/apps/frontpage          # 4 pass
bun test src/apps/admin.product.com  # 18 pass
```

## 2. As an agent: "can I find the gate list, the commit scopes, the file map?"

| Question                                     | Where the page sends them             | Where the answer actually is              | Verdict |
| -------------------------------------------- | ------------------------------------- | ----------------------------------------- | ------- |
| Which gates will reject my change?           | nowhere                               | `AGENTS.md` § 2, and `make help`          | Fixed   |
| What commit scope do I use?                  | nowhere                               | `AGENTS.md` § 5, `commitlint` config      | Fixed   |
| Where does a new file go?                    | nowhere                               | `AGENTS.md`, `plans/tasks/README.md` §1.2 | Fixed   |
| Is the page's own status generated or typed? | the page shows version, sizes, health | `src/tools/dev.ts` injects them at serve  | Fine    |
| Can I trust a card's driver list?            | "an honest status"                    | `make frontpage` (`frontpage-claims.ts`)  | Fine    |

**What changed for this pass.** The page had no path to `AGENTS.md`, which is the one file written
for exactly this reader. The status panel now links it with the three things an agent needs first
(gates, commit scopes, file map) — one sentence, because the page has a 128 KiB single-file budget
and the budget is the reason it is one sentence.

**What did not change, and why.** The page does not try to _contain_ the file map. A marketing page
that reproduces `AGENTS.md` is a second copy that will disagree with the first, which is the failure
`DOCS-008` and `check-frontpage` exist to prevent.

---

## 3. The rows this pass produced

| Id         | Finding                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCS-020` | The page tells a reader to install the distribution, and the distribution is not published. The install step needs the four commands that build it from a checkout, or a link to the guide that has them.                                                                                     |
| `DOCS-021` | The three code samples at the top are `exampleOf()`-extracted from `prose/{http,validate,database}.md` and executed by the package test suite — true, and worth a gate that says the three names are still the three the page shows.                                                          |
| `DOCS-022` | The "34 packages" count and the filter buttons come from `packages.ts`; the count is correct today and nothing fails if a package is added without a card. A package with no card already fails `check-frontpage`, so this is covered — recorded here so the next reader does not re-open it. |

## 4. What this pass is not

It is not a usability study, an accessibility audit or a copy edit. It is two question lists with the
answers checked against the repository, because the failure mode this file exists to catch is a page
that a maintainer remembers as fine and that a stranger cannot use.
