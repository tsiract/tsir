/**
 * `defineModel(table, options)` — the ceremony removed, not the query (`DX-004`).
 *
 * ADR-0032 § 2 is precise about what this is *not*: not an Active Record, nothing mutable, no
 * `user.save()`. A model carries a table, its row type and its insert type, and offers the six reads
 * every repository in the admin app writes by hand with the same `where(eq(table.id, id))`:
 *
 * ```ts
 * export const Users = defineModel(users, { timestamps: true });
 *
 * await Users.find(db, 7);              // User | undefined
 * await Users.findOrFail(db, 7);        // User, or DB_MODEL_NOT_FOUND naming the table and id
 * await Users.where(db, { email });     // User[]        — `{ emial }` is a compile error
 * await Users.first(db, { email });     // User | undefined
 * await Users.count(db);                // number
 * await Users.exists(db, { email });    // boolean
 * ```
 *
 * Three decisions that are the whole point:
 *
 * **`where` takes a column record, not a string.** `{ email }` is checked against the table's
 * columns, so `where(db, { emial })` does not compile. That matters more than it sounds: a
 * mistyped string key becomes a predicate that matches every row, which looks like a working filter
 * and is a full-table read on a table that may hold personal data. At runtime — where the key can
 * arrive from a query string — an unknown key throws rather than being ignored, for the same reason.
 *
 * **The row is the inferred type, never an index signature.** `User` comes from
 * `table.$inferSelect`, so `user.anything` is a compile error instead of `undefined`.
 *
 * **Nothing is cached and nothing is lazy.** Every call runs one statement against the `db` you
 * passed. A model that held a connection would be a second place the default is resolved, which is
 * the bug the rest of this file's neighbours exist to remove.
 *
 * Scoping: the first argument is the bound Drizzle instance (`bootstrap.db`, `dbFor('analytics')`),
 * so a model is usable across connections without knowing which one it is on.
 */

import { and, eq, sql, type SQL } from 'drizzle-orm';

import { modelNotFound, modelUnknownColumn } from './errors.ts';
import type { createDrizzle } from './drizzle.ts';

/**
 * What a table has to be to define a model over it.
 *
 * Deliberately a **structural minimum of the two inferred types**, not an index signature. An index
 * signature (`readonly [key: string]: unknown`) looks more permissive and is in fact stricter: a
 * Drizzle table has no string index signature, so `SQLiteTableWithColumns<…>` was *not* assignable
 * and every `defineModel(users)` failed to compile. Naming the two phantom types is also what keeps
 * the row type precise — `$inferSelect` is where `User` comes from.
 */
export interface ModelTable {
  readonly $inferSelect: unknown;
  readonly $inferInsert: unknown;
}

/** A column record: one or more of the table's columns to the value to match. */
export type Where<Row> = Partial<Record<keyof Row & string, unknown>>;

/**
 * The bound client a model queries through: `bootstrap.db`, or `dbFor(name)`.
 *
 * Typed as Drizzle's own interface rather than a structural shape of my own, for the reason this
 * file's first draft got wrong: a hand-written `{ select(): { from(): … } }` accepts anything that
 * happens to have a `select` method, so a string or a plain object typechecks and fails at runtime
 * on the first query. Naming the real type means passing the wrong thing is a compile error.
 */
export type ModelClient = ReturnType<typeof createDrizzle<Record<string, unknown>>>;

export interface ModelOptions {
  /**
   * Whether the table carries `createdAt`/`updatedAt`.
   *
   * Declared rather than assumed (`DX-007`'s rule applied to timestamps). It is recorded on the
   * model and used by `DX-005`'s writes; the reads in this file do not need it, and a model that
   * guessed would write a column the table does not have.
   */
  readonly timestamps?: boolean;
  /** Whether reads should exclude soft-deleted rows. Writes land in `DX-007`. */
  readonly softDeletes?: boolean;
}

/** A model: the table, two row types and the reads. */
export interface Model<Row, Insert, Table extends ModelTable> {
  readonly table: Table;
  readonly name: string;
  readonly options: ModelOptions;
  /** The row type, as a type — `User`, for a caller who does not want `typeof Users.$type`. */
  readonly $type: Row;
  readonly $insert: Insert;
  find(db: ModelClient, id: unknown): Promise<Row | undefined>;
  findOrFail(db: ModelClient, id: unknown): Promise<Row>;
  where(db: ModelClient, match: Where<Row>): Promise<Row[]>;
  first(db: ModelClient, match: Where<Row>): Promise<Row | undefined>;
  count(db: ModelClient, match?: Where<Row>): Promise<number>;
  exists(db: ModelClient, match: Where<Row>): Promise<boolean>;
}

/**
 * The columns of a Drizzle table, as a plain record.
 *
 * Drizzle keeps them behind a symbol (`drizzle:Columns`), which is why this is reflection rather
 * than a property read. The symbols are part of Drizzle's runtime shape and not its published API,
 * so this is the one place in the package that depends on it — a narrow surface with a test that
 * fails loudly if it ever moves, rather than a `columns.length === 0` that would make every `where`
 * throw "not a column".
 */
export function columnsOf(table: ModelTable): Readonly<Record<string, unknown>> {
  for (const symbol of Object.getOwnPropertySymbols(table)) {
    if (symbol.description === 'drizzle:Columns') {
      const found = (table as unknown as Record<symbol, Record<string, unknown>>)[symbol];
      if (found !== undefined) return found;
    }
  }
  // Not a Drizzle table. Returning the visible keys is the honest fallback: a caller who passed a
  // plain object gets a check against it rather than a silent pass.
  return table as unknown as Record<string, unknown>;
}

/** The table's SQL name, for the error a caller actually reads. */
function tableName(table: ModelTable): string {
  const symbols = Object.getOwnPropertySymbols(table);
  for (const symbol of symbols) {
    if (symbol.description === 'drizzle:Name') {
      const value = (table as unknown as Record<symbol, unknown>)[symbol];
      if (typeof value === 'string') return value;
    }
  }
  return 'table';
}

/** The `and(...)` of an equality per key, or `undefined` when the record is empty. */
function condition(
  table: ModelTable,
  columns: Readonly<Record<string, unknown>>,
  match: Readonly<Record<string, unknown>>,
): SQL | undefined {
  const parts = Object.entries(match).map(([key, value]) => {
    const column = columns[key];
    if (column === undefined) {
      // Reached only when the key bypassed the type — a filter built from a query string. Ignoring
      // it would return every row and read as a successful filter.
      throw modelUnknownColumn(tableName(table), key, Object.keys(columns));
    }
    return eq(column as never, value as never);
  });
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

/**
 * A model over one Drizzle table.
 *
 * ```ts
 * import { defineModel } from '@tsir/database';
 * import { users } from './shared/schema.ts';
 *
 * export const Users = defineModel(users);
 * export type User = typeof Users.$type;
 * ```
 */
export function defineModel<Table extends ModelTable>(
  table: Table,
  options: ModelOptions = {},
): Model<Table['$inferSelect'], Table['$inferInsert'], Table> {
  type Row = Table['$inferSelect'];

  const columns = columnsOf(table);
  const name = tableName(table);

  /**
   * The `id` column, discovered rather than declared.
   *
   * `find(7)` has to know what to compare `7` against, and every table in the framework declares a
   * primary key — but the *name* differs (`id`, `key`, `uuid`). Reading `drizzle:PrimaryKey` would
   * mean importing Drizzle internals; reading the conventional `id` and saying so is honest, and a
   * table without one simply does not get the id-shaped reads to work by accident: `eq(undefined)`
   * would throw.
   */
  const idColumn = columns['id'];

  return {
    table,
    name,
    options,
    $type: undefined,
    $insert: undefined,

    async find(input, id) {
      if (idColumn === undefined) {
        throw modelUnknownColumn(name, 'id', Object.keys(columns));
      }
      const rows = (await input
        .select()
        .from(table as never)
        .where(eq(idColumn as never, id as never))) as Row[];
      return rows[0];
    },

    async findOrFail(input, id) {
      const row = await this.find(input, id);
      if (row === undefined) throw modelNotFound(name, id);
      return row;
    },

    async where(input, match) {
      const query = input.select().from(table as never);
      const where = condition(table, columns, match);
      // `where(undefined)` is a Drizzle runtime error; an empty record means "all rows", which is
      // what `where(db, {})` reads like and what `count(db, {})` needs.
      if (where === undefined) return await query;
      return await query.where(where);
    },

    async first(input, match) {
      const rows = await this.where(input, match);
      return rows[0];
    },

    async count(input, match) {
      const rows = await this.where(input, match ?? {});
      // A `count` that fetches every row is honest for the sizes this framework is used at and is
      // one implementation instead of two; `DX-005` replaces it with `select({ count: sql<number> })`
      // when a page needs it on a table that grows.
      return rows.length;
    },

    async exists(input, match) {
      const rows = await this.where(input, match);
      return rows.length > 0;
    },
  };
}

/**
 * `sql<number>` over `count(*)`, for a caller that needs the count without the rows.
 *
 * Exported because `Model.count` fetching rows to length them is fine at a thousand rows and wrong
 * at a million, and a caller who knows their table should not have to re-derive this.
 */
export function countExpression(): SQL<number> {
  return sql<number>`count(*)`;
}
