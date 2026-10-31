/**
 * Query logging with redaction (`DB-009`, `DB-010`).
 *
 * A query log is one of the easiest ways to leak everything you were protecting:
 * an email in a `WHERE`, a password hash in an `INSERT`, a session token in an
 * `UPDATE`. So the default is that **parameter values never appear**, at any log
 * level, in any environment. What appears is the statement shape plus the *types*
 * and count of its parameters — enough to debug "why is this query slow / what
 * did it run" without turning the log into a copy of the database.
 *
 * Three levels, matching `databaseConfigSchema`:
 *
 * | level  | what is logged                         |
 * | ------ | -------------------------------------- |
 * | `off`  | nothing                                |
 * | `slow` | statements at or above `slowQueryMs`   |
 * | `all`  | every statement                        |
 *
 * The event shape is flat and stable — the same rule as
 * A log line is data for a query language,
 * not a sentence for a human.
 */

export type QueryLogLevel = 'off' | 'slow' | 'all';

/** What a parameter was, never what it was. */
export type ParamType =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'date'
  | 'bytes'
  | 'array'
  | 'object'
  | 'function';

export interface QueryLogEvent {
  readonly event: 'db.query';
  /**
   * Which named connection ran it (ADR-0019 § 7).
   *
   * Without this field a slow-query log from a process holding three connections
   * is a list of durations with no way to tell which database to look at.
   */
  readonly connection: string;
  readonly level: QueryLogLevel;
  /** Statement text with string literals scrubbed and whitespace collapsed. */
  readonly sql: string;
  /** One entry per bound parameter: its type only. */
  readonly paramTypes: readonly ParamType[];
  readonly paramCount: number;
  readonly durationMs: number;
  readonly rows: number;
  readonly ok: boolean;
  /** Present only on failure; the message is the driver's, never a parameter. */
  readonly error?: string;
}

/**
 * Emitted when a transaction stays open past `3 × statementTimeoutMs`.
 *
 * Not an error: a transaction that is slow may be a batch job doing exactly what
 * it should. But it is the only warning before lock waits and timeouts cascade,
 * and it carries no SQL, so it cannot leak a value either.
 */
export interface TransactionLogEvent {
  readonly event: 'db.transaction.open';
  readonly connection: string;
  readonly level: QueryLogLevel;
  /** Nesting depth: 0 is the outermost transaction. */
  readonly depth: number;
  readonly readOnly: boolean;
  readonly warnAfterMs: number;
}

export type DatabaseLogEvent = QueryLogEvent | TransactionLogEvent;

export type QueryLogger = (event: DatabaseLogEvent) => void;

export function paramType(value: unknown): ParamType {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return 'date';
  if (value instanceof Uint8Array) return 'bytes';
  if (Array.isArray(value)) return 'array';
  // `symbol` and any remaining object (a plain object, a map, a class instance)
  // are both "not something you bind", so they share one bucket: the logger's
  // job is a coarse shape, not a type system.
  const type = typeof value;
  return type === 'string' ||
    type === 'number' ||
    type === 'bigint' ||
    type === 'boolean' ||
    type === 'function'
    ? type
    : 'object';
}

/**
 * Collapses whitespace and replaces quoted literals with `?`.
 *
 * Drizzle emits placeholders, so this is usually a no-op for generated SQL. It
 * matters for hand-written SQL (`where email = 'ada@example.com'`), which is
 * exactly where a literal sneaks into a log.
 *
 * Only **single-quoted** spans are scrubbed, because in SQL single quotes are
 * the string literal delimiter and double quotes are **identifiers**. Rewriting
 * `"users"."email"` to `?` does not make the log safer — there was never a value
 * in it — it makes the log useless: every Drizzle query on SQLite and Postgres
 * would read `select ?, ? from ?`. That is a redaction rule that hides the very
 * thing you opened the log for.
 *
 * The scrubber is deliberately conservative and does not try to parse SQL: a
 * logger that can be wrong about escaping is worse than one that over-redacts.
 * Dollar-quoted strings (`$$…$$`) are not rewritten — they are not valid in the
 * statements this framework generates, and a guess there would be worse than the
 * gap. Parameter values never reach the log at all (§ 2.3), so the gap costs
 * nothing.
 */
export function scrubSql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .trim();
}

export interface QueryLogOptions {
  readonly level: QueryLogLevel;
  readonly slowQueryMs: number;
  readonly log: QueryLogger;
}

/**
 * Decides whether an event is emitted and in what shape.
 *
 * Split out from the `Database` so the rule is testable without a driver: `slow`
 * is the only level with a threshold, and a *failed* statement is logged at every
 * level except `off` — an error that took 3 ms is still an error.
 */
export function shouldLog(
  level: QueryLogLevel,
  durationMs: number,
  slowQueryMs: number,
  ok: boolean,
): boolean {
  if (level === 'off') return false;
  if (!ok) return true;
  if (level === 'all') return true;
  return durationMs >= slowQueryMs;
}
