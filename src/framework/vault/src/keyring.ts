/**
 * The keyring and its four states (`VLT-010` … `VLT-014`).
 *
 * `APP_KEY_NOW` and `APP_KEY_NEXT` are **material carriers, not the state machine**
 * (ADR-0008). The state lives in the keyring, and the env vars only say which
 * material is on hand. That split is what makes a rolling deploy safe: an instance
 * can hold the next key without being allowed to decrypt with it.
 *
 * | State          | Encrypts | Decrypts |
 * | -------------- | -------- | -------- |
 * | `staged`       | no       | no       |
 * | `active`       | yes      | yes      |
 * | `decrypt-only` | no       | yes      |
 * | `retired`      | no       | no       |
 */

import { invalidKeyring, keyringMismatch, notConfigured } from './errors.ts';
import { assertKeyId, parseKeySpec, type ParsedKey } from './keys.ts';
import type { VaultAlg } from './envelope.ts';

export const KEY_STATES = ['staged', 'active', 'decrypt-only', 'retired'] as const;
export type KeyState = (typeof KEY_STATES)[number];

export interface KeyringEntry {
  readonly id: string;
  readonly alg: VaultAlg;
  readonly state: KeyState;
  /** ISO timestamp, for operator output only. Never used in a decision. */
  readonly createdAt?: string | undefined;
}

export interface Keyring {
  readonly entries: readonly KeyringEntry[];
  /** The one key that encrypts. */
  readonly active: KeyringEntry;
  /** Ids this process can decrypt with: `active` + `decrypt-only`. */
  readonly decryptKeyIds: readonly string[];
  /** The parsed material, keyed by id. Internal to the package. */
  readonly keys: ReadonlyMap<string, ParsedKey>;
  entry(id: string): KeyringEntry | undefined;
}

export interface KeyringInput {
  /** `APP_KEY_NOW`, or `undefined` when the vault is not configured. */
  readonly now?: string | undefined;
  /** `APP_KEY_NEXT` — staged material. Inert until activated. */
  readonly next?: string | undefined;
  /** The deployed manifest (`TSIR_KEYRING_FILE`), for decrypt-only and retired keys. */
  readonly manifest?: readonly KeyringEntry[] | undefined;
  /**
   * Material for keys the manifest lists but the environment does not carry.
   *
   * A `decrypt-only` key has to be able to decrypt, and its material has to come
   * from somewhere: `APP_KEY_NOW` and `APP_KEY_NEXT` hold one key each, so every
   * older key is materialised here (from the same secret file the manifest came
   * from). Keyed by id; each value is a full `<id>:<alg>:<material>` spec.
   *
   * Kept separate from `KeyringEntry` so that a *plan* — which the CLI prints —
   * cannot carry key bytes by construction.
   */
  readonly materials?: Readonly<Record<string, string>> | undefined;
}

/** The legal state graph. Anything not listed here is a bug, not a preference. */
const TRANSITIONS: Readonly<Record<KeyState, readonly KeyState[]>> = {
  staged: ['active', 'retired'],
  active: ['decrypt-only'],
  'decrypt-only': ['retired'],
  retired: [],
};

export function canTransition(from: KeyState, to: KeyState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Rejects an illegal transition, naming both states (`VLT-011`). */
export function assertTransition(from: KeyState, to: KeyState): void {
  if (canTransition(from, to)) return;
  throw invalidKeyring(`cannot go from "${from}" to "${to}"`, {
    from,
    to,
    allowed: TRANSITIONS[from].join(', ') || '(none — retired is final)',
  });
}

/**
 * Builds and validates the keyring.
 *
 * Validation happens here, once, at boot — not at the first decrypt. Every
 * invariant below is a mistake that would otherwise surface as a 500 on one
 * request in production: no active key, two active keys, a duplicated id, an
 * `APP_KEY_NOW` the manifest has never heard of.
 */
export function createKeyring(input: KeyringInput): Keyring {
  if (input.now === undefined || input.now.trim() === '') throw notConfigured();

  const nowKey = parseKeySpec(input.now);
  const nextSpec = input.next?.trim();
  const nextKey = nextSpec === undefined || nextSpec === '' ? undefined : parseKeySpec(nextSpec);

  if (nextKey !== undefined && nextKey.id === nowKey.id) {
    throw invalidKeyring('APP_KEY_NEXT names the same id as APP_KEY_NOW', {
      keyId: nextKey.id,
    });
  }

  /**
   * The writer: `APP_KEY_NEXT` when it is deployed, else `APP_KEY_NOW` (ADR-0008,
   * amended 2026-10-28).
   *
   * This is `MultiFernet`'s rule — encrypt with the first key in the list, decrypt
   * with all of them — expressed as two env vars. Deploying the next key therefore
   * *is* the start of the migration: the moment an instance sees it, that instance
   * writes with it, and the old key stays in the decrypt set until the ledger says
   * no row needs it.
   */
  const writer = nextKey ?? nowKey;

  const keys = new Map<string, ParsedKey>();
  keys.set(nowKey.id, nowKey);
  if (nextKey !== undefined) keys.set(nextKey.id, nextKey);

  for (const [id, spec] of Object.entries(input.materials ?? {})) {
    assertKeyId(id);
    const parsed = parseKeySpec(spec);
    if (parsed.id !== id) {
      throw invalidKeyring(`material for "${id}" is labelled "${parsed.id}"`, {
        keyId: id,
        materialId: parsed.id,
      });
    }
    keys.set(id, parsed);
  }

  const declared: KeyringEntry[] = [];
  const seen = new Set<string>();

  for (const entry of input.manifest ?? []) {
    assertKeyId(entry.id);
    if (!(KEY_STATES as readonly string[]).includes(entry.state)) {
      throw invalidKeyring(`key "${entry.id}" has unknown state "${String(entry.state)}"`, {
        keyId: entry.id,
      });
    }
    if (seen.has(entry.id)) {
      throw invalidKeyring(`key "${entry.id}" appears twice in the manifest`, { keyId: entry.id });
    }
    seen.add(entry.id);

    if (entry.state === 'active' && entry.id !== writer.id && entry.id !== nowKey.id) {
      // Two writers is the failure this whole state machine exists to prevent.
      // `APP_KEY_NOW` is excepted: a manifest written before `APP_KEY_NEXT` was
      // deployed legitimately still calls it active, and the env is what decides —
      // that entry is rewritten to `decrypt-only` below rather than rejected.
      throw invalidKeyring(
        `the manifest marks "${entry.id}" active, but the writing key is "${writer.id}"`,
        { writer: writer.id, manifestActive: entry.id },
      );
    }
    declared.push(entry);
  }

  // `VLT-014`: `APP_KEY_NOW` is the key rows on disk may still be under. An
  // instance whose deployed keyring has never heard of it cannot read the fleet's
  // existing data, and `APP_KEY_NEXT` arriving first must not hide that.
  if (input.manifest !== undefined && !seen.has(nowKey.id)) {
    throw keyringMismatch(nowKey.id, [...seen]);
  }

  /**
   * The two carrier keys get canonical states, and they come first in the list so
   * that output reads writer-then-previous. Everything else keeps whatever the
   * manifest said (`decrypt-only`, `retired`, or `staged` for material that is
   * deployed but not yet writing).
   */
  const entries: KeyringEntry[] = [
    { id: writer.id, alg: writer.alg, state: 'active' },
    ...(nextKey === undefined
      ? []
      : [{ id: nowKey.id, alg: nowKey.alg, state: 'decrypt-only' as const }]),
    ...declared.filter((entry) => entry.id !== writer.id && entry.id !== nowKey.id),
  ];

  const actives = entries.filter((entry) => entry.state === 'active');
  if (actives.length !== 1) {
    throw invalidKeyring(`expected exactly one active key, found ${String(actives.length)}`, {
      active: actives.map((entry) => entry.id).join(', '),
    });
  }

  return {
    entries,
    active: entries[0] as KeyringEntry,
    decryptKeyIds: entries
      .filter((entry) => entry.state === 'active' || entry.state === 'decrypt-only')
      .map((entry) => entry.id),
    keys,
    entry: (id) => entries.find((entry) => entry.id === id),
  };
}

/** The manifest a deployment should carry, derived from the current state. */
export function keyringManifest(keyring: Keyring): readonly KeyringEntry[] {
  return keyring.entries.filter((entry) => entry.state !== 'staged');
}
