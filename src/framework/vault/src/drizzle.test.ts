import { describe, expect, test } from 'bun:test';

import {
  ENCRYPTED_COLUMN,
  encryptedColumnsOf,
  encryptedMarkerOf,
  encryptedText,
} from './drizzle.ts';

/**
 * A stand-in for Drizzle's column builder: `text('x')` returns a builder, and
 * `table()` calls `build()` once and keeps the returned column — which is exactly
 * the lifecycle the marker has to survive.
 */
function builder(name: string) {
  const built: Record<PropertyKey, unknown>[] = [];
  return {
    name,
    built,
    build(table: unknown): Record<PropertyKey, unknown> {
      // Drizzle passes the table being built; the fake ignores it but must accept it.
      void table;
      const column: Record<PropertyKey, unknown> = { name, dataType: 'string' };
      built.push(column);
      return column;
    },
  };
}

describe('encryptedText (VLT-008)', () => {
  test('the marker rides on the built column, not on the builder', () => {
    const taxId = encryptedText(builder('tax_id'));
    const column = taxId.build({});

    expect(encryptedMarkerOf(column)).toEqual({ column: 'tax_id', nullable: false });
    // Nothing leaked onto the builder: Drizzle discards it there.
    expect((taxId as Record<PropertyKey, unknown>)[ENCRYPTED_COLUMN]).toBeUndefined();
  });

  test('nullability is a declaration and defaults to false', () => {
    const nullable = encryptedText(builder('phone'), { nullable: true });
    const strict = encryptedText(builder('ssn'));

    expect(encryptedMarkerOf(nullable.build({}))?.nullable).toBe(true);
    expect(encryptedMarkerOf(strict.build({}))?.nullable).toBe(false);
  });

  test('the builder is returned unchanged, so Drizzle still sees a text column', () => {
    const text = builder('tax_id');
    const wrapped = encryptedText(text);

    expect(wrapped).toBe(text);
    expect(wrapped.name).toBe('tax_id');
  });

  test('building twice marks both columns', () => {
    // Drizzle builds a column per table; a shared builder must not be marked once.
    const shared = encryptedText(builder('tax_id'));
    const first = shared.build({});
    const second = shared.build({});

    expect(encryptedMarkerOf(first)).toEqual({ column: 'tax_id', nullable: false });
    expect(encryptedMarkerOf(second)).toEqual({ column: 'tax_id', nullable: false });
    expect(first).not.toBe(second);
  });

  test('a table yields its encrypted columns in declaration order', () => {
    const users = {
      id: builder('id').build({}),
      taxId: encryptedText(builder('tax_id')).build({}),
      email: builder('email').build({}),
      phone: encryptedText(builder('phone'), { nullable: true }).build({}),
    };

    // `taxId` is the property, `tax_id` the column: the row key and the AAD name.
    expect(encryptedColumnsOf('users', users)).toEqual([
      { table: 'users', column: 'tax_id', key: 'taxId' },
      { table: 'users', column: 'phone' },
    ]);
  });

  test('a plain column carries no marker', () => {
    expect(encryptedMarkerOf(builder('email').build({}))).toBeUndefined();
    expect(encryptedMarkerOf(null)).toBeUndefined();
    expect(encryptedMarkerOf('tax_id')).toBeUndefined();
  });
});
