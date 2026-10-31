# Requests for Comments

An RFC is a **written proposal for changing the project itself**, published before the work
starts so that the design can be argued with while arguing is still cheap.

This directory is deliberately separate from the internal design plans and from the architecture
decision records. The three answer different questions:

| Artefact | Question it answers                          | Lives in                                              |
| -------- | -------------------------------------------- | ----------------------------------------------------- |
| **RFC**  | _Should we do this at all, and roughly how?_ | `rfc/` — public, open for discussion                  |
| **ADR**  | _What did we decide, and what does it cost?_ | the ADR index — one decision, immutable once accepted |
| **Task** | _Who is doing it, and when is it done?_      | the task ledger — `PREFIX-NNN`, acceptance-tested     |

An RFC that changes architecture usually ends with an ADR. That is the intended path: the RFC
holds the argument, the ADR holds the verdict.

---

## 1. What belongs here

**In scope — open an RFC:**

- **New features.** A capability, a package, an entrypoint, a public API that does not exist yet.
- **Breaking changes.** Anything that removes, renames, or changes the meaning of something
  already released or already documented as stable.
- **Tooling and process that improve the project itself.** A generator, a gate, a CI job, a
  build step, a testing strategy, a change to the plan or review process, a new entry in the
  dependency policy.

**Out of scope — use the right channel instead:**

| Not an RFC                                          | Where it goes                          |
| --------------------------------------------------- | -------------------------------------- |
| A **bug** — something that should work and does not | the issue tracker, with a reproduction |
| A question about how to use the framework           | discussions                            |
| A typo, a broken link, a stale number               | a pull request, no RFC needed          |
| A change already covered by an accepted ADR         | a pull request that implements it      |
| A request that only one application needs           | that application's repo                |

The distinction that matters: **an RFC proposes an improvement; it never reports a defect.**
If the proposal starts with "X is broken", it is a bug report and it belongs in the issues.
If it starts with "X should also do Y, and here is what that costs", it is an RFC.

---

## 2. The process

```
Draft ──▶ Discussion ──▶ Accepted ──▶ implementation (a task with an id)
  │            │
  │            ├──▶ Rejected   (kept, with the reason, so it is not re-proposed blind)
  └──▶ Withdrawn (author steps back; kept for history)
```

1. **Draft.** Copy [`0001-sample-template-here.md`](./0001-sample-template-here.md) to
   `NNNN-kebab-case-title.md`, fill every section, open a pull request. The file name is the
   pull request.
2. **Discussion.** The comment thread on that pull request is the discussion. The RFC file is
   amended as the argument moves — a proposal that only lives in comments cannot be cited later.
3. **Decision.** A maintainer sets `Status` to `Accepted`, `Rejected`, or `Withdrawn` and adds a
   line to the review log at the bottom of the file. `Rejected` is a real outcome and the file
   stays: the reasoning is worth more than the proposal.
4. **Implementation.** An accepted RFC that needs code gets a task with an id, and an ADR
   if it settles architecture. The RFC stays as the record of the argument.

An RFC is never deleted, and a number is never reused.

### Numbering

Zero-padded, four digits, starting at `0002`.

**`0001` is reserved for the template.** It is not a proposal and never will be — it is the
shape every other file copies.

---

## 3. What a good RFC includes

The template enforces the headings; this is what fills them honestly.

- **A cost, not just a benefit.** Every proposal has a price — a dependency, a surface to
  maintain, a target that stops being supported, a migration someone has to run. An RFC that
  names no cost has not been thought through.
- **The alternatives that lost, and why.** "We could also have done X" is the single most
  useful paragraph in a proposal, because it is the one a reviewer cannot reconstruct.
- **The blast radius, measured.** Which packages, which deploy targets (Bun, Workers, Lambda),
  whether it is breaking, whether it adds to the dependency count, whether it changes a public
  API recorded in `src/docs/api-surface.json`.
- **A migration path for anything breaking.** Deprecation first, a codemod or a written
  procedure second, removal last — never removal first.
- **Evidence or a plan to get some.** A performance or security claim needs a benchmark or a
  test; a proposal that has neither says so and says when it will.
- **Open questions, listed.** An RFC with no open questions is usually an RFC with unexamined
  assumptions.

---

## 4. Index

| RFC                                      | Title                                    | Status   |
| ---------------------------------------- | ---------------------------------------- | -------- |
| [`0001`](./0001-sample-template-here.md) | **Template** — copy this, do not edit it | Template |

New RFCs are added to this table in the same pull request that adds the file.
