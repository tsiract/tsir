/**
 * Field shapes (`LNK-016` runtime half).
 *
 * These are the functions a generated module calls, so their strictness *is* the contract:
 * a response with an undeclared field, a missing required field, or a number that is not a
 * number must fail where the WSDL is interpreted, not somewhere downstream.
 */

import { describe, expect, test } from 'bun:test';

import { parseDecimal, shapeFromXml, shapeToXml, type SoapFieldShape } from './soap.ts';
import { parseXml, serializeXml, textOf, childNamed } from './soap.ts';

const FIELDS: readonly SoapFieldShape[] = [
  { name: 'rate', type: 'number' },
  { name: 'exempt', type: 'boolean', required: false },
  { name: 'note', type: 'string', required: false, repeated: true },
  { name: 'country', type: 'string', required: false },
];

describe('field shapes — encoding (LNK-016)', () => {
  test('records become elements, arrays repeat, absent optional fields are omitted', () => {
    const element = shapeToXml('GetTaxRate', 'urn:tax', { country: 'SG', note: undefined }, [
      { name: 'country', type: 'string' },
      { name: 'note', type: 'string', required: false, repeated: true },
    ]);

    const parsed = parseXml(serializeXml(element));
    expect(parsed.attributes['xmlns']).toBe('urn:tax');
    expect(textOf(childNamed(parsed, 'country') ?? parsed)).toBe('SG');
    expect(childNamed(parsed, 'note')).toBeUndefined();
  });

  test('a missing required field is a programming error, not an empty element', () => {
    expect(() => shapeToXml('Op', undefined, {}, [{ name: 'rate', type: 'number' }])).toThrow(
      /required by the contract/,
    );
  });

  test('a value of the wrong scalar type is refused', () => {
    expect(() =>
      shapeToXml('Op', undefined, { rate: '7' }, [{ name: 'rate', type: 'number' }]),
    ).toThrow(/must be a number/);
  });
});

describe('field shapes — decoding (LNK-016)', () => {
  test('decodes scalars, arrays and optional fields', () => {
    const parsed = parseXml(
      '<GetTaxRateResponse><rate>7.25</rate><exempt>false</exempt><note>a</note><note>b</note></GetTaxRateResponse>',
    );

    expect(shapeFromXml(parsed, FIELDS)).toEqual({
      rate: 7.25,
      exempt: false,
      note: ['a', 'b'],
    });
  });

  test('an undeclared field fails loudly — the contract changed under us', () => {
    const parsed = parseXml('<R><rate>7</rate><surprise>x</surprise></R>');
    expect(() => shapeFromXml(parsed, FIELDS)).toThrow(/undeclared field/);
  });

  test('a missing required field fails; a missing optional one does not', () => {
    expect(() => shapeFromXml(parseXml('<R><exempt>true</exempt></R>'), FIELDS)).toThrow(
      /missing required field "rate"/,
    );
    expect(shapeFromXml(parseXml('<R><rate>1</rate></R>'), FIELDS)).toEqual({ rate: 1 });
  });

  test('a scalar that is not what it claims is a protocol failure, not a guess', () => {
    expect(() => shapeFromXml(parseXml('<R><rate>seven</rate></R>'), FIELDS)).toThrow(
      /not a decimal/,
    );
    expect(() =>
      shapeFromXml(parseXml('<R><rate>7</rate><exempt>maybe</exempt></R>'), FIELDS),
    ).toThrow(/not a boolean/);
  });

  test('a repeated element where the schema allows one is refused', () => {
    expect(() => shapeFromXml(parseXml('<R><rate>1</rate><rate>2</rate></R>'), FIELDS)).toThrow(
      /repeats field/,
    );
  });
});

describe('decimal parsing (VLD-007)', () => {
  test('accepts plain decimals and nothing else', () => {
    expect(parseDecimal('0')).toBe(0);
    expect(parseDecimal('7.25')).toBe(7.25);
    expect(parseDecimal('-3.5')).toBe(-3.5);

    // Everything `Number()` would have accepted and silently distorted.
    for (const rejected of ['', ' 7 ', '0x10', '1e9', '7,5', '1_000', '.5']) {
      expect(parseDecimal(rejected)).toBeUndefined();
    }
  });
});
