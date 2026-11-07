# Tasks — `@tsir/oauth` (← socialize) (Phase 10)

> Social login: OAuth 2.0 authorization code flow with state verification, app-supplied HTTP
> clients, and Google + GitHub providers. Five of eight features are complete. The remaining work
> is additional providers, OAuth 1.0a support, and stateless (session-less) auth.
>
> **Plan:** [`15-capabilities.md`](../modules/15-capabilities.md) · **Related:**
> [`auth.md`](./auth.md) (session binding).

**Status: in progress.** OAuth 2.0 core, state verification, Google + GitHub providers are complete
(5/8). Three features remain: additional providers, OAuth 1.0a, and stateless auth.

## Tasks

| ID        | Task                                                       | Status | Depends   | Acceptance                                                                                                                         |
| --------- | ---------------------------------------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `OAUTH-1` | OAuth 2.0 authorization code flow + state                  | `[x]`  | —         | `redirectUrl` and `handleCallback`; state is a signed nonce verified at callback; a missing/mismatched state is refused            |
| `OAUTH-2` | `SocializeProvider` port — `authorize`/`token`/`user`      | `[x]`  | `OAUTH-1` | The port is provider-agnostic; a new provider implements three methods                                                             |
| `OAUTH-3` | App-supplied HTTP client (no SDK dependency)               | `[x]`  | `OAUTH-2` | Every provider takes a `{ fetch }`-compatible client; no SDK imports; errors map to coded failures                                 |
| `OAUTH-4` | Google provider                                            | `[x]`  | `OAUTH-2` | `googleProvider({ clientId, clientSecret, redirectUri, scopes })`; `user()` returns the profile from Google's userinfo             |
| `OAUTH-5` | GitHub provider                                            | `[x]`  | `OAUTH-2` | `githubProvider({ clientId, clientSecret, redirectUri, scopes })`; `user()` returns the profile from GitHub's API                  |
| `OAUTH-6` | Additional providers — Facebook, Twitter/X, Apple          | `[ ]`  | `OAUTH-2` | One new provider per vendor following the same app-supplied-client rule; each is verified against the conformance kit              |
| `OAUTH-7` | OAuth 1.0a support (Twitter/X legacy)                      | `[ ]`  | `OAUTH-2` | `OAuth1Provider` implements the 1.0a three-legged flow (request token → authorize → access token) with signature verification      |
| `OAUTH-8` | Stateless auth — session-less callback with signed handoff | `[ ]`  | `OAUTH-1` | `stateless: true` skips the session store; the callback returns a signed token the app can exchange for a session; no server state |

## Design notes

**Providers are app-supplied clients, not SDKs.** Following the same rule as `@tsir/cache`'s Redis
driver and `@tsir/broadcast`'s Pusher driver: each provider takes a tiny client interface and
validates it at startup. No SDK dependency, no global `fetch`.

**State is the only server-side state in OAuth 2.0.** The state param binds the authorization
request to the callback, preventing CSRF. `OAUTH-8`'s stateless mode extends this: instead of
storing the user in a session, the callback returns a signed token that the app can redeem — useful
for mobile/native flows where cookies don't apply.

**OAuth 1.0a is a separate port.** OAuth 1.0a's signature-based flow is structurally different from
2.0's bearer-token flow. `OAUTH-7` adds a `OAuth1Provider` interface rather than bending the 2.0
port; Twitter/X is the forcing function.

**What the gates check.** `bun test src/framework/socialize` covers the 2.0 flow, state
verification, and Google/GitHub against fake HTTP clients. `OAUTH-6`–`OAUTH-8` add provider tests
and stateless-flow tests.
