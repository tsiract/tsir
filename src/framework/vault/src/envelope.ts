/**
 * The ciphertext envelope (`VLT-001`).
 *
 * ```text
 * tsir:v1:<keyId>:<alg>:<base64url(nonce || ciphertext || tag)>
 * ```
 *
 * Parsing is a pure function with no crypto in it, which is the point: every
 * malformed shape must be rejected *before* a key is selected or a byte is
 * decrypted. A parser that throws from inside the AEAD path turns a data problem
 * into a confusing authentication failure.
 *
 * The encoding is base64url **without padding** — the value ends up in URLs, logs
 * and copy-pasted support tickets, and `+`, `/` and `=` are all things that get
 * mangled by one of those. Unpadded input is the only form accepted: two encodings
 * of one ciphertext would be two rows that look different and compare equal.
 */

import { malformedEnvelope } from './errors.ts';

export const ENVELOPE_PREFIX = 'tsir';
export const ENVELOPE_VERSION = 'v1';

export const VAULT_ALGS = ['aes-256-gcm', 'xchacha20-poly1305'] as const;
export type VaultAlg = (typeof VAULT_ALGS)[number];

/** Nonce sizes fixed by the algorithms themselves, not by taste. */
const NONCE_BYTES: Readonly<Record<VaultAlg, number>> = {
  'aes-256-gcm': 12,
  'xchacha20-poly1305': 24,
};

/** Both AEADs produce a 16-byte tag. */
export const TAG_BYTES = 16;

/** Lowercase base32, 8–32 chars, stable per key (`06-vault.md § 2`). */
/**
 * Key ids: 2–32 characters, lower-case, starting with a letter.
 *
 * The shape is deliberately wide enough for the two naming styles that exist in
 * the wild: an opaque id (`k7f3q2ab`, what `vault:key:generate` produces) and a
 * **version** (`v1`, `v2`, `v11`) written by hand. It stays narrow enough that an
 * id can never carry a colon (the envelope's separator), upper case (which invites
 * `V2` vs `v2` collisions) or leading digits.
 */
export const KEY_ID_PATTERN = /^[a-z][a-z0-9]{1,31}$/;

export interface Envelope {
  readonly keyId: string;
  readonly alg: VaultAlg;
  /** `nonce || ciphertext || tag`, exactly as stored. */
  readonly payload: Uint8Array;
}

export interface SplitPayload {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}

/** The `aad` an envelope is bound to: `tsir:v1:<keyId>:<alg>:<table>.<column>`. */
export function associatedData(
  alg: VaultAlg,
  keyId: string,
  table: string,
  column: string,
): Uint8Array {
  return new TextEncoder().encode(
    `${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:${keyId}:${alg}:${table}.${column}`,
  );
}

/** Base64url, unpadded. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a 64 KiB value does not blow the argument limit of `apply`.
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Decodes unpadded base64url, rejecting everything else.
 *
 * `atob` is lenient in ways that would make two ciphertexts compare equal — it
 * ignores whitespace and accepts padding — so the input is checked first, and the
 * round-trip is verified after: a string that decodes and re-encodes to something
 * else was not canonical.
 */
export function decodeBase64Url(text: string, what: string): Uint8Array<ArrayBuffer> {
  if (text === '') throw malformedEnvelope(`${what} is empty`);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw malformedEnvelope(`${what} is not unpadded base64url`);
  }

  let binary: string;
  try {
    binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    throw malformedEnvelope(`${what} is not valid base64url`);
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  if (encodeBase64Url(bytes) !== text) {
    throw malformedEnvelope(`${what} is not canonical base64url`);
  }
  return bytes;
}

/** Splits `nonce || ciphertext || tag`, checking the lengths before any crypto. */
export function splitPayload(alg: VaultAlg, payload: Uint8Array): SplitPayload {
  const nonceBytes = NONCE_BYTES[alg];
  const minimum = nonceBytes + TAG_BYTES;
  if (payload.length < minimum) {
    throw malformedEnvelope(
      `payload is ${String(payload.length)} bytes, below the ${String(minimum)}-byte minimum for ${alg}`,
    );
  }
  return {
    nonce: payload.subarray(0, nonceBytes),
    ciphertext: payload.subarray(nonceBytes, payload.length - TAG_BYTES),
    tag: payload.subarray(payload.length - TAG_BYTES),
  };
}

/** Joins the three parts into the stored payload. */
export function joinPayload(nonce: Uint8Array, sealed: Uint8Array): Uint8Array {
  const payload = new Uint8Array(nonce.length + sealed.length);
  payload.set(nonce, 0);
  payload.set(sealed, nonce.length);
  return payload;
}

export function serializeEnvelope(envelope: Envelope): string {
  return [
    ENVELOPE_PREFIX,
    ENVELOPE_VERSION,
    envelope.keyId,
    envelope.alg,
    encodeBase64Url(envelope.payload),
  ].join(':');
}

/**
 * Parses a stored value into its parts.
 *
 * Five explicit checks, in order, because each has a different fix: segment count,
 * prefix, version, key id shape, algorithm. A version mismatch in particular must
 * not read as tampering — it means the row was written by a newer format.
 */
export function parseEnvelope(text: string): Envelope {
  const parts = text.split(':');
  if (parts.length !== 5) {
    throw malformedEnvelope(`expected 5 segments, found ${String(parts.length)}`, {
      segments: parts.length,
    });
  }

  const [prefix, version, keyId, alg, payload] = parts as [string, string, string, string, string];

  if (prefix !== ENVELOPE_PREFIX) {
    throw malformedEnvelope(`unknown prefix "${prefix}"`, { prefix });
  }
  if (version !== ENVELOPE_VERSION) {
    throw malformedEnvelope(`unsupported envelope version "${version}"`, { version });
  }
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw malformedEnvelope(`"${keyId}" is not a valid key id`, { keyId });
  }
  if (!(VAULT_ALGS as readonly string[]).includes(alg)) {
    throw malformedEnvelope(`unknown algorithm "${alg}"`, { alg });
  }

  const keyAlg = alg as VaultAlg;
  const bytes = decodeBase64Url(payload, 'payload');
  // Lengths are validated here, not in the cipher: a truncated value must never
  // reach a crypto call that would report it as an authentication failure.
  splitPayload(keyAlg, bytes);

  return { keyId, alg: keyAlg, payload: bytes };
}

/** True when a string claims to be an envelope, without throwing. For column checks. */
export function looksLikeEnvelope(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:`);
}
