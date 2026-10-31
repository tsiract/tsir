# ADR-0008 — Key Ids in Envelopes; a Keyring Manifest Carries State

- **Status:** Accepted
- **Date:** 2026-10-27
- **Affects:** `@tsir/vault`, `@tsir/database` codec, deploy secrets
- **Amended by:** [ADR-0021](./0021-next-key-writes.md) — § 2 only. `APP_KEY_NEXT` is the
  **writer** when present, not inert; key ids may be version tokens (`v1`, `v2`). Everything
  else here — ids in envelopes, a manifest for state, the ledger, the boot invariants —
  stands unchanged.

---

## Context

The brief mandates `APP_KEY_NOW` and `APP_KEY_NEXT` and requires that rotation distinguish **four** states:

1. key used for new encryption,
2. key versions accepted for decryption,
3. next key to be activated,
4. migration status of existing ciphertext,

adding: "the two environment variables must not be the only source of truth for all four states."

A naive `now`/`next` scheme has failure modes:

- Decryption requires knowing _which_ key made a value, but `now`/`next` are relative to **time of deployment**, not to the ciphertext.
- Rolling deployments mean two instances disagree about "now".
- Retiring a key requires proving no ciphertext references it.

## Decision

1. **Every envelope embeds a stable `keyId`** (`tsir:v1:<keyId>:<alg>:<payload>`). Decryption selects the key by id, never by position or variable name.
2. **`APP_KEY_NOW` / `APP_KEY_NEXT` carry material only.**
   - `APP_KEY_NOW` = the material for the currently active key (its id must be present in the keyring).
   - `APP_KEY_NEXT` = staged material for the next rotation. It is **inert**: it is not a decryption key until activation changes its state.
3. **A keyring manifest carries state**: `staged` / `active` / `decrypt-only` / `retired`, plus key ids and algorithms. It is deployed as a secret alongside the env vars.
4. **A rotation ledger table** tracks which rows still carry an old key id — state (4) lives in the database, not in env.
5. Boot invariants: exactly one `active` key; `APP_KEY_NOW`'s id must exist in the keyring; a `retired` key id referenced by rows fails boot (`VLT_STALE_KEY`).
6. Transitioning between old and new keys is an explicit CLI state machine: `vault:key:generate` → deploy `APP_KEY_NEXT` → `vault:key:activate` → rolling deploy → `vault:rotate` → `vault:key:retire`.

## Rationale

- The id in the envelope makes decryption **deterministic** and deployment-order-independent — the core requirement for rolling deploys.
- Separating material (env) from state (manifest + ledger) prevents the classic incident where flipping an env var instantly makes historical rows unreadable.
- `APP_KEY_NEXT` being inert prevents accidental double-active states.

## Consequences

**Positive**

- Rotation is resumable and observable; retirement is provable (ledger count = 0).
- A partially rolled-out deployment produces a clear error (`VLT_KEYRING_MISMATCH`), not silent corruption.
- Supports more than two keys, which real rotation windows require.

**Negative / costs**

- One more secret to deploy (the keyring manifest) and a ledger table to manage.
- Key ids appear in ciphertext (~9 bytes overhead) and in operator logs (ids only, never material).
- Envelope parsing is a trust boundary that needs its own fuzz tests.

## Alternatives considered

| Alternative                         | Why rejected                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `now`/`next` only, try-both-decrypt | Ambiguous, doubles auth failures, breaks with > 2 keys, gives no retirement proof          |
| Version integer instead of key id   | Loses meaning after reorderings; ids are stable across environments                        |
| External KMS decrypt-by-any-version | Still needs envelope identification; reserved as a `VaultKeyProvider` implementation later |

## Revisit conditions

When a `VaultKeyProvider` (KMS/HSM) backend lands, the id-in-envelope rule stays; only material acquisition changes.
