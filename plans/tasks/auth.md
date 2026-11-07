# Tasks — `@tsir/auth` (Phase 7)

> Passwords, sessions, tokens and API keys — the four things an application authenticates with, and
> the four things it invents badly when nobody ships them. The package has no HTTP in it: a guard
> takes `{ request }`, which is structural, so a queue worker can authenticate the same way.
>
> **Plan:** [`14-security.md § 2–4`](../operations/14-security.md) · [`04-http.md § 8`](../modules/04-http.md) ·
> **Related:** [`policy.md`](./policy.md) (what the principal may do), [`12-security.md`](./12-security.md)
> (`SEC-2xx`), [`03-http.md`](./03-http.md) (401/403).

**Status: in progress.** Core auth (passwords, sessions, tokens, API keys, guards) is complete
(`AUTH-1`–`AUTH-12`). Three features remain: SPA cookie auth (Sanctum), CSRF protection, and email
verification (`AUTH-13`–`AUTH-15`).

## Tasks

| ID        | Task                                                          | Status | Depends           | Acceptance                                                                                                                                               |
| --------- | ------------------------------------------------------------- | ------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH-1`  | `PasswordHasher` port + `pbkdf2Hasher` over WebCrypto         | `[x]`  | —                 | A self-describing hash (`$tsir$pbkdf2-sha256$i=…$salt$digest`); fewer than 100 000 iterations is a `RangeError`, so the floor cannot drift down          |
| `AUTH-2`  | `argon2id` adapter behind `@tsir/auth/bun`                    | `[x]`  | `AUTH-1`          | `Bun.password` only, in an adapter subpath, so a Worker bundle never sees a `Bun` global; PHC strings verify through `extraHashers`                      |
| `AUTH-3`  | `assertPasswordAcceptable` **before** hashing                 | `[x]`  | `AUTH-1`          | Min 8 / max 1 024, a common-password list, ≤ 2 distinct characters; a refusal costs nothing, not 200 ms                                                  |
| `AUTH-4`  | `verifyPassword` — dispatch on the algorithm in the hash      | `[x]`  | `AUTH-1`,`AUTH-2` | A deployment that moves runtime keeps verifying old rows; an unreadable hash is `AUTH_INVALID_HASH`, never "wrong password"                              |
| `AUTH-5`  | `needsRehash` + rehash-on-login path                          | `[x]`  | `AUTH-4`          | Raising the cost is a non-event: old hashes verify with their own parameters and say when they should be upgraded                                        |
| `AUTH-6`  | Tokens: `randomToken`, `hashToken`, `constantTimeEqual`       | `[x]`  | —                 | 32 bytes of CSPRNG, stored as SHA-256 hex; comparison has no early exit                                                                                  |
| `AUTH-7`  | Sessions — `start`/`read`/`rotate`/`revoke`/`revokeSubject`   | `[x]`  | `AUTH-6`          | Absolute **and** idle lifetime, both enforced on read; an expired or revoked row is **deleted**, not merely refused                                      |
| `AUTH-8`  | `__Host-` cookie, asserted verbatim                           | `[x]`  | `AUTH-7`          | `Path=/; HttpOnly; Secure; SameSite=Lax`, no `Domain`; `clearCookie()` adds the 1970 `Expires`                                                           |
| `AUTH-9`  | API keys — `tsk_<public id>_<secret>`, hash at rest, revoke   | `[x]`  | `AUTH-6`          | The key is shown **once**; verification is one indexed read plus a constant-time compare; revocation is a column, so an audit can see the key            |
| `AUTH-10` | `memory` and `database` stores for both ports (D1 + Postgres) | `[x]`  | `AUTH-7`,`AUTH-9` | One structural SQL port that `@tsir/database` satisfies without an import; `sessionTableDdl`/`apiKeyTableDdl` print the migrations                       |
| `AUTH-11` | Guards — session, bearer, API key, `composeGuards`            | `[x]`  | `AUTH-7`,`AUTH-9` | A guard answers `Principal                                                                                                                               | null` and never explains itself; a **throw stops the chain** so an outage cannot downgrade |
| `AUTH-12` | Type tests                                                    | `[x]`  | `AUTH-11`         | A `Redacted`-style confusion, a guard whose principal type is wrong, and a session started without a subject all fail to compile                         |
| `AUTH-13` | SPA cookie auth (Sanctum) — `XSRF-TOKEN` + stateful cookie    | `[ ]`  | `AUTH-7`          | `sanctumGuard` reads the session cookie and the `XSRF-TOKEN` header; a missing or mismatched token is 401; the cookie is `SameSite=Lax`                  |
| `AUTH-14` | CSRF protection middleware                                    | `[ ]`  | `AUTH-13`         | `csrfMiddleware` rejects state-changing requests without a valid `X-CSRF-TOKEN`; the token is bound to the session; safe methods (GET/HEAD) pass through |
| `AUTH-15` | Email verification — signed URL + verified flag               | `[ ]`  | `AUTH-13`, vault  | `sendVerificationEmail` signs a URL with `@tsir/vault`; `verifyEmail` checks the signature and sets `emailVerifiedAt`; an expired signature is refused   |

## As built: hashes are self-describing, so cost is not a migration

```
$tsir$pbkdf2-sha256$i=210000,l=32$<salt base64url>$<digest base64url>
```

Every parameter a verification needs is in the string. That is what makes raising the cost safe:
old rows keep verifying with the parameters they were written with, `needsRehash` says which ones to
upgrade on the next successful login, and the alternative — one global constant — would silently
invalidate every existing password the day it changed.

**Why PBKDF2 is the default and argon2id is an adapter.** WebCrypto has PBKDF2 and nothing else, so
the default has to work on Workers, Bun and Node; `node:crypto` is not an option in a Worker.
PBKDF2's only defence is its parameters, so the floor is **210 000 iterations of SHA-256** (OWASP's
current recommendation) and it is checked in a test so it cannot drift down. argon2id is better and
is Bun-only, so `Bun.password` lives in `src/adapters/bun-password.ts` behind `@tsir/auth/bun`.
`verifyPassword` dispatches on the **algorithm in the hash**, not the driver you called, so moving
runtime keeps working — it just rehashes on the way past.

**An unreadable hash is an error, not a failed login.** Answering `false` to a row nobody can read
locks an account out with no trace of why; `AUTH_INVALID_HASH` / `AUTH_UNSUPPORTED_HASH` names the
algorithm and the hashers this build knows.

## As built: sessions are rows keyed by a hash, and three controls are named threats

| Control           | What it does                                              | Why it is built this way                                                                                                                           |
| ----------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixation          | `rotate()` issues a new token and **deletes** the old row | The old id is dead the moment the new one exists — a copy is a session an attacker keeps after a privilege change                                  |
| Idle + absolute   | `expiresAt` bounds life, `lastSeenAt` bounds inactivity   | Both enforced on read, and a read that fails either **revokes**: a session merely "not returned" returns when the clock is corrected               |
| Cookie attributes | `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` | `__Host-` is what stops a compromised `staging.example.com` planting a session for `example.com`; it _requires_ the other three, so they are fixed |

`read()` touches `lastSeenAt` at most once a minute: an `UPDATE` per request is write amplification
an hours-long idle timeout does not care about. Store failures are wrapped as
`AUTH_SESSION_STORE_FAILED` — an outage is a 500, never a 401 that hides it.

## As built: an API key is public id + hashed secret, and the split is the design

`tsk_<public id>_<secret>`. The id is **hex** and indexed, so verification is one primary-key read;
the secret is base64url and stored as `sha256(secret)`. Two consequences worth stating:

- The id is hex because base64url contains `_`, which is the separator — a base64url id makes the
  string ambiguous to split. `parseApiKey` splits at the first two separators and the rest is the
  secret, so a secret containing `_` (roughly one key in eight, decided by the CSPRNG) still parses.
  Splitting on every `_` is a bug that appears in production only.
- A miss spends the same hash as a hit, so "no such id" is not measurably faster than "wrong
  secret". `touch()` is best effort: a read-only replica must not turn a valid key into a 401.

## As built: guards never explain themselves

`sessionGuard`, `bearerGuard`, `apiKeyGuard`, and `composeGuards` for the first-answer-wins case.
A guard returns `Principal | null`; `@tsir/http` turns `null` into a 401. No `?error=token_expired`,
no `WWW-Authenticate: Bearer error="invalid_token"` — a client that can tell "expired" from "wrong"
is being helped, and so is an attacker probing. `composeGuards` stops on a **throw**: a session store
that is down must be a 500, not a silent fall-through to "maybe the API key works".

## Files

| File                              | What it is                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/errors.ts`                   | The eleven `AUTH_*` codes, each with the reason it is uniform                                 |
| `src/token.ts`                    | base64url, `randomToken`, `randomHex`, `hashToken`, `constantTimeEqual`, API-key parse/format |
| `src/password.ts`                 | The hasher port, PBKDF2, policy, `parseHash`, `verifyPassword`, `algorithmOf`                 |
| `src/session.ts`                  | `createSessions`, the cookie, `cookieFrom`, the guarded store calls                           |
| `src/keys.ts`                     | `createApiKeys` — issue, verify, revoke, list                                                 |
| `src/guards.ts`                   | The three guards and `composeGuards`                                                          |
| `src/adapters/bun-password.ts`    | `bunArgon2Hasher`, reachable as `@tsir/auth/bun`                                              |
| `src/drivers/session-memory.ts`   | The in-process session store (`sharedAcrossInstances: false`)                                 |
| `src/drivers/keys-memory.ts`      | The in-process key store                                                                      |
| `src/drivers/session-database.ts` | Session store over `SessionSql`, plus the DDL printer                                         |
| `src/drivers/keys-database.ts`    | API-key store over the same port, plus the DDL printer                                        |
| `src/drivers/memory.ts`           | The `@tsir/auth/memory` entry point (both stores, one import)                                 |
| `src/index.ts`                    | The public surface                                                                            |

## Tests

`password.test.ts` (parameters, the floor, the vectors, weak passwords, rehash, malformed hashes,
argon2id), `token.test.ts` (base64url boundaries, entropy, the SHA-256 vector, the separator bug),
`session.test.ts` (lifecycle, cookie verbatim, idle vs absolute, rotation, store failures),
`keys.test.ts` (issue, verify, revoke, expiry, last-use, listing), `guards.test.ts` (three guards,
composition, outages), `drivers/drivers.test.ts` (a fake `SessionSql` that routes by statement plus
placeholder and DDL assertions) — **87 tests**. `type-tests/auth.types.ts` is compiled by
`make typecheck`.

## Not built

- **JWT.** A signed token is a second, differently-broken session mechanism; sessions and API keys
  cover the two real cases (a browser, a machine). If it is added it belongs behind
  `@tsir/auth/jwt`, with `alg` pinned and no `none`.
- **WebAuthn / passkeys.** A ceremony, not a primitive — a browser API plus a credential store.
  It would sit next to `PasswordHasher` as a second verification path, not replace it.
- **Rate limiting on login.** That is an HTTP concern with a store (`@tsir/cache`), not an auth one;
  the error this package returns is already uniform, which is the half that belongs here.
