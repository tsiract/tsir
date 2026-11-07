/**
 * SQL-backed search engines.
 *
 * Both drivers expect the caller to manage the FTS table. The engine provides
 * `createTableSql` so migrations can set it up, and a `query` function to run
 * statements — keeping the driver ORM-agnostic.
 */
import type { SearchEngine } from './scout.ts';

type QueryFn = (
  sql: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/**
 * SQLite FTS5 engine.
 *
 * Table shape (virtual):
 *   CREATE VIRTUAL TABLE search_index USING fts5(id, content);
 */
export function sqliteEngine(query: QueryFn): SearchEngine {
  return {
    async index(doc) {
      const content = Object.values(doc.fields).join(' ');
      await query('INSERT INTO search_index (id, content) VALUES (?, ?)', [doc.id, content]);
    },
    async remove(id) {
      await query('DELETE FROM search_index WHERE id = ?', [id]);
    },
    async search(q, limit = 20) {
      const rows = await query(
        'SELECT id, bm25(search_index) AS score FROM search_index WHERE search_index MATCH ? ORDER BY score LIMIT ?',
        [q, limit],
      );
      return rows.map((row) => ({
        id: String(row.id),
        // coercion-ok: `bm25()` returns a REAL ranking score from SQLite FTS5; it is never user-typed but always numeric.
        score: Number(row.score) || 0,
      }));
    },
  };
}

/**
 * Postgres tsvector engine.
 *
 * Table shape:
 *   CREATE TABLE search_index (
 *     id TEXT PRIMARY KEY,
 *     content TEXT NOT NULL,
 *     tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
 *   );
 *   CREATE INDEX search_index_tsv_idx ON search_index USING gin(tsv);
 */
export function postgresEngine(query: QueryFn): SearchEngine {
  return {
    async index(doc) {
      const content = Object.values(doc.fields).join(' ');
      await query(
        'INSERT INTO search_index (id, content) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content',
        [doc.id, content],
      );
    },
    async remove(id) {
      await query('DELETE FROM search_index WHERE id = $1', [id]);
    },
    async search(q, limit = 20) {
      const rows = await query(
        `SELECT id, ts_rank(tsv, plainto_tsquery('english', $1)) AS score
         FROM search_index
         WHERE tsv @@ plainto_tsquery('english', $1)
         ORDER BY score DESC
         LIMIT $2`,
        [q, limit],
      );
      return rows.map((row) => ({
        id: String(row.id),
        // coercion-ok: `ts_rank()` returns a double precision ranking score from Postgres.
        score: Number(row.score) || 0,
      }));
    },
  };
}
