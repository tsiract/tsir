/**
 * @tsir/container — explicit constructor-based dependency injection.
 *
 * Public surface (stable within a minor):
 *   token, contract, Container, classProvider, factoryProvider, valueProvider,
 *   TsirError, isTsirError, normalizeError
 *
 * Everything else is internal. There is no global container instance.
 */

export { Container } from './container.ts';
export type {
  ContainerOptions,
  DiagnosticEvent,
  Disposable,
  Scope,
  ScopeKind,
} from './container.ts';

export { classProvider, factoryProvider, valueProvider } from './provider.ts';
export type { InjectTuple, Lifetime, Provider, ProviderOptions } from './provider.ts';

export { contract, describeToken, token } from './token.ts';
export type { Token, TokenKind } from './token.ts';

export { isTsirError, normalizeError, TsirError } from './errors.ts';
export type { ErrorContext, ErrorContextValue, ErrorKind, TsirErrorInit } from './errors.ts';
