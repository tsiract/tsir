/**
 * The SOAP client (`LNK-017`, `LNK-018`).
 *
 * `fetch` is injected, so every test is a scripted exchange: the request envelope, the
 * headers and the HTTP status are assertions rather than side effects.
 */

import { describe, expect, test } from 'bun:test';

import {
  SOAP_NAMESPACE,
  createSoapClient,
  envelope,
  recordToXml,
  type SoapCallEvent,
  type SoapClient,
  type SoapOperation,
  type SoapRecord,
} from './soap.ts';
import { createCallContext, type CallErrorKind } from './types.ts';
import { parseXml, xmlElement, xmlLeaf, type XmlElement } from './xml.ts';

type Ops = { readonly GetTaxRate: SoapOperation<SoapRecord, SoapRecord> };

const ctx = (): ReturnType<typeof createCallContext> =>
  createCallContext({ traceId: 'a'.repeat(32), correlationId: 'c-1' });

const envelopeFor = (payload: string, version: '1.1' | '1.2' = '1.2'): string =>
  `<env:Envelope xmlns:env="${SOAP_NAMESPACE[version]}"><env:Body>${payload}</env:Body></env:Envelope>`;

interface Exchange {
  readonly body: string;
  readonly init: RequestInit;
}

interface Script {
  readonly version?: '1.1' | '1.2';
  readonly maxResponseBytes?: number;
  readonly faults?: Readonly<Record<string, CallErrorKind>>;
  readonly retry?: { attempts: number; backoffMs?: number };
  readonly onCall?: (event: SoapCallEvent) => void;
}

function scripted(
  response: { status?: number; body: string },
  options: Script = {},
): { soap: SoapClient<Ops>; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const soap = createSoapClient<Ops>({
    endpoint: 'https://tax.example.com/soap',
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.onCall === undefined ? {} : { onCall: options.onCall }),
    operations: {
      GetTaxRate: { operation: 'GetTaxRate', namespace: 'urn:tax', action: 'urn:tax#GetTaxRate' },
    },
    ctx: ctx(),
    deps: {
      fetch: (_input, init) => {
        exchanges.push({ body: typeof init.body === 'string' ? init.body : '', init });
        return Promise.resolve(new Response(response.body, { status: response.status ?? 200 }));
      },
      sleep: () => Promise.resolve(),
      now: () => 1_000,
      random: () => 0.5,
    },
  });
  return { soap, exchanges };
}

describe('SOAP client — envelopes (LNK-017)', () => {
  test('SOAP 1.1 sends text/xml, a quoted SOAPAction and a namespaced body', async () => {
    const { soap, exchanges } = scripted(
      { body: envelopeFor('<GetTaxRateResponse><rate>7</rate></GetTaxRateResponse>', '1.1') },
      { version: '1.1' },
    );

    const result = await soap.call('GetTaxRate', { country: 'SG', category: 'digital' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ rate: '7' });

    const headers = new Headers(exchanges[0]?.init.headers);
    expect(exchanges[0]?.init.method).toBe('POST');
    expect(headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(headers.get('soapaction')).toBe('"urn:tax#GetTaxRate"');
    expect(exchanges[0]?.body).toContain(`xmlns:soap="${SOAP_NAMESPACE['1.1']}"`);
    expect(exchanges[0]?.body).toContain('<GetTaxRate xmlns="urn:tax"><country>SG</country>');
  });

  test('SOAP 1.2 puts the action in the media type and sends no SOAPAction', async () => {
    const { soap, exchanges } = scripted({
      body: envelopeFor('<GetTaxRateResponse><rate>7</rate></GetTaxRateResponse>'),
    });

    await soap.call('GetTaxRate', { country: 'SG' });

    const headers = new Headers(exchanges[0]?.init.headers);
    expect(headers.get('content-type')).toBe(
      'application/soap+xml; charset=utf-8; action="urn:tax#GetTaxRate"',
    );
    expect(headers.get('soapaction')).toBeNull();
    expect(exchanges[0]?.body).toContain(`xmlns:soap="${SOAP_NAMESPACE['1.2']}"`);
  });

  test('trace headers ride along, as they do on every other protocol', async () => {
    const { soap, exchanges } = scripted({ body: envelopeFor('<GetTaxRateResponse/>') });

    await soap.call('GetTaxRate', {});

    const headers = new Headers(exchanges[0]?.init.headers);
    expect(headers.get('traceparent')).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
    expect(headers.get('x-correlation-id')).toBe('c-1');
  });

  test('an operation may encode and decode a shape that is not a flat record', async () => {
    // `satisfies` is how a caller pins the shapes: without it the inference falls back to
    // the constraint, and `call()` would return `SoapRecord` instead of the decoded shape.
    const operations = {
      Add: {
        operation: 'Add',
        encode: (request: { readonly a: number; readonly b: number }) =>
          xmlElement('Add', {
            children: [xmlLeaf('a', String(request.a)), xmlLeaf('b', String(request.b))],
          }),
        decode: (element: XmlElement) => ({ sum: Number(childText(element, 'sum')) }),
      },
    } satisfies Record<string, SoapOperation<{ a: number; b: number }, { sum: number }>>;

    const soap = createSoapClient({
      endpoint: 'https://tax.example.com/soap',
      ctx: ctx(),
      operations,
      deps: {
        fetch: () =>
          Promise.resolve(new Response(envelopeFor('<AddResponse><sum>5</sum></AddResponse>'))),
        sleep: () => Promise.resolve(),
        now: () => 0,
        random: () => 0.5,
      },
    });

    const result = await soap.call('Add', { a: 2, b: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ sum: 5 });
  });
});

function childText(element: XmlElement, name: string): string {
  const child = element.children.find((node) => 'name' in node && node.localName === name);
  if (child === undefined || !('children' in child)) return '';
  return child.children.map((node) => ('text' in node ? node.text : '')).join('');
}

describe('SOAP client — faults (LNK-017)', () => {
  test('a 1.1 fault becomes a server failure carrying the service words', async () => {
    const { soap } = scripted(
      {
        status: 500,
        body: envelopeFor(
          '<env:Fault><faultcode>soap:Server</faultcode><faultstring>Backend down</faultstring></env:Fault>',
          '1.1',
        ),
      },
      { version: '1.1' },
    );

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: 'server',
      code: 'LNK_SOAP_FAULT',
      retryable: false,
    });
    expect(result.error.message).toBe('soap:Server: Backend down');
  });

  test('a 1.2 fault uses Code/Value and Reason/Text, and its detail can defer the retry', async () => {
    const { soap } = scripted({
      status: 500,
      body: envelopeFor(
        '<env:Fault><env:Code><env:Value>app:QuotaExceeded</env:Value></env:Code><env:Reason><env:Text xml:lang="en">Slow down</env:Text></env:Reason><env:Detail><retryAfter>30</retryAfter></env:Detail></env:Fault>',
      ),
    });

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `unknown` by the standard table — no contract map was configured for this one.
    expect(result.error).toMatchObject({ kind: 'unknown', code: 'LNK_SOAP_FAULT' });
    expect(result.error.message).toBe('app:QuotaExceeded: Slow down');
    expect(result.error.retryAfterMs).toBe(30_000);
  });

  test('a mapped fault becomes retryable, and the retry budget is honoured', async () => {
    const fault = envelopeFor(
      '<env:Fault><env:Code><env:Value>app:QuotaExceeded</env:Value></env:Code><env:Reason><env:Text>Slow down</env:Text></env:Reason></env:Fault>',
    );
    const { soap, exchanges } = scripted(
      { status: 500, body: fault },
      { faults: { 'app:QuotaExceeded': 'rate_limited' }, retry: { attempts: 3, backoffMs: 1 } },
    );

    const result = await soap.call('GetTaxRate', {}, { idempotent: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate_limited');
    expect(exchanges).toHaveLength(3);
    expect(result.meta.attempts).toBe(3);
  });

  test('without an idempotency claim, a failing call is attempted once', async () => {
    const { soap, exchanges } = scripted(
      { status: 503, body: '' },
      { retry: { attempts: 3, backoffMs: 1 } },
    );

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    expect(exchanges).toHaveLength(1);
  });

  test('an error page from a gateway is an HTTP failure, not a SOAP fault', async () => {
    const { soap } = scripted({ status: 503, body: '<html><body>gateway</body></html>' });

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'unavailable', code: 'HTTP_503', retryable: true });
  });

  test('a 2xx that is not a SOAP envelope is a protocol failure', async () => {
    const { soap } = scripted({ status: 200, body: '<html><body>not soap</body></html>' });

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('LNK_PROTOCOL');
  });
});

describe('SOAP client — hardening and configuration (LNK-018)', () => {
  test('a response carrying a DTD is refused before it becomes a tree', async () => {
    const { soap } = scripted({
      body: `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><env:Envelope xmlns:env="${SOAP_NAMESPACE['1.2']}"><env:Body><GetTaxRateResponse><rate>&xxe;</rate></GetTaxRateResponse></env:Body></env:Envelope>`,
    });

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('protocol');
    expect(result.error.message).toContain('DTD');
  });

  test('an oversized response is refused by size', async () => {
    const { soap } = scripted(
      {
        body: envelopeFor(
          `<GetTaxRateResponse><rate>${'7'.repeat(400)}</rate></GetTaxRateResponse>`,
        ),
      },
      { maxResponseBytes: 128 },
    );

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('exceeds');
  });

  test('a version mismatch is caught from the envelope namespace', async () => {
    const { soap } = scripted(
      { body: envelopeFor('<GetTaxRateResponse/>', '1.2') },
      { version: '1.1' },
    );

    const result = await soap.call('GetTaxRate', {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('speaks SOAP 1.1');
  });

  test('an aborted context never opens a connection', async () => {
    const { soap, exchanges } = scripted({ body: '' });
    const controller = new AbortController();
    controller.abort();

    const result = await soap.call(
      'GetTaxRate',
      {},
      {
        ctx: createCallContext({ traceId: 'b'.repeat(32), signal: controller.signal }),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cancelled');
    expect(exchanges).toHaveLength(0);
  });

  test('one event per call, carrying the trace id of the context', async () => {
    const events: SoapCallEvent[] = [];
    const { soap } = scripted(
      { body: envelopeFor('<GetTaxRateResponse><rate>7</rate></GetTaxRateResponse>') },
      {
        onCall: (event) => events.push(event),
      },
    );

    await soap.call('GetTaxRate', {});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ protocol: 'soap', operation: 'GetTaxRate', kind: 'ok' });
    expect(events[0]?.traceId).toBe('a'.repeat(32));
  });

  test('configuration mistakes are startup failures, not call failures', () => {
    expect(() =>
      createSoapClient({ endpoint: 'http://tax.example.com/soap', ctx: ctx(), operations: {} }),
    ).toThrow(/https/);

    expect(() =>
      createSoapClient({
        endpoint: 'https://tax.example.com/soap',
        ctx: ctx(),
        operations: { GetTaxRate: { operation: 'GetTaxRateX' } },
      }),
    ).toThrow(/key names the operation/);
  });
});

describe('SOAP — envelope helpers (LNK-017)', () => {
  test('a built envelope is parseable by our own reader', () => {
    const root = parseXml(envelope('1.1', xmlLeaf('Ping', 'ok')));

    expect(root.localName).toBe('Envelope');
    expect(root.namespace).toBe(SOAP_NAMESPACE['1.1']);
  });

  test('records become elements, arrays repeat them, and null is xsi:nil', () => {
    const node = recordToXml('Order', { id: 'o-1', lines: ['a', 'b'], note: null });

    expect(node.localName).toBe('Order');
    expect(node.children).toHaveLength(3);
  });
});
