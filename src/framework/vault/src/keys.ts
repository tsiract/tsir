/**
 * Key material (`VLT-005`, `VLT-006`).
 *
 * A key is `<id>:<alg>:<base64url of 32 raw bytes>` — the exact shape `APP_KEY_NOW`
 * carries, so there is one format to learn and one parser to harden.
 *
 * Two rules the code enforces rather than documents:
 *
 * - **32 bytes, and nothing else.** A passphrase is not a key: it has no fixed
 *   length, it is guessable, and stretching it would need a KDF nobody asked for.
 * - **The raw material does not survive the import.** `importKey(..., false, ...)`
 *   yields a non-extractable `CryptoKey`; the byte array is dropped. JavaScript
 *   cannot zero a string, which `14-security.md` states plainly — but the window in
 *   which the bytes exist is one function call wide.
 */

import { TsirError } from '@tsir/core';

import {
  decodeBase64Url,
  encodeBase64Url,
  KEY_ID_PATTERN,
  type VaultAlg,
  VAULT_ALGS,
} from './envelope.ts';
import { invalidKeyMaterial, invalidKeyring } from './errors.ts';

/** AES-256 and XChaCha20 both take a 256-bit key. */
export const KEY_BYTES = 32;

export interface ParsedKey {
  readonly id: string;
  readonly alg: VaultAlg;
  /** The raw 32 bytes. Do not store, log, or return these. */
  readonly material: Uint8Array<ArrayBuffer>;
}

/** Validates an id without importing anything. */
export function assertKeyId(id: string): string {
  if (!KEY_ID_PATTERN.test(id)) {
    throw invalidKeyring(
      `"${id}" is not a valid key id (lower-case, 2–32 chars, starting with a letter)`,
      { keyId: id },
    );
  }
  return id;
}

/**
 * Parses `id:alg:material`, or `id:material` when the algorithm is unambiguous.
 *
 * The short form exists because a versioned key is written by hand —
 * `APP_KEY_NOW=v2:<material>` reads better than the same thing with a redundant
 * `aes-256-gcm` in the middle, and the algorithm is already recorded in every
 * envelope this key writes. It is only accepted for the one implemented algorithm;
 * a second algorithm will require the long form, because a default is a guess and
 * a guess about which primitive decrypted a row is not one to make silently.
 *
 * The error names the key by **id only** — never the material, not even a prefix of
 * it. A truncated secret in a log is still a secret leak, and key material is the
 * one value in this package that must never appear in an error.
 */
export function parseKeySpec(spec: string): ParsedKey {
  const parts = spec.split(':');
  if (parts.length !== 3 && parts.length !== 2) {
    throw invalidKeyMaterial(
      parts[0] ?? '(missing)',
      'expected `<id>:<alg>:<material>` (or `<id>:<material>` for aes-256-gcm)',
    );
  }
  const [id, alg, material] =
    parts.length === 2
      ? ([parts[0], 'aes-256-gcm', parts[1]] as [string, string, string])
      : (parts as [string, string, string]);

  if (!KEY_ID_PATTERN.test(id)) {
    throw invalidKeyMaterial(id, 'id must be lowercase base32, 8–32 chars');
  }
  if (!(VAULT_ALGS as readonly string[]).includes(alg)) {
    throw invalidKeyMaterial(id, `unknown algorithm "${alg}"`);
  }

  const bytes = decodeBase64Url(material, 'key material');
  if (bytes.length !== KEY_BYTES) {
    throw invalidKeyMaterial(id, `${String(bytes.length)} bytes, expected ${String(KEY_BYTES)}`);
  }

  return { id, alg: alg as VaultAlg, material: bytes };
}

/** Imports the raw bytes into a non-extractable `CryptoKey` (`VLT-006`). */
export async function importVaultKey(key: ParsedKey): Promise<CryptoKey> {
  if (key.alg !== 'aes-256-gcm') {
    throw invalidKeyMaterial(
      key.id,
      `${key.alg} has no implementation in this build — see 06-vault.md § 6 (ADR required before adding the dependency)`,
    );
  }
  return crypto.subtle.importKey('raw', key.material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Builds the `id:alg:material` string a secret manager should hold. */
export function formatKeySpec(key: ParsedKey): string {
  return `${key.id}:${key.alg}:${encodeBase64Url(key.material)}`;
}

/**
 * The id half of a spec, without touching the material.
 *
 * Used at boot to answer "does `APP_KEY_NOW` name a key we have?" before importing
 * anything, so a mismatch is reported as a mismatch rather than as bad material.
 */
export function keyIdOf(spec: string): string {
  const id = spec.split(':')[0] ?? '';
  if (id === '') throw invalidKeyMaterial('(missing)', 'spec is empty');
  return id;
}

/**
 * Generates a new key (`VLT-015`).
 *
 * 32 bytes from the runtime CSPRNG and a random base32 id. The id is random rather
 * than sequential because it travels in every envelope: a counter would tell an
 * attacker how many keys a project has generated and when.
 */
export function generateKey(alg: VaultAlg = 'aes-256-gcm', id?: string): ParsedKey {
  const material = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  // 9 random base32 chars behind a fixed `k`: 45 bits, far more than the number of
  // keys a project will ever generate, and the leading `k` keeps the id valid for
  // an alphabet where the first character must be a letter.
  const idBytes = crypto.getRandomValues(new Uint8Array(9));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let generated = 'k';
  for (const byte of idBytes) generated += alphabet[byte % alphabet.length];

  // A caller-chosen id is how a project keeps its own versioning (`v1`, `v2`); it
  // is validated with the same rule the envelope applies on the way back in.
  return { id: id === undefined ? generated : assertKeyId(id), alg, material };
}

/** Re-exported for callers that build errors about material. */
export { TsirError };
