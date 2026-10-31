/**
 * Service identity (`LNK-007`): credentials come from a provider, never from env reads
 * scattered through call sites.
 *
 * The rules, and why each one exists:
 *
 *   1. **The secret never travels in `CallMeta`.** Meta carries `credentialId`. A log
 *      line that records which identity was used is useful; one that records the token
 *      is an incident.
 *   2. **Tokens rotate, so a provider is async.** Reading `process.env` inside the
 *      header builder would freeze the token at boot; a provider can fetch a fresh one
 *      from a token endpoint or a KMS without changing a single call site.
 *   3. **Header values are validated.** A token containing `\r\n` is a header-injection
 *      bug, and it is rejected where the credential is attached rather than left for
 *      the transport to interpret.
 */

import { invalidLinkConfig } from './errors.ts';
import type { CallContext, ServiceCredential } from './types.ts';

export interface CredentialRequest {
  /** The configured target being called (`https://billing.internal`). */
  readonly target: string;
  readonly ctx: CallContext;
}

export interface ServiceCredentialProvider {
  /** Shown in errors and logs; name it after the source (`service-token`, `mtls-billing`). */
  readonly name: string;
  /** Resolves the credential for one call, or `undefined` for an unauthenticated target. */
  credential(request: CredentialRequest): Promise<ServiceCredential | undefined>;
}

/** A fixed credential — tests, local development, and single-tenant deployments. */
export function staticCredentialProvider(credential: ServiceCredential): ServiceCredentialProvider {
  validateCredential(credential);
  return {
    name: `static:${credential.id}`,
    async credential() {
      return credential;
    },
  };
}

/** A bearer token, optionally refreshed per call (rotation without redeploys). */
export function bearerCredentialProvider(options: {
  readonly id: string;
  readonly token: string | (() => string | Promise<string>);
}): ServiceCredentialProvider {
  return {
    name: `bearer:${options.id}`,
    async credential() {
      const token = typeof options.token === 'function' ? await options.token() : options.token;
      const credential: ServiceCredential = {
        id: options.id,
        scheme: 'bearer',
        headers: { authorization: `Bearer ${token}` },
      };
      validateCredential(credential);
      return credential;
    },
  };
}

/**
 * Rejects a credential the transport must not send.
 *
 * CR/LF in a header value is request smuggling; an empty value is a silent auth
 * failure that looks like a server bug. Both are configuration mistakes, so they throw
 * `LNK_INVALID_CONFIG` at construction instead of producing a 401 in production.
 */
export function validateCredential(credential: ServiceCredential): void {
  if (credential.id.trim() === '') {
    throw invalidLinkConfig(
      'a service credential needs a non-empty id (it is the only thing logged)',
    );
  }
  for (const [name, value] of Object.entries(credential.headers)) {
    if (name.trim() === '')
      throw invalidLinkConfig(`credential "${credential.id}" has an empty header name`);
    if (/[\r\n]/.test(value) || /[\r\n]/.test(name)) {
      throw invalidLinkConfig(
        `credential "${credential.id}" contains CR/LF in header "${name}" — header injection`,
      );
    }
    if (value.trim() === '') {
      throw invalidLinkConfig(
        `credential "${credential.id}" has an empty value for header "${name}"`,
      );
    }
  }
}

/**
 * What may be logged: the id and the scheme.
 *
 * A function rather than "just don't log it" because every logger eventually receives
 * the whole object; giving people a safe projection is the only way that stays true.
 */
export function redactCredential(credential: ServiceCredential): {
  readonly id: string;
  readonly scheme: string;
} {
  return { id: credential.id, scheme: credential.scheme };
}

/**
 * Resolves the credential for a call: the context's own first, then the provider's.
 *
 * `ctx.credentials` wins so a caller can act as a specific tenant/identity for one call
 * without building a second client.
 */
export async function resolveCredential(
  provider: ServiceCredentialProvider | undefined,
  ctx: CallContext,
  target: string,
): Promise<ServiceCredential | undefined> {
  if (ctx.credentials !== undefined) {
    validateCredential(ctx.credentials);
    return ctx.credentials;
  }
  if (provider === undefined) return undefined;
  const resolved = await provider.credential({ target, ctx });
  if (resolved !== undefined) validateCredential(resolved);
  return resolved;
}
