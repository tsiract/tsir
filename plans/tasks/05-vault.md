# Tasks — Vault (Phase 4)

> Envelope, keyring, column codec, rotation state machine.

**Plan:** [`../06-vault.md`](../modules/06-vault.md)

---

## Core encryption

| ID        | Title                                                                                   | Status | Depends         | Acceptance criteria (summary)                            |
| --------- | --------------------------------------------------------------------------------------- | ------ | --------------- | -------------------------------------------------------- |
| `VLT-001` | Envelope format (`tsir:v1:<keyId>:<alg>:<payload>`) parser + serializer                 | `[x]`  | —               | 17 malformed-shape fixtures produce deterministic errors |
| `VLT-002` | AES-256-GCM encrypt/decrypt via WebCrypto                                               | `[x]`  | VLT-001         | Round-trip test across Bun/Node/Workers runtimes         |
| `VLT-003` | AAD binding (`table.column`)                                                            | `[x]`  | VLT-002         | Ciphertext moved between columns fails auth              |
| `VLT-004` | Nonce generation + uniqueness test (1e6)                                                | `[x]`  | VLT-002         | Zero collisions; nonce length enforced (12 B)            |
| `VLT-005` | Key material parsing/validation (32 B, base64url, id charset)                           | `[x]`  | VLT-001         | `VLT_INVALID_KEY_MATERIAL` with id only                  |
| `VLT-006` | Non-extractable `CryptoKey` import; raw string discarded                                | `[x]`  | VLT-005         | Key not exposed on the key object                        |
| `VLT-007` | Fail-closed error set (`UNKNOWN_KEY`, `AUTH_FAILED`, `MALFORMED_ENVELOPE`, `TOO_LARGE`) | `[x]`  | VLT-002         | Each mapped in `06-vault.md § 7`                         |
| `VLT-008` | Drizzle `encryptedText` column codec                                                    | `[x]`  | VLT-003, DB-012 | Insert/select round-trips a string                       |
| `VLT-009` | Codec rejects non-string input types                                                    | `[x]`  | VLT-008         | Numbers/objects → `VLT_UNSUPPORTED_TYPE`                 |

## Keyring & state machine

| ID        | Title                                                      | Status | Depends | Acceptance criteria (summary)                             |
| --------- | ---------------------------------------------------------- | ------ | ------- | --------------------------------------------------------- |
| `VLT-010` | `Keyring` manifest loader + merge with env                 | `[x]`  | VLT-005 | Conflict detection when sources disagree                  |
| `VLT-011` | State machine (`staged`/`active`/`decrypt-only`/`retired`) | `[x]`  | VLT-010 | Illegal transition rejected with current/attempted states |
| `VLT-012` | Invariant checks at boot (exactly one active, unique ids)  | `[x]`  | VLT-011 | `VLT_KEYRING_INVALID` lists all keys and states           |
| `VLT-013` | `APP_KEY_NOW` / `APP_KEY_NEXT` semantics                   | `[x]`  | VLT-012 | NEXT is inert until activated (test #9)                   |
| `VLT-014` | `VLT_KEYRING_MISMATCH` rollout guard                       | `[x]`  | VLT-011 | NOW id missing from keyring → boot fails                  |
| `VLT-015` | `vault:key:generate` (prints once, never stores)           | `[x]`  | VLT-005 | Output shown once; not written to disk                    |
| `VLT-016` | `vault:key:activate` with state transition + CLI diff      | `[x]`  | VLT-011 | Prints exact env/manifest changes                         |
| `VLT-017` | `vault:key:retire` guarded by remaining-rows check         | `[x]`  | VLT-019 | Refuses while rows remain; `--force` + typed id           |
| `VLT-018` | Rollback/downgrade behavior documented + tested            | `[x]`  | VLT-014 | Old instance reading new key → explicit error             |

## Rotation

| ID        | Title                                            | Status | Depends | Acceptance criteria (summary)                         |
| --------- | ------------------------------------------------ | ------ | ------- | ----------------------------------------------------- |
| `VLT-019` | Rotation ledger table + watermark batching       | `[x]`  | VLT-011 | Unique `(table, pk, column)`; resume-safe             |
| `VLT-020` | `vault:rotate --batch` resumable runner          | `[x]`  | VLT-019 | Kill mid-run then resume completes without duplicates |
| `VLT-021` | Concurrency lock per (table, column)             | `[x]`  | VLT-020 | Second runner exits with `VLT_ROTATION_LOCKED`        |
| `VLT-022` | `vault:rotate:status` (remaining, failures, ETA) | `[x]`  | VLT-020 | `--json` schema documented                            |
| `VLT-023` | Rotation metrics + spans                         | `[~]`  | VLT-020 | `vault_rotation_remaining` reported per column        |
| `VLT-024` | Concurrent-writer test during rotation           | `[x]`  | VLT-020 | All rows end on active key; no double processing      |

## Blast-radius / extras

| ID        | Title                                                | Status | Depends | Acceptance criteria (summary)                       |
| --------- | ---------------------------------------------------- | ------ | ------- | --------------------------------------------------- |
| `VLT-025` | Blind index (`HMAC-SHA256`) with caveats documented  | `[x]`  | VLT-002 | Equality lookup works; docs state frequency leakage |
| `VLT-026` | `VaultKeyProvider` seam for KMS/HSM (no vendor code) | `[x]`  | VLT-006 | Interface stable; default provider is the keyring   |
| `VLT-027` | Log-capture test: no key material or plaintext       | `[x]`  | VLT-002 | Zero matches across the full suite                  |

### Notes on the ticked rows

- **`VLT-013` was re-decided on 2026-10-28** ([ADR-0021](../decisions/0021-next-key-writes.md)):
  `APP_KEY_NEXT` is the **writer** when present, `APP_KEY_NOW` otherwise. The row stays
  `[x]`; the tests now assert the new semantics (next writes, now keeps decrypting,
  versioned ids, a stale `active` flag on the previous key tolerated).

- `VLT-002` is `[x]`, proven three ways in `make verify-dist`: the Bun round-trip runs in the
  smoke test, the `node` bundle is **executed** under Node 20 and asserted to decrypt, and the
  `browser` (Workers) bundle is 9.2 KiB with no `node:`/`bun:` specifier. The remaining gap is
  honest: Workers are proven by bundling, not by a deployed worker.
- `VLT-004` is 1e6 nonces in one process (`vault.test.ts`), not a statistical claim.
- `VLT-008` is `encryptedText()` from `@tsir/vault/drizzle` plus `createVaultCodec()`;
  the round-trip runs against a real Postgres in `@tsir/database`'s
  `encrypted-column.integration.test.ts`, because `vault` may not import `database`.
- `VLT-010`…`VLT-014` cover manifest merge, the state machine, boot invariants and the
  `APP_KEY_NOW` rollout guard.
- `VLT-015`/`VLT-016` ship as `tsir vault:key:generate` and `tsir vault:key:activate`;
  `planActivation()` is the tested core, and the command never prints key material —
  the promotion output is ids, states and the manifest.
- `VLT-017` stays `[ ]`: "refuses while rows remain" needs the rotation ledger
  (`VLT-019`), and a retire command that cannot count is a command that lies.
- `VLT-018` is `[x]`: matrix row 14 runs the real rolling-deploy shape — an old
  instance holding only the old key meets a new-key row and gets `VLT_UNKNOWN_KEY`
  while the promoted instance reads both. A decrypt-only key _without_ material is
  now a boot failure (`VLT_INVALID_KEY_MATERIAL`) rather than a runtime surprise.

### Rotation: as built (2026-10-28)

- **Engine, `@tsir/vault`:** `runRotation()` + `rotationStatus()` over a `RotationStore`
  port — watermark query (`key > watermark order by key`), per-row idempotence (a row
  already on the active key is skipped, not rewritten), per-row failure sampling that never
  stops the run, an abort signal that leaves a resumable state, and a measured
  `rowsPerSecond` / `etaMs` rather than an estimate.
- **The port is `ensureLedger` + `withLock(target, run)` + `remaining`.** The lock _wraps_
  the work instead of being acquired and released around it, because a Postgres advisory
  lock is session-scoped: taking it on one pooled connection and rewriting rows through
  another is not a lock at all. `withLock` hands back a `RotationScope` bound to the locked
  session and releases on throw and on abort.
- **Store, `@tsir/database`:** `createRotationStore(database, { table, column, keyColumn })`
  with the ledger DDL (`__tsir_vault_rotation`, primary key `(table_name, column_name,
row_key)` — so a resumed run cannot double-count), one `batch([update, insert …])` per row
  so the value and its ledger entry commit together, and `pg_try_advisory_lock` on a pinned
  connection for `withLock`. D1 takes no lock and does not need one: one writer per location.
- **CLI:** `tsir vault:rotate --table --column [--key-column] [--batch] [--dry-run] [--json]`
  and `tsir vault:rotate:status`. Both read the vault the application exports — the CLI
  never re-derives keys from `APP_KEY_*`, because a re-derived keyring is how rows get
  "rotated" onto a key the application cannot read. A held lock exits `4`, per-row failures
  exit `1`, and the `--json` shapes are asserted in `vault-rotate.test.ts`.
- **`VLT-019`…`VLT-022`, `VLT-024` are `[x]`; the evidence, per row:**

  | Row       | Where it is proven                                                                                                                                    |
  | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `VLT-019` | `database/rotation.test.ts` (ledger, duplicate refusal, rollback on a failed ledger write) + `database/rotation.integration.test.ts` on real Postgres |
  | `VLT-020` | `rotation.test.ts` kill-and-resume; `vault-rotate.test.ts` two runs, the second a no-op; interrupted-run resume in the Postgres suite                 |
  | `VLT-021` | Postgres suite: a second store, therefore a second pinned session, gets `locked: true` and the row count is unchanged                                 |
  | `VLT-022` | `vault-rotate.test.ts` `--json` before/after; `percent` is `null` when no denominator is known — never invented                                       |
  | `VLT-024` | Postgres suite: a row written by the application mid-run is already on the active key and is not touched                                              |

- **`VLT-023` is `[~]`.** The engine emits `vault_rotation_rows_total`,
  `vault_rotation_errors_total{code}` and `vault_rotation_remaining` through an optional
  structural `RotationObserver`, and a test proves a throwing sink cannot fail a rotation.
  What is missing is the other end: `@tsir/telemetry` is phase 8 (`OBS-*`), so nothing
  exports these numbers yet, and spans wait for the same package.
- **`VLT-017` (`vault:key:retire`) is `[x]`.** `planRetire()` refuses in the order operators
  actually make mistakes — unknown id, then the writer (`VLT_KEY_STILL_ACTIVE`, including a
  `staged` key that ADR-0021 makes the writer), then rows (`VLT_STALE_KEY` with the count) —
  and the CLI requires `--confirm <id>` beside `--force`. The count is `countKey()` in the
  SQL store: a prefix scan, not a ledger lookup.

---

## Extras as built (2026-10-28)

- **`VLT-025` blind index:** `createBlindIndex({ key, table, column, normalize? })` =
  `HMAC-SHA256` over `tsir:bid:v1:<table>.<column>:<value>`, 43 characters of base64url.
  Caveats are in § 6.2: frequency leakage, equality only, a separate secret (a key spec is
  refused), and rotation of the index secret being its own backfill.
- **`VLT-026` provider seam:** `VaultKeyProvider` returns a `CryptoKey` per key id **at boot**;
  the default provider is the keyring's own material, so the seam has a real caller from day
  one. The vault refuses extractable keys, the wrong algorithm, or a missing usage. No vendor
  code, no new dependency.
- **`VLT-027` log capture:** `vault/src/logs.test.ts` logs every vault error through
  `console.error`, `String(error)`, `error.stack` and `toLogObject()`, then greps the capture
  for the material, the spec and the plaintext. `make logs` runs the **whole suite** and
  fails on any key material, `APP_KEY_*` value or the plaintext canary in its output.

## Gate P4 checklist

- [x] Test matrix in `06-vault.md § 8` fully implemented — **17 of 17 rows** (row 11 via
      `VLT-017`, row 15 via `VLT-027` and `make logs`).
- [~] Rotation resumable + idempotent per row — **yes** (`VLT-019`, `VLT-020`, `VLT-024`);
  observable — **partly**: the metric seam exists, the exporter is phase 8 (`VLT-023`).
- [x] Rolling deploy simulation passes (`VLT-018`, matrix row 14).
- [x] No secret/plaintext in logs (`VLT-027`: in-package capture test + suite-wide sweep).
- [x] Runbook reviewed by `SEC-004` — [review notes](../reviews/2026-10-28-vault-design-review.md)
      (author's review; an independent audit is still listed there as an open risk).
