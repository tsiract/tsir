/**
 * Tokens.
 *
 * Every token in this package is **opaque random bytes**, and nothing but a hash of it is ever
 * stored. Three properties, each of which is a bug when it is missing:
 *
 * · **Random, not derived.** A token is 32 bytes from the platform CSPRNG. It is not a signed
 * blob, so there is no key to leak, no algorithm to confuse, and no `alg: none`.
 * · **Hashed at rest.** The database holds `sha256(token)`. A dump of the sessions table is then
 * useless without a pre-image, which for 256 bits of entropy never arrives. A fast hash is the
 * right choice *here* — unlike a password — because the input is not guessable.
 * · **Comparable in constant time.** `constantTimeEqual` is used for every comparison of a
 * secret, so a byte-by-byte early exit cannot be timed.
 *
 * `tokenPrefix` exists for one reason: an API key needs an **indexed** lookup. Storing only a hash
 * makes verification a scan of every row; storing `prefix + hash` makes it one indexed read, and the
 * prefix is public by construction (it is in the key string the client holds).
 */

const encoder = new TextEncoder();

/** Base64url without padding — safe in a URL, a cookie and a header. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** `bytes` of CSPRNG output, base64url. 32 bytes is the default and the floor. */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) {
    throw new RangeError('a token needs at least 16 bytes of randomness');
  }
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * `bytes` of CSPRNG output, hex — for a **public identifier**.
 *
 * Hex rather than base64url for the same reason a session token is base64url: an API key is
 * `tsk_<id>_<secret>`, `_` is in the base64url alphabet, and an id containing it would make the
 * string ambiguous to split. Twenty-four unambiguous characters are cheap; an ambiguous credential
 * parser is not.
 */
export function randomHex(bytes = 12): string {
  if (!Number.isInteger(bytes) || bytes < 4) {
    throw new RangeError('an identifier needs at least 4 bytes of randomness');
  }
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** `sha256(token)`, hex. What the store keeps. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The public, non-secret part of a token — the lookup key for an API key. */
export function tokenPrefix(token: string, length = 8): string {
  return token.slice(0, length);
}

/** Compare without an early exit, so a wrong secret takes the same time as a nearly-right one. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * An API key as the client sees it: `tsk_<public id>_<secret>`.
 *
 * The id is hex (no `_`) and the secret is base64url (which **contains** `_`), so the string is split
 * at its first two separators and the remainder is the secret. Splitting on every `_` would reject a
 * perfectly valid key roughly one time in eight, decided by the CSPRNG — a bug that shows up in
 * production only, on the keys nobody can reproduce.
 */
const API_KEY_PREFIX = 'tsk';

export function formatApiKey(id: string, secret: string): string {
  return `${API_KEY_PREFIX}_${id}_${secret}`;
}

/** Split a presented key back into its parts, or `undefined` when it is not shaped like one. */
export function parseApiKey(
  key: string,
): { readonly id: string; readonly secret: string } | undefined {
  if (!key.startsWith(`${API_KEY_PREFIX}_`)) return undefined;
  const separator = key.indexOf('_', API_KEY_PREFIX.length + 1);
  if (separator === -1) return undefined;

  const id = key.slice(API_KEY_PREFIX.length + 1, separator);
  const secret = key.slice(separator + 1);
  // The id has no `_` by construction, so anything with one is not one of ours.
  if (!/^[0-9A-Za-z-]{6,}$/u.test(id)) return undefined;
  if (secret.length < 16 || !/^[0-9A-Za-z_-]+$/u.test(secret)) return undefined;
  return { id, secret };
}
