/**
 * `encryptedText()` — declaring an encrypted column on a Drizzle schema
 * (`VLT-008` / `DB-010`).
 *
 * ```ts
 * import { pgTable, text } from 'drizzle-orm/pg-core';
 * import { encryptedText, encryptedColumnsOf } from '@tsir/vault/drizzle';
 *
 * export const users = pgTable('users', {
 *   id: text('id').primaryKey(),
 *   taxId: encryptedText(text('tax_id')),
 * });
 *
 * const coded = defineCodedColumns(
 *   encryptedColumnsOf('users', users).map((column) => ({ ...column, codec })),
 * );
 * ```
 *
 * ## Why this takes a builder instead of importing a dialect
 *
 * Drizzle exposes one `text()` per dialect (`drizzle-orm/pg-core`,
 * `drizzle-orm/sqlite-core`, …). A `@tsir/vault/drizzle` that imported one of them
 * would pick a dialect for every project in the monorepo, and a project on D1 that
 * imports the Postgres builder gets a column Drizzle refuses to compile. Passing
 * the builder in keeps this package dialect-free — and dependency-free, which is
 * what lets `@tsir/vault` stay runtime-neutral (no `node:`, no `bun:`, no ORM).
 *
 * ## Why the marker is attached when Drizzle builds the column, not now
 *
 * `text('tax_id')` returns a *builder*; `pgTable()` later calls `.build(table)` and
 * keeps the resulting `Column`. Anything stored on the builder is discarded, so the
 * marker is written onto the column that `build()` returns. The wrapper is
 * installed once per builder at declaration time, which is the only moment this
 * module gets to see it.
 *
 * ## What the marker is not
 *
 * It is not a transform. Drizzle's `toDriver`/`fromDriver` are synchronous and
 * AES-256-GCM is not (`@tsir/database`'s `codec.ts` documents the whole argument),
 * so the actual encryption happens at the row boundary through
 * `defineCodedColumns`/`encodeRow`/`decodeRow`. The column's SQL type stays `text`,
 * and the application still sees `string`.
 */

import { TsirError } from '@tsir/core';

/** Where a marker lives. `Symbol.for` so two copies of this package still agree. */
export const ENCRYPTED_COLUMN = Symbol.for('@tsir/vault/encrypted-column');

/** What is remembered about one declared column. */
export interface EncryptedColumnMarker {
  /** The SQL column name Drizzle will emit. */
  readonly column: string;
  /** Mirrors the DDL. A boot check compares this to the column's actual nullability. */
  readonly nullable: boolean;
}

export interface EncryptedTextOptions {
  /**
   * `true` when the column is nullable in the schema. Default `false`.
   *
   * This is a declaration, not a constraint: `06-vault.md § 5` requires the boot
   * check to compare it with the Drizzle column, because "nullable in TypeScript,
   * NOT NULL in SQL" is a bug that only shows up on the first insert.
   */
  readonly nullable?: boolean;
}

/**
 * The part of a Drizzle column builder this module needs.
 *
 * Deliberately *not* a required member: Drizzle's published builder types do not
 * expose `build`, though every builder has one. Requiring it would reject every
 * real `text()` call, so the shape is checked at runtime instead — and the error
 * says what happened rather than failing three frames later inside Drizzle.
 */
export interface ColumnBuilderLike {
  build?(table: unknown): Record<PropertyKey, unknown>;
}

/** Marks a Drizzle text column as holding a vault envelope. Returns the same builder. */
export function encryptedText<B extends object>(builder: B, options: EncryptedTextOptions = {}): B {
  const nullable = options.nullable ?? false;
  const buildColumn = (builder as ColumnBuilderLike).build?.bind(builder);
  if (typeof buildColumn !== 'function') {
    throw new TsirError(
      'VLT_UNSUPPORTED_TYPE',
      'encryptedText() was given something that is not a Drizzle column builder',
      {
        kind: 'vault',
        hint: 'pass a text column builder, e.g. encryptedText(text("tax_id"))',
        context: { received: typeof builder },
      },
    );
  }

  Object.defineProperty(builder, 'build', {
    configurable: true,
    writable: true,
    // `enumerable: false` keeps the wrapper out of anything that walks the builder's
    // own keys, which Drizzle does when it clones columns.
    enumerable: false,
    value: (table: unknown): Record<PropertyKey, unknown> => {
      const column = buildColumn(table);
      const name = typeof column.name === 'string' ? column.name : '';
      Object.defineProperty(column, ENCRYPTED_COLUMN, {
        value: { column: name, nullable } satisfies EncryptedColumnMarker,
        enumerable: false,
        configurable: true,
        writable: false,
      });
      return column;
    },
  });

  return builder;
}

/** The marker on a built column, or `undefined` when it is not encrypted. */
export function encryptedMarkerOf(column: unknown): EncryptedColumnMarker | undefined {
  if (typeof column !== 'object' || column === null) return undefined;
  const marker = (column as Record<PropertyKey, unknown>)[ENCRYPTED_COLUMN];
  return marker === undefined ? undefined : (marker as EncryptedColumnMarker);
}

/**
 * The declared encrypted columns of a built Drizzle table, in declaration order.
 *
 * Takes the table name explicitly rather than reading Drizzle's internal table
 * symbol: the name is what the AAD binds (`06-vault.md § 3`), so it should be
 * visible in the call that registers it, not recovered from a private key.
 */
export function encryptedColumnsOf(
  tableName: string,
  table: Readonly<Record<string, unknown>>,
): readonly {
  readonly table: string;
  /** The SQL column name — what the AAD binds. */
  readonly column: string;
  /** The schema property holding the value, when it differs from the SQL name. */
  readonly key?: string;
}[] {
  const found: { table: string; column: string; key?: string }[] = [];
  for (const [key, value] of Object.entries(table)) {
    const marker = encryptedMarkerOf(value);
    if (marker === undefined) continue;
    found.push(
      key === marker.column
        ? { table: tableName, column: marker.column }
        : { table: tableName, column: marker.column, key },
    );
  }
  return found;
}
