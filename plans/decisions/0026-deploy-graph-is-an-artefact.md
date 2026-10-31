# ADR-0026 — The deploy shape is a committed artefact, not a build-time decision

- **Status:** Accepted
- **Date:** 2026-10-28
- **Affects:** `@tsir/deploy`, `@tsir/console` (`deploy:plan`, `deploy:diff`), `plans/modules/08-deploy.md`
- **Related:** [ADR-0024](./0024-wsdl-compiled-at-build-time.md) (the same argument for WSDL), [ADR-0005](./0005-deploy-topology-default.md) (`separate` topology), [ADR-0019](./0019-multi-connection.md) (one migration unit per connection)

---

## Context

`plans/modules/08-deploy.md § 2` says the unit graph "serializes to a stable JSON committed to the
repo" and that a snapshot test fails CI on any change. Until `DPL-004` landed that was a
sentence; this is the decision it implies, written down.

The question is where the _deploy shape_ lives — which functions exist, which bindings each
one gets, which routes each one serves. There were three plausible answers:

1. **Compute it inside the bundler.** The emit step decides units from the entry points it
   was given. Fast, and invisible: the shape is whatever `bun build` inferred that morning.
2. **Derive it at deploy time from the platform.** Ask `wrangler` what it would deploy.
   That requires credentials and a network to answer a question about source code.
3. **Resolve it from declarations, validate it, serialize it, commit it.**

## Decision

The unit graph is a **first-class artefact**:

- `resolveUnits` derives units from declarations — route `meta.unit`, route modules,
  journaled connections, and explicit `deploy.units` — never from the directory layout.
- `checkGraph` validates the result against the configured targets before anything is
  emitted, and reports every problem with the fix (`DPL_DUPLICATE_ROUTE`,
  `DPL_CAPABILITY_MISSING`, `DPL_BINDING_MISSING`).
- `serializeGraph` is deterministic (every collection sorted), and `unit-graph.json` is
  committed next to `tsir.js`.
- `deploy:plan --check` fails when the resolved graph differs from the snapshot;
  `deploy:diff` names the unit and the field. `make codegen-check` runs the check for the
  example app on every `make check`.
- Emitters (`DPL-008` onward) consume a validated `UnitGraph`. They do not re-derive it,
  and they do not decide which units exist.

Two supporting rules:

- **`separate` is the default and `single` is opt-in**, and a merge is _reported_
  (`merged: [...]`) rather than silently applied. The expensive topology must be a decision
  someone typed.
- **A unit carries its reasons.** `Unit.reasons` is part of the serialized graph, so
  "why does a `queue` unit exist?" is answered by the committed file and by
  `deploy:plan --explain`, not by archaeology.

## Consequences

**Good**

- A deploy-shape change is a diff in review: a route moving from `http` to `admin`, a
  binding appearing on the queue unit, a new `migrate:analytics` unit. None of those can
  ship unnoticed.
- CI catches the two failures that otherwise surface in production: a route claimed twice,
  and a unit using a binding its target never declares.
- `deploy:plan` is offline. It reads `tsir.js`, the compiled route table and the module
  declarations; no credential, no network, no cloud API.
- Emitters get a small, validated input instead of a bundler's opinion, which is what makes
  the Workers and Lambda emitters testable without either platform.
- The same argument as ADR-0024 holds here: a generated artefact you _can_ read is worth
  more than a generator you have to trust.

**Bad, and accepted**

- Two files to keep in sync (`tsir.js` and `unit-graph.json`), and a command in the loop
  after changing routes. `--check` is the mitigation, and the failure message names the
  command that fixes it.
- The graph carries no per-target unit filtering yet: a unit that only makes sense on one
  target (a Durable Object room on Workers) either declares its binding everywhere or is
  reported as a problem on the target that cannot host it. `DPL-010` is where that gets
  decided, and it will need a `targets` field on the unit.
- `deploy:plan` reads process-wide route state (that is what makes it work without booting
  an app), so anything that imports several applications in one process must scope the
  load — which the command does, and which is written down in the code because it is not
  obvious.

## Alternatives considered

- **Infer units from the bundler's entry points.** Rejected: the shape would depend on the
  build, so it could not be reviewed, and a tree-shaking change could add or remove a unit.
- **Deploy-time discovery.** Rejected: it needs credentials to answer a question about
  source code, and it cannot fail a pull request.
- **No snapshot, just print the plan.** Rejected: a plan nobody diffs is a plan nobody
  reads. The committed file is what turns "the deploy changed" into "here is the line".
