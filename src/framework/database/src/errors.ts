/**
 * Database error codes.
 *
 * Every failure here is a *programming or configuration* error, detected at boot
 * or at the first call — never a data error a request could recover from. That is
 * why they are separate from the HTTP problem codes: one is fixed by a developer,
 * the other by a client.
 */

import { TsirError } from '@tsir/core';

export type DatabaseErrorCode =
  | 'DB_DRIVER_UNAVAILABLE'
  | 'DB_TX_INTERACTIVE_UNSUPPORTED'
  | 'DB_REQUIRES_INTERACTIVE_TX'
  | 'DB_BATCH_EMPTY'
  | 'DB_CLOSED'
  | 'DB_HEALTH_FAILED'
  | 'DB_CAPABILITY_MISMATCH'
  | 'DB_TX_DEPTH_EXCEEDED'
  | 'DB_TX_OPTION_UNSUPPORTED'
  | 'DB_CODEC_INVALID_COLUMN'
  | 'DB_CODEC_INVALID_NAME'
  | 'DB_CODEC_DUPLICATE_COLUMN'
  | 'DB_CODEC_UNDEFINED_VALUE'
  | 'DB_CONNECTION_PIN_UNSUPPORTED'
  | 'DB_UNKNOWN_CONNECTION'
  | 'DB_NO_CONNECTIONS'
  | 'DB_UNKNOWN_DEFAULT'
  | 'DB_REQUIRES_TX_CONNECTION'
  | 'DB_RAW_UNSUPPORTED'
  | 'DB_BATCH_UNSUPPORTED'
  | 'DB_ROTATION_TARGET_MISMATCH'
  | 'DB_ROTATION_INVALID_IDENTIFIER'
  | 'DB_D1_NO_BINDING'
  | 'DB_POSTGRES_BOOTSTRAP_UNWIRED'
  | 'DB_TX_STATEMENT_UNSUPPORTED'
  | 'DB_URL_REQUIRED'
  | 'DB_SQLITE_NO_HANDLE'
  | 'DB_POSTGRES_HTTP_FAILED'
  | 'DB_MYSQL_HTTP_FAILED'
  | 'DB_TX_NESTED_UNSUPPORTED';

/**
 * The configured engine cannot run on this target.
 *
 * The message names the target as well as the engine: "D1 requires a Workers
 * binding" is actionable, "database unavailable" is not.
 */
export function driverUnavailable(engine: string, target: string, reason: string): TsirError {
  return new TsirError(
    'DB_DRIVER_UNAVAILABLE',
    `database driver "${engine}" is not available on target "${target}": ${reason}`,
    {
      kind: 'database',
      hint:
        engine === 'd1'
          ? 'D1 is a Cloudflare binding: deploy to Workers or set database.driver to "postgres"'
          : 'set database.driver to an engine this target can reach',
      context: { engine, target },
    },
  );
}

/** `transaction()` was called on a driver that has no interactive transactions. */
export function interactiveTxUnsupported(engine: string): TsirError {
  return new TsirError(
    'DB_TX_INTERACTIVE_UNSUPPORTED',
    `driver "${engine}" does not support interactive transactions`,
    {
      kind: 'database',
      hint:
        engine === 'postgres'
          ? 'the Postgres client was created without begin(); pass a client built by postgres.js (`postgres(url)`)'
          : 'D1 rejects BEGIN/COMMIT/SAVEPOINT. Use batch([...]) for atomic multi-statement writes, ' +
            'or optimistic concurrency (WHERE version = ?) for read-modify-write.',
      context: { engine },
    },
  );
}

/** A component declared `requires.interactiveTx` and the chosen driver cannot honour it. */
export function requiresInteractiveTx(component: string, engine: string): TsirError {
  return new TsirError(
    'DB_REQUIRES_INTERACTIVE_TX',
    `"${component}" requires interactive transactions, but driver "${engine}" has none`,
    {
      kind: 'database',
      hint: 'choose database.driver "postgres" for this unit, or rewrite the component to use batch([...])',
      context: { component, engine },
    },
  );
}

/**
 * Several components declared `requires.interactiveTx` on one driver.
 *
 * The single-component form above is for a direct `declare()` call; this one is
 * for the boot check, which reports all of them: fixing one component per
 * restart is a slow way to learn the list.
 */
export function requirementsMissing(components: readonly string[], engine: string): TsirError {
  const componentList = components.join(', ');
  return new TsirError(
    'DB_REQUIRES_INTERACTIVE_TX',
    `${components.length} component(s) require interactive transactions, but driver "${engine}" has none: ${componentList}`,
    {
      kind: 'database',
      hint: 'choose database.driver "postgres" for this unit, or rewrite these components to use batch([...])',
      context: { components: componentList, engine },
    },
  );
}

/**
 * A driver's declared capability and its implementation disagree.
 *
 * Caught at `createDatabase`, i.e. before the first query: the alternative is a
 * capability the framework believes and the driver cannot keep.
 */
export function capabilityLie(engine: string, declared: boolean, implemented: boolean): TsirError {
  return new TsirError(
    'DB_CAPABILITY_MISMATCH',
    `driver "${engine}" declares interactiveTx: ${String(declared)} but ${
      implemented ? 'implements' : 'does not implement'
    } begin()`,
    {
      kind: 'database',
      hint: 'a driver must implement begin() exactly when it declares interactiveTx',
      context: { engine, declared, implemented },
    },
  );
}

/**
 * `connection()` on a driver that cannot pin one (`DB-018`).
 *
 * The alternative — running the work on whatever connection the pool hands out —
 * is exactly the bug this API exists to prevent: an advisory lock taken on one
 * connection and honoured on none.
 */
export function pinnedConnectionUnsupported(engine: string): TsirError {
  return new TsirError(
    'DB_CONNECTION_PIN_UNSUPPORTED',
    `driver "${engine}" cannot pin a connection`,
    {
      kind: 'database',
      hint:
        engine === 'postgres'
          ? "the Postgres client has no reserve(); pass a client built by postgres.js or Bun's SQL"
          : 'D1 has no per-session state to pin: the binding is one connection to one database',
      context: { engine },
    },
  );
}

/**
 * A driver whose `pinnedConnection` flag and `reserve()` disagree.
 *
 * Same rule as `interactiveTx`/`begin()`: claiming the capability without the
 * method turns a boot-time fact into a migration that believed it was locked.
 */
export function pinnedConnectionLie(
  engine: string,
  declared: boolean,
  implemented: boolean,
): TsirError {
  return new TsirError(
    'DB_CAPABILITY_MISMATCH',
    `driver "${engine}" declares pinnedConnection: ${String(declared)} but ${
      implemented ? 'implements' : 'does not implement'
    } reserve()`,
    {
      kind: 'database',
      hint: 'a driver must implement reserve() exactly when it declares pinnedConnection',
      context: { engine, declared, implemented },
    },
  );
}

/** A transaction option the engine cannot honour, e.g. `readOnly` off Postgres. */
export function unsupportedTransactionOption(option: string, engine: string): TsirError {
  return new TsirError(
    'DB_TX_OPTION_UNSUPPORTED',
    `transaction option "${option}" is not supported on driver "${engine}"`,
    {
      kind: 'database',
      hint: 'readOnly maps to Postgres SET TRANSACTION READ ONLY; remove it or switch database.driver to "postgres"',
      context: { option, engine },
    },
  );
}

/** Nested transactions stopped making sense (`DB-013` caps savepoint depth). */
export function transactionDepthExceeded(limit: number): TsirError {
  return new TsirError(
    'DB_TX_DEPTH_EXCEEDED',
    `transactions are nested more than ${String(limit)} deep`,
    {
      kind: 'database',
      hint: 'deep nesting means the work belongs in one transaction, not many; flatten it or split the unit',
      context: { limit },
    },
  );
}

/** `batch([])` — an empty transaction is a bug in the caller, not a no-op. */
export function emptyBatch(): TsirError {
  return new TsirError('DB_BATCH_EMPTY', 'batch() was called with no statements', {
    kind: 'database',
    hint: 'an empty batch is almost always a conditional that produced nothing; guard it at the call site',
  });
}

/** A query ran after `close()` — usually a shutdown-ordering bug. */
export function databaseClosed(): TsirError {
  return new TsirError('DB_CLOSED', 'the database has been closed', {
    kind: 'database',
    hint: 'queries must finish before shutdown; dispose the database after in-flight work drains',
  });
}

/**
 * `db.connection(name)` named a connection that was never declared (ADR-0019).
 *
 * The message lists what *does* exist, because the failure is almost always a
 * typo or a `tsir.js` edited without a rebuild — and both are fixed by looking at
 * the names, not by reading the stack.
 */
export function unknownConnection(name: string, declared: readonly string[]): TsirError {
  return new TsirError(
    'DB_UNKNOWN_CONNECTION',
    `database connection "${name}" is not declared (declared: ${declared.join(', ') || 'none'})`,
    {
      kind: 'database',
      hint:
        declared.length === 0
          ? 'declare it under database.connections in tsir.js, then rebuild so the name enters the type'
          : `use one of: ${declared.join(', ')} — or add "${name}" to database.connections and rebuild`,
      context: { connection: name, declared: declared.join(', ') },
    },
  );
}

/** A registry was created with no connections at all. */
export function noConnections(): TsirError {
  return new TsirError('DB_NO_CONNECTIONS', 'database registry has no connections', {
    kind: 'database',
    hint: 'declare at least one entry under database.connections; one entry is the single-connection case',
    context: {},
  });
}

/** `database.default` names a connection that does not exist (ADR-0019). */
export function unknownDefaultConnection(name: string, declared: readonly string[]): TsirError {
  return new TsirError(
    'DB_UNKNOWN_DEFAULT',
    `database.default is "${name}", which is not a declared connection (declared: ${declared.join(', ')})`,
    {
      kind: 'database',
      hint: 'set database.default to one of the declared names — there is no "first key wins"',
      context: { default: name, declared: declared.join(', ') },
    },
  );
}

/**
 * Several components declared `requires.interactiveTx` on a named connection that
 * cannot honour it (ADR-0019 § 4).
 *
 * Every unsatisfied pair is reported at once, and each carries its own engine:
 * "ReportingExport needs a transaction on `reporting` (d1)" is fixed by moving
 * that component to the Postgres connection; "database driver has no transactions"
 * is not a sentence anyone can act on.
 */
export function connectionRequirementsMissing(
  unsatisfied: readonly {
    readonly component: string;
    readonly connection: string;
    readonly engine: string;
  }[],
): TsirError {
  const detail = unsatisfied
    .map(
      (entry) =>
        `${entry.component} needs interactiveTx on "${entry.connection}" (${entry.engine})`,
    )
    .join('; ');
  const engines = new Set(unsatisfied.map((entry) => entry.engine));
  return new TsirError(
    'DB_REQUIRES_TX_CONNECTION',
    `${unsatisfied.length} component(s) require interactive transactions on a connection that has none: ${detail}`,
    {
      kind: 'database',
      hint: engines.has('d1')
        ? 'point those components at a Postgres connection, or rewrite them to use batch([...]) — D1 rejects BEGIN'
        : 'the client for that connection was created without begin(); pass a client that supports transactions',
      context: {
        connections: unsatisfied.map((entry) => entry.connection).join(', '),
        components: unsatisfied.map((entry) => entry.component).join(', '),
      },
    },
  );
}

/**
 * A statement failed at the provider (`DB-028`, `DB-029`).
 *
 * The message carries what the provider said, because that is the part an operator can act on — a
 * missing table, a bad key, a paused database. The *code* is Tsir's, so a caller can branch on
 * "the database rejected this" without parsing a vendor's prose.
 */
export function providerRejected(engine: 'postgres' | 'mysql', detail: string): TsirError {
  return new TsirError(
    engine === 'postgres' ? 'DB_POSTGRES_HTTP_FAILED' : 'DB_MYSQL_HTTP_FAILED',
    `${engine}: ${detail}`,
    {
      kind: 'database',
      hint: 'the provider answered a statement with an error — check the table exists, the credentials are current, and the database is not paused',
      context: { engine },
    },
  );
}
