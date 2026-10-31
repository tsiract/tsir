/**
 * Addresses (`MAIL-1`).
 *
 * The first two tests are the reason this module exists at all: an address that arrives from a form
 * becomes a **header**, so `\r\nBcc: …` in a form field is a recipient the sender never chose. The
 * rest is the grammar this package accepts, which is deliberately narrower than RFC 5322's.
 */

import { describe, expect, test } from 'bun:test';

import { parseAddress, parseAddresses, splitAddressList } from './address.ts';
import { formatAddress } from './port.ts';

describe('what is refused, and why', () => {
  test('a newline in an address is refused before any transport sees it', () => {
    // This is the classic header injection: a valid-looking address that adds a second recipient.
    expect(() => parseAddress('ana@example.com\r\nBcc: everyone@example.com')).toThrow(
      /control characters/u,
    );
    expect(() => parseAddress('ana\r\n@example.com')).toThrow(/control characters/u);
    expect(() => parseAddress({ email: 'ana@example.com', name: 'Ana\r\nBcc: x@y.z' })).toThrow(
      /control characters in the display name/u,
    );
  });

  test('a malformed address names the reason, not just "invalid"', () => {
    const cases: readonly [string, RegExp][] = [
      ['', /it is empty/u],
      ['ana', /no `@`/u],
      ['a@b@c', /more than one `@`/u],
      ['@example.com', /nothing before the `@`/u],
      ['ana@', /nothing after the `@`/u],
      ['ana@example..com', /empty domain label/u],
      ['ana@-example.com', /is not a domain label/u],
      ['ana@example.com.', /is not a domain label/u],
      ['ana smith@example.com', /whitespace inside an address/u],
      ['"ana smith"@example.com', /quoted local part is not supported/u],
      ['Ana <ana@example.com', /unbalanced/u],
      ['Ana <ana@example.com> trailing', /characters after/u],
    ];
    for (const [input, pattern] of cases) {
      expect(() => parseAddress(input)).toThrow(pattern);
    }
  });

  test("a local part over 64 characters is refused, because the limit is the protocol's", () => {
    expect(() => parseAddress(`${'a'.repeat(65)}@example.com`)).toThrow(/longer than 64/u);
    expect(parseAddress(`${'a'.repeat(64)}@example.com`).email).toBe(
      `${'a'.repeat(64)}@example.com`,
    );
  });

  test('the error carries the code the CLI and the logs print', () => {
    try {
      parseAddress('ana');
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('MAIL_INVALID_ADDRESS');
    }
  });
});

describe('what is accepted', () => {
  test('a bare address, and the angle-bracket form', () => {
    expect(parseAddress('ana@example.com')).toEqual({ email: 'ana@example.com' });
    expect(parseAddress('Ana <ana@example.com>')).toEqual({
      email: 'ana@example.com',
      name: 'Ana',
    });
    expect(parseAddress('  ana@example.com  ')).toEqual({ email: 'ana@example.com' });
  });

  test('a quoted display name is unquoted, and one with an angle bracket still resolves', () => {
    expect(parseAddress('"Doe, Jane" <jane@example.com>')).toEqual({
      email: 'jane@example.com',
      name: 'Doe, Jane',
    });
    // Parsed from the **last** `<`: a name containing one yields the right address, not the name.
    expect(parseAddress('"Ana <billing>" <billing@example.com>')).toEqual({
      email: 'billing@example.com',
      name: 'Ana <billing>',
    });
    expect(parseAddress('Ana Q. <ana@example.com>').name).toBe('Ana Q.');
  });

  test('the local part accepts the characters real addresses use', () => {
    for (const email of [
      'ana+receipts@example.com',
      "o'brien@example.com",
      'a.b.c@example.com',
      'a_b-c=d@example.com',
      'ana@sub.domain.co.uk',
      'ana@[10.0.0.1]',
      'ana@[IPv6:::1]',
    ]) {
      expect(parseAddress(email).email).toBe(email);
    }
  });

  test('a structured address is checked just like a string', () => {
    expect(parseAddress({ email: ' ana@example.com ', name: ' Ana ' })).toEqual({
      email: 'ana@example.com',
      name: 'Ana',
    });
    expect(() => parseAddress({ email: 'not-an-address' })).toThrow(/no `@`/u);
  });
});

describe('formatting', () => {
  test('a plain name is not quoted; a name with syntax is', () => {
    expect(formatAddress({ email: 'ana@example.com', name: 'Ana Reyes' })).toBe(
      'Ana Reyes <ana@example.com>',
    );
    // A comma or a quote in a display name breaks a header unless it is quoted — and a quoted
    // name is also where a smuggled `"` has to be escaped.
    expect(formatAddress({ email: 'ana@example.com', name: 'Reyes, Ana' })).toBe(
      '"Reyes, Ana" <ana@example.com>',
    );
    expect(formatAddress({ email: 'ana@example.com', name: 'Ana "AJ" Reyes' })).toBe(
      '"Ana \\"AJ\\" Reyes" <ana@example.com>',
    );
    expect(formatAddress({ email: 'ana@example.com' })).toBe('ana@example.com');
  });
});

describe('lists', () => {
  test('a comma inside a display name or an angle bracket does not split the list', () => {
    expect(splitAddressList('"Reyes, Ana" <ana@example.com>, bo@example.com')).toEqual([
      '"Reyes, Ana" <ana@example.com>',
      'bo@example.com',
    ]);
    expect(splitAddressList('a@example.com,, b@example.com ,')).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });

  test('parseAddresses maps, and an empty list stays empty', () => {
    expect(parseAddresses(['a@example.com', 'B <b@example.com>'])).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com', name: 'B' },
    ]);
    expect(parseAddresses(undefined)).toEqual([]);
  });
});
