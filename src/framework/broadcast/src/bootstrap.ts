/**
 * One-call bootstrap for `@tsir/broadcast`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { memoryBroadcaster, type Broadcaster } from './broadcaster.ts';

export interface BroadcastBootstrapOptions {
  readonly broadcaster?: Broadcaster;
}

export interface BroadcastBootstrap {
  readonly broadcaster: Broadcaster;
  readonly broadcasterToken: Token<Broadcaster>;
  readonly broadcasterProvider: Provider<Broadcaster>;
}

export function createBroadcastBootstrap(
  options: BroadcastBootstrapOptions = {},
): BroadcastBootstrap {
  const broadcaster = options.broadcaster ?? memoryBroadcaster();
  const broadcasterToken = token<Broadcaster>('broadcaster');
  const broadcasterProvider = valueProvider(broadcasterToken, broadcaster);
  return { broadcaster, broadcasterToken, broadcasterProvider };
}
