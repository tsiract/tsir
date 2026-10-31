/**
 * `parseCount` / `parseDigits` — the two places a string becomes a number.
 *
 * They are tested directly because their *refusals* are the point: `Number()` would accept `""` as
 * `0` and `"12abc"` as `NaN`, and both of those put a wrong byte count into a `Range` header or a
 * wrong character into a bucket key. Each case below is an input the platform's own parsers would
 * have taken.
 */

import { describe, expect, test } from 'bun:test';

import { decodeEntities } from './list-xml.ts';
import { parseCount, parseDigits } from './numbers.ts';

describe('parseCount', () => {
  test('a plain count parses, and whitespace around it does not matter', () => {
    expect(parseCount('0')).toBe(0);
    expect(parseCount('42')).toBe(42);
    expect(parseCount(' 1024 ')).toBe(1024);
  });

  test('anything that is not a plain count is undefined, not 0 and not NaN', () => {
    for (const value of ['', '  ', 'abc', '12abc', '1e3', '-1', '1.5', '+3', '0x10']) {
      expect(parseCount(value)).toBeUndefined();
    }
    expect(parseCount(undefined)).toBeUndefined();
    expect(parseCount(null)).toBeUndefined();
  });

  test('a number too large to be exact is undefined, rather than a rounded one', () => {
    expect(parseCount(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    // `Number("9007199254740993")` is `9007199254740992`: precision lost, silently.
    expect(parseCount('9007199254740993')).toBeUndefined();
    expect(parseCount('99999999999999999999')).toBeUndefined();
  });
});

describe('parseDigits', () => {
  test('decimal and hexadecimal are read, and leading zeroes are harmless', () => {
    expect(parseDigits('38', 10)).toBe(38);
    expect(parseDigits('0026', 16)).toBe(0x26);
    expect(parseDigits('FF', 16)).toBe(255);
    expect(parseDigits('ff', 16)).toBe(255);
  });

  test('a digit outside the radix voids the whole string', () => {
    expect(parseDigits('', 10)).toBeUndefined();
    expect(parseDigits('38x', 10)).toBeUndefined();
    expect(parseDigits('1g', 16)).toBeUndefined();
    expect(parseDigits('42', 16)).toBe(0x42);
  });

  test('a code point past Unicode is refused, so `fromCodePoint` is never handed one', () => {
    expect(parseDigits('10FFFF', 16)).toBe(0x10ffff);
    expect(parseDigits('110000', 16)).toBeUndefined();
  });
});

describe('numeric entities in a listing', () => {
  test('they decode, in both spellings', () => {
    // A bucket key containing `&` arrives as `&amp;`, and one containing a control character can
    // only arrive numerically — which is exactly why the decoder cannot afford a loose parse.
    expect(decodeEntities('a&amp;b')).toBe('a&b');
    expect(decodeEntities('a&#38;b')).toBe('a&#38;b'.replace('&#38;', '&'));
    expect(decodeEntities('&#x26;')).toBe('&');
  });

  test('an entity the reader does not understand is left alone', () => {
    expect(decodeEntities('&#xZZ;')).toBe('&#xZZ;');
    expect(decodeEntities('&#999999999999;')).toBe('&#999999999999;');
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });
});
