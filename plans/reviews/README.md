# Gate reviews

One file per phase gate. A review is what turns "the tests pass" into "someone looked at this
adversarially and wrote down what they found".

| Review                                                                                               | Gate | Date       | Reviewer                           | Outcome                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ---- | ---------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`2026-10-28-vault-design-review.md`](./2026-10-28-vault-design-review.md)                           | P4   | 2026-10-28 | the author of the code (`SEC-004`) | 9 findings — 6 fixed, 3 accepted                                                                                                          |
| [`2026-10-29-capabilities-review.md`](./2026-10-29-capabilities-review.md)                           | P7   | 2026-10-29 | the author of the code             | 6 findings — 2 fixed, 4 accepted; 5 open risks                                                                                            |
| [`2026-11-07-infrastructure-agnosticism-audit.md`](./2026-11-07-infrastructure-agnosticism-audit.md) | P8   | 2026-11-07 | the author of the code             | source-code audit of 33 packages — 16 findings `INF-001`…`INF-016`, all open                                                              |
| [`2026-11-08-admin-e2e-acceptance.md`](./2026-11-08-admin-e2e-acceptance.md)                         | P8   | 2026-11-08 | the author of the code             | 3 critical admin defects — all fixed; 8/8 e2e green                                                                                       |
| [`2026-11-13-aws-emulator.md`](./2026-11-13-aws-emulator.md)                                         | P6   | 2026-11-13 | the author of the code             | AWS Emulator v1.0.341 read at a pinned tag — 5 findings (2 fixed in the tool, 1 stale issue); C3/C6 partly move, C4/C5/C1/C2/C7/C8 do not |

## What a review has to contain

1. **Scope** — the files and behaviours read, and what was deliberately left out.
2. **Findings** — numbered, with a severity and a **disposition**: fixed (and where the test
   is), accepted (and why), or by design (and where it is documented). A finding with no
   disposition is an open question.
3. **What is verified, and how** — a property-to-evidence table. A claim with no evidence
   column does not belong in a review.
4. **Open risks** — the things that are still true and still bad. This is the section a reader
   should start with, and a review with an empty one is usually a review that stopped early.
5. **Sign-off** — including whether the reviewer is independent of the code. **Every review in
   this directory so far is the author's own**, which is exactly the limitation each one states
   at the top.

## The rule that matters

> A review is not an audit, and writing "reviewed" is not the same as "independent".

`SEC-004` and Gate P8 both require a second reader. Until one exists, the honest status of a
reviewed gate is _reviewed, not audited_ — and that is the phrase the sign-off uses.
