/**
 * The `database` session store — D1 and Postgres through one port.
 *
 * The port is `{ capabilities: { engine, placeholder }, query }`, which `@tsir/database`'s
 * `Database` satisfies **structurally**. That is the same trick `@tsir/cache/database` and
 * `@tsir/notify`'s inbox use, and it is why this package gains no dependency on the database
 * package: one driver serves both engines, and the placeholder style is read from the backend's own
 * declaration instead of guessed.
 *
 * `id` is the primary key and it is `sha256(token)`, so the table cannot be turned back into a set of
 * usable sessions. There is no column that holds a token, and that is the point.
 */

import type { SessionRecord, SessionStore } from '../session.ts';

export interface SessionSqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface SessionSqlResult {
  readonly rows: readonly unknown[];
  readonly changes: number;
}

export interface SessionSql {
  readonly capabilities: {
    /**
     * Any SQL engine. These channels branch on `placeholder`, never on the engine name, so
     * narrowing to `d1 | postgres` would reject a `mysql` or `sqlite` connection that works
     * (`CAP-009`). `@tsir/migrate` keeps the narrow pair: its state table really does have two
     * dialects.
     */
    readonly engine: 'd1' | 'postgres' | 'mysql' | 'sqlite';
    readonly placeholder: 'question' | 'dollar';
  };
  query(statement: SessionSqlStatement): Promise<SessionSqlResult>;
}

export interface DatabaseSessionStoreOptions {
  /** Default `tsir_sessions`. */
  readonly table?: string | undefined;
}

/**
 * The DDL, as statements a migration can carry — printed by `tsir auth:schema`.
 *
 * `subject` and `expires_at` are indexed together because the two queries a session table actually
 * serves are "this subject's sessions" (log out everywhere) and "drop the expired ones".
 */
export function sessionTableDdl(options: {
  readonly engine: SessionSql['capabilities']['engine'];
  readonly table?: string | undefined;
}): readonly string[] {
  const table = options.table ?? 'tsir_sessions';
  const bigint = options.engine === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (\n` +
      ' id TEXT PRIMARY KEY,\n' +
      ' subject TEXT NOT NULL,\n' +
      ' data TEXT,\n' +
      ` created_at ${bigint} NOT NULL,\n` +
      ` last_seen_at ${bigint} NOT NULL,\n` +
      ` expires_at ${bigint} NOT NULL,\n` +
      ` revoked_at ${bigint},\n` +
      ' user_agent TEXT,\n' +
      ' ip TEXT\n' +
      ')',
    `CREATE INDEX IF NOT EXISTS ${table}_subject ON ${table} (subject)`,
    `CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table} (expires_at)`,
  ];
}

export function databaseSessionStore(
  sql: SessionSql,
  options: DatabaseSessionStoreOptions = {},
): SessionStore {
  const table = options.table ?? 'tsir_sessions';
  const question = sql.capabilities.placeholder === 'question';

  /**
   * `?` for D1/SQLite, `$1`, `$2`, … for Postgres — starting at `start + 1`.
   *
   * The offset is not decoration. A statement with placeholders before the one being built —
   * `UPDATE t SET a = $1 WHERE id = $2` — needs the second to be `$2`. Passing `0` twice emitted
   * `SET a = $1 WHERE id = $1`, which Postgres reads as one parameter compared to itself: the update
   * matched no rows and the caller saw "nothing changed" instead of an error.
   */
  const placeholders = (count: number, start = 0): string =>
    Array.from({ length: count }, (_unused, index) =>
      question ? '?' : `$${String(start + index + 1)}`,
    ).join(', ');

  return {
    async put(record) {
      await sql.query({
        sql:
          `INSERT INTO ${table} (id, subject, data, created_at, last_seen_at, expires_at, revoked_at, user_agent, ip) ` +
          `VALUES (${placeholders(9)})`,
        params: [
          record.id,
          record.subject,
          record.data === null || record.data === undefined ? null : JSON.stringify(record.data),
          record.createdAt,
          record.lastSeenAt,
          record.expiresAt,
          record.revokedAt ?? null,
          record.userAgent ?? null,
          record.ip ?? null,
        ],
      });
    },

    async get(id) {
      const result = await sql.query({
        sql:
          `SELECT id, subject, data, created_at, last_seen_at, expires_at, revoked_at, user_agent, ip ` +
          `FROM ${table} WHERE id = ${placeholders(1)}`,
        params: [id],
      });
      const row = result.rows[0];
      return row === undefined ? undefined : readRow(row);
    },

    async delete(id) {
      await sql.query({ sql: `DELETE FROM ${table} WHERE id = ${placeholders(1)}`, params: [id] });
    },

    async deleteSubject(subject) {
      const result = await sql.query({
        sql: `DELETE FROM ${table} WHERE subject = ${placeholders(1)}`,
        params: [subject],
      });
      return result.changes;
    },

    async touch(id, lastSeenAt) {
      await sql.query({
        sql: `UPDATE ${table} SET last_seen_at = ${placeholders(1)} WHERE id = ${placeholders(1, 1)}`,
        params: [lastSeenAt, id],
      });
    },
  };
}

function readRow(value: unknown): SessionRecord {
  const row = (value ?? {}) as Record<string, unknown>;
  const data = row['data'];
  const revokedAt = numberOrUndefined(row['revoked_at']);
  const userAgent = row['user_agent'];
  const ip = row['ip'];

  return {
    id: asText(row['id']),
    subject: asText(row['subject']),
    data: typeof data === 'string' && data !== '' ? (JSON.parse(data) as unknown) : null,
    createdAt: numberOrZero(row['created_at']),
    lastSeenAt: numberOrZero(row['last_seen_at']),
    expiresAt: numberOrZero(row['expires_at']),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
    ...(typeof ip === 'string' ? { ip } : {}),
  };
}

function numberOrZero(value: unknown): number {
  return numberOrUndefined(value) ?? 0;
}

/**
 * A text column, read from a driver that may hand back anything.
 *
 * `String(row['id'] ?? '')` would turn an unexpected object into `[object Object]` and then into a
 * row key, which is a bug that looks like a successful read. Anything that is not text is empty.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') {
    // coercion-ok: a BIGINT millisecond timestamp, far inside 2^53.
    return Number(value);
  }
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    // coercion-ok: Postgres clients return BIGINT as a string; the regex admits only digits.
    return Number(value);
  }
  return undefined;
}
