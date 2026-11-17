/**
 * Errors (`CAP-*`).
 *
 * Two of these carry the weight of the whole package:
 *
 *   · `CAP_UNKNOWN_STORE` — a name that was never declared. Never a fallback to the default:
 *     a rate limiter that quietly lands on the wrong store is the failure this package exists
 *     to prevent (`15-capabilities.md § 2.2`).
 *   · `CAP_UNSUPPORTED_OPERATION` — a store whose *driver* cannot do what the caller asked,
 *     with both names in the message. "Tags are not supported" is useless; "store `pages`
 *     (driver `cloudflare-kv`) does not support tags" is a fix.
 *
 * Every error carries the store name as structured context, because the name is also an
 * observability dimension (`13-observability.md`) — a metric label and an error field that
 * disagree are worse than neither.
 */

import { TsirError } from '@tsir/container';

export type CacheErrorCode =
  | 'CAP_UNKNOWN_STORE'
  | 'CAP_UNSUPPORTED_OPERATION'
  | 'CAP_NO_STORES'
  | 'CAP_UNKNOWN_DEFAULT'
  | 'CAP_DRIVER_MISSING'
  | 'CAP_FORBIDDEN_IN_PRODUCTION'
  | 'CAP_CODEC_FAILED'
  | 'CAP_ENGINE_UNSUPPORTED';

const KIND = 'capability';

/** A store name nothing declared. Lists what *was* declared, in declaration order. */
export function unknownStore(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'CAP_UNKNOWN_STORE',
    `unknown cache store "${name}" (declared: ${known.length === 0 ? 'none' : known.join(', ')})`,
    {
      kind: KIND,
      hint: 'declare it under `cache.stores` in tsir.js — an undeclared name never falls back to the default',
      context: { store: name },
    },
  );
}

/** A driver that lacks an operation or capability the caller required. */
export function unsupportedOperation(
  store: string,
  driver: string,
  operation: string,
  detail?: string,
): TsirError {
  return new TsirError(
    'CAP_UNSUPPORTED_OPERATION',
    `store "${store}" (driver "${driver}") does not support ${operation}${detail === undefined ? '' : ` — ${detail}`}`,
    {
      kind: KIND,
      hint: 'move that key to a store whose driver supports it, or drop the `requires` block that names it',
      context: { store, driver, operation },
    },
  );
}

export function noStores(): TsirError {
  return new TsirError('CAP_NO_STORES', 'no cache stores declared', {
    kind: KIND,
    hint: 'declare at least one store under `cache.stores` in tsir.js',
  });
}

export function unknownDefault(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'CAP_UNKNOWN_DEFAULT',
    `cache.default is "${name}", which is not a declared store (declared: ${known.join(', ')})`,
    {
      kind: KIND,
      hint: 'there is no "first key wins": name one of the declared stores',
      context: { store: name },
    },
  );
}

export function driverMissing(store: string, driver: string, packageName: string): TsirError {
  return new TsirError(
    'CAP_DRIVER_MISSING',
    `store "${store}" names driver "${driver}", which is not registered`,
    {
      kind: KIND,
      hint: `install ${packageName} and import it, or pick a driver this target ships`,
      context: { store, driver },
    },
  );
}

/** `memory`/`null` are refused where they would be a lie about durability. */
export function forbiddenInProduction(store: string, driver: string, reason: string): TsirError {
  return new TsirError(
    'CAP_FORBIDDEN_IN_PRODUCTION',
    `store "${store}" uses driver "${driver}" in production: ${reason}`,
    {
      kind: KIND,
      hint: 'point the store at a durable driver, or leave it out of what production resolves',
      context: { store, driver },
    },
  );
}

/**
 * An app-supplied client missing the commands a driver needs (ADR-0027 § 1).
 *
 * Reported at **open** time, because the whole cost of not bundling a client is that the
 * contract has to be checked somewhere — and "at startup" is the only cheap place.
 */
export function clientContract(
  store: string,
  driver: string,
  missing: readonly string[],
): TsirError {
  return new TsirError(
    'CAP_DRIVER_MISSING',
    `store "${store}": the "${driver}" client is missing ${missing.join(', ')}`,
    {
      kind: KIND,
      hint: 'pass a real client (`new Redis(...)`, a pooled wrapper, or a test double) — the driver only needs these commands',
      context: { store, driver, missing: missing.length },
    },
  );
}

export function codecFailed(store: string, key: string, detail: string): TsirError {
  return new TsirError(
    'CAP_CODEC_FAILED',
    `store "${store}" could not encode key "${key}": ${detail}`,
    {
      kind: KIND,
      hint: 'a stored value is only readable by the codec that wrote it — pin the codec per key prefix',
      context: { store, key },
    },
  );
}

/**
 * The connection's engine cannot run the statements this driver emits (`CAP-009`).
 *
 * Refused at **construction**, not on the first write. The cache's upsert is
 * `ON CONFLICT … DO UPDATE … RETURNING`, which SQLite and Postgres have and MySQL does not — its
 * `ON DUPLICATE KEY UPDATE` cannot carry the `WHERE` that makes the acquire conditional. A type
 * that excluded `mysql` would only move the failure to whoever typed the config, and the caller
 * here holds a `Database` whose engine is a runtime value; a coded refusal at boot is the place
 * the mistake is cheap.
 */
export function engineUnsupported(
  store: string,
  engine: string,
  supported: readonly string[],
): TsirError {
  return new TsirError(
    'CAP_ENGINE_UNSUPPORTED',
    `cache store "${store}" cannot use a "${engine}" connection: its upsert is \
\`ON CONFLICT … RETURNING\`, which that engine does not speak`,
    {
      kind: KIND,
      hint: `use a connection on one of: ${supported.join(', ')} — \`tsir cache:table\` prints the DDL for each`,
      context: { store, engine },
    },
  );
}
