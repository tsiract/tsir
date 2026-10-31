/**
 * `encryptedText` against a real Postgres (`VLT-008`, closing `DB-010`).
 *
 * This is the test the two packages exist for: a declared encrypted column, a
 * Drizzle `insert`, a Drizzle `select`, and the plaintext coming back. Everything
 * between is the real stack — `pg-proxy` → `Database` → driver → Postgres — so the
 * assertion is about the seam, not about a mock agreeing with itself.
 *
 * It also states the two halves out loud:
 *   · the stored value is an envelope (`tsir:v1:…`) and contains no plaintext;
 *   · the application value is the original string, because `decodeRow` ran.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { pgTable, text } from 'drizzle-orm/pg-core';

import {
  createKeyring,
  createVault,
  createVaultCodec,
  formatKeySpec,
  generateKey,
  type Vault,
} from '@tsir/vault';
import { encryptedColumnsOf, encryptedText } from '@tsir/vault/drizzle';

import { defineCodedColumns } from '../src/codec.ts';
import { createDatabase, type Database } from '../src/index.ts';
import { createPostgresDriver } from '../src/postgres.ts';
import { createPgDrizzle } from '../src/postgres/drizzle.ts';
import { connectPostgres, databaseUrl, type TestDatabase } from '../../../tools/pg-test-client.ts';

const url = databaseUrl();
const suite = url === undefined ? describe.skip : describe;

const users = pgTable('it_encrypted_users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  // The schema property is `taxId`; the column is `tax_id`. The AAD binds the
  // column, the row holds the property — the codec seam keeps both.
  taxId: encryptedText(text('tax_id')),
  phone: encryptedText(text('phone'), { nullable: true }),
});

let pg: TestDatabase;
let db: Database;
let vault: Vault;

suite('database · encrypted columns (VLT-008, DB-010)', () => {
  beforeAll(async () => {
    pg = connectPostgres(url ?? '');
    vault = await createVault({ keyring: createKeyring({ now: formatKeySpec(generateKey()) }) });
    db = createDatabase({ driver: createPostgresDriver({ client: pg.client }), logging: 'off' });
  });

  afterAll(async () => {
    await db.close();
    await pg.close();
  });

  beforeEach(async () => {
    await pg.run('drop table if exists it_encrypted_users');
    await pg.run(
      'create table it_encrypted_users (id text primary key, email text not null, tax_id text not null, phone text)',
    );
  });

  function coded() {
    return defineCodedColumns(
      encryptedColumnsOf('it_encrypted_users', users as unknown as Record<string, unknown>).map(
        (column) => ({
          ...column,
          codec: createVaultCodec(vault),
        }),
      ),
    );
  }

  test('insert and select round-trip a string through the envelope', async () => {
    const columns = coded();
    const drizzle = createPgDrizzle(db, { schema: { users } });

    const row = await columns.encodeRow('it_encrypted_users', {
      id: 'u1',
      email: 'ops@example.test',
      taxId: '123-45-6789',
      phone: '+63 900 000 0000',
    });

    await drizzle.insert(users).values(row as typeof users.$inferInsert);

    const stored = await pg.run('select tax_id, phone from it_encrypted_users');
    const storedRow = stored[0] as { tax_id: string; phone: string };
    expect(storedRow.tax_id.startsWith('tsir:v1:')).toBe(true);
    expect(storedRow.phone.startsWith('tsir:v1:')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('123-45-6789');
    expect(JSON.stringify(stored)).not.toContain('0000');

    const selected = await drizzle.select().from(users as never);
    const decoded = await columns.decodeRow('it_encrypted_users', selected[0] as never);

    expect(decoded.taxId).toBe('123-45-6789');
    expect(decoded.phone).toBe('+63 900 000 0000');
    // Untouched columns stay untouched.
    expect(decoded.email).toBe('ops@example.test');
  });

  test('a NULL encrypted column stays NULL in both directions', async () => {
    const columns = coded();
    const drizzle = createPgDrizzle(db, { schema: { users } });

    const row = await columns.encodeRow('it_encrypted_users', {
      id: 'u2',
      email: 'ops@example.test',
      taxId: '000-00-0000',
      phone: null,
    });
    await drizzle.insert(users).values(row as typeof users.$inferInsert);

    const stored = (await pg.run('select phone from it_encrypted_users'))[0] as {
      phone: string | null;
    };
    expect(stored.phone).toBeNull();

    const selected = await drizzle.select().from(users as never);
    const decoded = await columns.decodeRow('it_encrypted_users', selected[0] as never);
    expect(decoded.phone).toBeNull();
  });

  test('a row moved to another column fails to decode instead of decrypting', async () => {
    const columns = coded();
    const drizzle = createPgDrizzle(db, { schema: { users } });

    const row = await columns.encodeRow('it_encrypted_users', {
      id: 'u3',
      email: 'ops@example.test',
      taxId: '123-45-6789',
      phone: '555',
    });
    await drizzle.insert(users).values(row as typeof users.$inferInsert);

    // Copy the envelope from `tax_id` into `phone`: same key, same table, wrong
    // column — so the AAD no longer matches.
    await pg.run('update it_encrypted_users set phone = tax_id');

    const selected = await drizzle.select().from(users as never);
    const error = await columns.decodeRow('it_encrypted_users', selected[0] as never).then(
      () => undefined,
      (reason: unknown) => reason as { code?: string },
    );

    expect(error?.code).toBe('VLT_AUTH_FAILED');
  });
});
