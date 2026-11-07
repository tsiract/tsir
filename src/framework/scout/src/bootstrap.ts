/**
 * One-call bootstrap for `@tsir/scout`.
 */
import { token, valueProvider, type Provider, type Token } from '@tsir/container';

import { memoryEngine, type SearchEngine } from './scout.ts';

export interface ScoutBootstrapOptions {
  readonly engine?: SearchEngine;
}

export interface ScoutBootstrap {
  readonly engine: SearchEngine;
  readonly searchEngineToken: Token<SearchEngine>;
  readonly searchEngineProvider: Provider<SearchEngine>;
}

export function createScoutBootstrap(options: ScoutBootstrapOptions = {}): ScoutBootstrap {
  const engine = options.engine ?? memoryEngine();
  const searchEngineToken = token<SearchEngine>('searchEngine');
  const searchEngineProvider = valueProvider(searchEngineToken, engine);
  return { engine, searchEngineToken, searchEngineProvider };
}
