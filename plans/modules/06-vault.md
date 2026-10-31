# 06 — Vault: Versioned Encryption & Key Rotation

> `@tsir/vault`. Authenticated, versioned, column-level encryption with an explicit rotation state machine that is resumable, observable, and fails closed.

---

## 1. Threat model summary

Detailed model in [`14-security.md`](../operations/14-security.md). Vault defends against:

| Threat                                  | Defended | Mechanism                                                    |
| --------------------------------------- | -------- | ------------------------------------------------------------ |
| Database dump / backup leak             | ✅       | Ciphertext only in DB                                        |
| Tampering with stored values            | ✅       | AES-GCM auth tag verified before plaintext returns           |
| Key confusion after rotation            | ✅       | Key id embedded in envelope; deterministic selection         |
| Nonce reuse                             | ✅       | 96-bit CSPRNG nonce per encryption, per key; uniqueness test |
| Log exfiltration                        | ✅       | No plaintext/keys in logs; redaction tests                   |
| Compromised running app (RCE)           | ❌       | Out of scope — keys are in process memory                    |
| Chosen-ciphertext oracle                | ✅       | Fail-closed errors are uniform and non-adaptive              |
| Rollback to an old envelope (downgrade) | ⚠️       | Detected via key state; old-key rows remain valid by design  |

**Out of scope:** HSM/KMS-backed keys (adapter slot reserved, `VaultKeyProvider` contract), field-level searchable encryption, envelope encryption of large blobs (documented size limit).

---

## 2. Ciphertext envelope

```text
tsir:v1:<keyId>:<alg>:<base64url(nonce || ciphertext || tag)>
  │    │    │      │
  │    │    │      └── alg: "aes-256-gcm" | "xchacha20-poly1305"
  │    │    └───────── keyId: lowercase base32, 8–32 chars, stable, never reused
  │    └────────────── envelope version (BREAKING format changes only)
  └─────────────────── magic prefix
```

Properties:

- **Self-describing.** A row can be decrypted by any code version that knows the prefix and has the key id.
- **AAD binding.** The auth tag covers `aad = tsir:v1:<keyId>:<alg>:<table>.<column>` — so a ciphertext moved to a different column fails authentication. Column context is supplied by the codec, not by the caller.
- **Fixed layout.** `nonce` is 12 bytes (GCM) / 24 bytes (XChaCha); tag 16 bytes. Length validation happens before any crypto call.
- **Size limit.** Plaintext > 64 KiB is rejected by the column codec with `VLT_TOO_LARGE` (use `@tsir/storage` for blobs).
- **No compression** before encryption (CRIME-class attacks), documented.

Envelope parsing is a pure function, exhaustively tested with malformed inputs.

---

## 3. Key model

```ts
export interface VaultKey {
  readonly id: string; // e.g. "v2" or "k7f3q2ab" — 2–32 chars, lower-case, letter first
  readonly material: CryptoKey; // imported, non-extractable
  readonly alg: 'aes-256-gcm' | 'xchacha20-poly1305';
  readonly state: KeyState;
  readonly createdAt: string;
}
export type KeyState = 'staged' | 'active' | 'decrypt-only' | 'retired';
```

### 3.1 State machine

```
                    activate
   staged ───────────────────────► active ──────┐
     │                              │           │ demote
     │ discard                      │ rotate    ▼
     ▼                              ▼        decrypt-only
  retired ◄── retire ─────────── new active      │
     ▲                                           │ retire (after re-encrypt verified)
     └───────────────────────────────────────────┘
```

**The writer is chosen by the environment, not by the table** ([ADR-0021](../decisions/0021-next-key-writes.md)):
`APP_KEY_NEXT` when it has a value, otherwise `APP_KEY_NOW`. The state list below is the
vocabulary the manifest and the ledger use; `active` is always the writer.

| State          | Encrypt          | Decrypt | Allowed transitions                           |
| -------------- | ---------------- | ------- | --------------------------------------------- |
| `staged`       | ❌               | ❌      | → `active`, → `retired` (discard)             |
| `active`       | ✅ (exactly one) | ✅      | → `decrypt-only` (when a new `active` exists) |
| `decrypt-only` | ❌               | ✅      | → `retired` (only when 0 rows reference it)   |
| `retired`      | ❌               | ❌      | terminal                                      |

Invariants enforced at boot (`VLT_KEYRING_INVALID`):

1. Exactly one `active` key, or zero when encryption is disabled.
2. Key ids are unique and never reused.
3. A `retired` key id present in the DB raises `VLT_STALE_KEY` at boot (checked by a startup count query, `SELECT count(*) … WHERE envelope LIKE 'tsir:v1:<id>:%'`, limited to a bounded sample + exact check via the rotation ledger).

### 3.2 Environment variables

The brief mandates `APP_KEY_NOW` and `APP_KEY_NEXT`; they are **material carriers**, not the state machine ([ADR-0008](../decisions/0008-vault-key-state.md)).

```dotenv
APP_KEY_NOW=v1:<base64url 32 bytes>        # writes, unless APP_KEY_NEXT is set
APP_KEY_NEXT=v2:<base64url 32 bytes>       # set it and the next write uses v2
TSIR_KEYRING_FILE=                   # optional path/manifests for decrypt-only keys (bundled as a secret)
```

Semantics, stated precisely ([ADR-0021](../decisions/0021-next-key-writes.md)):

- **The writer is `APP_KEY_NEXT` if it is deployed, otherwise `APP_KEY_NOW`.** Deploying the
  next key _is_ the start of the migration — `crypt.encrypt()` starts writing the new
  version on the instance that has it, and every envelope it writes carries that id. This is
  `MultiFernet`'s rule: encrypt with the first key, decrypt with all of them.
- `APP_KEY_NOW` keeps decrypting after the switch. It is not "the old key to remove later";
  it is the key the fleet's existing rows are still under, and it stays in the decrypt set
  until the ledger says zero rows reference it.
- A key id may be a version (`v1`, `v2`, `v11`) or an opaque id (`k7f3q2ab`, what
  `vault:key:generate` produces). Both go through the same charset rule, so the envelope's
  parse is unchanged; `vault:key:generate --id v2` emits the versioned form directly.
- Key material is `id:alg:material`, or `id:material` for `aes-256-gcm` — the short form
  exists because a versioned key is written by hand, and a default that cannot be ambiguous
  beats ceremony. A second algorithm will require the long form.
- Decrypt-only keys come from the keyring manifest; that manifest is _derived_ by the vault CLI from rotation state and must be deployed as a secret. The sources are merged with explicit precedence and conflict detection.
- **`TSIR_KEYRING_FILE` shape:** `{"keys":[{"id","alg","state"}],"materials":{"<id>":"<id>:<alg>:<material>"}}`.
  `keys` is state and is safe to print, log and diff; `materials` is secret and is only
  read — `planActivation()` and `keyringManifest()` never carry it, so a promotion plan
  cannot leak key bytes by construction. A `decrypt-only` key whose material is missing
  fails at boot with `VLT_INVALID_KEY_MATERIAL` naming the id.

**What the rolling deploy looks like now.** Pushing `APP_KEY_NEXT` to the whole fleet at
once is safe as long as the new key's material also reaches the fleet (env or manifest
`materials`) in the same change: every instance can read every row it or its neighbours
write. A config rollout that _is_ staggered produces a real window — instance A writes `v2`,
instance B has not seen it — and B fails with `VLT_UNKNOWN_KEY` naming the key it lacks.
That failure is loud and safe, which is why this ordering is acceptable; the alternative
(ADR-0008's inert `NEXT`) buys a zero-window rollout at the cost of a second knob. The
mitigation when a fleet cannot be updated atomically is documented, not hidden: deploy the
material through `TSIR_KEYRING_FILE` first (which changes no behaviour on its own, because
a key that is not the writer only decrypts), then flip `APP_KEY_NEXT`.

### 3.3 Four distinct states (brief requirement)

| Concern                                 | Source of truth                                       |
| --------------------------------------- | ----------------------------------------------------- |
| Key used for new encryption             | `APP_KEY_NEXT` when present, else `APP_KEY_NOW`       |
| Key versions accepted for decryption    | keyring entries with state `active` or `decrypt-only` |
| Next key to be activated                | `APP_KEY_NEXT` — already writing, promoted by the CLI |
| Migration status of existing ciphertext | rotation ledger table (`__tsir_vault_rotation`)       |

The two env vars are never the only source of truth, and the CLI refuses to infer state from them alone.

---

## 4. Rotation runbook

```
1. tsir vault:key:generate            → prints id:alg:material, writes to secret manager (never to repo)
2. Deploy new material as APP_KEY_NEXT (all instances).      [writer switches — ADR-0021]
3. tsir vault:key:activate --key <id> → bookkeeping: promote to APP_KEY_NOW, clear
                                        APP_KEY_NEXT, print the manifest that keeps the
                                        old key decrypt-only (material in `materials`)
4. Rolling deploy completes → every instance writes the new key.
5. tsir vault:rotate --batch 500      → resumable re-encryption; ledger tracks (table, pk) watermarks
6. tsir vault:rotate:status           → remaining rows per table/column, failures, ETA
7. tsir vault:key:retire --key <old>  → refuses while ledger reports rows remaining; requires --force + typed id
8. Remove old material from secrets.   → rollback now impossible; documented, deliberate
```

**Implemented so far (2026-10-28):** steps 1–3 and 5–6.

| Step | Command                              | What it does                                                                              |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1–2  | `tsir vault:key:generate`            | prints a key spec once; writes nothing                                                    |
| 3    | `tsir vault:key:activate`            | plans the promotion — env swap, manifest entries, states — as bookkeeping only (ADR-0021) |
| 5    | `tsir vault:rotate --table --column` | re-encrypts a column onto the writer key, batched, resumable, locked per target           |
| 6    | `tsir vault:rotate:status`           | rows left per column, from the same `remaining` query the runner uses                     |

Both rotation commands read the `Vault` the application entry exports, never a keyring the
CLI derives from `APP_KEY_NOW`/`APP_KEY_NEXT`: the runner has to write with the same keyring
the application reads with, and a second, weaker key path is exactly how a rotation ends up
writing rows nothing can decrypt. A held lock exits `4`; per-row failures exit `1` while
leaving the run resumable.

Step 7 (`tsir vault:key:retire`) requires the target column, for the same reason the other
two commands do: "how many rows still name this key" is a question about a column, and the
count is a prefix scan (`countKey`) rather than a ledger lookup — the ledger only knows what
a runner wrote, while a retiring key's danger is the row some earlier deployment wrote. A
non-empty count is `VLT_STALE_KEY`; `--force` goes ahead only with `--confirm <id>` typed
out, because a flag that is easy to replay from shell history is not a confirmation.

### Rolling deployments

- During step 2–4, **old and new instances coexist**. Old instances encrypt with the old key (still `active` in their view) and must be able to **decrypt** new-key rows only if such rows exist — they don't, until new-key writes start. The safe ordering is: _deploy decrypt-only capability first_ (old key remains in decrypt set), then switch writer, then re-encrypt.
- The vault refuses to start if `APP_KEY_NOW`'s id is not present in the deployed keyring (prevents a partial rollout that cannot decrypt its own writes), with `VLT_KEYRING_MISMATCH` and an explicit remediation hint.
- **Downgrade behavior:** a new-key ciphertext read by an instance lacking that key id throws `VLT_UNKNOWN_KEY` — a hard error, never a fallback to plaintext or an empty string.
- **Aborting a rotation.** Clearing `APP_KEY_NEXT` is safe only _before_ any row was written with it. Once rows exist, removing the key strands them: the key must move into the manifest's `materials` as `decrypt-only` (so the keyring can still read) while `APP_KEY_NOW` goes back to the old key. `vault:key:activate` prints exactly that manifest; there is no command that deletes a key that rows reference, by design.
- **Aborting a rotation** (ADR-0021 makes this a real scenario: `APP_KEY_NEXT` is already
  writing) is only free _before_ any new-key row exists. Clear `APP_KEY_NEXT` and nothing
  has changed. Once rows exist, clearing it strands them: move that key into
  `TSIR_KEYRING_FILE` `materials` as `decrypt-only` **first**, then clear the env. The
  CLI's promotion plan prints exactly that manifest, so the safe abort is "activate the
  key you were about to abandon, then retire it once the count is zero".

### Resumability & observability

**As built (2026-10-28):** the runner is `runRotation()` in `@tsir/vault`, and it talks to
storage through a `RotationStore` port — `ensureLedger`, `withLock(target, run)`,
`remaining`, with a `RotationScope` (`batch`, `commit`) handed to the callback — because `@tsir/vault` may not import `@tsir/database` (the arrow runs the
other way; see `database/src/codec.ts`). The consequence is worth the extra interface: the
kill-and-resume, double-write and held-lock cases are exercised in-process on every save,
and the CLI is a thin adapter rather than a second implementation.

**The SQL side is `createRotationStore()` in `@tsir/database`** (the arrow runs
database → vault, never the reverse): ledger DDL keyed on `(table_name, column_name,
row_key)`, `commit` as one `batch([update, insert …])` so a value and its ledger entry
cannot diverge, `remaining` as a `not like 'tsir:v1:<active>:%'` count, and `withLock` as
`pg_try_advisory_lock` on a **pinned** connection — session-scoped, so the callback shape is
the only correct one. D1 runs the same code without the lock: one writer per location.

**Runtime proof (`VLT-002`):** `make verify-dist` bundles `@tsir/vault` for `browser`
(Workers, 9.2 KiB, no `node:`/`bun:` specifier) and for `node`, then **executes** the Node
bundle and checks an encrypt/decrypt round-trip; the Bun round-trip runs in the same file's
smoke test. Three runtimes, three pieces of evidence, no mocking.

**Metrics:** the engine emits `vault_rotation_rows_total`,
`vault_rotation_errors_total{code}` and `vault_rotation_remaining` through an optional
`RotationObserver`. Nothing exports them yet — `@tsir/telemetry` is phase 8 — and a throwing
sink is swallowed, so a metrics problem can never fail a rotation that otherwise worked.

- `vault:rotate` batches by primary key watermark per (table, column), commits each batch, records progress, and can be killed/resumed safely (`ROTATION_LEDGER` unique on `(table, pk, column)`).
- Metrics: `vault_rotation_rows_total{table,column}`, `vault_rotation_errors_total`, `vault_rotation_remaining`; traces per batch.
- Concurrency: a Postgres advisory lock per (table, column) prevents two runners double-processing.

---

## 5. Column declaration (opt-in, explicit)

Encryption is **never implicit**. Declared through Drizzle column metadata via a codec adapter:

```ts
// schema/users.ts
import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
import { encryptedText } from '@tsir/vault/drizzle';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  taxId: encryptedText('tax_id'), // → text column holding an envelope
  phone: encryptedText('phone', { nullable: true }),
});
```

- `encryptedText` returns a Drizzle column of SQL type `text` with a codec attached through `@tsir/database`'s `codec.ts` single integration point.
  **As built (2026-10-28):** the implemented call is `encryptedText(text('tax_id'))` — the
  dialect's own builder is passed in, because one `text()` per dialect exists and a
  `@tsir/vault` that imported one of them would choose a dialect for every project (and
  give up runtime neutrality). The marker is attached when Drizzle calls `build()`, so the
  same file works for `pg-core`, `sqlite-core` and anything else that builds columns.
  `encryptedColumnsOf(tableName, table)` then turns the marked columns into the
  `CodedColumn`s `defineCodedColumns()` takes, and `CodedColumn.key` carries the one real
  mismatch: the schema property (`taxId`) that holds the value, versus the SQL column
  (`tax_id`) the AAD binds.
- Values are encrypted **before** the driver sees them and decrypted **after** rows come back; Drizzle's types surface `string` to application code.
- Deterministic encryption for lookup columns is **not** supported (no equality search on ciphertext). Documented alternative: a separate HMAC "blind index" column via `@tsir/vault/blind-index` (explicit, salted, with documented frequency-analysis caveats).
- Boot validates that every declared column exists in the Drizzle schema and that the vault is configured (`VLT_NOT_CONFIGURED`).

---

## 6. Algorithms & primitives

| Concern                | Choice                                                                      | Rationale                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| AEAD                   | AES-256-GCM via WebCrypto                                                   | Universal runtime support (Bun, Workers, Lambda Node 20+)                                                            |
| Alternative            | XChaCha20-Poly1305 (optional)                                               | Where extended nonce margin is preferred; implemented via a vetted library (ADR required before adding a dependency) |
| Randomness             | `crypto.getRandomValues`                                                    | CSPRNG in all targets                                                                                                |
| Key import             | `crypto.subtle.importKey('raw', …, { name }, false, ['encrypt','decrypt'])` | Non-extractable keys                                                                                                 |
| Encoding               | base64url (no padding)                                                      | URL/log safe                                                                                                         |
| Constant-time compares | `crypto.subtle.verify` / library primitive                                  | No hand-rolled comparisons                                                                                           |

**No custom primitives.** No `Math.random`, no custom KDF, no custom padding. Key material is 32 random bytes; anything else is rejected at boot.

### 6.1 Why the key is 32 raw bytes, and why it is not a bcrypt hash

Asked directly (2026-10-28): _"make sure that our encrypt/decrypt is not bound to machine at
all, if possible lets use bcrypt way so its easier to use on several servers."_ Two separate
claims, answered separately.

**Nothing is bound to a machine, and that is a property worth having a test for.**
`importKey('raw', …, false, …)` is WebCrypto: no OS keychain, no TPM, no instance identity,
no `node:`/`bun:` module anywhere in the package (`check-boundaries.ts` enforces runtime
neutrality for `vault`). A key is a string in `APP_KEY_NOW` / `TSIR_KEYRING_FILE`, so the
same value on a laptop, two Workers and a Lambda decrypts the same rows. `portability.test.ts`
proves it the only way worth trusting: a **second process** — `bun -e`, given nothing but the
key spec and a ciphertext through the environment — decrypts a value the test process wrote.

**bcrypt cannot do this job, because bcrypt is not encryption.** It is a one-way password
hash with a per-hash random salt: `bcrypt("correct horse")` deliberately cannot be reversed,
so a column "encrypted with bcrypt" could never be read back — it would be a very slow,
salted loss of data. Two further details make it a poor KDF even for _deriving_ a key:
bcrypt emits 184 bits of output (so it cannot produce an AES-256 key without another
construction), and each hash carries its own salt, which would have to be stored next to
every ciphertext — the salt would have to travel with the row, which is exactly what the
envelope's key id already does for keys, not for salts.

**If a passphrase-derived key is ever wanted**, the standard construction is a real KDF —
PBKDF2-HMAC-SHA256 (WebCrypto-native, no dependency) or Argon2id (needs a vetted library and
an ADR, per ADR-0012) — with a **stored, per-project salt** and recorded parameters, and the
derived bytes fed to the same `importKey` path. That is a deliberate, documented change to
§ 3.2's "material carrier" model, not a drop-in: the salt becomes a new piece of deployment
state that the CLI must generate and the manifest must carry. It is not implemented, and the
current default (32 random bytes from `vault:key:generate`) remains the recommendation —
random key material is what every KMS hands you, and it has no dictionary to attack.

### 6.2 Blind indexes — the one thing ciphertext cannot do

`createBlindIndex({ key, table, column, normalize? })` stores
`HMAC-SHA256(secret, "tsir:bid:v1:<table>.<column>:" + value)` as a 43-character base64url
column beside the ciphertext. Equality lookups work again: `where email_bid = $1`.

The caveats are the feature, so they are stated where the code is:

- **Frequency leaks.** Equal plaintexts produce equal digests, so anyone who can read the
  table learns which rows share a value without decrypting anything. Index high-entropy
  values (email, tax id, account number); do **not** index a boolean, a status, or anything
  from a small dictionary — that column is an offline oracle.
- **Equality only.** No `like`, no ranges, no ordering. A `unique` blind index leaks
  existence; that is sometimes exactly what you want (`users.email`), and it is a decision.
- **A separate secret.** The key must not be an `APP_KEY_*` spec, and `createBlindIndex`
  refuses one: reusing one secret for AES and HMAC is the kind of shortcut that turns two
  independent primitives into one shared weakness.
- **Rotation is its own backfill.** The rotation runner does not touch blind-index columns —
  it cannot derive them, because it does not have that secret. Rotating the index secret is a
  recompute of every row, and the runbook says so instead of letting an operator discover it.
- **Normalisation is opt-in.** `Alice@Example.com` and `alice@example.com` are different
  digests unless `normalize` says otherwise, because merging two values is a decision about
  _your_ data.

### 6.3 Where keys come from: `VaultKeyProvider`

The default deployment injects material through `APP_KEY_NOW` / `APP_KEY_NEXT` /
`TSIR_KEYRING_FILE`. `VaultKeyProvider` is the seam for deployments where that is not
acceptable — a KMS or an HSM that will not export bytes:

```ts
interface VaultKeyProvider {
  readonly name: string;
  loadKey(request: { keyId: string; alg: VaultAlg }): Promise<CryptoKey>;
}
```

Three properties of the contract are deliberate:

1. **Boot-time, once per key id.** A provider that is consulted per decryption is a network
   call inside a request; the vault calls `loadKey` exactly once per key while constructing.
2. **It returns a `CryptoKey`, not bytes.** A service that can only _use_ the key needs a
   different seam, and inventing one before there is a caller would freeze the wrong shape.
3. **The keyring still owns policy.** Ids and states come from the manifest; the provider only
   answers "give me `v2`". The vault refuses a provider key that is extractable, has the wrong
   algorithm, or lacks the usage the key id needs — at boot, never on the first request.

No vendor code ships here, and no new dependency: an AWS KMS or PKCS#11 adapter is twenty
lines in the application.

---

## 7. Failure modes

| Code                       | Cause                                | Behavior                         | Client-visible                          |
| -------------------------- | ------------------------------------ | -------------------------------- | --------------------------------------- |
| `VLT_NOT_CONFIGURED`       | Encrypted column used without keys   | Boot fails                       | —                                       |
| `VLT_INVALID_KEY_MATERIAL` | Wrong length/encoding                | Boot fails, prints id only       | —                                       |
| `VLT_KEYRING_INVALID`      | 0 or 2 active keys                   | Boot fails, lists states         | —                                       |
| `VLT_KEYRING_MISMATCH`     | `APP_KEY_NOW` id absent from keyring | Boot fails                       | —                                       |
| `VLT_UNKNOWN_KEY`          | Envelope references unknown key id   | Throw, row excluded from result  | 500 problem (no detail)                 |
| `VLT_MALFORMED_ENVELOPE`   | Truncated/extra segments             | Throw (`VLT_MALFORMED_ENVELOPE`) | 500 problem                             |
| `VLT_AUTH_FAILED`          | Tag mismatch (tamper or wrong AAD)   | Throw (`VLT_AUTH_FAILED`)        | 500 problem; never returns partial data |
| `VLT_STALE_KEY`            | Retired key still referenced by rows | Boot fails with count + table    | —                                       |
| `VLT_ROTATION_LOCKED`      | Concurrent rotation                  | CLI exits non-zero (4)           | —                                       |
| `VLT_KEY_STILL_ACTIVE`     | Retiring the key that still encrypts | CLI exits non-zero               | —                                       |
| `VLT_TOO_LARGE`            | Plaintext > 64 KiB                   | Throw before crypto              | 422                                     |

All decrypt errors are uniform at the HTTP boundary: a single 500 with a correlation id, and a distinct log event (`vault.decrypt_failed`) so monitoring can alert without leaking which key or row.

---

## 8. Test matrix

| #   | Test                                     | Expectation                                                       |
| --- | ---------------------------------------- | ----------------------------------------------------------------- |
| 1   | Round-trip encrypt/decrypt               | Plaintext equality, envelope shape validated                      |
| 2   | Two writes of same plaintext             | Different nonces and ciphertexts                                  |
| 3   | Nonce uniqueness over 1e6 encryptions    | Zero collisions                                                   |
| 4   | Flip one byte in ciphertext              | `VLT_AUTH_FAILED`                                                 |
| 5   | Flip one byte in tag                     | `VLT_AUTH_FAILED`                                                 |
| 6   | Change keyId in envelope                 | `VLT_UNKNOWN_KEY` or auth failure, never success                  |
| 7   | Swap ciphertext between columns          | Auth failure (AAD binding)                                        |
| 8   | Missing key for `decrypt-only`           | `VLT_UNKNOWN_KEY`                                                 |
| 9   | `APP_KEY_NEXT` present but not activated | Not used for encryption; not in decrypt set                       |
| 10  | Two `active` keys                        | Boot fails                                                        |
| 11  | Retire key with remaining rows           | Refused unless `--force`                                          |
| 12  | Rotation interrupted mid-batch           | Resume completes; no row re-encrypted twice                       |
| 13  | Rotation during concurrent writes        | New writes use active key; batch skips rows already on active key |
| 14  | Rolling deploy simulation                | Old instance reads new-key row → explicit error, never plaintext  |
| 15  | Log capture during all of the above      | No key material, no plaintext                                     |
| 16  | Envelope > 64 KiB plaintext              | `VLT_TOO_LARGE` before crypto                                     |
| 17  | Malformed envelopes (10 shapes)          | Deterministic errors, no crash                                    |

Concurrency tests run the rotation runner against a live Postgres with parallel writers.

---

## 9. Security considerations

- Keys live only in memory as non-extractable `CryptoKey`s; the raw string is discarded after import (best-effort, documented — JS strings are not zeroizable, noted in `14-security.md`).
- Error messages never include key ids in client responses; ids appear in operator logs at `warn` level only when action is required.
- The rotation ledger stores no plaintext and no hashes of plaintext.
- Blind indexes use HMAC-SHA256 with a dedicated key id; documentation states explicitly that they leak equality and frequency.
- `tsir vault:*` commands require `--confirm` in production and refuse to run against a DB whose `applicationName` is not registered in the keyring manifest.

---

## 10. Open questions

| #   | Question                                                                                            | Blocks  |
| --- | --------------------------------------------------------------------------------------------------- | ------- |
| Q16 | Ship an XChaCha20-Poly1305 backend in Phase 4, or defer until a runtime requires it?                | Phase 4 |
| Q17 | Key provider contract for KMS/HSM: define now (unimplemented) so the interface is stable, or later? | Phase 4 |
| Q18 | Rotation for Workers: Durable Object coordinator vs cron-driven HTTP unit?                          | Phase 6 |

---

## 11. Task index

[`tasks/05-vault.md`](../tasks/05-vault.md) — `VLT-001` … `VLT-024`.
