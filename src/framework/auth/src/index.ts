/**
 * @tsir/auth — passwords, sessions, tokens and API keys.
 *
 * ```ts
 * const hasher = defaultHasher; // PBKDF2-SHA256, WebCrypto only
 * const hash = await hasher.hash('correct horse battery staple'); // $tsir$pbkdf2-sha256$i=210000…
 * await hasher.verify('correct horse battery staple', hash); // true
 *
 * const sessions = createSessions({ store: databaseSessionStore(db) });
 * const { cookie } = await sessions.start({ subject: user.id });
 *
 * const guard = sessionGuard({ sessions }); // (ctx) => Principal | null
 * ```
 *
 * Four rules hold across the package:
 *
 * · **Uniform failures.** A wrong password, an unknown user, a bad token and a revoked key all
 * produce one message. The distinction lives in a log line, never in a response.
 * · **Hashed at rest.** Passwords with a self-describing PBKDF2 hash (or argon2id on Bun), tokens
 * and API-key secrets with SHA-256. Nothing stored can be presented as a credential.
 * · **Rotation on privilege change**, and an idle *and* absolute lifetime, both enforced on read.
 * · **`__Host-` cookies**, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` — fixed, not configurable.
 */

/* ── passwords ─────────────────────────────────────────────────────────────── */
export {
  assertPasswordAcceptable,
  defaultHasher,
  algorithmOf,
  parseHash,
  PASSWORD_LIMITS,
  pbkdf2Hasher,
  verifyPassword,
  type ParsedHash,
  type PasswordHasher,
  type PasswordPolicy,
  type Pbkdf2Options,
} from './password.ts';

/* ── tokens ───────────────────────────────────────────────────────────────── */
export {
  base64url,
  constantTimeEqual,
  formatApiKey,
  fromBase64url,
  hashToken,
  parseApiKey,
  randomHex,
  randomToken,
  tokenPrefix,
} from './token.ts';

/* ── sessions ─────────────────────────────────────────────────────────────── */
export {
  cookieFrom,
  createSessions,
  SESSION_DEFAULTS,
  sessionErrors,
  type ReadSession,
  type SessionOptions,
  type SessionRecord,
  type SessionStore,
  type Sessions,
  type StartedSession,
} from './session.ts';
export {
  databaseSessionStore,
  sessionTableDdl,
  type DatabaseSessionStoreOptions,
  type SessionSql,
  type SessionSqlResult,
  type SessionSqlStatement,
} from './drivers/session-database.ts';

/* ── API keys ─────────────────────────────────────────────────────────────── */
export {
  createApiKeys,
  type ApiKeyRecord,
  type ApiKeyStore,
  type ApiKeys,
  type ApiKeysOptions,
} from './keys.ts';
export { apiKeyTableDdl, databaseApiKeyStore } from './drivers/keys-database.ts';

/* ── guards ───────────────────────────────────────────────────────────────── */
export {
  apiKeyGuard,
  bearerGuard,
  composeGuards,
  sessionGuard,
  type ApiKeyPrincipal,
  type AuthSessionData,
  type Guard,
  type GuardRequest,
  type Principal,
} from './guards.ts';

export type { AuthErrorCode } from './errors.ts';
