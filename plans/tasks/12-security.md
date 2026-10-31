# Tasks — Security (Phases 1–8)

> Threat model, review gates, secret hygiene, disclosure.

**Plan:** [`../14-security.md`](../operations/14-security.md)

---

## Foundations

| ID        | Title                                                      | Status | Depends | Acceptance criteria (summary)                                                                                                          |
| --------- | ---------------------------------------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SEC-001` | Threat model document (assets, actors, boundaries)         | `[ ]`  | —       | Reviewed; `14-security.md § 2` linked to tests                                                                                         |
| `SEC-002` | Trust-boundary inventory (every untrusted input → owner)   | `[ ]`  | SEC-001 | No boundary without a validating package                                                                                               |
| `SEC-003` | Secure-defaults audit (CORS, cookies, TLS verify, headers) | `[ ]`  | HTP-019 | Table in `14-security.md § 4` matches code                                                                                             |
| `SEC-004` | Vault design review (envelope, AAD, state machine)         | `[x]`  | VLT-011 | [Review notes](../reviews/2026-10-28-vault-design-review.md)                                                                           |
| `SEC-005` | Cryptography inventory + prohibited-practices lint         | `[x]`  | VLT-002 | `Math.random`, custom crypto imports banned                                                                                            |
| `SEC-006` | Dependency budget review + `bun audit` in CI               | `[ ]`  | FND-017 | New dep without ADR fails review                                                                                                       |
| `SEC-007` | Secret scanning (diff + artifact + repo history)           | `[ ]`  | DPL-020 | Detects test fixtures without false-positive noise                                                                                     |
| `SEC-008` | `.env.example` hygiene + gitignore verification            | `[x]`  | —       | No real values in example                                                                                                              |
| `SEC-009` | Session/auth design review                                 | `[x]`  | —       | Fixation, rotation, cookie flags covered — recorded in [`auth.md`](./auth.md) and [`14-security.md § 4`](../operations/14-security.md) |
| `SEC-010` | Authorization seam review (service-level enforcement)      | `[x]`  | —       | Policy callable outside controllers — `authorize`/`require` are HTTP-free ([`policy.md`](./policy.md))                                 |

## Hardening

| ID        | Title                                                  | Status | Depends          | Acceptance criteria (summary)                                                              |
| --------- | ------------------------------------------------------ | ------ | ---------------- | ------------------------------------------------------------------------------------------ |
| `SEC-011` | Input DoS limits (body, depth, XML, WS frames)         | `[ ]`  | HTP-017, LNK-018 | Every limit has a negative test                                                            |
| `SEC-012` | Prototype-pollution audit of all parsers               | `[x]`  | VLD-001          | `__proto__`/`constructor` rejected                                                         |
| `SEC-013` | Log/telemetry exfiltration tests                       | `[x]`  | OBS-007          | Zero secrets in captured logs — the leak test in `pulse/src/logger.test.ts` scans the line |
| `SEC-014` | Deploy artifact secret scan                            | `[ ]`  | DPL-020          | CI gate                                                                                    |
| `SEC-015` | Rate limiting primitives (HTTP + link)                 | `[ ]`  | HTP-009          | Per-principal and per-target policies                                                      |
| `SEC-016` | Error-message leakage audit (no stacks/causes in prod) | `[ ]`  | ERR-005          | Snapshot tests per boundary                                                                |
| `SEC-017` | Supply-chain: lockfile, provenance, signed tags        | `[ ]`  | FND-021          | Verification procedure documented                                                          |
| `SEC-018` | External review + findings triage + `SECURITY.md`      | `[ ]`  | SEC-001…017      | Critical/high fixed before `v1.0.0`                                                        |

---

**As built (2026-10-29).** `SEC-009` and `SEC-010` are answered by shipped code with tests rather
than by a review note alone: fixation (`rotate()` deletes before it issues), rotation on privilege
change, `__Host-` cookie attributes asserted verbatim, uniform auth errors, and an `authorize()` that
a job or an RPC handler calls without an HTTP request existing. Two deviations from
[`14-security.md § 4`](../operations/14-security.md) — PBKDF2 as the default hasher, and no automatic 24-hour
rotation — are recorded there rather than quietly.

## Review gates

| Gate          | Requirement                                         |
| ------------- | --------------------------------------------------- |
| P4 (Vault)    | `SEC-004`, `SEC-005`, and the full VLT matrix green |
| P6 (Deploy)   | `SEC-014` and `SEC-017`                             |
| P8 (`v1.0.0`) | `SEC-018` complete; disclosure policy published     |

Two reviewers required on `src/framework/vault`, `src/framework/auth`, `src/framework/policy`, `src/framework/link/soap`. Enforced by CODEOWNERS (`FND-023`).
