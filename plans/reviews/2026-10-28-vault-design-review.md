# Vault design review — 2026-10-28 (`SEC-004`)

> **What this is.** A structured, adversarial review of the `@tsir/vault` implementation
> against `06-vault.md`, written by the author of the code. That makes it useful and it makes
> it **not** an independent audit: no second party has tried to break this, and nothing here
> substitutes for one before the first production key material is created. The point of the
> document is that the findings are written down and disposed of, rather than rediscovered by
> whoever reads the code next.

## Scope

- Envelope format and AAD binding (`envelope.ts`, `cipher.ts`)
- Keyring state machine, writer selection, manifest merge (`keyring.ts`, ADR-0021)
- Rotation: engine (`rotation.ts`), SQL store (`@tsir/database/src/rotation.ts`), CLI
- Blind index (`blind.ts`) and external key providers (`provider.ts`)
- Failure modes and what reaches logs (`errors.ts`, `LOG_CAPTURE` tests)

## Findings

| #   | Severity | Finding                                                                                                                                                                                                                              | Disposition                                                                                                                                                                                                                                                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | high     | The SQL store bound the "not on the active key" predicate to a **fixed** `$3`, while parameter indexes shift when a watermark is present. A resumed batch would filter on the wrong value.                                           | **Fixed.** Indexes are allocated while the SQL is built; the Postgres suite resumes a killed run and asserts the count.                                                                                                                                                                          |
| F2  | high     | `APP_KEY_NEXT` was documented as inert while ADR-0021 makes it the **writer**. Documentation and code disagreed about which key encrypts.                                                                                            | **Fixed.** ADR-0021 records the decision; `VLT-013`, the keyring tests and § 4 of `06-vault.md` now assert the same rule.                                                                                                                                                                        |
| F3  | medium   | No row-level binding in the AAD: the envelope authenticates `table.column`, not the primary key. Two ciphertexts **swapped within the same column** decrypt cleanly, so a write that only moves values between rows is not detected. | **Accepted, documented** (§ 7). Binding the row key would require the codec to know the primary key at encode time, which it does not (auto-increment and application-generated ids). Mitigation today: a swap changes what a row _means_, so it surfaces in the application, not in the crypto. |
| F4  | medium   | `count(*)` was coerced with `Number(...)` on a driver value that may be `bigint` (Postgres) or `string` (Bun SQL). An unexpected shape produced `NaN`, which JSON renders as `null`.                                                 | **Fixed.** `toCount()` handles all three shapes; `make coercion` is clean.                                                                                                                                                                                                                       |
| F5  | medium   | Blind indexes leak frequency: equal plaintexts produce equal digests.                                                                                                                                                                | **Inherent, documented** (§ 6.2) with the guidance to index only high-entropy values. Nothing in the code can remove this.                                                                                                                                                                       |
| F6  | medium   | Rotation was described as "automatic" in an early draft of the runbook while the implementation is a batched job. An operator could have believed rows moved on deploy.                                                              | **Fixed.** § 4 is explicit: setting `APP_KEY_NEXT` changes zero bytes on disk; `vault:rotate` is a scheduled job with a ledger.                                                                                                                                                                  |
| F7  | low      | A throwing metrics sink could fail a rotation that had otherwise worked.                                                                                                                                                             | **Fixed.** `report()` swallows sink failures; a test asserts the rotation still completes.                                                                                                                                                                                                       |
| F8  | low      | The CLI closed the application's exported `Database` in a `finally`, so a second command in the same process got `DB_CLOSED`.                                                                                                        | **Fixed.** The commands leave the connection to the app; the binary exits immediately after `runCli`.                                                                                                                                                                                            |
| F9  | low      | Blind-index normalisation is opt-in, so `Alice@Example.com` and `alice@example.com` index differently unless configured.                                                                                                             | **By design** — merging two values is a product decision, not a library default. § 6.2 says so.                                                                                                                                                                                                  |

## What is verified, and how

| Property                               | Evidence                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Machine independence (no OS keychain)  | `portability.test.ts` — a separate `bun -e` process decrypts a value the test process wrote           |
| AAD binding                            | matrix rows 6, 7: swapped column and tampered ciphertext both fail closed                             |
| Fail-closed errors                     | matrix rows 4–8, 16, 17; every code in § 7 has a test                                                 |
| Rotation idempotence and resume        | `rotation.test.ts` (in-process) + Postgres suite (kill mid-run, resume, no double write)              |
| One runner per target                  | Postgres advisory lock, `locked: true` rather than an exception                                       |
| Retirement cannot strand rows silently | `VLT_STALE_KEY` with the count; `--force` requires `--confirm <id>`                                   |
| No secret in logs                      | `vault/src/logs.test.ts` + `make logs` sweeping the whole suite's output                              |
| Portable across runtimes               | `make verify-dist`: Bun (smoke), Node (executed bundle), Workers (browser bundle, no `node:` imports) |

## Open risks

1. **No external audit.** (Above.)
2. **`xchacha20-poly1305` is unimplemented.** AES-256-GCM via WebCrypto only; adding a second
   algorithm needs a vetted library and an ADR (ADR-0012).
3. **Blind-index secrets have no rotation tooling.** Rotating one is a manual backfill (§ 6.2).
4. **Row-level AAD is not bound** (F3).
5. **`VLT-023` has no exporter yet** — metrics are emitted, nothing collects them until
   `@tsir/telemetry` lands in phase 8.

## Sign-off

The design in `06-vault.md` is implemented as written, with the deviations recorded in § 4 and
§ 6. Findings F1–F2 and F6–F8 are fixed in code and covered by tests; F3–F5 are accepted and
documented. **Reviewer: the author of the implementation (not independent).**
