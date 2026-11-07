/**
 * One-call bootstrap for `@tsir/nightwatch`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { inMemoryBackend, type BrowserBackend } from './nightwatch.ts';

export interface NightwatchBootstrapOptions {
  readonly backend?: BrowserBackend;
}

export interface NightwatchBootstrap {
  readonly backend: BrowserBackend;
  readonly browserBackendToken: Token<BrowserBackend>;
  readonly browserBackendProvider: Provider<BrowserBackend>;
}

export function createNightwatchBootstrap(
  options: NightwatchBootstrapOptions = {},
): NightwatchBootstrap {
  const backend = options.backend ?? inMemoryBackend();
  const browserBackendToken = token<BrowserBackend>('browserBackend');
  const browserBackendProvider = valueProvider(browserBackendToken, backend);
  return { backend, browserBackendToken, browserBackendProvider };
}
