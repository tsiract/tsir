/**
 * Typed tokens.
 *
 * A token is an opaque, branded handle for a provider. Two tokens for the same
 * contract are *not* interchangeable, which is what makes swapping a repository
 * implementation a compile-time change rather than a runtime surprise.
 *
 * The brand is a phantom property: it exists only in the type system and is
 * never present at runtime, so tokens stay cheap objects.
 */

declare const tokenPhantom: unique symbol;

export type TokenKind = 'token' | 'contract';

export interface Token<T> {
  readonly kind: TokenKind;
  readonly description: string;
  /** Identity used for provider lookup. Unique per token instance. */
  readonly key: symbol;
  /** Phantom — never set at runtime. Covariant so `Token<X>` widens to `Token<unknown>`. */
  readonly [tokenPhantom]?: () => T;
}

export function token<T>(description: string): Token<T> {
  return Object.freeze({ kind: 'token' as const, description, key: Symbol(description) });
}

/**
 * A token for an interface/contract. Identical to `token` at runtime; the
 * distinct name documents intent at the use site.
 */
export function contract<T>(description: string): Token<T> {
  return Object.freeze({ kind: 'contract' as const, description, key: Symbol(description) });
}

/** Human-readable identifier used in diagnostics. */
export function describeToken(value: Token<unknown>): string {
  return `${value.kind === 'contract' ? 'contract' : 'token'}<${value.description}>`;
}
