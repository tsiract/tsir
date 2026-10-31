/**
 * The `database` API-key store, over the same structural SQL port as the sessions.
 *
 * `scopes` is stored as JSON text: a key's scopes are a short list read as a unit, and a join table
 * for four strings is a join on every request.
 */

import type { ApiKeyRecord, ApiKeyStore } from '../keys.ts';
import type { SessionSql } from './session-database.ts';

export function apiKeyTableDdl(options: {
  readonly engine: SessionSql['capabilities']['engine'];
  readonly table?: string | undefined;
}): readonly string[] {
  const table = options.table ?? 'tsir_api_keys';
  const bigint = options.engine === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (\n` +
      ' id TEXT PRIMARY KEY,\n' +
      ' subject TEXT NOT NULL,\n' +
      ' name TEXT NOT NULL,\n' +
      ' scopes TEXT,\n' +
      ' secret_hash TEXT NOT NULL,\n' +
      ` created_at ${bigint} NOT NULL,\n` +
      ` last_used_at ${bigint},\n` +
      ` expires_at ${bigint},\n` +
      ` revoked_at ${bigint}\n` +
      ')',
    `CREATE INDEX IF NOT EXISTS ${table}_subject ON ${table} (subject)`,
  ];
}

export function databaseApiKeyStore(
  sql: SessionSql,
  options: { readonly table?: string | undefined } = {},
): ApiKeyStore {
  const table = options.table ?? 'tsir_api_keys';
  const question = sql.capabilities.placeholder === 'question';
  const placeholders = (count: number): string =>
    Array.from({ length: count }, (_unused, index) =>
      question ? '?' : `$${String(index + 1)}`,
    ).join(', ');

  return {
    async put(record) {
      await sql.query({
        sql:
          `INSERT INTO ${table} (id, subject, name, scopes, secret_hash, created_at, last_used_at, expires_at, revoked_at) ` +
          `VALUES (${placeholders(9)})`,
        params: [
          record.id,
          record.subject,
          record.name,
          JSON.stringify(record.scopes),
          record.secretHash,
          record.createdAt,
          record.lastUsedAt ?? null,
          record.expiresAt ?? null,
          record.revokedAt ?? null,
        ],
      });
    },

    async get(id) {
      const result = await sql.query({
        sql:
          `SELECT id, subject, name, scopes, secret_hash, created_at, last_used_at, expires_at, revoked_at ` +
          `FROM ${table} WHERE id = ${placeholders(1)}`,
        params: [id],
      });
      const row = result.rows[0];
      return row === undefined ? undefined : readRow(row);
    },

    async list(subject) {
      const result = await sql.query({
        sql:
          `SELECT id, subject, name, scopes, secret_hash, created_at, last_used_at, expires_at, revoked_at ` +
          `FROM ${table} WHERE subject = ${placeholders(1)} ORDER BY created_at DESC`,
        params: [subject],
      });
      return result.rows.map(readRow);
    },

    async revoke(id, at) {
      const result = await sql.query({
        sql: `UPDATE ${table} SET revoked_at = ${placeholders(1)} WHERE id = ${placeholders(1)} AND revoked_at IS NULL`,
        params: [at, id],
      });
      return result.changes > 0;
    },

    async touch(id, at) {
      await sql.query({
        sql: `UPDATE ${table} SET last_used_at = ${placeholders(1)} WHERE id = ${placeholders(1)}`,
        params: [at, id],
      });
    },
  };
}

function readRow(value: unknown): ApiKeyRecord {
  const row = (value ?? {}) as Record<string, unknown>;
  const scopes = row['scopes'];
  const lastUsed = numberOrUndefined(row['last_used_at']);
  const expires = numberOrUndefined(row['expires_at']);
  const revoked = numberOrUndefined(row['revoked_at']);

  return {
    id: asText(row['id']),
    subject: asText(row['subject']),
    name: asText(row['name']),
    scopes: typeof scopes === 'string' && scopes !== '' ? (JSON.parse(scopes) as string[]) : [],
    secretHash: asText(row['secret_hash']),
    createdAt: numberOrUndefined(row['created_at']) ?? 0,
    ...(lastUsed === undefined ? {} : { lastUsedAt: lastUsed }),
    ...(expires === undefined ? {} : { expiresAt: expires }),
    ...(revoked === undefined ? {} : { revokedAt: revoked }),
  };
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
