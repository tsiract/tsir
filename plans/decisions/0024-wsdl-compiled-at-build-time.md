# ADR-0024 — A WSDL is compiled at build time; the generated module is committed

- **Status:** Accepted
- **Date:** 2026-10-28
- **Affects:** `@tsir/link/soap`, `@tsir/console` (`link:soap:gen`), `plans/modules/07-link.md` § 5
- **Builds on:** [ADR-0023](./0023-soap-xml-subset.md) (the XML subset), [ADR-0012](./0012-dependency-policy.md) (dependency policy)

---

## Context

`LNK-016` asks for "WSDL → typed operations" with one acceptance line that decides the
architecture: **generated types compile; no WSDL fetch at runtime.**

There are four places a WSDL could be turned into shapes:

1. **At request time.** The client fetches the WSDL on first use, parses it, and builds
   codecs in memory. A cold start now depends on a third host being up, a proxy needs the
   same WSDL at the same version, and a schema change ships silently with a deployment
   nobody reviewed.
2. **At boot.** The process reads a local WSDL, compiles it, and starts. Cheaper than (1),
   but still a runtime failure mode: a bad WSDL is a crash loop, and the compiler runs on
   every cold start (a Workers isolate restarts often).
3. **At build time, not committed.** A prebuild step writes the module into `dist/` or a
   gitignored folder. Now the contract is invisible in review: a WSDL change alters
   behaviour with no diff to read.
4. **At build time, committed, `--check`-gated.** The generated file is source. Reviewers
   see exactly which fields changed; CI fails when the file and the WSDL disagree.

## Decision

A WSDL is compiled by `tsir link:soap:gen` into a committed `<name>.gen.ts` module next to
it, and the compiler refuses to guess:

- **The output is committed and read as ordinary source.** It contains the interfaces, a
  `SoapFieldShape` table per element, and an `operations` record that `createSoapClient`
  consumes directly. Nothing is fetched, parsed or generated at runtime; the SOAP client
  does not import the compiler, and the compiler does not ship in an app bundle.
- **`--check` is the gate.** CI (and `make codegen-check`) recompiles the WSDL in memory
  and fails the build if the committed module is missing or differs. The comparison is
  byte-for-byte, which is only meaningful because the compiler is deterministic: fixed
  ordering (enums → complex types → elements → messages → binding → portType), no
  timestamps, no absolute paths, no hash of the environment.
- **The compiler compiles what it can prove, and says what it skipped.** Document/literal
  only; `rpc` style, `wsdl:import`, `xsd:include`, `choice`, attributes, substitution
  groups and unknown types produce a named warning and a compiling fallback (`string`),
  never a silent guess. Warnings are printed, counted by the test, and visible in `--json`.
- **The generated module is the only place the WSDL's element names appear.** Application
  code talks in `GetTaxRate` and `{ rate, exempt }`; element names, namespaces and
  `minOccurs` live in the generated table, so a WSDL change is a diff in one file.

## Consequences

**Good**

- The contract is reviewable: a WSDL update is a diff in the generated module, and an
  unreviewed behaviour change cannot slip in with a deploy.
- No runtime dependency on the WSDL document, the compiler, or a schema host. The client
  is a record of shapes and a `fetch`; it bundles for Workers unchanged.
- A stale module is a build failure, not a mismatched-fields bug in a nightly job.
- `parseDecimal`-based decoding means the generated code never coerces: a field typed
  `number` either parses as a decimal or the response is a `LNK_PROTOCOL` failure.

**Bad, and accepted**

- Two files to keep in sync, and a command in the loop: a developer who edits a WSDL must
  remember to run `link:soap:gen`. `--check` is what makes forgetting visible, and the
  failure message names both paths.
- The generated module is not prettier-formatted (`**/*.gen.ts` is ignored) so `--check`
  compares bytes rather than style; the header says so.
- One nesting level only. A WSDL with deeper structures is compiled with a warning and a
  flat fallback; a real service that needs depth is a later task, and the compiler says so
  rather than emitting something that looks typed and is not.

## Alternatives considered

- **Runtime WSDL fetch or boot-time parse.** Rejected above: the acceptance criterion
  forbids it, and it turns a build error into a production incident.
- **Generating types only, with the client decoding by field name.** Simpler, but it loses
  repetitions, optionality and enums — the three things a WSDL actually states — and every
  application would re-implement them.
- **A general WSDL/XSD toolkit as a dependency.** Rejected under ADR-0012: the compiler we
  need is a document/literal subset of a subset, and its gaps are warnings we can read.
- **Generating in `dist/` during the build.** Rejected: invisible in review, and the
  package would need the compiler in its build dependencies for consumers who never run it.
