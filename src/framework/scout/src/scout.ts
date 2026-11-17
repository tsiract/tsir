/**
 * @tsir/scout — full-text search abstraction.
 *
 * A `SearchEngine` indexes documents (id + fields) and answers queries with
 * ranked results. Drivers:
 *   · `memoryEngine`  — in-process, for tests and small datasets.
 *   · `sqliteEngine`  — SQLite FTS5.
 *   · `postgresEngine` — Postgres `tsvector`/`tsquery`.
 *
 * The engine is ORM-agnostic: callers supply a `query` function for SQL
 * drivers.
 */

/**
 * The engines this build ships, by the name a `tsir.js` writes.
 *
 * Four are ours and three are hosted third parties (`hosted.ts`); one list, because a project
 * choosing a search engine should not have to know which file implements it.
 */
export const SEARCH_DRIVERS = [
  'memory',
  'sqlite',
  'postgres',
  'typesense',
  'meilisearch',
  'algolia',
] as const;

export type SearchDriverName = (typeof SEARCH_DRIVERS)[number];

export interface SearchDocument {
  id: string;
  fields: Record<string, string>;
}

export interface SearchResult {
  id: string;
  score: number;
}

export interface SearchEngine {
  index(doc: SearchDocument): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: string, limit?: number): Promise<SearchResult[]>;
}

/** Simple in-memory engine: tokenises, scores by term frequency. */
export function memoryEngine(): SearchEngine {
  const docs = new Map<string, SearchDocument>();

  function tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  return {
    async index(doc) {
      docs.set(doc.id, doc);
    },
    async remove(id) {
      docs.delete(id);
    },
    async search(query, limit = 20) {
      const terms = tokenize(query);
      if (terms.length === 0) return [];

      const results: SearchResult[] = [];
      for (const doc of docs.values()) {
        const text = Object.values(doc.fields).join(' ').toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (text.includes(term)) score += 1;
        }
        if (score > 0) results.push({ id: doc.id, score });
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    },
  };
}
