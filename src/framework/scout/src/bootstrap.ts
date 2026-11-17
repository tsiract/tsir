/**
 * One-call bootstrap for `@tsir/scout`.
 *
 * `engine` is an instance the app built; `search` is the `tsir.js` block. Same rule as the
 * broadcast bootstrap: one or the other, and the config path is the one that can refuse `memory`
 * in production.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { searchFromConfig } from './config.ts';
import type { ConfiguredSearch, SearchBindings } from './config.ts';
import { memoryEngine, type SearchEngine } from './scout.ts';

export interface ScoutBootstrapOptions {
  /** An instance, already built. Mutually exclusive with `search`. */
  readonly engine?: SearchEngine;
  /** The `search` block from `tsir.js`. */
  readonly search?: ConfiguredSearch | undefined;
  readonly bindings?: SearchBindings | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly production?: boolean | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export interface ScoutBootstrap {
  readonly engine: SearchEngine;
  readonly searchEngineToken: Token<SearchEngine>;
  readonly searchEngineProvider: Provider<SearchEngine>;
}

export function createScoutBootstrap(options: ScoutBootstrapOptions = {}): ScoutBootstrap {
  if (options.engine !== undefined && options.search !== undefined) {
    throw new TypeError(
      'pass either `engine` (an instance) or `search` (the tsir.js block), not both — a registry that can be overridden silently is a registry nobody can trust',
    );
  }

  const engine =
    options.engine ??
    (options.search === undefined && options.bindings === undefined
      ? memoryEngine()
      : searchFromConfig({
          ...(options.search === undefined ? {} : { search: options.search }),
          ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.production === undefined ? {} : { production: options.production }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }));

  const searchEngineToken = token<SearchEngine>('searchEngine');
  const searchEngineProvider = valueProvider(searchEngineToken, engine);
  return { engine, searchEngineToken, searchEngineProvider };
}
