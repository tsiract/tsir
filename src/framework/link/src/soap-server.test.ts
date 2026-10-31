/**
 * The SOAP server (`LNK-020`).
 *
 * The handler takes a `Request` and returns a `Response`, so most of this file is a
 * function call — no socket, no port, no flake. The last block opens one real server to
 * prove the handler composes with a fetch-shaped runtime and that our own client can talk
 * to our own server.
 */

import { afterAll, describe, expect, test } from 'bun:test';

import { createSoapClient, SOAP_NAMESPACE, type SoapRecord } from './soap.ts';
import { createSoapHandler, type SoapServerEvent } from './soap-server.ts';
import { callError } from './errors.ts';
import { createCallContext } from './types.ts';
import { verifyUsernameToken } from './wsse.ts';
import { childNamed, parseXml, textOf } from './xml.ts';

const WSDL = '<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>';

interface TaxRequest extends SoapRecord {
  readonly country: string;
}

function handler(
  options: Partial<Parameters<typeof createSoapHandler>[0]> = {},
): ReturnType<typeof createSoapHandler> {
  return createSoapHandler({
    version: '1.2',
    operations: {
      GetTaxRate: {
        operation: 'GetTaxRate',
        namespace: 'urn:tax',
        handle: (request: TaxRequest) => ({ rate: request.country === 'SG' ? '7' : '20' }),
      },
    },
    ...options,
  } as never);
}

function post(body: string, version: '1.1' | '1.2' = '1.2'): Request {
  return new Request('https://tax.example.com/soap', {
    method: 'POST',
    headers: { 'content-type': version === '1.1' ? 'text/xml' : 'application/soap+xml' },
    body,
  });
}

const envelopeFor = (payload: string, version: '1.1' | '1.2' = '1.2'): string =>
  `<env:Envelope xmlns:env="${SOAP_NAMESPACE[version]}"><env:Body>${payload}</env:Body></env:Envelope>`;

/** Reads a fault in either dialect: 1.2 `Code/Value`+`Reason/Text`, 1.1 `faultcode`+`faultstring`. */
function faultIn(text: string): { readonly code: string; readonly reason: string } {
  const body = childNamed(parseXml(text), 'Body') ?? parseXml(text);
  const fault = childNamed(body, 'Fault') ?? body;
  const value =
    childNamed(childNamed(fault, 'Code') ?? fault, 'Value') ?? childNamed(fault, 'faultcode');
  const reason =
    childNamed(childNamed(fault, 'Reason') ?? fault, 'Text') ?? childNamed(fault, 'faultstring');
  return { code: textOf(value ?? fault), reason: textOf(reason ?? fault) };
}

describe('SOAP server — dispatch (LNK-020)', () => {
  test('a request becomes a handler call, and the answer is an envelope', async () => {
    const response = await handler()(
      post(envelopeFor('<GetTaxRate><country>SG</country></GetTaxRate>')),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/soap+xml');

    const root = parseXml(await response.text());
    expect(root.localName).toBe('Envelope');
    const body = childNamed(childNamed(root, 'Body') ?? root, 'GetTaxRateResponse') ?? root;
    expect(textOf(childNamed(body, 'rate') ?? body)).toBe('7');
  });

  test('a SOAP 1.1 endpoint answers with text/xml', async () => {
    const soap = handler({ version: '1.1' });
    const response = await soap(
      post(envelopeFor('<GetTaxRate><country>SG</country></GetTaxRate>'), '1.1'),
    );

    expect(response.headers.get('content-type')).toBe('text/xml; charset=utf-8');
  });

  test('an unknown operation is a Client fault, not a 404 page', async () => {
    const response = await handler()(post(envelopeFor('<Refund><id>1</id></Refund>')));
    const fault = faultIn(await response.text());

    expect(response.status).toBe(500);
    expect(fault.code).toBe('soap:Client');
    expect(fault.reason).toContain('no operation named');
  });

  test('a handler that throws becomes a Server fault carrying the message', async () => {
    const soap = createSoapHandler({
      operations: {
        GetTaxRate: {
          operation: 'GetTaxRate',
          handle: () => {
            throw new Error('ledger unavailable');
          },
        },
      },
    });

    const response = await soap(post(envelopeFor('<GetTaxRate/>')));
    const fault = faultIn(await response.text());

    expect(response.status).toBe(500);
    expect(fault.code).toBe('soap:Server');
    expect(fault.reason).toBe('ledger unavailable');
  });

  test('a CallError keeps its kind, which decides the fault side', async () => {
    const soap = createSoapHandler({
      operations: {
        GetTaxRate: {
          operation: 'GetTaxRate',
          handle: () => {
            // Throwing a CallError is how a handler declares a fault.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw callError('invalid_argument', 'LNK_INVALID_ARGUMENT', {
              message: 'country is required',
            });
          },
        },
      },
    });

    const response = await soap(post(envelopeFor('<GetTaxRate/>')));
    const fault = faultIn(await response.text());

    expect(fault.code).toBe('soap:Client');
    expect(fault.reason).toBe('country is required');
  });

  test('the wrong envelope namespace is refused before dispatch', async () => {
    const response = await handler()(
      post(
        `<env:Envelope xmlns:env="${SOAP_NAMESPACE['1.1']}"><env:Body><GetTaxRate/></env:Body></env:Envelope>`,
      ),
    );

    expect(response.status).toBe(400);
    expect(faultIn(await response.text()).reason).toContain('speaks SOAP 1.2');
  });

  test('methods, size and body shape each fail with a fault', async () => {
    const soap = handler({ maxRequestBytes: 64 });

    const wrongMethod = await soap(new Request('https://tax.example.com/soap'));
    expect(wrongMethod.status).toBe(405);

    const tooLarge = await soap(post(envelopeFor(`<GetTaxRate>${'x'.repeat(100)}</GetTaxRate>`)));
    expect(tooLarge.status).toBe(413);

    const notXml = await soap(post('definitely not xml'));
    expect(notXml.status).toBe(400);
  });
});

describe('SOAP server — WSDL and events (LNK-020)', () => {
  test('?wsdl serves the configured document', async () => {
    const withWsdl = await handler({ wsdl: { document: WSDL } })(
      new Request('https://tax.example.com/soap?wsdl'),
    );
    expect(withWsdl.status).toBe(200);
    expect(await withWsdl.text()).toBe(WSDL);

    const withoutWsdl = await handler()(new Request('https://tax.example.com/soap?wsdl'));
    expect(withoutWsdl.status).toBe(404);
  });

  test('one event per request, on success and on failure', async () => {
    const events: SoapServerEvent[] = [];
    const soap = handler({ onCall: (event) => events.push(event) });

    await soap(post(envelopeFor('<GetTaxRate><country>SG</country></GetTaxRate>')));
    await soap(post(envelopeFor('<Refund/>')));

    expect(events.map((event) => event.kind)).toEqual(['ok', 'not_found']);
    expect(events[0]).toMatchObject({ protocol: 'soap-server', operation: 'GetTaxRate' });
  });
});

describe('SOAP server — authentication (LNK-019)', () => {
  test('a request without a token never reaches the handler', async () => {
    let called = false;
    const soap = createSoapHandler({
      operations: {
        GetTaxRate: {
          operation: 'GetTaxRate',
          handle: () => {
            called = true;
            return {};
          },
        },
      },
      authenticate: (header) =>
        header === undefined
          ? {
              ok: false,
              error: callError('unauthenticated', 'LNK_UNAUTHENTICATED', {
                message: 'no security header',
              }),
            }
          : { ok: true, username: 'svc' },
    });

    const response = await soap(post(envelopeFor('<GetTaxRate/>')));
    const fault = faultIn(await response.text());

    expect(called).toBe(false);
    expect(response.status).toBe(500);
    expect(fault.code).toBe('soap:Client');
    expect(fault.reason).toBe('no security header');
  });
});

describe('SOAP — client and server on a real socket (LNK-020)', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterAll(() => {
    void server?.stop(true);
  });

  test('our client can call our server, with WS-Security in between', async () => {
    const soap = createSoapHandler({
      version: '1.2',
      authenticate: async (header) => {
        if (header === undefined) {
          return {
            ok: false,
            error: callError('unauthenticated', 'LNK_UNAUTHENTICATED', {
              message: 'no security header',
            }),
          };
        }
        const security = childNamed(header, 'Security');
        if (security === undefined) {
          return {
            ok: false,
            error: callError('unauthenticated', 'LNK_UNAUTHENTICATED', {
              message: 'no security element',
            }),
          };
        }
        return verifyUsernameToken(security, { passwordFor: async () => 'secret' });
      },
      operations: {
        GetTaxRate: {
          operation: 'GetTaxRate',
          namespace: 'urn:tax',
          handle: (request: TaxRequest, context) => {
            if (context.principal !== 'svc-tax') throw new Error('principal missing');
            return { rate: request.country === 'SG' ? '7' : '20' };
          },
        },
      },
    });

    server = Bun.serve({ port: 0, fetch: soap });
    const port = server.port;

    const client = createSoapClient({
      endpoint: `http://127.0.0.1:${String(port)}/soap`,
      ctx: createCallContext({ traceId: 'c'.repeat(32) }),
      security: {
        usernameToken: { username: 'svc-tax', password: 'secret' },
      },
      operations: { GetTaxRate: { operation: 'GetTaxRate', namespace: 'urn:tax' } },
    });

    const result = await client.call('GetTaxRate', { country: 'SG' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ rate: '7' });
  });
});
