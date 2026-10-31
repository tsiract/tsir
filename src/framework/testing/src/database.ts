/**
 * `createTestDatabase` — per-suite isolation for Postgres tests (`DB-016`).
 *
 * A test suite that shares a schema with every other suite is a suite whose
 * failures depend on execution order. The fix is not "truncate between tests"
 * (that leaves sequences, triggers and constraints behind, and it cannot run two
 * suites at once); it is to give each suite a schema of its own and point
 * `search_path` at it, so the code under test cannot see anything else.
 *
 * ## Why a factory and not a client
 *
 * `search_path` is a **connection** setting. Handing this harness a pool that was
 * created without it would mean either mutating a session the caller owns (a
 * race with every other query on that pool) or prefixing every statement (which
 * breaks parameterised SQL and transactions). So the caller supplies a factory
 * that receives the schema name and returns a client whose connections already
 * point at it:
 *
 * ```ts
 * const db = await createTestDatabase({
 *   suite: 'users',
 *   connect: (schema) => postgres(url, { max: 2, connection: { search_path: schema } }),
 *   setup: (database) => migrate(database),
 * });
 * ```
 *
 * `connect` runs once per suite; `reset()` reuses that client, because dropping
 * and recreating a schema on the same connections is both faster and less
 * surprising than tearing down a pool between tests.
 *
 * ## What it refuses
 *
 * The harness `DROP SCHEMA … CASCADE`s whatever it is given, so it accepts only
 * identifier-shaped names and refuses the schemas Postgres itself owns
 * (`public`, `pg_catalog`, `information_schema`, `pg_toast`, and anything
 * starting with `pg_`). A typo there drops a development database, and a thrown
 * error is more reliable than a paragraph in a README.
 */

import { TsirError } from '@tsir/container';
import { createDatabase, statement, type Database, type QueryLogger } from '@tsir/database';
import { createPostgresDriver, type PgClientLike } from '@tsir/database/postgres';

export interface TestDatabaseOptions {
  /**
   * Creates a client whose connections have `search_path` set to `schema`.
   *
   * Called once per suite. The harness never rewrites SQL to inject the schema:
   * if the client is not pointed at it, the isolation is fiction.
   */
  readonly connect: (schema: string) => PgClientLike | Promise<PgClientLike>;
  /** Suite name folded into the generated schema name. Defaults to `suite`. */
  readonly suite?: string;
  /**
   * Name this database answers to (`DB-022`).
   *
   * A suite that needs two databases calls `createTestDatabase` twice — once per
   * connection — instead of building a registry for a test. The name is what keeps
   * the two apart in logs and in failure messages; the isolation is the schema.
   */
  readonly connection?: string;
  /** Overrides the generated name. Must be identifier-shaped; see the module doc. */
  readonly schema?: string;
  /** Runs after the schema exists and after every `reset()`. Migrations go here. */
  readonly setup?: (database: Database) => Promise<void>;
  /** Logging is `off` by default: a test suite that logs every statement is noise. */
  readonly logging?: 'off' | 'slow' | 'all';
  readonly log?: QueryLogger;
}

export interface TestDatabase {
  /** The database every query in the suite should use. */
  readonly database: Database;
  /** The connection name it was created under (`DB-022`); `'default'` if unnamed. */
  readonly connection: string;
  /** The schema it is isolated in — useful in failure messages. */
  readonly schema: string;
  /** Drops and recreates the schema, then re-runs `setup`. */
  reset(): Promise<void>;
  /** Convenience for assertion queries; returns rows only. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<readonly T[]>;
  /** Closes the database, then drops the schema. Idempotent. */
  close(): Promise<void>;
}

/** Postgres identifiers are `[A-Za-z_][A-Za-z0-9_$]*` and at most 63 bytes. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,49}$/;

/** Schemas the harness will not drop, whatever it is told. */
const PROTECTED = new Set(['public', 'pg_catalog', 'information_schema', 'pg_toast', 'pg_temp']);

/**
 * Builds a schema name that is unique across parallel suites but still readable
 * in a failure message: `tsir_test_users_a1b2c3d4`.
 */
export function testSchemaName(suite?: string): string {
  // Postgres counts *bytes*, not characters, and a suite name can be anything.
  const slug = (suite ?? 'suite')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 32);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  return `tsir_test_${slug === '' ? 'suite' : slug}_${suffix}`;
}

/** Refuses a schema name the harness must not `DROP … CASCADE`. */
export function assertSchemaName(schema: string): string {
  if (!IDENTIFIER.test(schema)) {
    throw new TsirError('TEST_SCHEMA_INVALID', `"${schema}" is not a usable schema name`, {
      kind: 'internal',
      hint: 'use lowercase letters, digits and underscores (max 50 characters)',
      context: { schema },
    });
  }
  if (PROTECTED.has(schema) || schema.startsWith('pg_')) {
    throw new TsirError('TEST_SCHEMA_INVALID', `refusing to use protected schema "${schema}"`, {
      kind: 'internal',
      hint: 'createTestDatabase drops the schema it is given; pick a dedicated name',
      context: { schema },
    });
  }
  return schema;
}

export async function createTestDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
  const schema = assertSchemaName(options.schema ?? testSchemaName(options.suite));
  let client = await options.connect(schema);

  const connection = options.connection ?? 'default';

  const open = (): Database =>
    createDatabase({
      driver: createPostgresDriver({ client }),
      name: connection,
      logging: options.logging ?? 'off',
      ...(options.log === undefined ? {} : { log: options.log }),
    });

  /**
   * Schema DDL runs on the suite's own client: it is already authorised, and the
   * name is quoted, so a schema called `order` cannot break the statement.
   */
  const create = async (): Promise<void> => {
    await client.unsafe(`create schema if not exists "${schema}"`);
  };

  const drop = async (): Promise<void> => {
    await client.unsafe(`drop schema if exists "${schema}" cascade`);
  };

  await create();
  let database = open();
  if (options.setup !== undefined) await options.setup(database);

  let closed = false;

  return {
    get database(): Database {
      return database;
    },
    connection,
    schema,
    async reset(): Promise<void> {
      if (closed) {
        throw new TsirError('TEST_DATABASE_CLOSED', 'reset() after close()', {
          kind: 'internal',
          hint: 'create a new test database for the next suite',
        });
      }
      // Drop while the pool is still open: the connections are authorised, and a
      // schema cannot be dropped from a client that has already ended.
      await drop();
      await database.close();
      // Reconnecting is the point of the factory: a pool that `close()` ended is
      // not reusable, and pretending otherwise returns a database whose next
      // query fails with "connection closed".
      client = await options.connect(schema);
      await create();
      database = open();
      if (options.setup !== undefined) await options.setup(database);
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<readonly T[]> {
      const result = await database.query(statement(sql, params));
      return result.rows as readonly T[];
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await drop();
      await database.close();
    },
  };
}
