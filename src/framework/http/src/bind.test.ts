/**
 * Request binding (`HTP-*`, SEC-012).
 *
 * The query string is the one place an attacker chooses object keys in a request that no schema
 * has seen yet, so the names it may not use are pinned here rather than inferred from the body
 * parser's behaviour.
 */

import { describe, expect, test } from 'bun:test';

import { searchParamsToObject } from './bind.ts';

describe('query string → object (SEC-012)', () => {
  test('a repeated __proto__ key does not replace the result prototype with an array', () => {
    const out = searchParamsToObject(new URLSearchParams('__proto__=a&__proto__=b&ok=1'));
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['ok']);
    expect(out['ok']).toBe('1');
  });

  test('constructor and prototype are skipped as well', () => {
    const out = searchParamsToObject(
      new URLSearchParams('constructor=x&prototype=y&constructor=z&page=2'),
    );
    expect(Object.keys(out)).toEqual(['page']);
  });

  test('ordinary repeated keys still become arrays, and single keys stay strings', () => {
    const out = searchParamsToObject(new URLSearchParams('tag=a&tag=b&q=c'));
    expect(out).toEqual({ tag: ['a', 'b'], q: 'c' });
  });
});
