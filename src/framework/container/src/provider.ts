/**
 * Provider definitions.
 *
 * The factories in this module are where type safety is enforced: the `inject`
 * array must match the constructor/factory parameter list in *both length and
 * type*. The container consumes the flattened `Provider<T>` shape, which keeps
 * its internals simple without weakening the public API.
 *
 * Explicit `inject` arrays are deliberate. Tsir does not use
 * `emitDecoratorMetadata` and never infers dependencies from parameter names
 * The decision is recorded as ADR-0001.
 */

import type { Token } from './token.ts';

export type Lifetime = 'singleton' | 'transient' | 'scoped';

/** Token tuple positionally matching a parameter list: `(a: A, b: B)` → `[Token<A>, Token<B>]`. */
export type InjectTuple<P extends readonly unknown[]> = {
  readonly [K in keyof P]: Token<P[K]>;
};

/** Symbol key holding the implementation. Internal to `@tsir/container`. */
export const implSlot: unique symbol = Symbol('tsir.provider.impl');

declare const providesPhantom: unique symbol;

export interface Provider<T> {
  readonly kind: 'class' | 'factory' | 'value';
  readonly token: Token<T>;
  readonly lifetime: Lifetime;
  readonly inject: readonly Token<unknown>[];
  /** @internal Implementation reference; not part of the public surface. */
  readonly [implSlot]: unknown;
  /** Phantom — ties `Provider<T>` to its result type for assignability checks. */
  readonly [providesPhantom]?: () => T;
}

export interface ProviderOptions {
  /** Defaults to `singleton`. */
  readonly lifetime?: Lifetime;
}

/** Registers a class; the container constructs it from the injected arguments. */
export function classProvider<T, P extends readonly unknown[]>(
  token: Token<T>,
  use: new (...args: P) => T,
  inject: InjectTuple<P>,
  options: ProviderOptions = {},
): Provider<T> {
  return Object.freeze({
    kind: 'class' as const,
    token,
    lifetime: options.lifetime ?? 'singleton',
    inject: Object.freeze([...inject]),
    [implSlot]: use,
  });
}

/** Registers a factory. Asynchronous factories require `resolveAsync`. */
export function factoryProvider<T, P extends readonly unknown[]>(
  token: Token<T>,
  use: (...args: P) => T | Promise<T>,
  inject: InjectTuple<P>,
  options: ProviderOptions = {},
): Provider<T> {
  return Object.freeze({
    kind: 'factory' as const,
    token,
    lifetime: options.lifetime ?? 'singleton',
    inject: Object.freeze([...inject]),
    [implSlot]: use,
  });
}

/** Registers an already-constructed value (config objects, clients, fakes). */
export function valueProvider<T>(token: Token<T>, use: T): Provider<T> {
  return Object.freeze({
    kind: 'value' as const,
    token,
    lifetime: 'singleton' as const,
    inject: Object.freeze([]),
    [implSlot]: use,
  });
}
