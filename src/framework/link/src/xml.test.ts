/**
 * The XML reader (`LNK-018`).
 *
 * The negative half is the important half: every test here that expects a throw is a
 * class of attack that cannot reach a SOAP handler because the document never becomes a
 * tree. That is the argument for writing the reader at all (ADR-0023) — a configuration
 * can be undone by the next upgrade; a grammar without DTD support cannot.
 */

import { describe, expect, test } from 'bun:test';

import {
  XmlParseError,
  attributeNamed,
  childNamed,
  childrenNamed,
  elementChildren,
  isElement,
  parseXml,
  recordFromXml,
  serializeXml,
  textOf,
  xmlElement,
  xmlLeaf,
} from './xml.ts';

function codeOf(
  source: string,
  limits?: { maxBytes?: number; maxDepth?: number; maxNodes?: number },
): string {
  try {
    parseXml(source, limits);
  } catch (error) {
    if (error instanceof XmlParseError) return error.code;
    throw error;
  }
  throw new Error('expected the document to be refused');
}

describe('XML reader — the happy path (LNK-018)', () => {
  test('elements, attributes, namespaces and text are read as written', () => {
    const root = parseXml(
      `<?xml version="1.0"?>
       <soap:Envelope xmlns:soap="urn:soap" xmlns="urn:app">
         <soap:Body>
           <GetTaxRate country="SG" xmlns:xsi="urn:xsi">
             <category>digital</category>
             <note>5 &lt; 7 &amp;&amp; 3 &gt; 1</note>
             <nil xsi:nil="true"/>
           </GetTaxRate>
         </soap:Body>
       </soap:Envelope>`,
    );

    expect(root.localName).toBe('Envelope');
    expect(root.namespace).toBe('urn:soap');
    const body = childNamed(root, 'Body');
    expect(body?.namespace).toBe('urn:soap');

    const operation = childNamed(body ?? root, 'GetTaxRate');
    expect(operation?.namespace).toBe('urn:app');
    expect(attributeNamed(operation ?? root, 'country')).toBe('SG');
    expect(textOf(childNamed(operation ?? root, 'note') ?? root)).toBe('5 < 7 && 3 > 1');
    expect(attributeNamed(childNamed(operation ?? root, 'nil') ?? root, 'nil')).toBe('true');
  });

  test('CDATA is text, and comments and processing instructions are skipped', () => {
    const root = parseXml('<a><!-- note --><?target data?><b><![CDATA[<raw> & text]]></b></a>');

    expect(elementChildren(root).map((child) => child.localName)).toEqual(['b']);
    expect(textOf(childNamed(root, 'b') ?? root)).toBe('<raw> & text');
  });

  test('numeric character references decode', () => {
    const root = parseXml('<a>&#65;&#x42;</a>');
    expect(textOf(root)).toBe('AB');
  });

  test('serialising escapes everything that could re-open a tag', () => {
    const node = xmlElement('a', {
      attributes: { quote: `"'&<>` },
      children: [xmlLeaf('b', '</b><script>')],
    });

    expect(serializeXml(node)).toBe(
      '<a quote="&quot;&apos;&amp;&lt;&gt;"><b>&lt;/b&gt;&lt;script&gt;</b></a>',
    );
  });
});

describe('XML reader — refusals (LNK-018)', () => {
  test('a DOCTYPE is refused, so no DTD exists to declare entities with', () => {
    expect(codeOf('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a/>')).toBe('XML_UNSAFE');
  });

  test('an entity declaration inside the tree is refused', () => {
    expect(codeOf('<a><!ENTITY lol "lol"></a>')).toBe('XML_UNSAFE');
  });

  test('the billion-laughs payload cannot expand: there is nothing to expand', () => {
    const laughs = `<?xml version="1.0"?>
      <!DOCTYPE lolz [
        <!ENTITY lol "lol">
        <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
        <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
      ]>
      <lolz>&lol2;</lolz>`;

    expect(codeOf(laughs)).toBe('XML_UNSAFE');
  });

  test('an external entity reference is refused rather than fetched or dropped', () => {
    expect(codeOf('<a>&xxe;</a>')).toBe('XML_UNSAFE');
  });

  test('a bare ampersand is ambiguous input, not text', () => {
    expect(codeOf('<a>fish & chips</a>')).toBe('XML_UNSAFE');
  });

  test('a character reference to NUL is refused', () => {
    expect(codeOf('<a>&#0;</a>')).toBe('XML_UNSAFE');
  });

  test('malformed structure is malformed, not unsafe', () => {
    expect(codeOf('<a><b></a>')).toBe('XML_MALFORMED');
    expect(codeOf('<a x="1" x="2"/>')).toBe('XML_MALFORMED');
    expect(codeOf('<a>')).toBe('XML_MALFORMED');
    expect(codeOf('<a/><b/>')).toBe('XML_MALFORMED');
    expect(codeOf('text only')).toBe('XML_MALFORMED');
    expect(codeOf('')).toBe('XML_MALFORMED');
  });

  test('nesting beyond the depth ceiling is refused while scanning', () => {
    const deep = `${'<a>'.repeat(10)}${'</a>'.repeat(10)}`;
    expect(codeOf(deep, { maxDepth: 3 })).toBe('XML_TOO_LARGE');
    expect(() => parseXml(deep, { maxDepth: 10 })).not.toThrow();
  });

  test('the byte ceiling and the node ceiling are both enforced', () => {
    expect(codeOf(`<a>${'x'.repeat(200)}</a>`, { maxBytes: 64 })).toBe('XML_TOO_LARGE');
    expect(codeOf('<a><b/><b/><b/></a>', { maxNodes: 2 })).toBe('XML_TOO_LARGE');
  });
});

describe('XML → record (LNK-018)', () => {
  test('leaves stay strings — no coercion of numbers or booleans (VLD-007)', () => {
    const root = parseXml('<order><total>007</total><paid>false</paid><empty/></order>');
    expect(recordFromXml(root)).toEqual({
      total: '007',
      paid: 'false',
      empty: '',
    });
  });

  test('repeated elements become an array; nesting becomes a record', () => {
    const root = parseXml(
      '<order><line><sku>a</sku></line><line><sku>b</sku></line><customer><id>c1</id></customer></order>',
    );
    expect(recordFromXml(root)).toEqual({
      line: [{ sku: 'a' }, { sku: 'b' }],
      customer: { id: 'c1' },
    });
  });

  test('childrenNamed and isElement narrow the way callers need', () => {
    const root = parseXml('<a><b>1</b><b>2</b></a>');
    expect(childrenNamed(root, 'b').map(textOf)).toEqual(['1', '2']);
    expect(isElement(root.children[0] ?? { text: '' })).toBe(true);
  });
});

describe('XML → record: object-prototype names (SEC-012)', () => {
  test('an element named __proto__ is refused, not merged into the record prototype', () => {
    const doc = parseXml('<root><__proto__><polluted>yes</polluted></__proto__></root>');
    let refusal: unknown;
    try {
      recordFromXml(doc);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(XmlParseError);
    expect((refusal as XmlParseError).code).toBe('XML_UNSAFE');
  });

  test('constructor and prototype are refused the same way; ordinary names are untouched', () => {
    for (const name of ['constructor', 'prototype']) {
      expect(() => recordFromXml(parseXml(`<root><${name}>x</${name}></root>`))).toThrow(
        /forbidden object key/u,
      );
    }
    const ok = recordFromXml(parseXml('<root><orderId>o-1</orderId></root>'));
    expect(Object.keys(ok)).toEqual(['orderId']);
    expect(Object.getPrototypeOf(ok)).toBe(Object.prototype);
  });
});
