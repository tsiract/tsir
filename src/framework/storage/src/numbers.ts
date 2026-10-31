/**
 * A count from a header or an XML attribute — `1` → `1`, `"abc"` → `undefined`.
 *
 * `Number("")` is `0`, `Number("12abc")` is `NaN`, and `Number(" 3 ")` is `3`. A storage driver
 * builds range requests and reports byte sizes out of these strings, so a silent coercion here is
 * a wrong `content-length` or a `Range` header nobody asked for. The digits are checked and then
 * accumulated, which makes the set of accepted inputs exactly the set of strings that are numbers.
 *
 * `15` digits rather than `Number.MAX_SAFE_INTEGER`: past that an object size is not a size, it is
 * a broken server, and reporting `undefined` is the honest answer.
 */
export function parseCount(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return accumulate(value.trim(), 10, Number.MAX_SAFE_INTEGER);
}

/** `0`–`9` (and `a`–`f` for hex) as a value, or `-1` for anything else. */
function digitValue(character: string, radix: 10 | 16): number {
  const code = character.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (radix === 16) {
    if (code >= 97 && code <= 102) return code - 87;
    if (code >= 65 && code <= 70) return code - 55;
  }
  return -1;
}

/**
 * A bare digit string in `10` or `16`, or `undefined`.
 *
 * Exists so an XML entity (`&#38;`, `&#x26;`) is decoded by a check-and-accumulate rather than by
 * `parseInt`, which reads `"26abc"` as `26` and `""` as `NaN` — two ways to put a wrong character
 * in a bucket key, which is the one field this package must not get wrong.
 */
export function parseDigits(text: string, radix: 10 | 16): number | undefined {
  // `0x10FFFF` is the last code point Unicode defines; anything above it is not an entity, and
  // `String.fromCodePoint` would throw a `RangeError` inside a listing parser.
  return accumulate(text, radix, 0x10ffff);
}

/**
 * The digit walk both parsers share.
 *
 * `limit` is checked *before* the multiply, so a value that would lose precision is refused rather
 * than rounded — `Number("9007199254740993")` is `9007199254740992` and nothing says so.
 */
function accumulate(text: string, radix: 10 | 16, limit: number): number | undefined {
  if (text === '') return undefined;
  let total = 0;
  for (const character of text) {
    const value = digitValue(character, radix);
    if (value < 0) return undefined;
    if (total > (limit - value) / radix) return undefined;
    total = total * radix + value;
  }
  return total;
}
