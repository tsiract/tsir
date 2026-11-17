/**
 * A `@tsir/database` connection as a search query function.
 *
 * `sqliteEngine` and `postgresEngine` take a `(sql, params) => rows` function, and until now the
 * only way to get one was to hand-write the adapter in each app — the same shape of gap as a
 * driver reachable only from `app.ts`. `databaseQuery(db)` is that adapter, and it is one short
 * function because there is one difference: `Database.query` takes a `DbStatement` object and
 * answers a `DbResult`, while a search engine passes a literal and a positional list.
 *
 * **Typed structurally, not by importing the package.** `@tsir/scout` does not depend on
 * `@tsir/database` (§ boundaries: a capability package does not import a sibling), and it does
 * not need to. `QueryableDatabase` is the one method this adapter calls; a real `Database`
 * satisfies it, and so does a test double with no driver behind it.
 *
 * **Positional parameters only.** Postgres engines number their placeholders (`$1`), SQLite
 * ones use `?`, and both drivers read `params` positionally — so a statement that needs the
 * same value twice numbers or repeats it rather than naming it.
 *
 * `format: 'arrays'` is the load-bearing part. Every engine in this package reads rows by column
 * name (`row['id']`, `row['content']`), which is the driver's object format — but a caller that
 * overrode it would silently get rows keyed `0`, `1`, `2`, and the search would return nothing
 * while every layer reported success. The adapter pins the format so the engine cannot be handed
 * a shape it does not read.
 */

import type { QueryFn } from './config.ts';

/** One statement result, in the shape `@tsir/database` returns it. */
interface QueryResult {
  readonly rows: readonly unknown[];
}

/**
 * The minimum a connection must offer. A full `@tsir/database` `Database` satisfies it
 * structurally, so no cast is needed at the call site.
 */
export interface QueryableDatabase {
  query(statement: {
    readonly sql: string;
    readonly params: readonly unknown[];
    readonly format?: 'objects' | 'arrays';
  }): Promise<QueryResult>;
}

/**
 * Wrap a connection as the query function the SQL search engines take.
 *
 * ```ts
 * import { databases } from '../../database.ts';
 * import { databaseQuery, createScoutBootstrap } from '@tsir/scout';
 *
 * export const scout = createScoutBootstrap({
 *   search: { driver: 'postgres', connection: 'primary', collection: 'search_index' },
 *   bindings: { databases: { primary: databaseQuery(databases.defaultDatabase) } },
 * });
 * ```
 */
export function databaseQuery(db: QueryableDatabase): QueryFn {
  return async (sql, params) => {
    const result = await db.query({ sql, params, format: 'arrays' });
    // `rows` is `unknown[]` upstream on purpose — the driver cannot know a schema. The engines
    // above it do, and this cast is the single place that says so, rather than in each of the six
    // call sites inside `drivers.ts`.
    return result.rows as readonly Record<string, unknown>[];
  };
}
