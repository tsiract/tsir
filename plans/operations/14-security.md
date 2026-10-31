# 14 — Security Model

> Threat model, trust boundaries, and the security review gate. Vault specifics live in [`06-vault.md`](../modules/06-vault.md); this document is the cross-cutting view.

---

## 1. Trust boundaries

```
                    untrusted                                   trusted
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  HTTP request  ──► validate ──► typed value ──► handler ──► service       │
 │  Env vars      ──► validate ──► typed config                             │
 │  Queue payload ──► validate ──► typed job                                │
 │  DB ciphertext ──► vault decrypt (+ auth tag) ──► plaintext              │
 │  Upstream REST/gRPC/SOAP/WS ──► schema validate ──► typed value          │
 │  tsir.js       ──► schema validate ──► typed project config              │
 └──────────────────────────────────────────────────────────────────────────┘
```

Every arrow into "trusted" is a boundary with an owning package, a runtime schema, and a failure code. There is no boundary without validation; that is the invariant this document exists to protect.

---

## 2. Threat model by asset

| Asset                   | Threat                              | Control                                                          | Test                    |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| Database contents       | Backup/dump leak                    | Vault column encryption, fail-closed                             | `VLT` matrix            |
| Encrypted columns       | Tamper, swap, replay                | AEAD + AAD column binding, key ids                               | `VLT` #4–7              |
| Keys                    | Leak via logs/artifacts             | Redaction, artifact scan, never in `tsir.js`                     | `OBS`, `DPL`, `CFG`     |
| Sessions/tokens         | Theft, fixation, confusion          | Hashing at rest, rotation on privilege change, `__Host-` cookies | `@tsir/auth` tests      |
| Authorization decisions | Bypass via controller-only checks   | Policies callable at service boundary                            | `@tsir/policy` tests    |
| Untrusted input         | Injection, DoS, prototype pollution | Schema validation, size/depth limits, key filtering              | `HTP`, `VLD`            |
| Upstream services       | MITM, XXE, malformed responses      | TLS verify on, hardened XML parser, response validation          | `LNK`                   |
| Supply chain            | Malicious dependency                | Lockfile, dependency budget, `bun audit`, publish provenance     | `FND`, `SEC`            |
| Deploy artifacts        | Secret baked into bundle            | Artifact secret scan, binding references only                    | `DPL`                   |
| Logs / telemetry        | Secret & PII exfiltration           | Default-deny redaction, no body logging                          | `@tsir/pulse` leak test |

---

## 3. Framework-wide security rules

1. **Fail closed.** Missing key, unknown key id, tampered tag, invalid signature → error. Never "continue without encryption", never "return null".
2. **No custom crypto, ever.** AES-256-GCM/ChaCha via WebCrypto; password hashing via `argon2id` (Bun's `Bun.password`) with documented parameters; no invented token formats. **As built (2026-10-29):** the _default_ hasher is PBKDF2-SHA256 at 210 000 iterations through WebCrypto, because WebCrypto has PBKDF2 and nothing else and a Worker cannot import `node:crypto`; argon2id ships as `@tsir/auth/bun` and the hash string names its algorithm, so a project can switch either way and old rows keep verifying ([`tasks/auth.md`](../tasks/auth.md)).
3. **Uniform error surfaces.** Authentication and decryption failures return a single generic error; distinctions go to logs, not clients.
4. **Least privilege.** Deploy units get only the bindings they need; DB roles documented per module (app role = no DDL; migration role = DDL, used only by the migrate unit).
5. **Explicit trust.** `X-Forwarded-*`, `traceparent`, and proxy headers are ignored unless a trusted proxy/origin is configured.
6. **No hidden state.** No global container, no ambient principal, no implicit tenant. Anything security-relevant is an argument.
7. **Bounds everywhere.** Body size, JSON depth, XML entity expansion, WS frame size, response size, retry counts, timeouts, batch sizes — all have defaults and hard maximums.
8. **Dependency discipline.** New runtime dependencies need an ADR with maintenance and security posture; `bun audit` runs in CI; lockfile pinned.
9. **Provenance.** Published packages ship with `--provenance`; release tags are signed.
10. **Review gate.** `src/framework/vault`, `auth`, `policy`, `link/soap` require two reviewers, one with security context.

---

## 4. Secure-by-default settings

| Setting                      | Default                                                                                             | Rationale                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| TLS verification on outbound | `true`                                                                                              | `false` warns and is rejected in production                      |
| CORS                         | disabled (same-origin)                                                                              | Wildcard + credentials is a boot error                           |
| Cookies                      | `HttpOnly`, `Secure` (prod), `SameSite=Lax`, `__Host-` prefix                                       | Session safety                                                   |
| Helmet-equivalent headers    | on for HTML responses (`nosniff`, `frame-ancestors 'none'`, referrer policy)                        | Cheap, harmless for APIs                                         |
| Response validation          | `dev` (opt-in `always` in prod)                                                                     | Cost/perf tradeoff; documented                                   |
| JSON depth limit             | 32                                                                                                  | Nesting bombs                                                    |
| Body limit                   | 1 MiB (configurable, max 10 MiB without explanation)                                                | Memory safety                                                    |
| Password hashing             | PBKDF2-SHA256, 210 000 iterations, 16-byte salt, 32-byte key (argon2id on Bun via `@tsir/auth/bun`) | Works on Workers, Bun and Node; the hash names its own algorithm |
| Session cookie rotation      | on privilege change (`rotate()`); absolute 7 d, idle 12 h                                           | Fixation, and a session that dies on its own                     |

**As built (2026-10-29) — the four controls this table promises, and where each lives in code.**

| Promise here                                       | Shipped as                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Hashes, never credentials, at rest                 | `sha256(token)` is the session row key; `sha256(secret)` is the API-key column; passwords use a self-describing hash           |
| Rotation on privilege change                       | `sessions.rotate()` deletes the old id before returning the new one — a copy would survive the privilege change that caused it |
| `__Host-` + `HttpOnly` + `Secure` + `SameSite=Lax` | Fixed cookie attributes, asserted verbatim in `session.test.ts`; `clearCookie()` adds the 1970 `Expires`                       |
| Policies callable at the service boundary          | `authorize()`/`require()` take a principal and a ref and are HTTP-free; `toHttpPolicies` is the adapter, not the rule          |

**One more deviation, on the record: `@tsir/pulse` ships a hand-written SHA-256.** Rule 2 says "no
custom crypto", and this is not custom crypto — it is FIPS 180-4 § 6.2 implemented as published, in
70 lines, checked against the NIST vectors including the million-`a` case. It exists because
`crypto.subtle.digest` is asynchronous and a `logger.info()` cannot be, and it is used **only** for PII
pseudonyms and log fingerprints. Nothing it produces is a credential, a key or a signature;
`@tsir/auth` and `@tsir/vault` stay on WebCrypto. `make crypto` scans it like every other file.

Two more deviations are recorded rather than hidden: password hashing defaults to PBKDF2 (argon2id on
Bun) for the reason in § 3 rule 2, and the "after 24 h" rotation is **not** automatic —
`rotate()` is called on privilege change, and the idle timeout (12 h) is what ends a session nobody
comes back to. An automatic 24-hour rotation is a scheduler concern (`@tsir/schedule`), not a
session-store one.

---

## 5. Secrets management

| Secret                         | Source               | Never                                   |
| ------------------------------ | -------------------- | --------------------------------------- |
| `DATABASE_URL`                 | env / secret manager | in `tsir.js`, in artifacts, in logs     |
| `APP_KEY_NOW` / `APP_KEY_NEXT` | env / secret manager | in git, in `tsir.js`, in error messages |
| OAuth client secrets           | secret manager       | in config files                         |
| SMTP/storage credentials       | secret manager       | in artifacts                            |

Rules: `.env` gitignored; `.env.example` contains names and placeholder formats only; CI scans the diff for high-entropy strings and known secret prefixes; `tsir doctor` reports missing secrets without printing values.

---

## 6. Security review gate (Phase 8)

Before `v1.0.0`:

1. **Internal review** using `SEC-###` checklist tasks (each with evidence links).
2. **External review** of `vault`, `auth`, `policy`, and `link/soap` by an independent reviewer.
3. Findings triaged: `critical`/`high` block release; `medium` requires a mitigation plan; `low` tracked.
4. `SECURITY.md` published with a disclosure address, PGP key, and 90-day policy.
5. Penetration-style tests added for the top 10 findings.

---

## 7. Security failure-mode index

| Code family                             | Area                                               |
| --------------------------------------- | -------------------------------------------------- |
| `VLT_*`                                 | Encryption, keys, rotation — see `06-vault.md § 7` |
| `HTP_UNAUTHENTICATED` / `HTP_FORBIDDEN` | Authn/z at HTTP boundary                           |
| `LNK_UNAUTHENTICATED` (`clock_skew`)    | Service auth                                       |
| `CFG_SECRET_INLINED`                    | Secret in config file                              |
| `DPL_SECRET_LEAK`                       | Secret in artifact                                 |
| `OBS_REDACTION_ERROR`                   | Redaction failure (logged, never silent)           |
| `SEC_*`                                 | Reserved for the security subsystem itself         |

---

## 8. Failure modes (of the security process itself)

A threat model fails differently from code: the code keeps working, and the failure is that
nobody notices the process stopped. The ways this document stops being true:

| Failure                                       | How it happens                                                     | The guard                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| A review becomes a rubber stamp               | the same author reviews their own module and signs it off          | the review is labelled non-independent (`SEC-004`); Phase 8 owes a second reader       |
| A secret reaches an artifact                  | a literal in `tsir.js`, or a var inlined by the bundler            | `check-crypto`/`check-deps` in CI, `CFG_SECRET_INLINED`, `DPL_SECRET_LEAK` before emit |
| Redaction silently stops matching             | a field renamed, a value shaped differently than the regex expects | `OBS_REDACTION_ERROR` is logged, never swallowed; redaction tests fail on a miss       |
| A dependency adds a credential-bearing client | convenience in a driver, without an ADR                            | `make deps` fails on an unlisted dependency (ADR-0012)                                 |
| The threat model goes stale                   | a new entrypoint, target or capability nobody mapped               | every capability module must state its own security section (§ 3)                      |
| "We'll audit before 1.0" never happens        | no owner, no date                                                  | it is listed as an open question below rather than assumed                             |

---

## 9. Open questions

| #   | Question                                                                                                       | Blocks        |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------- |
| Q56 | Who performs the independent security audit that Gate P8 requires, and against which commit?                   | Phase 8       |
| Q57 | Is there a bug-bounty or a coordinated-disclosure address before `v1.0.0`, or does `SECURITY.md` suffice?      | Phase 8       |
| Q58 | Do we publish a machine-readable threat model (per-capability, in the docs site), or keep it in the plan set?  | Phase 8 (DOC) |
| Q59 | Can `make check` prove "no secret in any artifact" mechanically today, or is that still a `verify-dist` probe? | Phase 6       |

---

## 10. Task index

[`tasks/12-security.md`](../tasks/12-security.md) — `SEC-001` … `SEC-018`.
