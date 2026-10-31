# Capabilities review — 2026-10-29 (Gate P7)

> **What this is.** A structured, adversarial review of the ten capability modules against
> `15-capabilities.md`, `ADR-0027` and Gate P7's exit criteria, written by the author of the
> code. That makes it useful and it makes it **not an independent audit**: no second party has
> tried to break these packages, and nothing here substitutes for one before an application puts
> credentials, money or other people's inboxes behind them. The point of the document is that
> findings are written down and disposed of, rather than rediscovered by whoever reads the code
> next.
>
> Three findings were found and fixed during this review (F1, F2, F7). The rest are either
> accepted with a reason or recorded as open risks — the second list is the more useful one to
> read.

## Scope

Ten packages, 829 tests, every driver path included:

| Package    | Tests | Lines | Funcs | What was read                                                      |
| ---------- | ----- | ----- | ----- | ------------------------------------------------------------------ |
| `cache`    | 106   | 95.95 | 92.99 | port, codecs, 5 drivers, registry, `cache:*`, conformance kit      |
| `queue`    | 126   | 97.88 | 93.57 | port, worker, 5 drivers, outbox, `queue:*`, triggers, backoff      |
| `events`   | 40    | 100.0 | 99.05 | dispatch, sync/queued listeners, the transactional outbox writer   |
| `schedule` | 59    | 96.79 | 91.95 | cron parser, task registry, the tick, lock port + 2 drivers        |
| `storage`  | 71    | 97.66 | 96.57 | disk registry, 3 drivers, SigV4 in WebCrypto, `storage:*`          |
| `mail`     | 106   | 93.77 | 90.77 | mailers, 7 transports, templates, MIME, `mail:*`                   |
| `notify`   | 78    | 96.02 | 96.76 | 6 channels, queued delivery, webhook signing, `notify:*`           |
| `policy`   | 32    | 100.0 | 100.0 | roles, permissions, gates, `authorize`/`require`, `toHttpPolicies` |
| `auth`     | 88    | 96.57 | 97.79 | passwords, sessions, API keys, tokens, guards, two stores          |
| `pulse`    | 123   | 97.27 | 97.39 | logger, 3-layer redaction, metrics, tracing, health                |

Not in scope: `@tsir/link` and `@tsir/deploy` (reviewed with Phases 5 and 6), and anything that
requires a real Cloudflare or AWS account — see open risk 4.

## Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Disposition                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | medium   | **A `__Host-` cookie with `secure: false` is silently dropped by every browser.** `createSessions({ secure: false })` kept the default `__Host-tsir_session` name and emitted the cookie without `Secure`. `start()` succeeded, the `Set-Cookie` header looked correct, and every subsequent request was anonymous — a login that appears to work.                                                                                                                                                                                  | **Fixed.** `createSessions` refuses the combination at construction with `AUTH_CONFIG_INVALID` naming both remedies (TLS, or drop the prefix for plain-HTTP local dev). Regression test in `session.test.ts`; the same name without the prefix still works, which is how local development is meant to.                                                                                                        |
| F2  | low      | **The public `presignUrl` did not validate `X-Amz-Expires`.** The `s3` driver clamps to 1 … 604 800 seconds before signing, but the helper is exported from the package root for callers that mint a URL without a disk in hand, and it passed the value straight into the signature. An out-of-range expiry produces a URL S3 **accepts at signing and refuses at use** — a bare 403 in a different part of the system from the mistake.                                                                                           | **Fixed.** `presignUrl` throws `STO_SIGNING_FAILED` before signing when the value is not a whole number in range, naming the limit. The seven-day ceiling is now one exported constant shared with the driver instead of two copies. Test covers `0`, `-1`, `>7d`, `1.5`, `NaN` and both legal boundaries.                                                                                                     |
| F3  | medium   | **No brute-force protection anywhere in `@tsir/auth`.** Password verification, session lookup, API-key lookup and token parsing are all constant-time and rate-independent: an attacker can make unlimited guesses at full speed. `pulse` has a log-throughput `rateLimit` (1 000/s), which is not this.                                                                                                                                                                                                                            | **Accepted, documented** (§ 6 of `15-capabilities.md` now says so). Throttling belongs to the application because the correct policy depends on the deployment: a KV counter on Workers, a Postgres row, an edge WAF rule. The framework ships the primitive (`@tsir/cache` `increment`, atomic where the driver supports it) and a documented recipe; it deliberately does not pick a lockout policy for you. |
| F4  | low      | `verifyPassword` dispatches on the algorithm in the stored hash, so a hash produced by a driver the current runtime cannot verify (e.g. `argon2id` on Workers) is an `AUTH_UNSUPPORTED_HASH` at **login time**, not at boot. A project that moves from Bun to Workers discovers it on the first login, not on deploy.                                                                                                                                                                                                               | **Accepted** — a boot-time check cannot see the hashes in the database without reading the user table, which the framework has no access to. The error names the algorithm and the driver, so the failure is one line of log away from the fix (rehash on the way past, which the port already supports).                                                                                                      |
| F5  | low      | Gate P7 criterion 4 asks the scheduler to refuse "without a distributed lock provider when more than one instance is detected". The framework **cannot detect instance count** — there is no registry of running processes in any of the three targets.                                                                                                                                                                                                                                                                             | **Deviation, accepted and recorded.** The implemented rule is stronger where it can be checked: in `production: true`, a lock whose `capabilities.shared` is false is refused outright when any task declares `overlap: 'skip'` (`SCHED_LOCK_NOT_SHARED`, naming the tasks). That is stricter than "more than one instance", because it does not depend on the count being knowable.                           |
| F6  | low      | The `cache` and `queue` registries must be able to _name_ every driver they can build, so they import all of them for error messages; only `drivers.gen.ts` prunes what a bundle carries. A project that imports `createCaches` directly from `@tsir/cache` instead of the generated module gets the whole driver set.                                                                                                                                                                                                              | **By design, documented** (`15-capabilities.md` § 2.2, `ADR-0027` § 4). The generated module is what `tsir build` produces and what an application is told to import; `drivers.test.ts` asserts one import per driver however many stores sit on top, and `make verify-dist` measures the bundle.                                                                                                              |
| F7  | low      | **A guard that could never fire.** `createRegistry` refused a duplicate policy with `POL_DUPLICATE_POLICY`, but `policies` is a `Readonly<Record<string, …>>` — a record collapses two entries with one key before the registry sees them, so the check was unreachable and `duplicatePolicy` was dead code. The test named "two policies for one ref are refused at construction" asserted `.not.toThrow()`. A generator emitting `[ref, rule]` pairs would have overwritten one module's ownership rule with another's, silently. | **Fixed.** `RegistryOptions.policies` now accepts a record _or_ pairs (`PolicyEntries`); the pair form is what generated config produces and the only form in which a duplicate survives long enough to be refused. Two tests replace the one that lied: a pair list works, and a duplicate pair throws `POL_DUPLICATE_POLICY` naming the ref.                                                                 |

Nothing was found that is remotely exploitable on its own. F1 is a footgun with a silent
failure, F3 is an absence rather than a defect, F7 is a dead guard rather than a live hole (the
record form made the duplicate impossible to express, which is why nobody noticed it could not be
caught), and the rest are trade-offs that were made deliberately and are now written down.

## What is verified, and how

| Property                                            | Evidence                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One import per driver, however many stores use it   | `drivers.test.ts` + a manual run: 3 cache stores on 2 drivers and 1 connection on 1 driver renders **4 imports**, not 6                |
| A driver the build does not ship fails the build    | `planDrivers().problems` — `tsir build` returns non-zero _before_ writing anything to `.tsir/`                                         |
| Policy fails closed                                 | `registry.ts` — an unmapped permission returns `deny('default', …)`; a policy returning a non-`Decision` throws `POL_INVALID_DECISION` |
| Constant-time secret comparison                     | `keys.ts` (`constantTimeEqual`), `token.ts`, `password.ts` (`constantTimeBytesEqual`), `notify/signing.ts`                             |
| Password hashes are self-describing and upgradeable | `password.test.ts` — every parameter is in the hash; `needsRehash` names the rows to upgrade; the 210 000-iteration floor is a test    |
| Session cookies cannot be planted by a subdomain    | `__Host-` prefix, asserted verbatim in a test (and now guarded against being silently neutered — F1)                                   |
| Header injection is refused, not escaped            | `mail/address.ts`, `mail/message.ts` — a newline in an address or header value throws before a message is built                        |
| Webhook signatures are signed and compared in time  | `notify/signing.ts` — hex HMAC-SHA256 over `${t}.${body}`, constant-time comparison, timestamp window                                  |
| Storage credentials never reach a browser           | SigV4 in WebCrypto, presigned URLs only, signing helpers unexported; `presignUrl` now validates its own lifetime (F2)                  |
| Logs redact before they are written                 | `pulse` 3-layer redaction; `make logs` sweeps the whole suite's output for secret-shaped strings                                       |
| The dependency count did not move                   | `make deps` — still **2** runtime dependencies for the whole framework; every capability driver takes an app-supplied client           |
| Named stores reject an undeclared name at boot      | `CAP_UNKNOWN_STORE` / `CAP_UNKNOWN_CONNECTION`, capability validation per store without I/O; the default resolves eagerly              |

## Gate P7 criteria

| #   | Criterion                                                                                                                                                                      | Verdict                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Auth and policy are separate packages with a documented seam; a policy runs in a service, not just a controller                                                                | **Met.** `@tsir/policy` depends only on `@tsir/container` — no HTTP import to reach for — and `authorize()` is callable from anywhere                                                                                                    |
| 2   | Queue has durable backends, retries, backoff, DLQ, idempotency keys, graceful drain; outbox mandatory where needed                                                             | **Met in code.** 5 drivers; `retryDelayMs(attempt)` with per-task overrides; dead-letter after `maxAttempts`; `worker.ts` drains in-flight messages on shutdown; `tsir build` refuses a non-transactional backend without `@tsir/events` |
| 3   | Events support a transactional outbox; sync and async listener semantics are explicit and tested                                                                               | **Met.** `events` writes through the same transaction as the application write; sync listeners run inline, queued listeners go to the outbox, and both paths are tested                                                                  |
| 4   | Scheduler refuses to run without a distributed lock when more than one instance is detected                                                                                    | **Met, restated.** Instance count is not knowable; the implemented rule refuses a non-shared lock in production (F5)                                                                                                                     |
| 5   | Cache and storage are driver-based with explicit serialization; no implicit `JSON.parse` of unknown payloads                                                                   | **Met.** Every read goes through a `Codec`; there is no default codec that assumes JSON                                                                                                                                                  |
| 6   | Named stores and connections (ADR-0019): explicit `default`, typed accessors, `CAP_UNKNOWN_*`, per-store validation, deduplicated `drivers.gen.ts`, one trigger per connection | **Met.** See the evidence table; `CAP-003` was verified by rendering the module, not by reading the plan                                                                                                                                 |

## Open risks

1. **No independent review.** This document is the author's. F1 is the kind of finding a second
   reader finds in an hour and the author missed for a week, which is the argument for one.
2. **No cross-target boot proof.** Every ✅ in the capability matrix is bundle-level
   (`make verify-dist`). No capability module has been started on a real Worker or Lambda, and
   nothing in this review changes that — it is Gate P6's open half.
3. **No brute-force protection** (F3). The recipe is documented; the policy is yours to choose.
4. **`events` is fully line-covered but still thin on the guarantee it advertises.** Closed since
   the first draft of this review: 40 tests (was 36), `100 %` lines on all five source files,
   package functions at `99.05 %`, the remainder being one defensive branch in `bus.ts`. What the extra tests bought is the failure path that matters —
   an `Outbox` that rejects is now asserted to surface `CAP_OUTBOX_WRITE_FAILED` rather than a
   lost event, and a listener that logs is asserted to write through the worker's `log`. The
   remaining risk is not coverage, it is **semantics**: the package promises at-least-once plus an
   idempotency key, which is not exactly-once, and no test can make it so.
5. **`policy` is now at 100 % lines and functions across all five source files**, at 32 tests
   (was 26). Closing this one turned up more than a coverage hole: `duplicatePolicy` was
   **unreachable** — a `Readonly<Record>` collapses duplicate keys before the registry sees them,
   so the guard could never fire — and the test claiming to cover it asserted `.not.toThrow()`.
   `RegistryOptions.policies` now also accepts `[ref, rule]` pairs, which is the shape a generator
   emits and the only shape in which a duplicate survives to be refused. The guard is live and
   tested as `POL_DUPLICATE_POLICY`; the two gate factories, an abstaining gate, `missing()`
   deduplication and every `describe()` branch are covered too. The failure mode still bears
   repeating: this is the surface where a missed case is "an authorisation that should have been
   denied", and line coverage is not a substitute for an independent reader.

## Sign-off

The design in `15-capabilities.md` is implemented as written, with one restated criterion (F5)
and two defects found and fixed during this review (F1, F2). The gate passes **with those
deviations recorded**, and it passes as a code-and-test claim, not as a deployment or audit
claim.

**Reviewer: the author of the implementation (not independent).**
