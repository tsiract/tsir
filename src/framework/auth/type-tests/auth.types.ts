/**
 * Type-level tests for `@tsir/auth` (`TST-009`).
 *
 * Compiled, not executed: a `@ts-expect-error` that stops failing is a compile error, so these
 * guarantees cannot rot.
 *
 * The four this package promises:
 *
 * 1. a stored **hash is a string and a token is a string** — the two cannot be swapped by accident
 * in a way that compiles, because the functions that consume them are named for their input;
 * 2. a **guard** answers `Principal | null`, and a `Guard<P>` decides the principal's data type, so
 * a route reading `data.role` cannot be handed a guard that produces something else;
 * 3. a **session's** `data` is the caller's type at `start` and `unknown` on read — the store is a
 * JSON boundary, and pretending otherwise is the bug this prevents;
 * 4. an **API key** is issued with the record, and the record never contains a usable secret.
 */

import {
  apiKeyGuard,
  assertPasswordAcceptable,
  bearerGuard,
  composeGuards,
  createApiKeys,
  createSessions,
  defaultHasher,
  parseApiKey,
  sessionGuard,
  verifyPassword,
  type ApiKeyRecord,
  type ApiKeys,
  type Guard,
  type PasswordHasher,
  type Principal,
  type Sessions,
} from '../src/index.ts';
import { bunArgon2Hasher } from '../src/adapters/bun-password.ts';
import { memoryApiKeyStore, memorySessionStore } from '../src/drivers/memory.ts';

// ── 1. hashes and tokens are strings, and the ports line up ─────────────────

declare const hasher: PasswordHasher;
const hash: Promise<string> = hasher.hash('correct horse battery staple');
const verified: Promise<boolean> = hasher.verify('correct horse battery staple', 'stored');
const stale: boolean = hasher.needsRehash('stored');
void hash;
void verified;
void stale;

// @ts-expect-error — a hasher cannot verify a number
void hasher.verify(42, 'stored');

const fallback: PasswordHasher = defaultHasher();
const argon: PasswordHasher = bunArgon2Hasher({ memoryCost: 65_536, timeCost: 2 });
void fallback;
void argon;

// A policy is an options object, not a bare number.
// @ts-expect-error — `minLength` is not a positional argument
void assertPasswordAcceptable('correct horse battery staple', 12);

void verifyPassword('correct horse battery staple', 'stored', { extraHashers: [argon] });

// ── 2. a guard's principal type is the guard's own ─────────────────────────

interface SessionData {
  readonly sessionId: string;
  readonly data: unknown;
  readonly expiresAt: number;
}

declare const sessions: Sessions;
const guard: Guard<SessionData> = sessionGuard({ sessions });
void guard;

const mapped: Guard<{ readonly plan: string }> = sessionGuard<{ readonly plan: string }>({
  sessions,
  principal: (session) => ({ subject: session.subject, data: { plan: 'pro' } }),
});
void mapped;

// @ts-expect-error — the mapper must return a `Principal`, not a bare string
void sessionGuard<{ readonly plan: string }>({ sessions, principal: () => 'user_1' });

const bearer: Guard<{ readonly scope: string }> = bearerGuard<{ readonly scope: string }>({
  verify: (token) =>
    Promise.resolve(token === '' ? null : { subject: 'svc', data: { scope: 'a' } }),
});
void bearer;

// A guard may answer `null` synchronously: `@tsir/http` treats that as a 401.
const composed: Guard<unknown> = composeGuards(guard, () => null, bearer);
void composed;

// `reads` is a literal on the guard, so a route can require a cookie session specifically.
declare const cookieGuard: ReturnType<typeof sessionGuard>;
const reads: 'cookie' = cookieGuard.reads;
void reads;

// ── 3. session data is typed on the way in, `unknown` on the way out ───────

interface Cart {
  readonly items: readonly string[];
}

async function startTyped(): Promise<void> {
  const started = await sessions.start({
    subject: 'user_1',
    data: { items: ['a'] } satisfies Cart,
  });
  const token: string = started.token;
  const cookie: string = started.cookie;
  void token;
  void cookie;

  const read = await sessions.read(token);
  if (read !== undefined) {
    // A store is a JSON boundary: the record's `data` is `unknown` until the caller validates it.
    const raw: unknown = read.record.data;
    const touched: boolean = read.touched;
    void raw;
    void touched;
  }

  // @ts-expect-error — `subject` is required; a session with no subject authenticates nobody
  await sessions.start({ data: { items: [] } });
}
void startTyped();

// ── 4. an issued key never carries a usable secret beyond its one return ───

declare const keys: ApiKeys;

async function issueTyped(): Promise<void> {
  const issued = await keys.issue({ subject: 'svc_1', name: 'ci', scopes: ['deploy:write'] });
  const key: string = issued.key;
  const record: ApiKeyRecord = issued.record;
  void key;

  // The record holds a hash — and the type says so: there is no `secret` to read.
  const hashOnly: string = record.secretHash;
  void hashOnly;

  // @ts-expect-error — a record carries no plaintext secret
  void record.secret;

  const parsed = parseApiKey(key);
  if (parsed !== undefined) {
    const parts: { readonly id: string; readonly secret: string } = parsed;
    void parts;
  }

  const found = await keys.verify(key);
  if (found !== undefined) {
    const scopes: readonly string[] = found.scopes;
    void scopes;
  }

  // @ts-expect-error — a key is issued with a subject and a name
  await keys.issue({ subject: 'svc_1' });
}
void issueTyped();

// ── 5. the stores are swappable, and the memory ones admit what they are ───

const memorySessions = memorySessionStore();
const memoryKeys = memoryApiKeyStore();
const closed: false = memorySessions.sharedAcrossInstances;
const closedToo: false = memoryKeys.sharedAcrossInstances;
void closed;
void closedToo;

const sessionsOverMemory: Sessions = createSessions({ store: memorySessions, ttlMs: 1_000 });
const keysOverMemory: ApiKeys = createApiKeys({ store: memoryKeys, idBytes: 16 });
void sessionsOverMemory;
void keysOverMemory;

const apiKeyOnly: Guard<{ readonly key: ApiKeyRecord }> = apiKeyGuard({ keys });
void apiKeyOnly;

// @ts-expect-error — a principal needs a subject
const subjectless: Principal<null> = { data: null };
void subjectless;
