/**
 * The `database` channel (`§ 4.4`) — the in-app inbox.
 *
 * An inbox row is the one notification a user can always find again, so this channel is the
 * default one alongside `mail`: it costs nothing, it is transactional with the business row that
 * caused it, and it is the only channel that survives a mail provider having a bad day.
 *
 * Three decisions are in this file rather than in a doc:
 *
 *   · **The row id is the delivery id.** A retried job therefore *cannot* duplicate an inbox row:
 *     the insert is `ON CONFLICT DO NOTHING` (`INSERT OR IGNORE` on D1) against the same key. This
 *     is what "the queue is transactional" has to mean for a channel that writes a row.
 *   · **The body is plain text.** An inbox that renders HTML from notification data is a stored
 *     XSS with a database in front of it. `html` is refused by the capability check before a
 *     payload gets this far.
 *   · **SQL is engine-aware, the store is not.** The port is `{ query }`, which `@tsir/database`'s
 *     `Database` satisfies structurally — the same trick `@tsir/cache/database` uses — so one
 *     implementation serves D1 and Postgres and this package gains no dependency.
 */

import { deliveryFailed, engineUnsupported, invalidPayload, notifiableMissing } from '../errors.ts';
import type { Channel } from '../channel.ts';
import type { InboxLevel, InboxPayload } from '../payloads.ts';

export interface InboxSqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface InboxSqlResult {
  readonly rows: readonly unknown[];
  readonly changes: number;
}

/** The slice of `@tsir/database` this channel needs. `Database` satisfies it structurally. */
export interface InboxSql {
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
  query(statement: InboxSqlStatement): Promise<InboxSqlResult>;
}

/** One row of `notification_inbox`, as it is written. */
export interface InboxRow {
  readonly id: string;
  readonly notification: string;
  readonly notifiableId: string;
  readonly title: string;
  readonly body: string | null;
  readonly url: string | null;
  readonly level: InboxLevel;
  readonly data: string | null;
  readonly createdAt: number;
}

/** What an application reads back: the table, plus one convenience query. */
export interface InboxStore {
  insert(row: InboxRow): Promise<void>;
  /** The newest rows for one recipient — what a screen shows. */
  list(notifiableId: string, limit?: number): Promise<readonly InboxRow[]>;
  /** How many are unread — a badge. */
  unread(notifiableId: string): Promise<number>;
}

export interface InboxStoreOptions {
  /** Default `notification_inbox`. */
  readonly table?: string | undefined;
}

/**
 * The DDL, as statements a migration can carry — printed by `tsir notify:schema`, run by a test
 * setup. Written out rather than generated, because a migration that says what it does is
 * reviewable.
 */
export function inboxTableDdl(options: {
  readonly engine: InboxSql['capabilities']['engine'];
  readonly table?: string | undefined;
}): readonly string[] {
  const table = options.table ?? 'notification_inbox';
  const bigint = options.engine === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (\n` +
      '  id TEXT PRIMARY KEY,\n' +
      '  notification TEXT NOT NULL,\n' +
      '  notifiable_id TEXT NOT NULL,\n' +
      '  title TEXT NOT NULL,\n' +
      '  body TEXT,\n' +
      '  url TEXT,\n' +
      `  level TEXT NOT NULL DEFAULT 'info',\n` +
      '  data TEXT,\n' +
      `  read_at ${bigint},\n` +
      `  created_at ${bigint} NOT NULL\n` +
      ')',
    // The only query a badge makes: unread rows for one recipient, newest first.
    `CREATE INDEX IF NOT EXISTS ${table}_inbox ON ${table} (notifiable_id, created_at)`,
  ];
}

export function createInboxStore(sql: InboxSql, options: InboxStoreOptions = {}): InboxStore {
  const table = options.table ?? 'notification_inbox';
  const engine = sql.capabilities.engine;

  // At construction. `mysql` reaches this with a working connection, so the refusal is about the
  // statement, and it belongs before the first delivery rather than after one was dropped.
  if (engine !== 'd1' && engine !== 'postgres' && engine !== 'sqlite') {
    throw engineUnsupported(engine);
  }

  /** `?` on D1, `$1` on Postgres — resolved once, from the backend's own declaration. */
  const placeholders = (count: number): string => {
    if (sql.capabilities.placeholder === 'question') {
      return Array.from({ length: count }, () => '?').join(', ');
    }
    return Array.from({ length: count }, (_unused, index) => `$${String(index + 1)}`).join(', ');
  };

  return {
    async insert(row) {
      // Same primary key every retry, and the conflict is ignored: this is what makes a retried
      // delivery a no-op instead of a second copy of the same notification in somebody's inbox.
      const columns =
        '(id, notification, notifiable_id, title, body, url, level, data, read_at, created_at)';
      const values = `VALUES (${placeholders(10)})`;
      const sqlText =
        engine === 'postgres'
          ? `INSERT INTO ${table} ${columns} ${values} ON CONFLICT (id) DO NOTHING`
          : `INSERT OR IGNORE INTO ${table} ${columns} ${values}`;

      await sql.query({
        sql: sqlText,
        params: [
          row.id,
          row.notification,
          row.notifiableId,
          row.title,
          row.body,
          row.url,
          row.level,
          row.data,
          null,
          row.createdAt,
        ],
      });
    },

    async list(notifiableId, limit = 20) {
      const result = await sql.query({
        sql:
          `SELECT id, notification, notifiable_id, title, body, url, level, data, created_at ` +
          `FROM ${table} WHERE notifiable_id = ${placeholders(1)} ` +
          `ORDER BY created_at DESC LIMIT ${String(limit)}`,
        params: [notifiableId],
      });
      return result.rows.map(readRow);
    },

    async unread(notifiableId) {
      const result = await sql.query({
        sql:
          `SELECT COUNT(*) AS unread FROM ${table} ` +
          `WHERE notifiable_id = ${placeholders(1)} AND read_at IS NULL`,
        params: [notifiableId],
      });
      const row = result.rows[0] as { readonly unread?: unknown } | undefined;
      return countOf(row?.unread);
    },
  };
}

function readRow(value: unknown): InboxRow {
  const row = (value ?? {}) as Record<string, unknown>;
  return {
    id: text(row['id']),
    notification: text(row['notification']),
    notifiableId: text(row['notifiable_id']),
    title: text(row['title']),
    body: nullableText(row['body']),
    url: nullableText(row['url']),
    level: levelOf(row['level']),
    data: nullableText(row['data']),
    createdAt: countOf(row['created_at']),
  };
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function levelOf(value: unknown): InboxLevel {
  return value === 'success' || value === 'warning' || value === 'error' ? value : 'info';
}

function countOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') {
    // coercion-ok: COUNT(*) on a BIGINT column; the range is a badge, far inside 2^53.
    return Number(value);
  }
  if (typeof value === 'string') {
    // coercion-ok: several Postgres clients return COUNT(*) as a string.
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface DatabaseChannelOptions {
  /** Default `database`. */
  readonly name?: string | undefined;
  readonly store: InboxStore;
  readonly now?: (() => number) | undefined;
}

export function databaseChannel(options: DatabaseChannelOptions): Channel {
  const name = options.name ?? 'database';
  const now = options.now ?? ((): number => Date.now());

  return {
    name,
    driver: 'database',
    // An inbox row reaches the person the next time they open the app: it delivers, and it carries
    // plain text only.
    capabilities: { delivers: true, html: false, attachments: false },
    check(payload) {
      parse(payload, name);
    },
    async send(delivery) {
      const payload = parse(delivery.payload, name);
      const id = delivery.to.id;
      if (id === undefined || id === null || id === '') throw notifiableMissing(name, 'id');

      try {
        const row: InboxRow = {
          id: delivery.deliveryId,
          notification: delivery.notification,
          notifiableId: String(id),
          title: payload.title,
          body: payload.body ?? null,
          url: payload.url ?? null,
          level: payload.level ?? 'info',
          data: payload.data === undefined ? null : JSON.stringify(payload.data),
          createdAt: now(),
        };
        await options.store.insert(row);
        return { accepted: true, id: row.id, detail: `stored for notifiable ${row.notifiableId}` };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw deliveryFailed(delivery.notification, name, detail);
      }
    },
  };
}

export function parseInboxPayload(payload: unknown, channel = 'database'): InboxPayload {
  return parse(payload, channel);
}

function parse(payload: unknown, channel: string): InboxPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw invalidPayload(channel, 'the payload is not an object');
  }
  const record = payload as Partial<InboxPayload>;
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    throw invalidPayload(channel, '`title` must be a non-empty string');
  }
  if (record.body !== undefined && typeof record.body !== 'string') {
    throw invalidPayload(channel, '`body` must be a string');
  }
  if (record.url !== undefined && typeof record.url !== 'string') {
    throw invalidPayload(channel, '`url` must be a string');
  }
  if (
    record.level !== undefined &&
    !['info', 'success', 'warning', 'error'].includes(record.level)
  ) {
    throw invalidPayload(channel, '`level` must be one of info, success, warning, error');
  }
  if (record.data !== undefined && (typeof record.data !== 'object' || record.data === null)) {
    throw invalidPayload(channel, '`data` must be a JSON object');
  }
  return record as InboxPayload;
}
