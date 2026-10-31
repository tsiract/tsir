# RFC 0001 — Title in the imperative: "Add X", "Replace Y with Z", "Make W configurable"

- **Status:** Template
- **Date:** 2026-10-29
- **Author:** your name or handle
- **Affects:** packages, entrypoints, CLI commands, gates, or targets this proposal touches
- **Related:** ADR or task ids it depends on, if any

> **This file is the template.** Copy it to `rfc/NNNN-kebab-case-title.md` (the next free
> number, starting at `0002`), replace every heading's body, and delete every blockquote like
> this one. Do not edit `0001` itself.
>
> An RFC proposes **new features, breaking changes, or tooling that improves the project**.
> It is **not a bug report** — a defect goes to the issue tracker with a reproduction. If your
> first sentence is "X is broken", stop and file an issue instead.

---

## 1. Summary

> One paragraph. A reader who stops here should know what you are proposing, what it costs, and
> whether it is breaking. No code in this section.

<!-- Example shape, delete when writing: "Add a `@tsir/search` package that exposes ... It
costs one allowlisted runtime dependency and no breaking change; existing applications opt in
by adding a connection in `tsir.js`." -->

## 2. Motivation

> Why does this need to exist? Describe the problem in terms of an application built on the
> framework — what someone has to write by hand today, what they get wrong, or what they cannot
> do at all. If the answer is "it would be nice", the RFC is not ready.

- What is impossible, awkward, or duplicated today:
- Who hits it, and how often:
- What the workaround costs (lines, dependencies, correctness):

## 3. Proposed design

> The design, at the level of shapes rather than implementation. Public API sketches,
> configuration blocks, error codes. Mark anything you are unsure about as an open question
> rather than silently deciding it.

```ts
// The public surface this proposal adds or changes. Types matter more than bodies.
```

> Show how an application uses it, too. A design that is only shown from the framework's side
> hides the ergonomics — which is usually the part being argued about.

```ts
// The same feature, from the application's point of view.
```

## 4. Alternatives considered

> At least two. A proposal with one alternative is a proposal that was not compared to
> anything. For each: what it is, why it is worse, and what would change your mind.

| Alternative | Why it lost | Would win if |
| ----------- | ----------- | ------------ |
|             |             |              |

## 5. Impact

> The blast radius, measured rather than estimated. Delete rows that do not apply; "none" is a
> perfectly good answer and it is the answer a reviewer wants to see stated.

| Question                                         | Answer                                                     |
| ------------------------------------------------ | ---------------------------------------------------------- |
| Breaking change?                                 | no / yes — and if yes, what                                |
| Packages affected                                |                                                            |
| Public API surface (`src/docs/api-surface.json`) | unchanged / additive / changed                             |
| Deploy targets                                   | Bun / Workers / Lambda — which stop working, if any        |
| New runtime dependency                           | none / which, and why the allowlist should grow (ADR-0012) |
| Bundle budget                                    | roughly what it adds, per target                           |
| Performance                                      | the number, or "not measured — see § 8"                    |
| Security                                         | new trust boundary, secret, or auth decision?              |

## 6. Migration and rollout

> Required for anything breaking, optional otherwise. The rule is deprecation → codemod or
> written procedure → removal, never removal first.

1. Deprecation: what warns, for how long.
2. Migration: a codemod, a document, or a versioned flag.
3. Removal: the release that drops it.

## 7. Testing

> How a reviewer will know it works, and how it will keep working. Name the tests, not the
> intention. A negative test for each new failure mode is not optional in this repository.

- Unit tests:
- Conformance / negative matrix:
- Type-level tests:
- What cannot be tested here, and why:

## 8. Evidence

> Any performance, security, or compatibility claim needs a committed benchmark or test. If the
> evidence does not exist yet, say when it will and what it will measure — an RFC with an
> unmeasured "it is faster" is an RFC that will be cited as a fact later.

## 9. Open questions

> Numbered, so the discussion thread can reference them. If you have none, say why — "no open
> questions" from a first draft is a claim that the assumptions were examined.

1.

## 10. Review log

> Maintained by the reviewer, not the author. One line per status change.

| Date | Status | Who | Note |
| ---- | ------ | --- | ---- |
|      | Draft  |     |      |

---

<details>
<summary>Checklist — delete before opening the pull request</summary>

- [ ] The file is named `rfc/NNNN-kebab-case-title.md` with the next free number (`0001` is the template).
- [ ] Status is `Draft`, and every section above has been replaced or explicitly answered.
- [ ] This is a **new feature, a breaking change, or project-improving tooling** — not a bug report.
- [ ] It is not already covered by an accepted ADR (checked the ADR index).
- [ ] § 4 lists at least two alternatives and what would change the author's mind.
- [ ] § 5 names a cost. A proposal with no cost has not been thought through.
- [ ] Anything breaking has a migration path in § 6.
- [ ] Every performance or security claim in § 8 is measured, or marked as unmeasured.
- [ ] Added a row to the table in `rfc/README.md`.
- [ ] `make check` passes (`make links` covers this directory too).

</details>
