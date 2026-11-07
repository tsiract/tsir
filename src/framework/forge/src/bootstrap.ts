/**
 * One-call bootstrap for `@tsir/forge`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { localProvider, type ServerProvider } from './forge.ts';

export interface ForgeBootstrapOptions {
  readonly provider?: ServerProvider;
}

export interface ForgeBootstrap {
  readonly provider: ServerProvider;
  readonly serverProviderToken: Token<ServerProvider>;
  readonly serverProviderProvider: Provider<ServerProvider>;
}

export function createForgeBootstrap(options: ForgeBootstrapOptions = {}): ForgeBootstrap {
  const provider = options.provider ?? localProvider();
  const serverProviderToken = token<ServerProvider>('serverProvider');
  const serverProviderProvider = valueProvider(serverProviderToken, provider);
  return { provider, serverProviderToken, serverProviderProvider };
}
