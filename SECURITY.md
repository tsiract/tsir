# Security policy

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's private advisory channel:

<https://github.com/tsir-framework/tsir/security/advisories/new>

If you cannot use GitHub, write to `security@tsir.dev` and encrypt with the key
published there. Include the affected package and version, the smallest
reproduction you can manage, and what an attacker gains.

You will get an acknowledgement within three working days and an assessment
within ten. We will tell you when a fix ships; we will credit you unless you ask
us not to.

## Scope

In scope:

- Encryption, key handling and rotation (`@tsir/vault`, Phase 4): envelope
  format, `APP_KEY_NOW`/`APP_KEY_NEXT` rotation, fail-closed behaviour.
- Authentication and authorization (`authn`, `authz`, Phase 5): session and token
  handling, policy bypass, privilege escalation.
- Request handling (`@tsir/router`, `@tsir/http`, Phase 2): path traversal,
  prototype pollution, request smuggling, header injection, validation bypass.
- Release artifacts: a published tarball that differs from the tagged build.

Out of scope: vulnerabilities in third-party dependencies (report those upstream,
and tell us so we can pin or vendor), missing hardening headers in the example
applications, and anything that requires running untrusted code inside the
application process.

## Supported versions

Tsir is pre-1.0. Security fixes land on `main` and in the next release; there are
no backport branches yet. That policy changes at 1.0.

## What we already promise

- No custom cryptography: AES-256-GCM or ChaCha20-Poly1305 through a vetted
  implementation, with a versioned envelope.
- All untrusted input is validated at runtime before it reaches application code.
- Secrets never appear in logs, error reports or problem+json documents.
