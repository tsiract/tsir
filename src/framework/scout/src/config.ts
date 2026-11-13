/**
 * `search.driver` in `tsir.js` — the registry half of `@tsir/search` (`CAP-006`).
 *
 * The three kinds of engine have three kinds of dependency, and the registry's job is to make that
 * difference visible instead of surprising:
 *
 *   · **`memory`** needs nothing. It is the development default for the same reason every other
 *     `memory` default exists — `make dev` must need no account — and it is refused in production,
 *     because an index that dies with the isolate returns no results rather than stale ones.
 *   · **`sqlite` and `postgres`** need a `query` function, which the database package's own port
 *     satisfies structurally. This is the free path: no service, no key, no per-query invoice.
 *   · **`typesense`, `meilisearch`, `algolia`** need a host and a key. `{ fromEnv: … }` is resolved
 *     here so the key never appears in a committed file, which is the rule the other registries
 *     follow.
 *
 *   ```ts
 *   // config/search.ts
 *   export default { driver: 'typesense', host: 'https://xxx.a1.typesense.net', collection: 'docs',
 *                    apiKey: { fromEnv: 'TYPESENSE_API_KEY' } };
 *   ```
 */

import { TsirError } from '@tsir/container';

import { postgresEngine, sqliteEngine } from './drivers.ts';
import { HOSTED_SEARCH_PROVIDERS, hostedSearch, type HostedSearchProvider } from './hosted.ts';
import { SEARCH_DRIVERS, memoryEngine, type SearchDriverName, type SearchEngine } from './scout.ts';

export type { SearchDriverName };

/** A string, or a reference to one in the environment — the rule every secret follows. */
export type EnvRef = string | { readonly fromEnv: string };

/** One `search` block, as configuration sees it. */
export interface ConfiguredSearch {
  /** As written in `tsir.js`; `string`, so an unknown name is a coded error, not a type error. */
  readonly driver: string;
  /** `sqlite`/`postgres`: which connection, when `bindings.databases` holds several. */
  readonly connection?: string | undefined;
  /** `typesense`/`meilisearch`/`algolia`: the collection or index every document lands in. */
  readonly collection?: string | undefined;
  /** The cluster URL, e.g. `https://xxx.a1.typesense.net`. */
  readonly host?: string | undefined;
  /** The write key — `{ fromEnv: 'TYPESENSE_API_KEY' }`. */
  readonly apiKey?: EnvRef | undefined;
  /** `algolia` only: the search-only key, when the write key must not be shipped to a browser. */
  readonly searchApiKey?: EnvRef | undefined;
}

/** The SQL shape both SQL engines take — the same one `@tsir/database` satisfies structurally. */
export type QueryFn = (
  sql: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export interface SearchBindings {
  /** Connection name → a query function. Required by `driver: 'sqlite'` / `'postgres'`. */
  readonly databases?: Readonly<Record<string, QueryFn>> | undefined;
}

const KIND = 'capability';

function driverMissing(driver: string): TsirError {
  return new TsirError(
    'CAP_DRIVER_MISSING',
    `search names driver "${driver}", which is not registered`,
    {
      kind: KIND,
      hint: `set search.driver to one of: ${SEARCH_DRIVERS.join(', ')}`,
      context: { driver },
    },
  );
}

/**
 * The missing value, in the place a reader looks.
 *
 * The binding name goes in the **hint**, not only the message: `bindings.databases.default` is
 * the thing to add, and a hint that only explains why the driver needs it leaves the reader to
 * work out which key was absent.
 */
function missing(key: string, driver: string, hint: string): TsirError {
  return new TsirError('CAP_DRIVER_MISSING', `search: the "${driver}" driver needs \`${key}\``, {
    kind: KIND,
    hint: `add \`${key}\` — ${hint}`,
    context: { driver, key },
  });
}

/** Resolve a `{ fromEnv }` reference, or refuse naming the variable that was empty. */
function resolveRef(
  value: EnvRef | undefined,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  driver: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  const found = env[value.fromEnv];
  if (found === undefined || found === '') {
    throw missing(
      key,
      driver,
      `\`${value.fromEnv}\` is not set — a secret in \`tsir.js\` is refused on purpose`,
    );
  }
  return found;
}

function forbiddenInProduction(driver: string): TsirError {
  return new TsirError(
    'CAP_FORBIDDEN_IN_PRODUCTION',
    `search driver "${driver}" cannot be the production engine`,
    {
      kind: KIND,
      hint: 'an in-memory index dies with the isolate, so every query after a cold start returns nothing; use `sqlite`, `postgres`, or a hosted driver',
      context: { driver },
    },
  );
}

/** Build one engine from its configuration. The only place a driver name becomes code. */
export function engineFor(
  config: ConfiguredSearch,
  options: {
    readonly bindings?: SearchBindings | undefined;
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly production?: boolean | undefined;
    readonly fetch?: typeof fetch | undefined;
  } = {},
): SearchEngine {
  const env = options.env ?? {};
  const connection = config.connection ?? 'default';

  switch (config.driver) {
    case 'memory': {
      if (options.production === true) throw forbiddenInProduction('memory');
      return memoryEngine();
    }

    case 'sqlite':
    case 'postgres': {
      const query = options.bindings?.databases?.[connection];
      if (typeof query !== 'function') {
        throw missing(
          `bindings.databases.${connection}`,
          config.driver,
          "pass the database port's own query function — `sqlite` and `postgres` only need SQL and parameters",
        );
      }
      return config.driver === 'sqlite' ? sqliteEngine(query) : postgresEngine(query);
    }

    case 'typesense':
    case 'meilisearch':
    case 'algolia': {
      const host = config.host;
      if (host === undefined || host === '') {
        throw missing(
          'host',
          config.driver,
          'the cluster URL, e.g. `https://xxx.a1.typesense.net`',
        );
      }
      const collection = config.collection;
      if (collection === undefined || collection === '') {
        throw missing('collection', config.driver, 'the index name every document lands in');
      }
      const apiKey = resolveRef(config.apiKey, env, 'apiKey', config.driver);
      if (apiKey === undefined) {
        throw missing(
          'apiKey',
          config.driver,
          "set `apiKey: { fromEnv: 'TYPESENSE_API_KEY' }` — the value never belongs in `tsir.js`",
        );
      }
      const searchApiKey = resolveRef(config.searchApiKey, env, 'searchApiKey', config.driver);
      return hostedSearch({
        provider: config.driver satisfies HostedSearchProvider,
        collection,
        host,
        apiKey,
        ...(searchApiKey === undefined ? {} : { searchApiKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    }

    default:
      throw driverMissing(config.driver);
  }
}

/**
 * Build the engine from `tsir.js`.
 *
 * No `search` block is `memory`: a project that has not configured search still boots, and
 * `tsir doctor` reports the row. `production: true` refuses it rather than serving an empty index.
 */
export function searchFromConfig(options: {
  readonly search?: ConfiguredSearch | undefined;
  readonly bindings?: SearchBindings | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly production?: boolean | undefined;
  readonly fetch?: typeof fetch | undefined;
}): SearchEngine {
  return engineFor(options.search ?? { driver: 'memory' }, {
    ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.production === undefined ? {} : { production: options.production }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/** The hosted provider names, re-exported so config validation can list them beside the engines. */
export { HOSTED_SEARCH_PROVIDERS };
