import { describe, expect, test } from 'bun:test';

import { defineCodedColumns, type ColumnCodec, type ColumnRef } from './codec.ts';

/**
 * A stand-in for vault's envelope codec.
 *
 * It is *not* encryption and does not pretend to be — the real AEAD arrives with
 * VLT-008. What it reproduces is the part `codec.ts` is responsible for: an async
 * transform, a per-write-changing stored value, and an AAD binding to the column
 * identity that fails loudly when a value turns up in the wrong column.
 */
function taggingCodec(): ColumnCodec & { readonly seen: ColumnRef[] } {
  const seen: ColumnRef[] = [];
  return {
    name: 'test.tagging.v1',
    seen,
    async encode(column, value) {
      seen.push(column);
      if (typeof value !== 'string') throw new TypeError('test codec only stores strings');
      // A real envelope changes per write (fresh nonce); this changes per value.
      return `enc:v1:${column.table}.${column.column}:${btoa(value)}`;
    },
    async decode(column, stored) {
      seen.push(column);
      const prefix = `enc:v1:${column.table}.${column.column}:`;
      if (typeof stored !== 'string' || !stored.startsWith(prefix)) {
        throw new Error(`ciphertext is not bound to ${column.table}.${column.column}`);
      }
      return atob(stored.slice(prefix.length));
    },
  };
}

describe('database · column codec seam (DB-010)', () => {
  test('a round trip returns the value the application wrote', async () => {
    const codecs = defineCodedColumns([
      { table: 'users', column: 'tax_id', codec: taggingCodec() },
    ]);

    const written = await codecs.encodeRow('users', {
      id: 1,
      email: 'ada@example.com',
      tax_id: '123-45-6789',
    });
    const read = await codecs.decodeRow('users', written);

    expect(read).toEqual({ id: 1, email: 'ada@example.com', tax_id: '123-45-6789' });
  });

  test('what reaches the database is not the plaintext', async () => {
    const codecs = defineCodedColumns([
      { table: 'users', column: 'tax_id', codec: taggingCodec() },
    ]);

    const stored = await codecs.encodeRow('users', { tax_id: '123-45-6789' });

    expect(stored.tax_id).not.toBe('123-45-6789');
    expect(String(stored.tax_id)).not.toContain('123-45-6789');
    expect(stored.tax_id).toBe(`enc:v1:users.tax_id:${btoa('123-45-6789')}`);
  });

  test('the codec gets the column identity, not just the value', async () => {
    const codec = taggingCodec();
    const codecs = defineCodedColumns([{ table: 'users', column: 'tax_id', codec }]);

    await codecs.encodeRow('users', { tax_id: 'x' });

    // Vault binds this into the associated data; the caller never supplies it.
    expect(codec.seen).toEqual([{ table: 'users', column: 'tax_id' }]);
  });

  test('ciphertext moved to another column fails closed instead of decoding', async () => {
    const codecs = defineCodedColumns([
      { table: 'users', column: 'tax_id', codec: taggingCodec() },
      { table: 'users', column: 'phone', codec: taggingCodec() },
    ]);

    const stored = await codecs.encodeRow('users', {
      tax_id: '123-45-6789',
      phone: '+63 900 000 0000',
    });

    // Someone pasted the tax id ciphertext into the phone column.
    const moved = await codecs.decodeRow('users', { ...stored, phone: stored.tax_id }).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    expect(moved).toBeInstanceOf(Error);
    expect(moved?.message).toContain('users.phone');
  });

  test('null passes through untouched; undefined is rejected', async () => {
    const codecs = defineCodedColumns([{ table: 'users', column: 'phone', codec: taggingCodec() }]);

    const encoded = await codecs.encodeRow('users', { phone: null });
    expect(encoded.phone).toBeNull();
    expect((await codecs.decodeRow('users', { phone: null })).phone).toBeNull();

    const error = await codecs.encodeRow('users', { phone: undefined }).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string; hint?: string },
    );
    expect(error?.code).toBe('DB_CODEC_UNDEFINED_VALUE');
    expect(error?.hint).toContain('null');
  });

  test('an absent column is a partial select, not a null value', async () => {
    const codecs = defineCodedColumns([
      { table: 'users', column: 'tax_id', codec: taggingCodec() },
    ]);

    const decoded = await codecs.decodeRow('users', { id: 1 });

    expect(decoded).toEqual({ id: 1 });
    expect(Object.hasOwn(decoded, 'tax_id')).toBe(false);
  });

  test('undeclared columns and undeclared tables are passed through', async () => {
    const codecs = defineCodedColumns([
      { table: 'users', column: 'tax_id', codec: taggingCodec() },
    ]);

    const users = await codecs.encodeRow('users', { id: 1, email: 'ada@example.com' });
    expect(users).toEqual({ id: 1, email: 'ada@example.com' });

    expect(await codecs.encodeRow('audit_log', { note: 'plain' })).toEqual({ note: 'plain' });
  });

  test('the caller’s row is never mutated', async () => {
    const codecs = defineCodedColumns([
      { table: 'users', column: 'tax_id', codec: taggingCodec() },
    ]);
    const row = { id: 1, tax_id: '123-45-6789' };

    const stored = await codecs.encodeRow('users', row);

    expect(row.tax_id).toBe('123-45-6789');
    expect(stored).not.toBe(row);
  });

  test('a duplicate declaration, a bad identifier, or a nameless codec fails at boot', () => {
    const codec = taggingCodec();

    expect(() =>
      defineCodedColumns([
        { table: 'users', column: 'tax_id', codec },
        { table: 'users', column: 'tax_id', codec },
      ]),
    ).toThrow(/more than one codec/);

    for (const [table, column] of [
      ['users; drop table users', 'tax_id'],
      ['users', 'tax_id" = "x'],
    ]) {
      expect(() => defineCodedColumns([{ table: table!, column: column!, codec }])).toThrow(
        /not a valid SQL identifier/,
      );
    }

    expect(() =>
      defineCodedColumns([{ table: 'users', column: 'tax_id', codec: { ...codec, name: '  ' } }]),
    ).toThrow(/has no name/);
  });

  test('columnsFor reports what a table will transform, sorted', () => {
    const codecs = defineCodedColumns([
      { table: 'users', column: 'tax_id', codec: taggingCodec() },
      { table: 'users', column: 'phone', codec: taggingCodec() },
      { table: 'cards', column: 'pan', codec: taggingCodec() },
    ]);

    expect(codecs.columnsFor('users')).toEqual(['phone', 'tax_id']);
    expect(codecs.columnsFor('posts')).toEqual([]);
    expect(codecs.size).toBe(3);
  });
});
