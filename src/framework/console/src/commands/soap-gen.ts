/**
 * `tsir link:soap:gen` (`LNK-016`): a WSDL becomes a typed operations module.
 *
 * The output is a `.gen.ts` file that is **committed**, for the same reason the gRPC
 * contracts are: a service must not fetch a WSDL at boot, and a contract that can change
 * under a running process is not a contract. `--check` compiles in memory and compares, so
 * drift fails a build instead of surprising production.
 *
 * What is compiled — document/literal SOAP 1.1, the shape enterprise services actually
 * publish:
 *
 *   · `xsd:complexType` with `sequence`/`all` → an interface and a field shape;
 *   · `xsd:simpleType` with `enumeration` → a union of string literals;
 *   · `minOccurs="0"` → an optional field; `maxOccurs>1` → an array;
 *   · one level of nested `complexType`, inline or by reference.
 *
 * What is refused or degraded, loudly (each one is a warning in the output and in
 * `--json`): `wsdl:import`, `xsd:include`/`import`, `choice`, attributes, substitution
 * groups, `any`, MTOM attachments, headers and RPC/encoded style. Refusing beats inventing
 * a contract: a wrong type in a generated file is a bug that ships.
 */

import { TsirError } from '@tsir/core';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import {
  childNamed,
  childrenNamed,
  elementChildren,
  parseDecimal,
  parseXml,
  type XmlElement,
} from '@tsir/link/soap';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, ok, style, UsageError, warn, jsonDocument } from '../output.ts';

export interface SoapOperationSummary {
  readonly name: string;
  readonly action: string | undefined;
  readonly request: string;
  readonly response: string;
  readonly namespace: string;
}

export interface SoapGenResult {
  readonly code: string;
  readonly operations: readonly SoapOperationSummary[];
  readonly warnings: readonly string[];
}

interface FieldDef {
  readonly name: string;
  readonly scalar: 'string' | 'number' | 'boolean';
  /** The TypeScript type, which may be a generated enum union. */
  readonly typeName: string;
  readonly required: boolean;
  readonly repeated: boolean;
  readonly fields?: readonly FieldDef[];
}

interface TypeDef {
  readonly fields: readonly FieldDef[];
}

interface EnumDef {
  readonly values: readonly string[];
}

const XSD_STRING = new Set([
  'string',
  'token',
  'normalizedString',
  'anyURI',
  'date',
  'dateTime',
  'time',
  'duration',
  'base64Binary',
  'hexBinary',
  'QName',
  'ID',
  'IDREF',
  'language',
]);

const XSD_NUMBER = new Set([
  'decimal',
  'double',
  'float',
  'int',
  'integer',
  'long',
  'short',
  'byte',
  'unsignedInt',
  'unsignedLong',
  'unsignedShort',
  'unsignedByte',
  'nonNegativeInteger',
  'positiveInteger',
]);

/** Compiles WSDL text into a TypeScript module. Pure: no filesystem, no clock. */
export function generateSoapModule(
  wsdl: string,
  options: { readonly source?: string; readonly moduleName?: string } = {},
): SoapGenResult {
  const warnings: string[] = [];
  const root = parseXml(wsdl, { maxBytes: 8 * 1_048_576 });

  if (root.localName !== 'definitions') {
    throw wsdlInvalid(`expected a WSDL <definitions> root, found <${root.name}>`);
  }

  const namespace = root.attributes['targetNamespace'] ?? '';
  if (namespace === '')
    warnings.push('the WSDL declares no targetNamespace; operations will have none');

  const types = new Map<string, TypeDef>();
  const enums = new Map<string, EnumDef>();
  const elements = new Map<string, string>();

  for (const schema of childrenNamed(childNamed(root, 'types') ?? root, 'schema')) {
    // Enumerations first: a field typed `tns:Category` must resolve to the union, and a
    // single pass would compile it as `string` whenever the complexType came first.
    for (const simpleType of childrenNamed(schema, 'simpleType')) {
      const name = simpleType.attributes['name'];
      if (name === undefined) continue;
      const restriction = childNamed(simpleType, 'restriction');
      const values = childrenNamed(restriction ?? simpleType, 'enumeration')
        .map((entry) => entry.attributes['value'])
        .filter((value): value is string => value !== undefined);
      if (values.length > 0) enums.set(name, { values });
      else warnings.push(`simpleType "${name}" has no enumeration; treated as a plain string`);
    }
    for (const complexType of childrenNamed(schema, 'complexType')) {
      const name = complexType.attributes['name'];
      if (name === undefined) continue;
      types.set(name, { fields: readFields(complexType, enums, warnings) });
    }
    for (const element of childrenNamed(schema, 'element')) {
      const name = element.attributes['name'];
      const type = element.attributes['type'];
      if (name === undefined) continue;
      if (type !== undefined) elements.set(name, localTypeName(type));
      else if (childNamed(element, 'complexType') !== undefined) {
        types.set(name, { fields: readFields(element, enums, warnings) });
        elements.set(name, name);
      }
    }
  }

  const messages = new Map<string, string>();
  for (const message of childrenNamed(root, 'message')) {
    const name = message.attributes['name'];
    const part = childNamed(message, 'part');
    const element = part?.attributes['element'];
    if (name === undefined || element === undefined) continue;
    messages.set(name, localTypeName(element));
  }

  const actions = new Map<string, string>();
  for (const binding of childrenNamed(root, 'binding')) {
    const style = childNamed(binding, 'binding')?.attributes['style'];
    if (style !== undefined && style !== 'document') {
      warnings.push(
        `binding "${binding.attributes['name'] ?? '?'}" is ${style}/encoded; only document/literal is compiled`,
      );
    }
    for (const operation of childrenNamed(binding, 'operation')) {
      const name = operation.attributes['name'];
      const action = childNamed(operation, 'operation')?.attributes['soapAction'];
      if (name !== undefined && action !== undefined) actions.set(name, action);
    }
  }

  const operations: SoapOperationSummary[] = [];
  const portType = childrenNamed(root, 'portType')[0];
  if (portType === undefined) throw wsdlInvalid('the WSDL declares no <portType>');

  for (const operation of childrenNamed(portType, 'operation')) {
    const name = operation.attributes['name'];
    if (name === undefined) continue;

    const inputMessage = childNamed(operation, 'input')?.attributes['message'];
    const outputMessage = childNamed(operation, 'output')?.attributes['message'];
    if (inputMessage === undefined || outputMessage === undefined) {
      warnings.push(`operation "${name}" is not request/response; skipped`);
      continue;
    }

    const request = messages.get(localTypeName(inputMessage));
    const response = messages.get(localTypeName(outputMessage));
    if (request === undefined || response === undefined) {
      warnings.push(`operation "${name}" references a message that is not declared; skipped`);
      continue;
    }

    operations.push({
      name,
      action: actions.get(name),
      request,
      response,
      namespace,
    });
  }

  const code = render({
    namespace,
    operations,
    types,
    enums,
    source: options.source,
    moduleName: options.moduleName,
  });

  return { code, operations, warnings };
}

function readFields(
  container: XmlElement,
  enums: Map<string, EnumDef>,
  warnings: string[],
): readonly FieldDef[] {
  const sequence = childNamed(container, 'sequence') ?? childNamed(container, 'all');
  if (sequence === undefined) {
    if (childNamed(container, 'choice') !== undefined) {
      warnings.push(
        'a <choice> was compiled as its first branch; XML Schema choice semantics are not modelled',
      );
      const first = elementChildren(childNamed(container, 'choice') ?? container)[0];
      return first === undefined ? [] : [readField(first, enums, warnings)];
    }
    return [];
  }

  if (childNamed(container, 'choice') !== undefined) {
    warnings.push('a <choice> was compiled as its first branch');
  }

  const fields = elementChildren(sequence)
    .filter((child) => child.localName === 'element')
    .map((child) => readField(child, enums, warnings));

  const attributes = childrenNamed(container, 'attribute');
  if (attributes.length > 0) {
    warnings.push(
      `complexType "${container.attributes['name'] ?? '?'}" declares attributes; XML attributes are not compiled`,
    );
  }

  return fields;
}

function readField(element: XmlElement, enums: Map<string, EnumDef>, warnings: string[]): FieldDef {
  const name = element.attributes['name'] ?? '';
  const rawType = element.attributes['type'];
  const inline = childNamed(element, 'complexType');
  const minOccurs = element.attributes['minOccurs'] ?? '1';
  const maxOccurs = element.attributes['maxOccurs'] ?? '1';
  const occurrences = maxOccurs === 'unbounded' ? Infinity : parseDecimal(maxOccurs);
  const repeated = occurrences !== undefined && occurrences > 1;
  const required = minOccurs !== '0';

  if (inline !== undefined) {
    return {
      name,
      scalar: 'string',
      typeName: pascal(name),
      required,
      repeated,
      fields: readFields(inline, enums, warnings),
    };
  }

  const type = localTypeName(rawType ?? 'xsd:string');
  if (enums.has(type)) {
    return { name, scalar: 'string', typeName: type, required, repeated };
  }

  const known = XSD_STRING.has(type) || XSD_NUMBER.has(type) || type === 'boolean';
  if (!known) warnings.push(`field "${name}" uses type "${type}"; compiled as string`);

  const scalar: 'string' | 'number' | 'boolean' =
    type === 'boolean' ? 'boolean' : XSD_NUMBER.has(type) ? 'number' : 'string';
  return { name, scalar, typeName: scalar, required, repeated };
}

function localTypeName(qualified: string): string {
  const index = qualified.indexOf(':');
  return index === -1 ? qualified : qualified.slice(index + 1);
}

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part !== '')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

interface RenderInput {
  readonly namespace: string;
  readonly operations: readonly SoapOperationSummary[];
  readonly types: ReadonlyMap<string, TypeDef>;
  readonly enums: ReadonlyMap<string, EnumDef>;
  readonly source: string | undefined;
  readonly moduleName: string | undefined;
}

function render(input: RenderInput): string {
  const lines: string[] = [];

  lines.push(
    `// Generated by \`tsir link:soap:gen\`${input.source === undefined ? '' : ` from \`${input.source}\``}.`,
    '// Do not edit: regenerate instead. `tsir link:soap:gen --check` fails when this file and',
    '// the WSDL disagree.',
    '',
    "import { shapeFromXml, shapeToXml, type SoapFieldShape, type SoapOperation } from '@tsir/link/soap';",
    '',
  );

  for (const [name, definition] of input.enums) {
    lines.push(
      `export type ${name} = ${definition.values.map((value) => `'${value}'`).join(' | ')};`,
      '',
    );
  }

  // Interfaces for the types and elements the operations reference.
  const emitted = new Set<string>();
  const emitInterface = (typeName: string, fields: readonly FieldDef[]): void => {
    if (emitted.has(typeName)) return;
    emitted.add(typeName);

    // Nested types are declared before the type that uses them, so the file reads top-down.
    for (const field of fields) {
      if (field.fields !== undefined) emitInterface(field.typeName, field.fields);
    }

    lines.push(`export interface ${typeName} {`);
    for (const field of fields) {
      const optional = field.required ? '' : '?';
      const type = field.repeated ? `readonly ${field.typeName}[]` : field.typeName;
      const undef = field.required ? '' : ' | undefined';
      lines.push(`  readonly ${field.name}${optional}: ${type}${undef};`);
    }
    lines.push('}', '');
  };

  const interfaceFor = (typeName: string): void => {
    const definition = input.types.get(typeName);
    if (definition === undefined) return;
    emitInterface(typeName, definition.fields);
  };

  for (const operation of input.operations) {
    interfaceFor(operation.request);
    interfaceFor(operation.response);
    lines.push(
      shapeConstant(operation.request, input.types),
      shapeConstant(operation.response, input.types),
    );
  }

  lines.push(
    '/** The operations this contract publishes, ready for `createSoapClient`. */',
    'export const operations = {',
  );

  for (const operation of input.operations) {
    lines.push(
      `  ${operation.name}: {`,
      `    operation: '${operation.name}',`,
      ...(input.namespace === '' ? [] : [`    namespace: '${input.namespace}',`]),
      ...(operation.action === undefined ? [] : [`    action: '${operation.action}',`]),
      `    encode: (request: ${operation.request}) =>`,
      `      shapeToXml('${operation.name}', ${input.namespace === '' ? 'undefined' : `'${input.namespace}'`}, { ...request }, ${operation.request}Shape),`,
      `    decode: (element) =>`,
      `      shapeFromXml(element, ${operation.response}Shape) as unknown as ${operation.response},`,
      '  },',
    );
  }

  lines.push(
    '} as const satisfies Record<string, SoapOperation<never, unknown>>;',
    '',
    '/** Body element names, for a server that dispatches by name. */',
    `export const OPERATIONS = ${JSON.stringify(input.operations.map((operation) => operation.name))} as const;`,
    '',
  );

  return lines.join('\n');
}

function shapeConstant(typeName: string, types: ReadonlyMap<string, TypeDef>): string {
  const definition = types.get(typeName);
  const fields = definition?.fields ?? [];
  const rendered = fields.map((field) => renderField(field, '  ')).join('\n');
  return `const ${typeName}Shape: readonly SoapFieldShape[] = [\n${rendered}\n];\n`;
}

function renderField(field: FieldDef, indent: string): string {
  const parts = [
    `name: '${field.name}'`,
    `type: '${field.scalar}'`,
    ...(field.required ? [] : ['required: false']),
    ...(field.repeated ? ['repeated: true'] : []),
  ];

  if (field.fields === undefined) return `${indent}{ ${parts.join(', ')} },`;

  const nested = field.fields.map((child) => renderField(child, `${indent}    `)).join('\n');
  return `${indent}{\n${indent}  ${parts.join(', ')},\n${indent}  fields: [\n${nested}\n${indent}  ],\n${indent}},`;
}

/** Reads the operation list out of a generated module, for `--check` diagnostics. */
export function summarize(result: SoapGenResult): string {
  return result.operations
    .map((operation) => `${operation.name} (${operation.request} → ${operation.response})`)
    .join('\n');
}

/**
 * `tsir link:soap:gen <wsdl> [--out <file>] [--check] [--json]`.
 *
 * `--check` is the mode CI runs: compile, compare, fail on drift. It never writes, so a
 * green build cannot leave a modified working tree behind.
 */
export async function soapGenCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--out': { type: 'string', description: 'output file (default: <wsdl>.gen.ts)' },
    '--check': { type: 'boolean', description: 'fail if the committed module is stale' },
    '--json': { type: 'boolean', description: 'machine-readable output' },
  });

  const source = args.positionals[0];
  if (source === undefined) {
    throw new UsageError(
      'link:soap:gen needs a WSDL path',
      'tsir link:soap:gen contracts/tax.wsdl --out src/contracts/tax.gen.ts',
    );
  }

  const json = boolFlag(args, '--json');
  const check = boolFlag(args, '--check');
  const wsdlPath = resolve(process.cwd(), source);
  const outPath = resolve(
    process.cwd(),
    stringFlag(args, '--out') ?? `${wsdlPath.replace(/\.wsdl$/u, '')}.gen.ts`,
  );

  const result = generateSoapModule(await readFile(wsdlPath, 'utf8'), {
    source: relative(process.cwd(), wsdlPath),
  });

  if (result.operations.length === 0) {
    throw new UsageError(
      `no request/response operations were compiled from ${source}`,
      'only document/literal SOAP 1.1 is compiled; unqualified schemas and RPC style are refused',
    );
  }

  if (check) {
    const existing = await readFile(outPath, 'utf8').catch(() => undefined);
    if (existing === undefined) {
      warn(`${relative(process.cwd(), outPath)} is missing — run \`tsir link:soap:gen ${source}\``);
      return EXIT.failure;
    }
    if (existing !== result.code) {
      warn(`${relative(process.cwd(), outPath)} is stale — regenerate it from ${source}`);
      return EXIT.failure;
    }
    if (json) {
      info(jsonDocument({ ok: true, operations: result.operations, warnings: result.warnings }));
    } else {
      ok(
        `${relative(process.cwd(), outPath)} matches ${source} (${String(result.operations.length)} operation(s))`,
      );
    }
    return EXIT.ok;
  }

  await writeFile(outPath, result.code);

  if (json) {
    info(
      jsonDocument({
        ok: true,
        output: relative(process.cwd(), outPath),
        operations: result.operations,
        warnings: result.warnings,
      }),
    );
    return EXIT.ok;
  }

  ok(`${relative(process.cwd(), outPath)} — ${String(result.operations.length)} operation(s)`);
  for (const operation of result.operations) {
    info(
      style.dim(
        `  ${operation.name}: ${operation.request} → ${operation.response}${operation.action === undefined ? '' : ` (${operation.action})`}`,
      ),
    );
  }
  for (const warning of result.warnings) warn(warning);
  return EXIT.ok;
}

void fail;

function wsdlInvalid(message: string): TsirError {
  return new TsirError('CLI_WSDL_INVALID', message, { kind: 'config' });
}
