/**
 * The column codec seam (`DB-010`).
 *
 * Encryption must not be sprinkled through a codebase: every `INSERT` that
 * remembers to encrypt is an `INSERT` that can forget. So `@tsir/database`
 * exposes **one** place where a stored value differs from the value the
 * application sees, and `@tsir/vault` (VLT-008) is the only package that
 * implements it.
 *
 * ## Why the seam is async, and why it is not a Drizzle column codec
 *
 * Drizzle's `customType` maps values with `toDriver` / `fromDriver`, and both are
 * **synchronous**. AES-256-GCM via WebCrypto is **asynchronous** — there is no
 * synchronous primitive that satisfies the vault contract. The two ways to
 * pretend otherwise are both unacceptable:
 *
 *   · hand-roll synchronous crypto — forbidden (no custom primitives);
 *   · return ciphertext to application code from `db.select()` — a silent,
 *     type-correct data leak.
 *
 * So the transformation happens at the boundary instead: `encodeRow()` before
 * Drizzle sees the values, `decodeRow()` after it returns rows. That is exactly
 * the contract ("encrypted before the driver sees them,
 * decrypted after rows come back"), and it keeps `sql` and `params` in the query
 * log (DB-009) free of plaintext by construction.
 *
 * ## What crosses the seam
 *
 * The codec is given the **column identity** (`{ table, column }`), not just the
 * value: vault binds it into the AEAD associated data, so a ciphertext moved from
 * `users.tax_id` to `users.phone` fails authentication instead of decrypting
 * happily in the wrong place.
 *
 * ## What this file refuses to guess
 *
 * `null` passes through untouched — SQL `NULL` is "no value", not a ciphertext.
 * `undefined` is rejected, because a missing column in an `INSERT` is a caller
 * bug that would otherwise store a plaintext value or silently drop the write.
 */

import { TsirError } from '@tsir/core';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Where a value lives. The unit vault's AAD is bound to. */
export interface ColumnRef {
  readonly table: string;
  readonly column: string;
}

/**
 * A reversible transformation between a stored value and an application value.
 *
 * Implementations must fail closed: a value they cannot decode raises, never
 * returns the stored form as if it were plaintext.
 */
export interface ColumnCodec {
  /** Recorded for logs and boot output, e.g. `vault.envelope.v1`. Never a secret. */
  readonly name: string;
  /** Application value → stored value. */
  encode(column: ColumnRef, value: unknown): Promise<unknown>;
  /** Stored value → application value. Must throw rather than return ciphertext. */
  decode(column: ColumnRef, stored: unknown): Promise<unknown>;
}

/** One declared coded column: the pairing of a location and its codec. */
export interface CodedColumn {
  readonly table: string;
  /** The SQL column name. This is what the AAD binds and what the codec is given. */
  readonly column: string;
  readonly codec: ColumnCodec;
  /**
   * The row key holding the value, when it differs from the SQL name.
   *
   * `users.tax_id` is declared as `taxId: encryptedText('tax_id')` in a Drizzle
   * schema, so inserts and selects speak `taxId` while the AAD and the stored
   * column speak `tax_id`. Both are needed: the row key to find the value, the SQL
   * name to bind the ciphertext to its storage location.
   */
  readonly key?: string;
}

/** Row-level transforms for one table. Rows are copied, never mutated. */
export interface CodedColumns {
  /** Writes: application row → the row Drizzle will store. */
  encodeRow(
    table: string,
    row: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** Reads: the row Drizzle returned → the row the application sees. */
  decodeRow(
    table: string,
    row: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** The coded columns for a table, sorted — used by boot checks and tests. */
  columnsFor(table: string): readonly string[];
  /** How many coded columns are registered. */
  readonly size: number;
}

function checkIdentifier(value: string, what: string, table?: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new TsirError(
      'DB_CODEC_INVALID_COLUMN',
      `${what} "${value}" is not a valid SQL identifier${table === undefined ? '' : ` (table "${table}")`}`,
      {
        kind: 'database',
        hint: 'codec columns are declared from code with plain identifiers, never from request data',
        context: { [what]: value },
      },
    );
  }
  return value;
}

/**
 * Registers coded columns.
 *
 * Two declarations for the same column is a configuration bug — one codec would
 * win silently and rows written by the other could not be read back.
 */
export function defineCodedColumns(entries: readonly CodedColumn[]): CodedColumns {
  const byTable = new Map<string, Map<string, { codec: ColumnCodec; key: string }>>();

  for (const entry of entries) {
    const table = checkIdentifier(entry.table, 'table');
    const column = checkIdentifier(entry.column, 'column', table);
    const key = checkIdentifier(entry.key ?? entry.column, 'column', table);
    if (entry.codec.name.trim() === '') {
      throw new TsirError('DB_CODEC_INVALID_NAME', `codec for "${table}.${column}" has no name`, {
        kind: 'database',
        hint: 'a codec name identifies the format in the database; an anonymous codec cannot be audited',
        context: { table, column },
      });
    }

    const columns = byTable.get(table) ?? new Map<string, { codec: ColumnCodec; key: string }>();
    if (columns.has(column)) {
      throw new TsirError(
        'DB_CODEC_DUPLICATE_COLUMN',
        `"${table}.${column}" is declared with more than one codec`,
        {
          kind: 'database',
          hint: 'remove the duplicate declaration; a column has exactly one storage format',
          context: { table, column },
        },
      );
    }
    columns.set(key, { codec: entry.codec, key });
    byTable.set(table, columns);
  }

  async function transform(
    direction: 'encode' | 'decode',
    table: string,
    row: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const columns = byTable.get(table);
    if (columns === undefined) return { ...row };

    const next: Record<string, unknown> = { ...row };
    const work: Promise<void>[] = [];
    for (const [column, { codec }] of columns) {
      // An absent key is a partial select (`select({ id })`), not a null value.
      if (!Object.hasOwn(row, column)) continue;
      const value = row[column];
      // SQL NULL is not a value: there is nothing to encrypt or decrypt.
      if (value === null) {
        next[column] = null;
        continue;
      }
      if (value === undefined) {
        throw new TsirError(
          'DB_CODEC_UNDEFINED_VALUE',
          `"${table}.${column}" was given undefined`,
          {
            kind: 'database',
            hint: 'pass null for "no value"; undefined would silently store an unencoded value',
            context: { table, column },
          },
        );
      }
      const ref: ColumnRef = { table, column };
      work.push(
        Promise.resolve(
          direction === 'encode' ? codec.encode(ref, value) : codec.decode(ref, value),
        ).then((result) => {
          next[column] = result;
        }),
      );
    }

    await Promise.all(work);
    return next;
  }

  return {
    encodeRow: (table, row) => transform('encode', table, row),
    decodeRow: (table, row) => transform('decode', table, row),
    columnsFor: (table) =>
      [...(byTable.get(table)?.values() ?? [])].map((entry) => entry.key).sort(),
    size: [...byTable.values()].reduce((total, columns) => total + columns.size, 0),
  };
}
