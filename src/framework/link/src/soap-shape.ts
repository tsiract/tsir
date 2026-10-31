/**
 * Declarative shapes for SOAP bodies — what `tsir link:soap:gen` emits, and what the
 * runtime interprets.
 *
 * A shape is data: a field name, a scalar type and a cardinality. The generator writes
 * shapes plus TypeScript interfaces; nothing here walks a WSDL, and nothing reflects over
 * types at runtime. That keeps three promises at once — the contract is compiled before
 * deploy, the wire format is explicit, and a field that changes shape fails in one place
 * with a message naming the field.
 *
 * Scalars are decoded strictly (VLD-007). `"7"` is a number only when the shape says
 * `number` *and* the text is a decimal; `"1e9"`, `" 7"` and `"7,5"` are errors, not
 * approximations.
 */

import { TsirError } from '@tsir/core';
import {
  childNamed,
  childrenNamed,
  elementChildren,
  isElement,
  textOf,
  xmlElement,
  type XmlElement,
} from './xml.ts';

export type SoapScalar = 'string' | 'number' | 'boolean';

export interface SoapFieldShape {
  /** The element name in the body, as the WSDL spells it. */
  readonly name: string;
  readonly type: SoapScalar;
  /** Default true. `minOccurs="0"` in the XSD becomes `false`. */
  readonly required?: boolean | undefined;
  /** `maxOccurs="unbounded"` (or > 1) becomes `true`. */
  readonly repeated?: boolean | undefined;
  /** Present for a nested complexType: one level of nesting is compiled, deeper is not. */
  readonly fields?: readonly SoapFieldShape[] | undefined;
}

/** A decoded field value. Nested records stay records; nothing is coerced implicitly. */
export type SoapShapeValue =
  | string
  | number
  | boolean
  | null
  | readonly SoapShapeValue[]
  | { readonly [key: string]: SoapShapeValue };

export type SoapShapeRecord = Readonly<Record<string, SoapShapeValue>>;

/** Record → body element. Arrays repeat the element; `undefined` and `null` are omitted. */
export function shapeToXml(
  name: string,
  namespace: string | undefined,
  value: Readonly<Record<string, unknown>>,
  fields: readonly SoapFieldShape[],
): XmlElement {
  const children = fields.flatMap((field) => {
    const fieldValue = value[field.name];
    if (fieldValue === undefined || fieldValue === null) {
      if (field.required === false) return [];
      throw schemaError(`field "${field.name}" is required by the contract but missing`);
    }

    const values: readonly unknown[] =
      field.repeated === true ? (fieldValue as readonly unknown[]) : [fieldValue];
    return values.map((item) => toNode(field, item));
  });

  return xmlElement(name, {
    ...(namespace === undefined ? {} : { attributes: { xmlns: namespace } }),
    children,
  });
}

function toNode(field: SoapFieldShape, value: unknown): XmlElement {
  if (field.fields !== undefined) {
    if (typeof value !== 'object' || value === null) {
      throw schemaError(`field "${field.name}" must be an object`);
    }
    return shapeToXml(
      field.name,
      undefined,
      value as Readonly<Record<string, unknown>>,
      field.fields,
    );
  }

  if (field.type === 'string' && typeof value !== 'string') {
    throw schemaError(`field "${field.name}" must be a string`);
  }
  if (field.type === 'number' && typeof value !== 'number') {
    throw schemaError(`field "${field.name}" must be a number`);
  }
  if (field.type === 'boolean' && typeof value !== 'boolean') {
    throw schemaError(`field "${field.name}" must be a boolean`);
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw schemaError(`field "${field.name}" has no scalar representation`);
  }

  return xmlElement(field.name, { children: [{ text: String(value) }] });
}

/**
 * Body element → record, validated field by field.
 *
 * Throws on anything the contract does not allow: a missing required field, a repeated
 * element where the schema says one, or a scalar that is not what it claims. The client
 * turns a throw from `decode` into `LNK_PROTOCOL`, which is the right classification —
 * the remote side broke the contract.
 */
export function shapeFromXml(
  element: XmlElement,
  fields: readonly SoapFieldShape[],
): SoapShapeRecord {
  const record: Record<string, SoapShapeValue> = {};

  for (const field of fields) {
    const matches = childrenNamed(element, field.name);

    if (matches.length === 0) {
      if (field.required === false) continue;
      throw schemaError(`response is missing required field "${field.name}"`);
    }
    if (field.repeated !== true && matches.length > 1) {
      throw schemaError(`response repeats field "${field.name}" but the contract allows one`);
    }

    const decoded = matches.map((match) => decodeValue(field, match));
    record[field.name] = field.repeated === true ? decoded : (decoded[0] ?? null);
  }

  const unknown = elementChildren(element)
    .map((child) => child.localName)
    .filter((name) => !fields.some((field) => field.name === name));
  if (unknown.length > 0) {
    throw schemaError(`response contains undeclared field(s): ${unknown.join(', ')}`);
  }

  return record;
}

function decodeValue(field: SoapFieldShape, element: XmlElement): SoapShapeValue {
  if (field.fields !== undefined) return shapeFromXml(element, field.fields);

  const text = textOf(element);
  if (field.type === 'string') return text;
  if (field.type === 'boolean') {
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
    throw schemaError(`field "${field.name}" is not a boolean: "${text}"`);
  }

  const number = parseDecimal(text);
  if (number === undefined) throw schemaError(`field "${field.name}" is not a decimal: "${text}"`);
  return number;
}

/**
 * Decimal → number, with no prefix parsing and no exponent notation.
 *
 * Hand-written because `Number()` accepts `""`, `" 7 "`, `"0x10"` and `"1e9"` — every one
 * of which would turn a malformed SOAP field into a silently wrong charge amount.
 */
export function parseDecimal(text: string): number | undefined {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/u.exec(text);
  if (match === null) return undefined;

  const [, sign, integer, fraction] = match;
  let value = 0;
  for (const digit of integer ?? '') value = value * 10 + '0123456789'.indexOf(digit);
  for (let index = 0; index < (fraction?.length ?? 0); index += 1) {
    const digit = '0123456789'.indexOf(fraction?.[index] ?? '');
    value += digit / 10 ** (index + 1);
  }
  return sign === '-' ? -value : value;
}

/** True when the element is a leaf with text and no children — used by generated decoders. */
export function isLeaf(element: XmlElement): boolean {
  return element.children.every((child) => !isElement(child));
}

/** Re-exported so generated modules import from one place. */
export { childNamed, elementChildren };

function schemaError(message: string): TsirError {
  return new TsirError('LNK_SCHEMA', message, { kind: 'link' });
}
