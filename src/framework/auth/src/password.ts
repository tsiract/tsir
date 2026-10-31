/**
 * Password hashing.
 *
 * Two drivers, one port, and the port is shaped so a **stored hash is self-describing**:
 *
 * ```
 * $tsir$pbkdf2-sha256$i=210000,l=32$<salt base64url>$<digest base64url>
 * ```
 *
 * Every parameter a verification needs is in the string. That is what makes raising the cost a
 * non-event: old hashes keep verifying with the parameters they were made with, `needsRehash` says
 * which rows to upgrade on the next successful login, and the alternative — one global constant —
 * would silently invalidate every existing password the day it changed.
 *
 * Why PBKDF2 is the default and argon2id is an adapter:
 *
 * · **WebCrypto has PBKDF2 and nothing else.** Workers, Bun and Node ≥ 20 all ship it, so the
 * default has to work in each, and a Workers deployment cannot import `node:crypto`. PBKDF2's
 * documented parameters are its only defence, so the floor here is **210 000 iterations of
 * SHA-256** — OWASP's current recommendation, checked in a test so it cannot drift down.
 * · **argon2id is better, and it is Bun-only.** `Bun.password` is native, fast and memory-hard,
 * and `@tsir/auth/bun` exposes it as a driver the runtime can choose when it is there. The
 * adapter lives in a subpath so a Worker bundle never sees a `Bun` global it cannot resolve.
 *
 * Both drivers verify each other's hashes: `verifyPassword` dispatches on the algorithm in the hash
 * rather than on the driver you called, so a project that moves from Bun to Workers keeps working —
 * it just rehashes on the way past.
 */

import { invalidHash, unsupportedHash, weakPassword } from './errors.ts';
import { base64url, fromBase64url } from './token.ts';

export interface PasswordHasher {
  /** The algorithm name as it appears in a hash: `pbkdf2-sha256`, `argon2id`. */
  readonly name: string;
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
  /** True when the stored hash was made with weaker parameters than this driver would use now. */
  needsRehash(hash: string): boolean;
}

export interface PasswordPolicy {
  /** Default 8. A minimum is not security theater; a *maximum* is (DoS), so that one is below. */
  readonly minLength?: number | undefined;
  /** Default 1 024 — an unbounded password is an unbounded PBKDF2 input. */
  readonly maxLength?: number | undefined;
  /** Refuse a password that is only one repeated character or a well-known placeholder. */
  readonly refuseCommon?: boolean | undefined;
}

export const PASSWORD_LIMITS = { minLength: 8, maxLength: 1024 } as const;

const COMMON = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwertyui',
  'qwerty123',
  'letmein1',
  'iloveyou',
  'admin123',
  'changeme',
  'welcome1',
]);

/** Validate **before** hashing: a refused password should cost nothing, not 200 ms. */
export function assertPasswordAcceptable(password: string, policy: PasswordPolicy = {}): string {
  const min = policy.minLength ?? PASSWORD_LIMITS.minLength;
  const max = policy.maxLength ?? PASSWORD_LIMITS.maxLength;

  if (password.length < min) throw weakPassword(`it is shorter than ${String(min)} characters`);
  if (password.length > max) throw weakPassword(`it is longer than ${String(max)} characters`);

  if (policy.refuseCommon !== false) {
    const normalised = password.toLowerCase().replace(/\s+/gu, '');
    if (COMMON.has(normalised))
      throw weakPassword('it is one of the passwords that appear first in every breach list');
    if (new Set(normalised).size <= 2)
      throw weakPassword('it uses at most two distinct characters');
  }
  return password;
}

export interface Pbkdf2Options {
  /** Default 210 000 — OWASP's floor for PBKDF2-SHA256. Lowered in tests, never in production. */
  readonly iterations?: number | undefined;
  /** Default 16 bytes. */
  readonly saltBytes?: number | undefined;
  /** Default 32 bytes. */
  readonly keyBytes?: number | undefined;
  readonly policy?: PasswordPolicy | undefined;
}

const PBKDF2_MIN_ITERATIONS = 100_000;

export function pbkdf2Hasher(options: Pbkdf2Options = {}): PasswordHasher {
  const iterations = options.iterations ?? 210_000;
  if (iterations < PBKDF2_MIN_ITERATIONS) {
    throw new RangeError(
      `PBKDF2 needs at least ${String(PBKDF2_MIN_ITERATIONS)} iterations (got ${String(iterations)}) — a cheaper hash is a hash that can be cracked offline`,
    );
  }
  const saltBytes = options.saltBytes ?? 16;
  const keyBytes = options.keyBytes ?? 32;
  const policy = options.policy;
  const name = 'pbkdf2-sha256';

  return {
    name,

    async hash(password) {
      assertPasswordAcceptable(password, policy);
      const salt = crypto.getRandomValues(new Uint8Array(saltBytes));
      const digest = await derive(password, salt, iterations, keyBytes);
      return `$tsir$${name}$i=${String(iterations)},l=${String(keyBytes)}$${base64url(salt)}$${base64url(digest)}`;
    },

    async verify(password, hash) {
      // Dispatch on the algorithm in the hash, not on the driver that was called: a project that
      // moves from Bun to Workers keeps verifying the argon2id rows it already has.
      if (algorithmOf(hash) !== name) return verifyPassword(password, hash);
      const parsed = parseHash(hash);
      // Named as ours but unreadable: a false here would read as "wrong password" and lock the
      // account out with no trace of why.
      if (parsed === undefined) throw invalidHash('its parameters could not be read');
      const derived = await derive(password, parsed.salt, parsed.iterations, parsed.digest.length);
      return constantTimeBytesEqual(derived, parsed.digest);
    },

    needsRehash(hash) {
      const parsed = parseHash(hash);
      if (parsed === undefined) return true;
      return (
        parsed.algorithm !== name ||
        parsed.iterations < iterations ||
        parsed.digest.length < keyBytes
      );
    },
  };
}

/** The default driver: PBKDF2-SHA256 at 210 000 iterations, WebCrypto only. */
export function defaultHasher(policy?: PasswordPolicy): PasswordHasher {
  return pbkdf2Hasher(policy === undefined ? {} : { policy });
}

export interface ParsedHash {
  readonly algorithm: string;
  readonly iterations: number;
  /** `Uint8Array<ArrayBuffer>`: `crypto.subtle` refuses a view over a shared buffer. */
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly digest: Uint8Array;
}

/** Read a `$tsir$…` hash. `undefined` for anything else — never a guess. */
export function parseHash(hash: string): ParsedHash | undefined {
  const parts = hash.split('$');
  // ['', 'tsir', algorithm, params, salt, digest]
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'tsir') return undefined;
  const algorithm = parts[2];
  const params = parts[3];
  const salt = parts[4];
  const digest = parts[5];
  if (
    algorithm === undefined ||
    params === undefined ||
    salt === undefined ||
    digest === undefined
  ) {
    return undefined;
  }

  const values = new Map<string, number>();
  for (const pair of params.split(',')) {
    const [key, raw] = pair.split('=');
    if (key === undefined || raw === undefined || !/^\d+$/u.test(raw)) return undefined;
    // coercion-ok: the regex above admits only decimal digits, and these are iteration and length
    // counts — far inside 2^53.
    values.set(key, Number(raw));
  }

  const iterations = values.get('i') ?? 0;
  if (iterations <= 0) return undefined;
  try {
    const decodedSalt = fromBase64url(salt);
    const digestBytes = fromBase64url(digest);
    if (decodedSalt.length < 8 || digestBytes.length < 16) return undefined;
    // A copy into a plain buffer: `crypto.subtle` refuses a view over a shared buffer, and a
    // `Uint8Array` built by `.set` is never one.
    const saltBytes = new Uint8Array(decodedSalt.length);
    saltBytes.set(decodedSalt);
    return { algorithm, iterations, salt: saltBytes, digest: digestBytes };
  } catch {
    return undefined;
  }
}

/**
 * Verify against **any** hasher this build knows, dispatching on the algorithm in the hash.
 *
 * This is what makes a hash portable between deployments: the caller does not have to know which
 * driver wrote a row, and a project that switches runtime keeps verifying old passwords.
 */
export async function verifyPassword(
  password: string,
  hash: string,
  options: { readonly extraHashers?: readonly PasswordHasher[] | undefined } = {},
): Promise<boolean> {
  const algorithm = algorithmOf(hash);
  if (algorithm === undefined) throw invalidHash('it is not a `$algorithm$…` string');

  if (algorithm === 'pbkdf2-sha256') {
    const parsed = parseHash(hash);
    if (parsed === undefined) throw invalidHash('its parameters could not be read');
    const derived = await derive(password, parsed.salt, parsed.iterations, parsed.digest.length);
    return constantTimeBytesEqual(derived, parsed.digest);
  }

  for (const hasher of options.extraHashers ?? []) {
    if (hasher.name === algorithm) return hasher.verify(password, hash);
  }
  throw unsupportedHash(algorithm, [
    'pbkdf2-sha256',
    ...(options.extraHashers ?? []).map((h) => h.name),
  ]);
}

/**
 * The algorithm segment of **any** PHC-shaped hash, not only this package's.
 *
 * `$tsir$pbkdf2-sha256$…` names its algorithm second (the first segment is this package's marker),
 * `$argon2id$v=19$…` names it first. Reading both is what lets `verifyPassword` recognise a hash it
 * cannot verify and say so, instead of calling it malformed.
 */
export function algorithmOf(hash: string): string | undefined {
  if (!hash.startsWith('$')) return undefined;
  const parts = hash.split('$');
  const candidate = parts[1] === 'tsir' ? parts[2] : parts[1];
  if (candidate === undefined || candidate === '') return undefined;
  return /^[a-z][a-z0-9-]*$/u.test(candidate) ? candidate : undefined;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  keyBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    keyBytes * 8,
  );
  return new Uint8Array(bits);
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}
