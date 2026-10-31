/**
 * The vault error set (`VLT-007`).
 *
 * Every one of these is a *fail-closed* error: the value is not returned, not
 * partially returned, and never replaced with an empty string. A decrypt that
 * "returns something" is how a tampered row becomes a silent data corruption
 * instead of a 500 with a correlation id.
 *
 * What the messages may contain is the other half of the design: a key **id** is
 * fine (it is not secret and the operator needs it), a key **material** is not,
 * and neither is any plaintext. Every factory below is written with that rule, and
 * `VLT-027` asserts it by capturing logs across the whole suite.
 */

import { TsirError, type TsirErrorInit } from '@tsir/core';

export type VaultErrorCode =
  | 'VLT_NOT_CONFIGURED'
  | 'VLT_INVALID_KEY_MATERIAL'
  | 'VLT_KEYRING_INVALID'
  | 'VLT_KEYRING_MISMATCH'
  | 'VLT_UNKNOWN_KEY'
  | 'VLT_MALFORMED_ENVELOPE'
  | 'VLT_AUTH_FAILED'
  | 'VLT_STALE_KEY'
  | 'VLT_KEY_STILL_ACTIVE'
  | 'VLT_ROTATION_LOCKED'
  | 'VLT_TOO_LARGE'
  | 'VLT_UNSUPPORTED_TYPE'
  | 'VLT_ROTATION_FAILED';

/** A ciphertext segment was not shaped like the envelope format says it must be. */
export function malformedEnvelope(
  reason: string,
  detail: TsirErrorInit['context'] = {},
): TsirError {
  return new TsirError('VLT_MALFORMED_ENVELOPE', `malformed vault envelope: ${reason}`, {
    kind: 'vault',
    hint: 'the column holds a value this vault did not write — check the column type and any manual writes',
    context: detail,
  });
}

/** Key material is the wrong length or encoding. The id is included; the material never is. */
export function invalidKeyMaterial(keyId: string, reason: string): TsirError {
  return new TsirError(
    'VLT_INVALID_KEY_MATERIAL',
    `key "${keyId}" has invalid material: ${reason}`,
    {
      kind: 'vault',
      hint: 'a key is `<id>:<alg>:<base64url of exactly 32 bytes>`; generate one with `tsir vault:key:generate`',
      context: { keyId },
    },
  );
}

/** The keyring is internally inconsistent: no active key, duplicate ids, unknown state. */
export function invalidKeyring(reason: string, detail: TsirErrorInit['context'] = {}): TsirError {
  return new TsirError('VLT_KEYRING_INVALID', `invalid keyring: ${reason}`, {
    kind: 'vault',
    hint: 'exactly one key is `active`; ids are unique; states are staged|active|decrypt-only|retired',
    context: detail,
  });
}

/** `APP_KEY_NOW` names a key the deployed keyring does not carry (`VLT-014`). */
export function keyringMismatch(nowId: string, known: readonly string[]): TsirError {
  return new TsirError(
    'VLT_KEYRING_MISMATCH',
    `APP_KEY_NOW names "${nowId}", which is not in the deployed keyring (known: ${known.join(', ') || 'none'})`,
    {
      kind: 'vault',
      hint: 'deploy the keyring that contains the new key before switching APP_KEY_NOW — otherwise this instance cannot read its own writes',
      context: { keyId: nowId, known: known.join(', ') },
    },
  );
}

/** A row references a key id this process does not have. Never falls back to plaintext. */
export function unknownKey(keyId: string, known: readonly string[]): TsirError {
  return new TsirError(
    'VLT_UNKNOWN_KEY',
    `ciphertext references key "${keyId}", which is not in this keyring (known: ${known.join(', ') || 'none'})`,
    {
      kind: 'vault',
      hint: 'the row is newer than this deployment: roll forward, or add the key as decrypt-only',
      context: { keyId, known: known.join(', ') },
    },
  );
}

/**
 * The auth tag did not verify.
 *
 * Deliberately uniform: tampering, a wrong key, a wrong AAD and a truncated
 * ciphertext all produce this one error, so the failure cannot be used as an
 * oracle to learn *which* of them happened.
 */
export function authFailed(keyId: string): TsirError {
  return new TsirError('VLT_AUTH_FAILED', `ciphertext failed authentication for key "${keyId}"`, {
    kind: 'vault',
    hint: 'the value was modified outside the vault, or it belongs to a different column or table',
    context: { keyId },
  });
}

/** Plaintext above the documented column limit (`06-vault.md § 2`). */
export function tooLarge(bytes: number, limit: number): TsirError {
  return new TsirError(
    'VLT_TOO_LARGE',
    `plaintext is ${String(bytes)} bytes, above the ${String(limit)}-byte column limit`,
    {
      kind: 'vault',
      hint: 'encrypt large payloads with storage-level encryption; vault columns hold short values',
      context: { bytes, limit },
    },
  );
}

/** A non-string reached an encrypted text column. Numbers are not quietly stringified. */
export function unsupportedType(actual: string): TsirError {
  return new TsirError('VLT_UNSUPPORTED_TYPE', `encrypted column received a ${actual}`, {
    kind: 'vault',
    hint: 'encryptedText holds strings; convert numbers and dates explicitly before writing',
    context: { actual },
  });
}

/**
 * Vault functions were used without keys. Boot-time, not request-time.
 *
 * `detail` lets a caller say *which* piece is missing (no `APP_KEY_NOW` at all, or
 * nothing staged for an activation) without inventing a second error code for it.
 */
export function notConfigured(detail?: string): TsirError {
  return new TsirError('VLT_NOT_CONFIGURED', detail ?? 'the vault has no keys configured', {
    kind: 'config',
    hint: 'set APP_KEY_NOW=<id>:<alg>:<material> (generate one with `tsir vault:key:generate`)',
    context: {},
  });
}

/** A rotation still references a retired key. */
export function staleKey(keyId: string, rows: number): TsirError {
  return new TsirError(
    'VLT_STALE_KEY',
    `key "${keyId}" is retired but ${String(rows)} row(s) still reference it`,
    {
      kind: 'vault',
      hint: 'run `tsir vault:rotate` to completion before retiring the key, or pass --force to accept unreadable rows',
      context: { keyId, rows },
    },
  );
}

/** Retiring the key that is still encrypting: that would leave a deployment with no writer. */
export function keyStillActive(keyId: string, state: string): TsirError {
  return new TsirError('VLT_KEY_STILL_ACTIVE', `key "${keyId}" is ${state} and cannot be retired`, {
    kind: 'vault',
    hint: 'retire the previous key, not the writer: activate the successor first (`tsir vault:key:activate`)',
    context: { keyId, state },
  });
}

/** Two rotation runners on the same (table, column). */
export function rotationLocked(table: string, column: string): TsirError {
  return new TsirError(
    'VLT_ROTATION_LOCKED',
    `a rotation for ${table}.${column} is already running`,
    {
      kind: 'vault',
      hint: 'one runner per column: wait for it to finish, or check `tsir vault:rotate:status`',
      context: { table, column },
    },
  );
}
