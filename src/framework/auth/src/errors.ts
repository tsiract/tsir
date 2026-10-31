/**
 * `@tsir/auth` error codes (append-only).
 *
 * Two rules shape this list, and both come from:
 *
 * · **Uniform error surfaces.** A wrong password and an unknown user are the *same* answer
 * (`AUTH_INVALID_CREDENTIALS`), because the difference is an account-enumeration oracle. The
 * distinction is available in the reason a caller may log, never in the message a client sees.
 * · **Fail closed.** A hash whose parameters cannot be read is an error, not a "verified".
 */

import { TsirError } from '@tsir/container';

export type AuthErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_WEAK_PASSWORD'
  | 'AUTH_INVALID_HASH'
  | 'AUTH_UNSUPPORTED_HASH'
  | 'AUTH_INVALID_TOKEN'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_SESSION_STORE_FAILED'
  | 'AUTH_API_KEY_INVALID'
  | 'AUTH_API_KEY_REVOKED'
  | 'AUTH_CONFIG_INVALID';

const KIND = 'capability';

/** One message for every credential failure, on purpose: see the docblock. */
export function invalidCredentials(): TsirError {
  return new TsirError('AUTH_INVALID_CREDENTIALS', 'those credentials are not valid', {
    kind: KIND,
    hint: 'the message is deliberately identical for "no such user" and "wrong password" — an account-enumeration oracle is built from the difference',
  });
}

export function weakPassword(reason: string): TsirError {
  return new TsirError('AUTH_WEAK_PASSWORD', `the password is not acceptable: ${reason}`, {
    kind: KIND,
    hint: 'raise `minLength` in the hasher options, or require more character classes — the check happens before hashing, so it costs nothing',
  });
}

export function invalidHash(problem: string): TsirError {
  return new TsirError('AUTH_INVALID_HASH', `this is not a password hash: ${problem}`, {
    kind: KIND,
    hint: 'a hash is `$tsir$<algorithm>$<params>$<salt>$<digest>` — a value from another library will not verify, and guessing is worse than refusing',
  });
}

export function unsupportedHash(algorithm: string, known: readonly string[]): TsirError {
  return new TsirError('AUTH_UNSUPPORTED_HASH', `no hasher can verify a "${algorithm}" hash`, {
    kind: KIND,
    hint: `this build knows: ${known.join(', ')} — a hash that cannot be read is an account nobody can log into, so it fails here rather than as "wrong password"`,
    context: { algorithm, known: known.join(',') },
  });
}

export function invalidToken(kind: string): TsirError {
  return new TsirError('AUTH_INVALID_TOKEN', `this is not a ${kind} token`, {
    kind: KIND,
    hint: 'a token is opaque random bytes; a truncated or hand-edited one is refused before any store is read',
  });
}

export function sessionExpired(): TsirError {
  return new TsirError('AUTH_SESSION_EXPIRED', 'this session has expired', {
    kind: KIND,
    hint: 'the absolute lifetime elapsed, or the last use was longer ago than the idle timeout — both revoke, neither refreshes',
  });
}

export function sessionRevoked(): TsirError {
  return new TsirError('AUTH_SESSION_REVOKED', 'this session was revoked', {
    kind: KIND,
    hint: 'a logout, a password change, or a rotation that has already happened',
  });
}

export function sessionStoreFailed(detail: string): TsirError {
  return new TsirError('AUTH_SESSION_STORE_FAILED', `the session store failed: ${detail}`, {
    kind: KIND,
    hint: 'fail closed: an unreadable session store means nobody is authenticated, never everybody',
  });
}

export function apiKeyInvalid(): TsirError {
  return new TsirError('AUTH_API_KEY_INVALID', 'that API key is not valid', {
    kind: KIND,
    hint: 'unknown id, wrong secret, or expired — the same answer for all three',
  });
}

export function apiKeyRevoked(id: string): TsirError {
  return new TsirError('AUTH_API_KEY_REVOKED', `API key "${id}" was revoked`, {
    kind: KIND,
    hint: 'issue a new key; a revoked key is refused even if the secret is correct',
    context: { key: id },
  });
}

export function configInvalid(problem: string): TsirError {
  return new TsirError('AUTH_CONFIG_INVALID', `auth config is invalid: ${problem}`, {
    kind: KIND,
    hint: 'check the `auth` block in `tsir.js`; it is validated at boot, not at the first login',
  });
}
