/**
 * API keys.
 *
 * A key is `tsk_<public id>_<secret>`. The split is the design:
 *
 * · **The id is public and indexed.** Verification reads one row by primary key. The naive
 * alternative — hash the presented secret and compare it to every row's hash — is a table scan
 * whose cost grows with the customer list, and it is usually "fixed" by caching.
 * · **The secret is hashed.** The database never holds anything that can be presented as a key,
 * so a dump is not a set of credentials. SHA-256 is right here for the reason PBKDF2 is right
 * for a password: 32 bytes of CSPRNG output cannot be guessed, so a slow hash buys nothing and
 * costs a lookup on every request.
 * · **Revocation is a column, not a delete.** An audit needs to know that a key existed.
 *
 * `verify` returns `undefined` for every failure and never says which one — the same uniform-error
 * rule the password hasher follows.
 */

import { apiKeyInvalid, apiKeyRevoked } from './errors.ts';
import {
  constantTimeEqual,
  formatApiKey,
  hashToken,
  parseApiKey,
  randomHex,
  randomToken,
} from './token.ts';

export interface ApiKeyRecord {
  readonly id: string;
  readonly subject: string;
  /** A human label: `CI deploy`, `Mobile app`. Never a secret. */
  readonly name: string;
  /** What the key is allowed to do, when the application checks them. Empty means "as the subject". */
  readonly scopes: readonly string[];
  /** `sha256(secret)`. */
  readonly secretHash: string;
  readonly createdAt: number;
  readonly lastUsedAt?: number | undefined;
  readonly expiresAt?: number | undefined;
  readonly revokedAt?: number | undefined;
}

export interface ApiKeyStore {
  put(record: ApiKeyRecord): Promise<void>;
  get(id: string): Promise<ApiKeyRecord | undefined>;
  list(subject: string): Promise<readonly ApiKeyRecord[]>;
  revoke(id: string, at: number): Promise<boolean>;
  /** Last use, for a key-management screen. Best effort: a failure here must not fail a request. */
  touch(id: string, at: number): Promise<void>;
}

export interface ApiKeys {
  /** The key string, shown **once**, and the record it created. */
  issue(input: {
    readonly subject: string;
    readonly name: string;
    readonly scopes?: readonly string[] | undefined;
    readonly expiresAt?: number | undefined;
  }): Promise<{ readonly key: string; readonly record: ApiKeyRecord }>;
  /** The record behind a presented key, or `undefined`. The secret is compared in constant time. */
  verify(key: string): Promise<ApiKeyRecord | undefined>;
  revoke(id: string): Promise<boolean>;
  list(subject: string): Promise<readonly ApiKeyRecord[]>;
  /** What an error should say, once a key has been rejected: the code and nothing else. */
  readonly errors: {
    readonly invalid: typeof apiKeyInvalid;
    readonly revoked: typeof apiKeyRevoked;
  };
}

export interface ApiKeysOptions {
  readonly store: ApiKeyStore;
  readonly now?: (() => number) | undefined;
  /** Public id length in bytes. Default 12 → 24 hex characters (96 bits) — enough to never collide. */
  readonly idBytes?: number | undefined;
  readonly secretBytes?: number | undefined;
}

export function createApiKeys(options: ApiKeysOptions): ApiKeys {
  const store = options.store;
  const now = options.now ?? ((): number => Date.now());
  const idBytes = options.idBytes ?? 12;
  const secretBytes = options.secretBytes ?? 32;

  return {
    errors: { invalid: apiKeyInvalid, revoked: apiKeyRevoked },

    async issue(input) {
      const id = randomHex(idBytes);
      const secret = randomToken(secretBytes);
      const record: ApiKeyRecord = {
        id,
        subject: input.subject,
        name: input.name,
        scopes: (input.scopes ?? []).slice(),
        secretHash: await hashToken(secret),
        createdAt: now(),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      };
      await store.put(record);
      return { key: formatApiKey(id, secret), record };
    },

    async verify(key) {
      const parsed = parseApiKey(key);
      if (parsed === undefined) return undefined;

      const record = await store.get(parsed.id);
      if (record === undefined) {
        // Spend the same work as a real comparison so a missing id is not measurably faster than a
        // wrong secret.
        await hashToken(parsed.secret);
        return undefined;
      }

      const presented = await hashToken(parsed.secret);
      if (!constantTimeEqual(presented, record.secretHash)) return undefined;
      if (record.revokedAt !== undefined) return undefined;
      if (record.expiresAt !== undefined && record.expiresAt <= now()) return undefined;

      // Best effort, and awaited-but-swallowed rather than fire-and-forget: a read-only replica or
      // a locked row must not turn a valid key into a 401, and a floating rejection would.
      try {
        await store.touch(record.id, now());
      } catch {
        // Last use is telemetry. Losing it is not losing the request.
      }
      return record;
    },

    async revoke(id) {
      return store.revoke(id, now());
    },

    async list(subject) {
      return store.list(subject);
    },
  };
}
