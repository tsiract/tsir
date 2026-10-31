/**
 * XML for SOAP, without a general-purpose XML parser (`LNK-018`).
 *
 * An earlier draft named `fast-xml-parser`. It is a fine library and it is not vendored here,
 * because at the version available to us it pulls six transitive packages for a feature
 * set we do not use — and the feature set we *do* need is the one that has to be safe:
 *
 *   · **no DTD.** `<!DOCTYPE …>` is refused outright, which is what makes external
 *     entities (XXE), entity expansion (billion laughs) and parameter entities impossible
 *     rather than merely disabled. A parser that supports DTD and then turns it off is one
 *     configuration mistake away from a vulnerability; a parser that never had it is not.
 *   · **five entities, decoded by us.** `&lt; &gt; &amp; &quot; &apos;` and numeric
 *     character references. Anything else — `&xxe;`, `&lol;` — is `XML_UNSAFE`, not text.
 *   · **bounded.** Byte, depth and node ceilings, checked while scanning, so a hostile
 *     document fails at the first violation instead of after allocating a tree.
 *   · **no coercion.** Values stay strings; `"0"` is not `0` and `"false"` is not `false`
 *     (VLD-007 applies to XML too). The SOAP layer validates with a schema, not with
 *     guesses.
 *
 * The alternative — a hardened configuration of a general parser — is defensible for a
 * library. It is not defensible for a *contract*: our tests can prove what this file
 * accepts, and nobody has to re-read someone else's parser options when a CVE lands.
 *
 * See ADR-0023 for the decision and its cost.
 */

/** Why a document was refused. Callers map these onto `LNK_PROTOCOL`. */
export type XmlErrorCode = 'XML_MALFORMED' | 'XML_UNSAFE' | 'XML_TOO_LARGE';

export class XmlParseError extends Error {
  readonly code: XmlErrorCode;

  constructor(code: XmlErrorCode, message: string) {
    super(message);
    this.name = 'XmlParseError';
    this.code = code;
  }
}

export interface XmlElement {
  /** Qualified name, exactly as written (`soap:Body`). */
  readonly name: string;
  /** Name after the first `:`. Namespace prefixes are presentation, never identity. */
  readonly localName: string;
  readonly prefix: string | undefined;
  /** Namespace URI in scope for this element, resolved from `xmlns`/`xmlns:p`. */
  readonly namespace: string | undefined;
  /** Qualified attribute names → decoded values. `xmlns` declarations are kept. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export interface XmlText {
  readonly text: string;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlLimits {
  /** Default 1 MiB: a SOAP body larger than this is not a message, it is an attack. */
  readonly maxBytes?: number | undefined;
  /** Default 64. Envelopes are shallow; deeply nested bodies are a stack to play with. */
  readonly maxDepth?: number | undefined;
  /** Default 20 000, counting elements only. */
  readonly maxNodes?: number | undefined;
}

const DEFAULT_LIMITS = { maxBytes: 1_048_576, maxDepth: 64, maxNodes: 20_000 } as const;

/** The name token this parser accepts: letters, digits, `-`, `_`, `.`, one `:`. */
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;
const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

export function isElement(node: XmlNode): node is XmlElement {
  return 'name' in node;
}

/** Direct text children concatenated — the value of a leaf element. */
export function textOf(element: XmlElement): string {
  return element.children
    .filter((child): child is XmlText => !isElement(child))
    .map((child) => child.text)
    .join('');
}

export function elementChildren(element: XmlElement): readonly XmlElement[] {
  return element.children.filter(isElement);
}

/** First direct child with a matching local name, regardless of prefix. */
export function childNamed(element: XmlElement, localName: string): XmlElement | undefined {
  return elementChildren(element).find((child) => child.localName === localName);
}

export function childrenNamed(element: XmlElement, localName: string): readonly XmlElement[] {
  return elementChildren(element).filter((child) => child.localName === localName);
}

/** Attribute by local name, regardless of prefix (`soap:mustUnderstand` → `mustUnderstand`). */
export function attributeNamed(element: XmlElement, localName: string): string | undefined {
  for (const [name, value] of Object.entries(element.attributes)) {
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    if (local === localName) return value;
  }
  return undefined;
}

/**
 * Parses a document and returns its root element.
 *
 * Throws `XmlParseError`; it never returns a partial tree and never fetches anything —
 * there is no code path here that performs I/O.
 */
export function parseXml(source: string, limits: XmlLimits = {}): XmlElement {
  const maxBytes = limits.maxBytes ?? DEFAULT_LIMITS.maxBytes;
  const maxDepth = limits.maxDepth ?? DEFAULT_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? DEFAULT_LIMITS.maxNodes;

  // `source.length` is UTF-16 units; the ceiling is bytes, so count the encoded length.
  // `TextEncoder` rather than `Buffer`: this module has to bundle for Workers, where a
  // `node:` import would be an undefined global at runtime rather than a build error.
  if (new TextEncoder().encode(source).length > maxBytes) {
    throw new XmlParseError('XML_TOO_LARGE', `document exceeds ${String(maxBytes)} bytes`);
  }

  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nodes = 0;

  const fail = (code: XmlErrorCode, message: string): never => {
    throw new XmlParseError(code, `${message} (at offset ${String(index)})`);
  };

  const atEnd = (): boolean => index >= source.length;
  const startsWith = (token: string): boolean => source.startsWith(token, index);

  /** Text before the next `<`, with predefined and numeric references decoded. */
  const readText = (): string => {
    const end = source.indexOf('<', index);
    const stop = end === -1 ? source.length : end;
    const raw = source.slice(index, stop);
    index = stop;
    return decodeEntities(raw, (message) => fail('XML_UNSAFE', message));
  };

  const skipMisc = (): void => {
    for (;;) {
      while (!atEnd() && /\s/u.test(source.charAt(index))) index += 1;
      if (atEnd()) return;

      if (startsWith('<!--')) {
        const end = source.indexOf('-->', index + 4);
        if (end === -1) fail('XML_MALFORMED', 'unterminated comment');
        const body = source.slice(index + 4, end);
        if (body.includes('--')) fail('XML_MALFORMED', '`--` inside a comment');
        index = end + 3;
        continue;
      }
      if (startsWith('<?')) {
        const end = source.indexOf('?>', index + 2);
        if (end === -1) fail('XML_MALFORMED', 'unterminated processing instruction');
        index = end + 2;
        continue;
      }
      if (startsWith('<!')) {
        // Every other `<!` construct in XML is a markup declaration: DOCTYPE, ENTITY,
        // ELEMENT, ATTLIST, NOTATION, conditional sections. We support none of them, so
        // the whole class is refused by name rather than parsed and ignored.
        const keyword = /^<!\s*([A-Za-z]+)/.exec(source.slice(index, index + 32))?.[1] ?? '';
        return fail(
          'XML_UNSAFE',
          `markup declaration <!${keyword || '…'}> is not accepted: DTDs, entity declarations and conditional sections are refused so XXE and entity expansion cannot occur`,
        );
      }
      return;
    }
  };

  const parseElement = (depth: number, inherited: ReadonlyMap<string, string>): XmlElement => {
    // Caller guarantees `source[index] === '<'` and that a name follows.
    index += 1;
    const nameMatch = NAME.exec(source.slice(index));
    if (nameMatch === null) return fail('XML_MALFORMED', 'element name expected');
    const name = nameMatch[0];
    index += name.length;

    nodes += 1;
    if (nodes > maxNodes) fail('XML_TOO_LARGE', `document exceeds ${String(maxNodes)} elements`);
    if (depth > maxDepth) fail('XML_TOO_LARGE', `element nesting exceeds ${String(maxDepth)}`);

    const attributes: Record<string, string> = {};
    for (;;) {
      const hadSpace = /\s/u.test(source.charAt(index));
      while (!atEnd() && /\s/u.test(source.charAt(index))) index += 1;
      if (atEnd()) return fail('XML_MALFORMED', `unterminated start tag <${name}>`);

      if (startsWith('/>')) {
        index += 2;
        return finish(name, attributes, [], inherited);
      }
      if (source.charAt(index) === '>') {
        index += 1;
        break;
      }
      if (!hadSpace) return fail('XML_MALFORMED', `attributes of <${name}> must be separated`);

      const attribute = NAME.exec(source.slice(index));
      if (attribute === null) return fail('XML_MALFORMED', `attribute name expected in <${name}>`);
      const attributeName = attribute[0];
      index += attributeName.length;
      while (!atEnd() && /\s/u.test(source.charAt(index))) index += 1;
      if (source.charAt(index) !== '=') {
        return fail('XML_MALFORMED', `attribute "${attributeName}" has no value`);
      }
      index += 1;
      while (!atEnd() && /\s/u.test(source.charAt(index))) index += 1;

      const quote = source.charAt(index);
      if (quote !== '"' && quote !== "'") {
        return fail('XML_MALFORMED', `attribute "${attributeName}" must be quoted`);
      }
      const end = source.indexOf(quote, index + 1);
      if (end === -1) return fail('XML_MALFORMED', `unterminated value for "${attributeName}"`);
      const value = decodeEntities(source.slice(index + 1, end), (message) =>
        fail('XML_UNSAFE', message),
      );
      index = end + 1;
      if (Object.hasOwn(attributes, attributeName)) {
        return fail('XML_MALFORMED', `duplicate attribute "${attributeName}"`);
      }
      attributes[attributeName] = value;
    }

    const scope = new Map(inherited);
    for (const [attributeName, value] of Object.entries(attributes)) {
      if (attributeName === 'xmlns') scope.set('', value);
      else if (attributeName.startsWith('xmlns:')) scope.set(attributeName.slice(6), value);
    }

    const children: XmlNode[] = [];
    for (;;) {
      if (atEnd()) return fail('XML_MALFORMED', `unterminated element <${name}>`);

      if (startsWith('</')) {
        const end = source.indexOf('>', index);
        if (end === -1) return fail('XML_MALFORMED', 'unterminated end tag');
        const closing = source.slice(index + 2, end).trim();
        if (closing !== name) {
          return fail('XML_MALFORMED', `</${closing}> closes <${name}>`);
        }
        index = end + 1;
        return finish(name, attributes, children, inherited);
      }

      if (startsWith('<![CDATA[')) {
        const end = source.indexOf(']]>', index + 9);
        if (end === -1) return fail('XML_MALFORMED', 'unterminated CDATA section');
        children.push({ text: source.slice(index + 9, end) });
        index = end + 3;
        continue;
      }
      if (startsWith('<!--')) {
        const end = source.indexOf('-->', index + 4);
        if (end === -1) return fail('XML_MALFORMED', 'unterminated comment');
        index = end + 3;
        continue;
      }
      if (startsWith('<?')) {
        const end = source.indexOf('?>', index + 2);
        if (end === -1) return fail('XML_MALFORMED', 'unterminated processing instruction');
        index = end + 2;
        continue;
      }
      if (startsWith('<!')) {
        return fail(
          'XML_UNSAFE',
          'markup declaration inside an element: DTDs, entity declarations and conditional sections are refused',
        );
      }
      if (startsWith('<')) {
        children.push(parseElement(depth + 1, scope));
        continue;
      }
      const text = readText();
      if (text !== '') children.push({ text });
    }
  };

  const finish = (
    name: string,
    attributes: Record<string, string>,
    children: XmlNode[],
    inherited: ReadonlyMap<string, string>,
  ): XmlElement => {
    const parts = name.split(':');
    const localName = parts.length > 1 ? (parts[1] ?? name) : name;
    const prefix = parts.length > 1 ? parts[0] : undefined;
    const scope = new Map(inherited);
    for (const [attributeName, value] of Object.entries(attributes)) {
      if (attributeName === 'xmlns') scope.set('', value);
      else if (attributeName.startsWith('xmlns:')) scope.set(attributeName.slice(6), value);
    }
    const namespace = scope.get(prefix ?? '');
    return {
      name,
      localName,
      prefix,
      namespace: namespace === undefined || namespace === '' ? undefined : namespace,
      attributes,
      children,
    };
  };

  // `<?xml …?>` is not a processing instruction in the grammar; accept it once, at the top.
  if (/^<\?xml[\s?]/u.test(source.slice(index))) {
    const end = source.indexOf('?>', index);
    if (end === -1) fail('XML_MALFORMED', 'unterminated XML declaration');
    index = end + 2;
  }

  skipMisc();
  if (atEnd()) return fail('XML_MALFORMED', 'no root element');
  if (!startsWith('<')) return fail('XML_MALFORMED', 'text before the root element');

  const root = parseElement(1, new Map());

  skipMisc();
  if (!atEnd()) return fail('XML_MALFORMED', 'content after the root element');

  return root;
}

const DIGITS = '0123456789abcdef';

/** Digits → code point, without a prefix-parsing conversion (VLD-007). */
function codePointOf(digits: string, radix: 10 | 16): number {
  let value = 0;
  for (const character of digits.toLowerCase()) {
    const digit = DIGITS.indexOf(character);
    if (digit === -1 || digit >= radix) return -1;
    value = value * radix + digit;
  }
  return value;
}

function decodeEntities(raw: string, fail: (message: string) => never): string {
  if (!raw.includes('&')) return raw;

  // A `&` that is not the start of a reference is ambiguous input, not text: `&lol` could
  // be a truncated entity, and guessing makes "is this escaped?" unanswerable.
  const stray = /&(?!(?:#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6}|[A-Za-z][\w.-]*);)/u.exec(raw);
  if (stray !== null) fail('a bare "&" must be written &amp;');

  return raw.replaceAll(
    /&(#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6}|[A-Za-z][\w.-]*);/gu,
    (_match, body: string) => {
      const code = body.startsWith('#x')
        ? codePointOf(body.slice(2), 16)
        : body.startsWith('#')
          ? codePointOf(body.slice(1), 10)
          : -1;

      if (code !== -1) {
        if (code === 0 || code > 0x10ffff) {
          return fail(`character reference "&${body};" is outside the XML character range`);
        }
        return String.fromCodePoint(code);
      }

      const known = PREDEFINED[body];
      return (
        known ?? fail(`entity "&${body};" is not defined; only the five XML entities are accepted`)
      );
    },
  );
}

/** Escapes text content. `>` is escaped too, so `]]>` can never appear. */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Renders a node back to XML. Used for requests and for test fixtures. */
export function serializeXml(node: XmlNode): string {
  if (!isElement(node)) return escapeXmlText(node.text);

  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${escapeXmlText(value)}"`)
    .join('');
  if (node.children.length === 0) return `<${node.name}${attributes}/>`;
  const inner = node.children.map(serializeXml).join('');
  return `<${node.name}${attributes}>${inner}</${node.name}>`;
}

export interface ElementOptions {
  readonly attributes?: Readonly<Record<string, string>> | undefined;
  readonly children?: readonly XmlNode[] | undefined;
}

/** Builds an element for writing. `name` may be prefixed (`soap:Body`). */
export function xmlElement(name: string, options: ElementOptions = {}): XmlElement {
  const parts = name.split(':');
  return {
    name,
    localName: parts.length > 1 ? (parts[1] ?? name) : name,
    prefix: parts.length > 1 ? parts[0] : undefined,
    namespace: undefined,
    attributes: options.attributes ?? {},
    children: options.children ?? [],
  };
}

/** A leaf element, or an empty element when the text is empty. */
export function xmlLeaf(name: string, text: string): XmlElement {
  return xmlElement(name, { children: text === '' ? [] : [{ text }] });
}

/** A decoded XML subtree: leaves are strings, repeats are arrays. */
export interface XmlRecord {
  readonly [key: string]: XmlValue;
}
export type XmlValue = string | readonly XmlValue[] | XmlRecord;

/** Records → XML. Arrays repeat the element; `null` becomes `xsi:nil`; no coercion. */
export function recordToXml(name: string, value: unknown, namespace?: string): XmlElement {
  if (value === null) {
    return xmlElement(name, {
      attributes: { 'xsi:nil': 'true', 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance' },
    });
  }

  if (Array.isArray(value)) {
    return xmlElement(name, {
      children: value.map((item) => recordToXml('item', item)),
    });
  }

  if (typeof value === 'object') {
    return xmlElement(name, {
      attributes: namespace === undefined ? {} : { xmlns: namespace },
      children: Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => recordToXml(key, child)),
    });
  }

  if (typeof value === 'string') return xmlElement(name, { children: [{ text: value }] });
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return xmlElement(name, { children: [{ text: String(value) }] });
  }
  return xmlElement(name);
}

/**
 * XML → a record of strings (`LNK-018`).
 *
 * Everything is a string on purpose: a SOAP service that means `0` says so in its schema,
 * and inventing numbers here is how `"007"` becomes `7`. Callers decode with their own
 * operation `decode` when the shape is richer than a flat record.
 */
const POLLUTION_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function recordFromXml(element: XmlElement): XmlRecord {
  const children = elementChildren(element);
  if (children.length === 0) return { value: textOf(element) };

  const record: Record<string, XmlValue> = {};
  for (const child of children) {
    const key = child.localName;
    // Refused, not skipped: an element named like an object-prototype key would otherwise rewrite
    // the record's prototype, and the same policy as `body.ts` and multipart applies here.
    if (POLLUTION_NAMES.has(key)) {
      throw new XmlParseError('XML_UNSAFE', `element name "${key}" is a forbidden object key`);
    }
    const value: XmlValue =
      textOf(child) === '' && elementChildren(child).length === 0
        ? ''
        : elementChildren(child).length === 0
          ? textOf(child)
          : recordFromXml(child);

    const existing = record[key];
    if (existing === undefined) record[key] = value;
    else if (Array.isArray(existing)) record[key] = [...(existing as readonly XmlValue[]), value];
    else record[key] = [existing, value];
  }
  return record;
}
