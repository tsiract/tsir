/**
 * `tsir link:soap:gen` (`LNK-016`).
 *
 * Three claims are being tested, and the third is the one that matters:
 *
 *   1. the compiler is deterministic — the committed `tax.gen.ts` is byte-identical to a
 *      fresh compile, which is what makes `--check` a usable gate;
 *   2. the command writes, reports and refuses the way the CLI contract says;
 *   3. **the generated module works**: it is imported, wired into the real SOAP client and
 *      server, and a response is decoded through the shapes it declares.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { SOAP_NAMESPACE, createSoapClient, createSoapHandler } from '@tsir/link/soap';

import { EXIT, UsageError } from '../output.ts';
import { generateSoapModule, soapGenCommand } from './soap-gen.ts';
import { operations } from './fixtures/tax.gen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const WSDL = join(FIXTURES, 'tax.wsdl');
const GENERATED = join(FIXTURES, 'tax.gen.ts');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capture(): { readonly text: () => string } {
  const chunks: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const absorb = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stdout.write = absorb;
  process.stderr.write = absorb;
  return {
    text: () => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      return chunks.join('');
    },
  };
}

describe('WSDL compiler — determinism (LNK-016)', () => {
  test('the committed module is exactly what the WSDL compiles to', async () => {
    const wsdl = await readFile(WSDL, 'utf8');
    const committed = await readFile(GENERATED, 'utf8');

    // The source path is part of the header, so compile with the same relative name the
    // commit used. That is also why the generator takes it as an option rather than
    // reading it from the filesystem.
    const fresh = generateSoapModule(wsdl, {
      source: 'src/framework/console/src/commands/fixtures/tax.wsdl',
    });

    expect(fresh.code).toBe(committed);
    expect(fresh.warnings).toEqual([]);
  });

  test('the operation list is what the client needs', async () => {
    const result = generateSoapModule(await readFile(WSDL, 'utf8'));

    expect(result.operations).toEqual([
      {
        name: 'GetTaxRate',
        action: 'urn:tax/GetTaxRate',
        request: 'GetTaxRate',
        response: 'GetTaxRateResponse',
        namespace: 'urn:tax',
      },
    ]);
  });

  test('enumerations, optional fields, repeats and nesting all survive', async () => {
    const code = generateSoapModule(await readFile(WSDL, 'utf8')).code;

    expect(code).toContain("export type Category = 'digital' | 'physical';");
    expect(code).toContain('readonly category?: Category | undefined;');
    expect(code).toContain('readonly note?: readonly string[] | undefined;');
    expect(code).toContain('export interface Jurisdiction {');
    expect(code).toContain('export const OPERATIONS = ["GetTaxRate"] as const;');
  });

  test('what it cannot compile, it says out loud', () => {
    const rpc = `<?xml version="1.0"?>
      <definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                   xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:x" targetNamespace="urn:x">
        <types><xsd:schema>
          <xsd:complexType name="Ping"><xsd:sequence>
            <xsd:element name="at" type="xsd:dateTime"/>
            <xsd:element name="mystery" type="tns:Unknown"/>
          </xsd:sequence></xsd:complexType>
          <xsd:element name="Ping" type="tns:Ping"/>
          <xsd:element name="PingResponse" type="tns:Ping"/>
        </xsd:schema></types>
        <message name="In"><part name="p" element="tns:Ping"/></message>
        <message name="Out"><part name="p" element="tns:PingResponse"/></message>
        <portType name="P"><operation name="Ping"><input message="tns:In"/><output message="tns:Out"/></operation></portType>
        <binding name="B" type="tns:P">
          <soap:binding style="rpc" transport="urn:t"/>
          <operation name="Ping"/>
        </binding>
      </definitions>`;

    const result = generateSoapModule(rpc);

    expect(result.warnings).toContainEqual(expect.stringContaining('rpc/encoded'));
    expect(result.warnings).toContainEqual(
      expect.stringContaining('"mystery" uses type "Unknown"'),
    );
  });

  test('a document that is not a WSDL is refused, not half-compiled', () => {
    expect(() => generateSoapModule('<html><body>nope</body></html>')).toThrow(/WSDL/);
    expect(() =>
      generateSoapModule(
        '<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>',
      ),
    ).toThrow(/portType/);
  });
});

describe('link:soap:gen command (LNK-016)', () => {
  test('writes the module and reports the operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'soap-gen-'));
    cleanup.push(dir);
    const out = join(dir, 'tax.gen.ts');

    const output = capture();
    const code = await soapGenCommand([WSDL, '--out', out]);
    const text = output.text();

    expect(code).toBe(EXIT.ok);
    expect(text).toContain('1 operation(s)');
    expect(text).toContain('GetTaxRate');
    expect(await readFile(out, 'utf8')).toBe(await readFile(GENERATED, 'utf8'));
  });

  test('--check passes on a fresh module and fails on a stale one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'soap-gen-'));
    cleanup.push(dir);
    const out = join(dir, 'tax.gen.ts');
    await writeFile(out, await readFile(GENERATED, 'utf8'));

    const fresh = capture();
    expect(await soapGenCommand([WSDL, '--out', out, '--check'])).toBe(EXIT.ok);
    expect(fresh.text()).toContain('matches');

    await writeFile(out, '// stale\n');
    const stale = capture();
    expect(await soapGenCommand([WSDL, '--out', out, '--check'])).toBe(EXIT.failure);
    expect(stale.text()).toContain('stale');
  });

  test('no argument is a usage error, not a crash', async () => {
    let thrown: unknown;
    try {
      await soapGenCommand([]);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(UsageError);
    expect((thrown as Error).message).toMatch(/WSDL path/);
  });
});

describe('the generated module on the wire (LNK-016)', () => {
  test('a response is decoded through the generated shapes', async () => {
    const response = `<env:Envelope xmlns:env="${SOAP_NAMESPACE['1.2']}"><env:Body><GetTaxRateResponse>
      <rate>7.25</rate>
      <exempt>false</exempt>
      <note>first</note>
      <note>second</note>
      <jurisdiction><code>SG</code><level>2</level></jurisdiction>
    </GetTaxRateResponse></env:Body></env:Envelope>`;

    const client = createSoapClient({
      endpoint: 'https://tax.example.com/soap',
      operations,
      ctx: { traceId: 'a'.repeat(32), correlationId: 'c-1', signal: new AbortController().signal },
      deps: {
        fetch: () => Promise.resolve(new Response(response)),
        sleep: () => Promise.resolve(),
        now: () => 0,
        random: () => 0.5,
      },
    });

    const result = await client.call('GetTaxRate', { country: 'SG', category: 'digital' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      rate: 7.25,
      exempt: false,
      note: ['first', 'second'],
      jurisdiction: { code: 'SG', level: 2 },
    });
  });

  test('a contract-breaking response is a protocol failure, not a wrong number', async () => {
    const handler = createSoapHandler({
      operations: {
        GetTaxRate: {
          operation: 'GetTaxRate',
          handle: () => ({ rate: 'not-a-number' }),
        },
      },
    });

    const client = createSoapClient({
      endpoint: 'https://tax.example.com/soap',
      operations,
      ctx: { traceId: 'a'.repeat(32), correlationId: 'c-1', signal: new AbortController().signal },
      deps: {
        fetch: (_input, init) =>
          handler(
            new Request('https://tax.example.com/soap', {
              method: 'POST',
              body: typeof init?.body === 'string' ? init.body : '',
            }),
          ),
        sleep: () => Promise.resolve(),
        now: () => 0,
        random: () => 0.5,
      },
    });

    const result = await client.call('GetTaxRate', { country: 'SG' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('protocol');
    expect(result.error.message).toContain('could not be decoded');
  });
});
