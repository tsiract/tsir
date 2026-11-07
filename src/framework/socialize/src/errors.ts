/**
 * Socialize error codes.
 *
 * Provider failures (token exchange, userinfo) and unknown-provider lookups.
 */
import { TsirError } from '@tsir/container';

export type SocializeErrorCode =
  | 'GITHUB_TOKEN_FAILED'
  | 'GITHUB_USER_FAILED'
  | 'GOOGLE_TOKEN_FAILED'
  | 'GOOGLE_USERINFO_FAILED'
  | 'SOCIALIZE_UNKNOWN_PROVIDER';

/** The GitHub token exchange endpoint returned a non-2xx status. */
export function githubTokenFailed(status: number): TsirError {
  return new TsirError('GITHUB_TOKEN_FAILED', `github token exchange failed: ${status}`, {
    kind: 'internal',
  });
}

/** The GitHub user endpoint returned a non-2xx status. */
export function githubUserFailed(status: number): TsirError {
  return new TsirError('GITHUB_USER_FAILED', `github user fetch failed: ${status}`, {
    kind: 'internal',
  });
}

/** The Google token exchange endpoint returned a non-2xx status. */
export function googleTokenFailed(status: number): TsirError {
  return new TsirError('GOOGLE_TOKEN_FAILED', `google token exchange failed: ${status}`, {
    kind: 'internal',
  });
}

/** The Google userinfo endpoint returned a non-2xx status. */
export function googleUserinfoFailed(status: number): TsirError {
  return new TsirError('GOOGLE_USERINFO_FAILED', `google userinfo failed: ${status}`, {
    kind: 'internal',
  });
}

/** A provider name was requested that no bootstrap registered. */
export function unknownProvider(name: string): TsirError {
  return new TsirError('SOCIALIZE_UNKNOWN_PROVIDER', `socialize: unknown provider "${name}"`, {
    kind: 'internal',
  });
}
