# ADR-0005 — Deploy Topology Defaults to `separate` Units

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/deploy`, `tsir.js`, generators, docs

---

## Context

A Tsir application has several kinds of workloads: HTTP routing, WebSocket connections, queue consumption, scheduled tasks, and administrative/health endpoints. On Cloudflare Workers and AWS Lambda these can be deployed as:

- **one function** that dispatches by event shape or path, or
- **multiple functions**, one per workload.

The brief states: "the framework can either handle 1 worker/lambda to handle the routings upon deploy or to separate the worker/lambda into their own functionality (by default: separation)."

## Decision

1. Default topology is **`separate`**: each enabled capability becomes its own deployable unit (`http`, `ws`, `queue`, `schedule`, `admin`).
2. `single` topology is opt-in via `tsir.js`:

```js
deploy: {
  topology: 'single';
}
```

3. The topology is resolved by the **unit graph**, printed by `tsir deploy:plan --explain`, and snapshotted in `unit-graph.json`.
4. The generator writes `topology: 'separate'` explicitly — the default is visible in the file, never implicit.

## Rationale

| Concern              | `separate`                   | `single`                      |
| -------------------- | ---------------------------- | ----------------------------- |
| Cold start           | Small HTTP bundle            | Whole app in every invocation |
| Limits               | Per-workload CPU/memory      | One shared limit              |
| Failure blast radius | Queue crash ≠ API down       | Coupled                       |
| Least privilege      | Bindings only where needed   | All bindings everywhere       |
| Deploy risk          | Independent, staged rollouts | All-or-nothing                |
| Operational cost     | More functions to monitor    | Fewer resources               |

For the target user (production backend services, SaaS platforms, enterprise), the operational benefits dominate. `single` remains available for small services and vendor-limit constraints.

## Consequences

**Positive**

- A queue consumer with heavy dependencies cannot degrade HTTP p99.
- Secrets and bindings are scoped per unit, shrinking the attack surface.
- Migrations get their own unit, so they never run on a request path.

**Negative / costs**

- More infrastructure objects; users must understand the unit graph (mitigated by `deploy:plan --explain`).
- Shared code is bundled per unit; duplication is accepted and budgeted.
- Cross-unit calls (HTTP → queue) must be modeled explicitly (HTTP unit publishes; queue unit consumes) — which is the point.

## Alternatives considered

| Alternative                        | Why rejected as default                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `single` default                   | Cheaper to start, but couples failure domains and bloats cold starts; contradicting the brief |
| Auto-detect topology from app size | Unpredictable; "predictable execution" forbids silent structural changes                      |

## Revisit conditions

If a target enforces a low function-count limit, revisit with data. Users can already opt into `single`.
