# ADR-0021 — `APP_KEY_NEXT` is the writing key

- **Status:** Accepted
- **Date:** 2026-10-28
  **Amends:** [ADR-0008](./0008-vault-key-state.md) § 2 — "`APP_KEY_NEXT` = staged material … It is **inert**" no longer holds.
  **Supersedes:** none · **Related:** [ADR-0008](./0008-vault-key-state.md) (ids in envelopes), [ADR-0019](./0019-multi-connection.md) (named connections), plans/modules/06-vault.md § 3–4

## Context

ADR-0008 made `APP_KEY_NEXT` inert on purpose: material could be deployed to every
instance with zero behaviour change, and a separate `vault:key:activate` command flipped
the writer. The cost is two knobs — material **and** state must agree before anything
changes, and the state has to be written down (the keyring manifest) so instances can
disagree about it honestly.

Production feedback from the product owner, recorded verbatim: _"when `_NEXT` has a value,
when they use the library like `crypt.encrypt(...)` it will use the `_NEXT` version … if
`_NEXT` wasn't defined or not in the env, then we default to use the `_NOW`."_

That is `MultiFernet`'s rule (`cryptography`): the list is `[next, now]`, encryption uses
the first key, decryption tries all. Rails' `previous` keys and HashiCorp Transit's
key-versioned encrypt behave the same way. One knob instead of two: **deploying the
material is the migration.**

## Decision

1. **The writer is `APP_KEY_NEXT` when present, `APP_KEY_NOW` otherwise.** `crypt.encrypt()`
   uses the writer; the envelope carries the writer's key id.
2. **Both keys are always decryptable.** `APP_KEY_NOW` keeps its material when `APP_KEY_NEXT`
   appears; it becomes `decrypt-only` in the keyring rather than disappearing.
3. **Key ids may be versions.** The spec stays `<id>:<alg>:<material>`, with
   `<id>:<material>` accepted for `aes-256-gcm`, and the id charset widened from
   "lower-case base32, 8–32 chars" to "lower-case, 2–32 chars, starting with a letter".
   `v1`, `v2`, `v11` are legal ids; `vault:key:generate --id v2` writes them.
4. **`vault:key:activate` stays, with a smaller job.** It is bookkeeping, not a switch:
   promote `NEXT` to `NOW`, clear `APP_KEY_NEXT`, and print the manifest that keeps the old
   key as `decrypt-only` with its material in `materials`.
5. **The rollout guard survives, renamed in purpose.** A deployed manifest must still name
   `APP_KEY_NOW`'s id (`VLT_KEYRING_MISMATCH`), because that is the key rows on disk may
   still be under. A manifest that still calls `APP_KEY_NOW` active is tolerated and
   rewritten — it is stale, not a second writer.

## Rationale

- The id-in-envelope rule (ADR-0008 § 1) is what makes this safe: a reader selects the key
  by id, so "which key encrypts" and "which keys decrypt" never have to agree across
  instances. Dropping the inert state does not weaken that.
- The state machine keeps four states. `staged` now means what it says — material deployed
  through the manifest but not writing — instead of doubling as "the env var is set".
- Rotation is still explicit, resumable and provable: `vault:rotate` rewrites rows,
  `vault:key:retire` refuses while a count is non-zero.

## Consequences

**Positive**

- One knob. No "I set `APP_KEY_NEXT`, why is it still writing with `APP_KEY_NOW`?".
- Versioned ids (`v1`, `v2`) read the way operators talk about rotation.
- The common case — rotate because a key is aging — needs no manifest edit at all until
  the old key is retired.

**Negative / costs, and the mitigations**

- **The config push is now the switch.** An env change that reaches one instance before
  another produces mixed writers for the length of that rollout. Mitigations: the previous
  key stays decryptable on every instance that received the new one; an instance that
  _didn't_ receive it fails loudly with `VLT_UNKNOWN_KEY` (never plaintext); the manifest
  can carry the new material to the whole fleet first, which makes the window empty; and
  `vault:rotate` + `retire --count 0` keep the end state provable.
- **A stale `APP_KEY_NEXT` keeps writing with a key nobody is watching.** Mitigation:
  `vault:key:activate` clears it, and boot logs the writer's id every start.
- Sequential ids are reusable in a way random ids are not. Reusing `v2` with different
  material makes old rows fail authentication (`VLT_AUTH_FAILED`) — loud, never silent —
  and the plan tells operators to keep ids unique per environment forever.

## Alternatives considered

| Alternative                                             | Why rejected                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Keep `APP_KEY_NEXT` inert (ADR-0008 as written)         | Two knobs for one intent; the deciding signal was that operators expect deploying a key to mean using it. |
| Encrypt with `NOW`, decrypt with both, no `NEXT` at all | Removes the only place to put the incoming key without a manifest edit per rotation.                      |
| Strict integer versions (`v1`, `v2`, … only)            | Loses the "never reuse an id" property; a version-style id is allowed, not mandated.                      |
| Auto-rotate rows in the background on boot              | Turns a deploy into unbounded write load on a database nobody is watching; rotation stays a CLI runner.   |

## Revisit conditions

If a deployment target cannot guarantee atomic config rollout (or the fleet can be
partitioned by a canary), reintroduce the explicit switch as an **optional** flag —
`VAULT_WRITER=now|next` — rather than changing the default back.
