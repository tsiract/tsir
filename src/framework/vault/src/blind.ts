/**
 * Blind indexes — equality lookups over data the database cannot read (`VLT-025`).
 *
 * An encrypted column is unsearchable by construction: two encryptions of the same
 * value share nothing, so `where email = $1` can only ever work if the plaintext is
 * in the database. A blind index is the standard compromise — store
 * `HMAC-SHA256(key, domain || value)` beside the ciphertext, index *that*, and look
 * up by computing the same digest for the value you are searching for.
 *
 * What it buys, precisely: **equality**. `=` and `in (…)` work. `like`, `>`, `between`
 * and ordering do not, and a unique index on a blind index leaks when two rows hold
 * the same value.
 *
 * What it costs — and why this file refuses to be clever:
 *
 *   1. **Frequency leakage.** Equal plaintexts produce equal digests. An attacker
 *      with read access to the table learns which rows share a value, even without
 *      decrypting any of them. That is why the docs insist on high-entropy values
 *      (email, tax id, account number) and warn against indexing short or guessable
 *      fields, where the index is an offline oracle waiting for a dictionary.
 *   2. **It is deterministic, so it must not be the encryption key.** Reusing one
 *      secret for AES and for HMAC would let a weakness in either primitive say
 *      something about the other. `createBlindIndex` takes its own key and says so
 *      in the error if you hand it a key spec from the vault.
 *   3. **It has to be rebuilt when the key changes.** A blind index is derived from
 *      a secret, so rotating that secret is a backfill of its own; the rotation
 *      runner does not touch these columns, and the docs say so rather than leaving
 *      an operator to discover it.
 *
 * The domain string (`tsir:bid:v1:<table>.<column>:`) is what keeps one secret safe
 * across many columns: the same value under `users.email` and `users.phone` produces
 * unrelated digests, so a digest cannot be replayed against another column.
 */

import { TsirError } from '@tsir/core';

import { invalidKeyMaterial } from './errors.ts';

const MATERIAL_BYTES = 32;
const DIGEST_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A digest is 32 bytes of base64url: 43 characters, no padding. */
export const BLIND_INDEX_LENGTH = 43;

export interface BlindIndexOptions {
  /**
   * The blind-index secret: 32 raw bytes, base64url. **Not** an `APP_KEY_*` spec.
   *
   * Key separation is the point. If this value is ever the same as an encryption
   * key, `createBlindIndex` refuses it rather than letting one secret serve two
   * primitives.
   */
  readonly key: string;
  /** The table the column belongs to — part of the domain string, not the key. */
  readonly table: string;
  /** The column being indexed. */
  readonly column: string;
  /**
   * Applied before hashing, so that `Alice@example.com` and `alice@example.com`
   * find each other. There is no default: normalisation is a decision about *your*
   * data (`trim` vs `lowercase` vs neither), and a library that guesses is a library
   * that silently merges two values someone needed to keep apart.
   */
  readonly normalize?: ((value: string) => string) | undefined;
}

export interface BlindIndex {
  /** `table.column`, for query builders and logs. */
  readonly column: string;
  /** The 43-character digest for a plaintext. Deterministic, and never reversible. */
  compute(value: string): Promise<string>;
  /** Constant-time comparison against a stored digest. */
  matches(value: string, stored: string): Promise<boolean>;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Builds the index for one column.
 *
 * The key is imported as a non-extractable HMAC key, so the resulting object can
 * compute digests but cannot hand the secret back — the same rule as the AES keys
 * (`VLT-006`).
 */
export async function createBlindIndex(options: BlindIndexOptions): Promise<BlindIndex> {
  if (options.table.trim() === '' || options.column.trim() === '') {
    throw new TsirError('VLT_INVALID_KEY_MATERIAL', 'a blind index needs a table and a column', {
      kind: 'vault',
      hint: 'the domain string is `tsir:bid:v1:<table>.<column>:` — without it one digest could be replayed across columns',
      context: { table: options.table, column: options.column },
    });
  }

  // A key spec (`v1:aes-256-gcm:…`) is the mistake this guard exists for: it looks
  // like a secret and would silently reuse the encryption key for HMAC.
  if (options.key.includes(':')) {
    throw new TsirError(
      'VLT_INVALID_KEY_MATERIAL',
      'a blind index key is base64url material, not a vault key spec',
      {
        kind: 'vault',
        hint: 'generate a separate secret (32 random bytes, base64url) — never reuse APP_KEY_NOW for HMAC',
        context: { column: `${options.table}.${options.column}` },
      },
    );
  }

  const raw = decodeBase64Url(options.key);
  if (raw === undefined || raw.byteLength !== MATERIAL_BYTES) {
    throw invalidKeyMaterial(
      `blind-index:${options.table}.${options.column}`,
      `the blind index key must be ${String(MATERIAL_BYTES)} bytes of base64url (${String(raw?.byteLength ?? 0)} given)`,
    );
  }

  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);

  const domain = `tsir:bid:v1:${options.table}.${options.column}:`;
  const encoder = new TextEncoder();

  async function compute(value: string): Promise<string> {
    const normalized = options.normalize === undefined ? value : options.normalize(value);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${domain}${normalized}`));
    return encodeBase64Url(new Uint8Array(digest));
  }

  return {
    column: `${options.table}.${options.column}`,
    compute,

    async matches(value, stored) {
      const expected = await compute(value);
      // Compare every character: an early return would leak how much of a digest
      // matched, which is the one thing a lookup like this must not do.
      if (expected.length !== stored.length) return false;
      let difference = 0;
      for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ stored.charCodeAt(index);
      }
      return difference === 0;
    },
  };
}

/** 32 random bytes as base64url: the shape `createBlindIndex` expects. */
export function generateBlindIndexKey(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(MATERIAL_BYTES)));
}

/** Exported for the tests and the docs: the digest is always this long. */
export const BLIND_INDEX_BYTES = DIGEST_BYTES;
