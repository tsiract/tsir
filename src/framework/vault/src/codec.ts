/**
 * The encrypted-text column codec (`VLT-008`, `VLT-009`).
 *
 * This is the piece that closes `DB-010`: `@tsir/database`'s codec seam takes a
 * structural `ColumnCodec` — `{ name, encode(column, value), decode(column, value) }`
 * — and this implements it for the vault. `@tsir/vault` deliberately does **not**
 * import `@tsir/database`: the seam is structural, so the dependency arrow points
 * one way (database → vault) and a database user who declares no encrypted column
 * pays nothing for vault existing.
 *
 * Two refusals worth their lines:
 *
 * - `undefined` is rejected. A missing column in an `INSERT` is a caller bug, and
 *   quietly treating it as `null` would write "no value" where the caller meant
 *   "forgot to pass one".
 * - Anything that is not a string is rejected. `42` looks harmless, but coercing it
 *   means a numeric id silently becomes text in one column and a number in another,
 *   and the type system said both were fine.
 */

import { unsupportedType } from './errors.ts';
import type { Vault } from './cipher.ts';

/** Where a value lives. The AAD is bound to it. */
export interface VaultColumnRef {
  readonly table: string;
  readonly column: string;
}

/** Structurally identical to `@tsir/database`'s `ColumnCodec`. */
export interface VaultColumnCodec {
  readonly name: string;
  encode(column: VaultColumnRef, value: unknown): Promise<unknown>;
  decode(column: VaultColumnRef, stored: unknown): Promise<unknown>;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * `encodeRow`/`decodeRow` call this for every declared column.
 *
 * `null` passes through on both sides: SQL `NULL` means "no value", not "encrypt
 * the empty string", and turning it into a ciphertext would make an absent field
 * indistinguishable from a present, empty one.
 */
export function createVaultCodec(vault: Vault): VaultColumnCodec {
  return {
    name: 'vault.envelope.v1',

    async encode(column, value) {
      if (value === null) return null;
      if (typeof value !== 'string') throw unsupportedType(typeName(value));
      return vault.encrypt(column, value);
    },

    async decode(column, stored) {
      if (stored === null) return null;
      if (typeof stored !== 'string') throw unsupportedType(typeName(stored));
      return vault.decrypt(column, stored);
    },
  };
}
