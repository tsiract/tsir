/**
 * The registry (`CAP-001`, `CAP-002`, `§ 2.2`).
 *
 * `cache.stores` is the same shape as `database.connections` (ADR-0019) on purpose: one
 * named, typed registry per port, an explicit `default`, and a name that was never declared
 * is an error rather than a fallback.
 *
 * Two decisions worth stating, because both are the opposite of the obvious one:
 *
 *   · **Capabilities are validated at boot; backends open lazily.** A project with a dozen
 *     stores should not open a dozen connections during boot (`§ 9` Q46), and it does not
 *     have to: a driver's capabilities are static, so the check needs no connection. The
 *     first call that actually resolves a store opens it, once.
 *   · **One store, one driver, one codec.** Two stores on the same driver are two caches
 *     (`app` and `sessions` both `database`, different tables) — that is the normal case,
 *     not a special one.
 */

import type { TsirError } from '@tsir/container';

import { json } from './codec.ts';
import { createCache } from './store.ts';
import {
  driverMissing,
  forbiddenInProduction,
  noStores,
  unknownDefault,
  unknownStore,
  unsupportedOperation,
} from './errors.ts';
import type { Cache, CacheCapabilities, CacheDriver, Codec } from './port.ts';

/** One entry of `cache.stores`. */
export interface StoreDefinition<T = unknown, Config = unknown> {
  readonly driver: CacheDriver<Config>;
  /** Passed to `driver.open`. Ignored by drivers that take no config. */
  readonly config?: Config | undefined;
  /** How values are encoded. Defaults to `json<T>()` — never an implicit parse. */
  readonly codec?: Codec<T> | undefined;
  /** Store-level default TTL in ms. Per-call `ttlMs` wins. */
  readonly ttlMs?: number | undefined;
  /**
   * Boot-validated, and refused in production if the driver is not durable. Set it on any
   * store a `requires` block names — a rate limiter must not silently run on a per-isolate map.
   */
  readonly required?: boolean | undefined;
}

/** Keeps `T` and `Config` inferable at the declaration site. */
export function defineStore<T = unknown, Config = unknown>(
  definition: StoreDefinition<T, Config>,
): StoreDefinition<T, Config> {
  return definition;
}

type AnyDefinition = StoreDefinition<never, never> | StoreDefinition<unknown, unknown>;
/** The value type a store definition declares, for callers typing against the registry. */
export type StoreValue<D> = D extends StoreDefinition<infer T, never> ? T : unknown;

export interface CachesOptions<S extends Readonly<Record<string, AnyDefinition>>> {
  readonly stores: S;
  /** Required, and must exist. There is no "first key wins" (`§ 2.2`). */
  readonly default: keyof S & string;
  /**
   * Refuse an ephemeral driver as the default (or on a `required` store). The app says which
   * environment it is booting as; the cache does not guess from `NODE_ENV`.
   */
  readonly production?: boolean | undefined;
}

type ValueOf<D> = D extends StoreDefinition<infer T, never> ? T : unknown;

/**
 * The registry, typed by what each store was **declared** with.
 *
 * `cache.store('sessions')` is a `Cache<Session>` because `sessions` was declared with a
 * `Session` codec — not because a caller passed a type argument. A generic `store<T>()` would
 * be the same hole as `JSON.parse(...) as T`, just spelled differently.
 */
export interface Caches<
  S extends Readonly<Record<string, AnyDefinition>> = Readonly<Record<string, AnyDefinition>>,
> {
  /** Declared names, in declaration order — the exact list the errors print. */
  readonly names: readonly (keyof S & string)[];
  readonly default: keyof S & string;
  /** The store every unnamed call site uses. */
  readonly defaultCache: Cache<ValueOf<S[keyof S & string]>>;
  store<N extends keyof S & string>(name: N): Cache<ValueOf<S[N]>>;
  capabilities(name: keyof S & string): CacheCapabilities;
  /** True once a store's backend has been opened. */
  isOpen(name: keyof S & string): boolean;
  /** Which stores were validated at boot (the default plus every `required: true`). */
  readonly validated: readonly (keyof S & string)[];
  /** Open every store and round-trip one key — the explicit health probe (`§ 9` Q46). */
  probe(): Promise<
    readonly { readonly store: keyof S & string; readonly ok: boolean; readonly detail?: string }[]
  >;
  clear(): Promise<void>;
}

/** The structural shape a requirement check needs; keeps `checkRequirements` generic-free. */
export interface CapabilityLookup {
  capabilities(name: string): CacheCapabilities;
  store(name: string): Cache<unknown>;
}

/**
 * A requirement block (`CAP-002`): "this store must be able to do X".
 *
 * Written as data so it can live in `tsir.js` and in `defineModule({ requires })`, and be
 * checked at boot rather than discovered in production.
 */
export interface StoreRequirement {
  readonly store: string;
  readonly readYourWrites?: boolean | undefined;
  readonly persistent?: boolean | undefined;
  readonly sharedAcrossInstances?: boolean | undefined;
  readonly tags?: boolean | undefined;
  readonly increment?: boolean | undefined;
}

/** One way a requirement block is not met. */
export interface RequirementProblem {
  readonly store: string;
  /** The capability that is missing, or `'store'` when the store itself is undeclared. */
  readonly capability: string;
  readonly driver: string;
  readonly detail: string;
  /** Set for an undeclared store: the original error, rethrown as-is by the assert form. */
  readonly error?: TsirError | undefined;
}

const REQUIREMENT_LABELS: readonly (keyof Omit<StoreRequirement, 'store'>)[] = [
  'readYourWrites',
  'persistent',
  'sharedAcrossInstances',
  'tags',
  'increment',
];

/**
 * Check requirement blocks against the declared stores.
 *
 * Returns the violations rather than throwing, so the caller can report all of them at once
 * (a boot report listing three problems is worth more than three restarts) — `assertRequirements`
 * is the throwing form for call sites that want one.
 */
export function checkRequirements(
  caches: CapabilityLookup,
  requirements: readonly StoreRequirement[],
): readonly RequirementProblem[] {
  const problems: RequirementProblem[] = [];

  for (const requirement of requirements) {
    let capabilities: CacheCapabilities;
    try {
      capabilities = caches.capabilities(requirement.store);
    } catch (error: unknown) {
      problems.push({
        store: requirement.store,
        capability: 'store',
        driver: '',
        detail: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error ? { error: error as TsirError } : {}),
      });
      continue;
    }

    const driver = caches.store(requirement.store).driver;
    for (const label of REQUIREMENT_LABELS) {
      if (requirement[label] !== true) continue;
      if (capabilities[label]) continue;
      problems.push({
        store: requirement.store,
        capability: label,
        driver,
        detail: `store "${requirement.store}" (driver "${driver}") requires ${label}, which it does not provide`,
      });
    }
  }

  return problems;
}

/** The throwing form, naming the store and its driver. */
export function assertRequirements(
  caches: CapabilityLookup,
  requirements: readonly StoreRequirement[],
): void {
  const [first] = checkRequirements(caches, requirements);
  if (first === undefined) return;
  // An undeclared store is its own error (`CAP_UNKNOWN_STORE`), not a capability failure.
  if (first.error !== undefined) throw first.error;
  throw unsupportedOperation(
    first.store,
    first.driver,
    first.capability,
    'the driver does not provide it',
  );
}

export function createCaches<const S extends Readonly<Record<string, AnyDefinition>>>(
  options: CachesOptions<S>,
): Caches<S> {
  type Names = keyof S & string;

  const names = Object.keys(options.stores) as Names[];
  if (names.length === 0) throw noStores();

  const defaultName = options.default;
  if (!names.includes(defaultName)) throw unknownDefault(defaultName, names);

  for (const name of names) {
    const definition = options.stores[name] as StoreDefinition<unknown, unknown> | undefined;
    if (definition?.driver === undefined) {
      throw driverMissing(name, '(none)', '@tsir/cache');
    }
  }

  // ── boot validation (CAP-002): no connection needed, capabilities are static ──
  const validated: Names[] = names.filter((name) => {
    const definition = options.stores[name] as StoreDefinition<unknown, unknown>;
    return name === defaultName || definition.required === true;
  });

  if (options.production === true) {
    for (const name of validated) {
      const definition = options.stores[name] as StoreDefinition<unknown, unknown>;
      if (definition.driver.capabilities.persistent) continue;
      throw forbiddenInProduction(
        name,
        definition.driver.name,
        name === defaultName
          ? 'it is the default store, so everything unnamed would land on a cache that dies with the process'
          : 'a `requires` block names it, so a code path that needs it would silently get an ephemeral cache',
      );
    }
  }

  // ── lazy opening, memoised (`§ 9` Q46: validate at boot, connect on first use) ──
  const open = new Map<string, Cache<unknown>>();

  const resolve = (name: string): Cache<unknown> => {
    const cached = open.get(name);
    if (cached !== undefined) return cached;

    const found = options.stores[name];
    if (found === undefined) throw unknownStore(name, names);

    // `StoreDefinition<T>` is invariant in `T` (a codec both accepts and returns it), so the
    // union of declared shapes is widened once, here, to the erased form. Every other
    // assertion in this package exists because of exactly this line.
    const definition: StoreDefinition<unknown, unknown> = found;
    const backend = definition.driver.open(definition.config);
    const codec = definition.codec ?? json<unknown>();
    const cache = createCache<unknown>({
      name,
      backend,
      codec,
      ...(definition.ttlMs === undefined ? {} : { ttlMs: definition.ttlMs }),
    });

    open.set(name, cache);
    return cache;
  };

  const caches: Caches<S> = {
    names,
    default: defaultName,
    validated,
    // A getter-free object: `defaultCache` is resolved eagerly so a bad default driver fails
    // at boot rather than at the first request that happened not to name a store.
    defaultCache: resolve(defaultName) as Cache<ValueOf<S[keyof S & string]>>,
    store: <N extends Names>(name: N): Cache<ValueOf<S[N]>> =>
      resolve(name) as Cache<ValueOf<S[N]>>,
    capabilities: (name: Names): CacheCapabilities => resolve(name).capabilities,
    isOpen: (name: Names): boolean => open.has(name),
    async probe() {
      const results: { store: Names; ok: boolean; detail?: string }[] = [];
      for (const name of names) {
        try {
          const cache = resolve(name);
          const key = `tsir:probe:${String(Date.now())}`;
          await cache.set(key, 'ok');
          const seen = await cache.get(key);
          await cache.delete(key);
          results.push(
            seen === 'ok'
              ? { store: name, ok: true }
              : { store: name, ok: false, detail: 'the probe value did not survive a round trip' },
          );
        } catch (error: unknown) {
          results.push({
            store: name,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    },
    async clear() {
      for (const name of names) await resolve(name).clear();
    },
  };

  return caches;
}
