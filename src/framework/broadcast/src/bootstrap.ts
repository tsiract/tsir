/**
 * One-call bootstrap for `@tsir/broadcast`.
 *
 * Two ways in, and the difference is deliberate. `broadcaster` takes an instance the app built —
 * the escape hatch for a driver we do not ship. `broadcast` takes the `tsir.js` block, so the
 * driver is a name in a file and `production: true` can refuse `memory` at boot (`CAP-006`).
 * Passing both is an error rather than a precedence puzzle.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { memoryBroadcaster, type Broadcaster } from './broadcaster.ts';
import {
  broadcasterFromConfig,
  type BroadcastBindings,
  type ConfiguredBroadcast,
} from './config.ts';

export interface BroadcastBootstrapOptions {
  /** An instance, already built. Mutually exclusive with `broadcast`. */
  readonly broadcaster?: Broadcaster;
  /** The `broadcast` block from `tsir.js`. */
  readonly broadcast?: ConfiguredBroadcast | undefined;
  /** Clients and namespaces the configured driver needs. */
  readonly bindings?: BroadcastBindings | undefined;
  /** Refuse `memory`, which cannot reach another isolate. */
  readonly production?: boolean | undefined;
}

export interface BroadcastBootstrap {
  readonly broadcaster: Broadcaster;
  readonly broadcasterToken: Token<Broadcaster>;
  readonly broadcasterProvider: Provider<Broadcaster>;
}

export function createBroadcastBootstrap(
  options: BroadcastBootstrapOptions = {},
): BroadcastBootstrap {
  if (options.broadcaster !== undefined && options.broadcast !== undefined) {
    throw new TypeError(
      'pass either `broadcaster` (an instance) or `broadcast` (the tsir.js block), not both — a registry that can be overridden silently is a registry nobody can trust',
    );
  }

  const broadcaster =
    options.broadcaster ??
    (options.broadcast === undefined && options.bindings === undefined
      ? memoryBroadcaster()
      : broadcasterFromConfig({
          ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
          ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
          ...(options.production === undefined ? {} : { production: options.production }),
        }));

  const broadcasterToken = token<Broadcaster>('broadcaster');
  const broadcasterProvider = valueProvider(broadcasterToken, broadcaster);
  return { broadcaster, broadcasterToken, broadcasterProvider };
}
