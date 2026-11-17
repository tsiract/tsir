import { describe, expect, test } from 'bun:test';

import { columnName, isSensitiveColumn, redactSql } from './redaction.ts';

/**
 * The table is the spec (`DX-016`).
 *
 * A redaction rule is exactly the kind of code that looks right and is not, so the cases below are
 * written as a table: the statement, and what may survive it. The failure this prevents is not a
 * crash — it is an email address in a slow-query log, which nobody notices until somebody reads it.
 */

describe('a quoted literal is never kept', () => {
  test.each([
    ["select * from users where name = 'Ada'", 'select * from users where name = ?'],
    ["select * from t where name = 'it''s'", 'select * from t where name = ?'],
    ["insert into t (name) values ('Ada')", 'insert into t (name) values (?)'],
  ])('%s', (input, expected) => {
    expect(redactSql(input)).toBe(expected);
  });
});

describe('a sensitive column takes its value with it', () => {
  test.each([
    // The value was a parameter: still dropped, because the column is the signal.
    ['select * from users where email = ?', 'select * from users where email = ?'],
    // A bare number is not quoted, so literal scrubbing cannot see it.
    ['select * from users where phone = 5551234', 'select * from users where phone = ?'],
    // A function call: the result of `lower(?)` is still an address.
    ['update users set email = lower(?) where id = ?', 'update users set email = ? where id = ?'],
    // Qualified, quoted by either dialect.
    [
      'select * from "users" where "users"."email" = ?',
      'select * from "users" where "users"."email" = ?',
    ],
    [
      'select * from `users` where `password_hash` = ?',
      'select * from `users` where `password_hash` = ?',
    ],
    // Prefix forms a schema actually uses.
    [
      'select * from users where password_reset_token = $1',
      'select * from users where password_reset_token = ?',
    ],
    ['select * from sessions where api_key = ?', 'select * from sessions where api_key = ?'],
    ['select * from cards where card_number = ?', 'select * from cards where card_number = ?'],
    // Operators that are not `=`.
    ['select * from users where email like ?', 'select * from users where email like ?'],
    ['select * from users where ssn <> ?', 'select * from users where ssn <> ?'],
  ])('%s', (input, expected) => {
    expect(redactSql(input)).toBe(expected);
  });
});

describe('what must survive, because a log you cannot read is not a log', () => {
  test.each([
    // An integer key is not personal data, and `id = ?` hides the join you opened the log for.
    ['select * from users where id = 7', 'select * from users where id = 7'],
    ['select * from users where id in (1, 2, 3)', 'select * from users where id in (1, 2, 3)'],
    // `is null` carries no value; rewriting it would change what the statement says.
    [
      'select * from sessions where token is not null',
      'select * from sessions where token is not null',
    ],
    // Identifiers stay: a statement of `? ? ?` tells nobody anything.
    ['select name, status from users where id = ?', 'select name, status from users where id = ?'],
    // A column named `email` in a projection is a name, not a value.
    ['select email from users', 'select email from users'],
  ])('%s', (input, expected) => {
    expect(redactSql(input)).toBe(expected);
  });
});

describe('the column signal', () => {
  test('is read from the last segment of a qualified name', () => {
    expect(columnName('"users"."email"')).toBe('email');
    expect(columnName('public.users.phone_number')).toBe('phone_number');
  });

  test('matches prefixes and suffixes, case-insensitively', () => {
    expect(isSensitiveColumn('EMAIL')).toBe(true);
    expect(isSensitiveColumn('password_hash')).toBe(true);
    expect(isSensitiveColumn('stripe_secret')).toBe(true);
    expect(isSensitiveColumn('created_at')).toBe(false);
    expect(isSensitiveColumn('status')).toBe(false);
  });

  test('a column merely containing a short token is not sensitive', () => {
    // `pinned` contains `pin`; over-redacting every statement is how a redactor gets turned off.
    expect(isSensitiveColumn('pinned')).toBe(false);
    expect(isSensitiveColumn('shipping_address')).toBe(true);
  });
});

describe('whitespace', () => {
  test('a multi-line statement is collapsed, so a row is one line', () => {
    expect(redactSql('select *\n  from users\n where id = 1')).toBe(
      'select * from users where id = 1',
    );
  });
});
