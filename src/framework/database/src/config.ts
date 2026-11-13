/**
 * Database configuration (`DB-003`).
 *
 * Validated at boot like every other Tsir config, so a typo in `driver` is a
 * startup error with a list of the values that exist — not a request that fails
 * hours later.
 *
 * Note what is *absent*: `url`, `pool`, `connectTimeoutMs` are not top-level
 * requirements. D1 has no URL (it is a binding) and no pool (it is single
 * threaded), so a config that demanded them would force every D1 application to
 * invent values for settings that do not exist on its engine.
 */

import { z } from '@tsir/validate';

/**
 * Every engine a connection may name (`CAP-009`).
 *
 * `d1` is the Cloudflare default; `postgres` the AWS one; `mysql` because it is the database most
 * teams arrive with; `sqlite` because it is the only one that needs no service at all. The order
 * is the order the error message lists them in, so it descends from "turnkey on a cloud" to
 * "needs nothing".
 */
export const DATABASE_ENGINES = ['d1', 'postgres', 'mysql', 'sqlite'] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

/**
 * One entry of `database.connections` (`DB-019`).
 *
 * The per-engine fields stay exactly as they were: a registry entry is a
 * single-connection config with a name in front of it, so nothing new has to be
 * learned to read it.
 */
export const connectionConfigSchema = z
  .object({
    /** Explicit always. Never sniffed from the environment (ADR-0016). */
    driver: z.enum(DATABASE_ENGINES).default('d1'),

    /** D1 only: the binding name injected by the Cloudflare runtime into `env`. */
    binding: z.string().min(1).optional(),

    /** Postgres only: the connection URL. */
    url: z.string().min(1).optional(),

    logging: z.enum(['off', 'slow', 'all']).default('slow'),
    slowQueryMs: z.number().int().positive().max(60_000).default(200),

    /** Engine statement cap. D1's own ceiling is 30 s. */
    statementTimeoutMs: z.number().int().positive().max(30_000).default(5_000),

    /** Postgres only. D1 ignores it, and saying so here beats ignoring it silently. */
    pool: z
      .object({
        max: z.number().int().positive().max(100).default(10),
        idleTimeoutMs: z.number().int().nonnegative().default(30_000),
        connectTimeoutMs: z.number().int().positive().default(10_000),
      })
      .optional(),

    /**
     * `mysql` only: the schema name.
     *
     * MySQL's HTTP gateways take the database separately from the endpoint, because the endpoint
     * is one URL per organization and not one per database. Postgres and SQLite carry it in the
     * url; this is the engine that has nowhere else to put it.
     */
    databaseName: z.string().min(1).optional(),

    /** Postgres only: appears in `pg_stat_activity`. */
    applicationName: z.string().min(1).max(63).optional(),
    searchPath: z.string().min(1).optional(),
  })
  .refine(
    (value) => value.driver !== 'd1' || value.pool === undefined,
    'database.connections.<name>.pool is a Postgres setting and has no effect on D1 — remove it or switch driver to "postgres"',
  )
  .refine(
    (value) => value.driver !== 'd1' || value.url === undefined,
    'database.connections.<name>.url is a setting for postgres, mysql and sqlite — a D1 connection is a `binding`; remove `url` or switch driver',
  )
  .refine(
    (value) =>
      value.driver === 'd1' ||
      value.driver === 'postgres' ||
      value.driver === 'mysql' ||
      value.driver === 'sqlite' ||
      value.url === undefined,
    'database.connections.<name>.url is for postgres, mysql and sqlite only',
  );

export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

/**
 * The registry (ADR-0019).
 *
 * Always a registry, even with one entry: a config that flattens to
 * `{ driver }` would change shape the day a second connection appears, and every
 * call site would have to be revisited at the same moment as a schema change.
 */
export const databaseConfigSchema = z
  .object({
    /** Required, and must name a declared entry — no "first key wins". */
    default: z.string().min(1),
    connections: z.record(z.string().min(1), connectionConfigSchema),
  })
  .refine(
    (value) => Object.keys(value.connections).length > 0,
    'database.connections needs at least one entry; one entry is the single-connection case',
  )
  .refine(
    (value) => Object.hasOwn(value.connections, value.default),
    'database.default names a connection that is not declared — set it to one of the keys of database.connections',
  );

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

/**
 * Settings that only make sense on Postgres.
 *
 * Used by `tsir doctor` and by the deploy planner, both of which should warn
 * about a config that is valid but inert.
 */
export function postgresOnlyKeys(connection: ConnectionConfig): readonly string[] {
  if (connection.driver !== 'd1') return [];
  return ['pool', 'applicationName', 'searchPath'].filter(
    (key) => (connection as Record<string, unknown>)[key] !== undefined,
  );
}

/** Connection names a validated config declares, `default` first. */
export function connectionNames(config: DatabaseConfig): readonly string[] {
  const declared = Object.keys(config.connections);
  return [config.default, ...declared.filter((name) => name !== config.default)];
}
