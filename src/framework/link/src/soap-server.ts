/**
 * SOAP server (`LNK-020`): a fetch-shaped handler, so it runs anywhere `fetch` does.
 *
 * It is deliberately *not* a router. `@tsir/http` owns HTTP routing, guards and the
 * problem+json shape for REST; SOAP has its own error shape (a `Fault` in a 500 response)
 * and its own dispatch rule (one body element). So the seam is a handler:
 *
 * ```ts
 * const soap = createSoapHandler({ version: '1.2', operations: TaxOperations });
 * Bun.serve({ fetch: (request) => (pathname === '/tax' ? soap(request) : app.fetch(request)) });
 * ```
 *
 * Three rules make it a SOAP server rather than an XML endpoint:
 *
 *   1. **The envelope is checked before the operation is trusted** — namespace, body and
 *      one body element. A 200 with the wrong namespace is a bug that only shows up in
 *      production otherwise.
 *   2. **Every failure is a `Fault`**, never an exception and never a bare 500: clients
 *      written against SOAP 1.1 read `faultcode`/`faultstring`, and 1.2 reads
 *      `Code/Value` + `Reason/Text`. Which side of the fault it is comes from § 9's kind —
 *      a bad request is the client's fault, everything else is ours.
 *   3. **`?wsdl` serves the contract**, when one is configured, because a SOAP service
 *      that cannot hand out its WSDL is a service every integrator has to reverse.
 */

import { callError, retryableKind } from './errors.ts';
import { SOAP_NAMESPACE, envelope, type SoapRecord, type SoapVersion } from './soap-core.ts';
import type { CallError } from './types.ts';
import { parseDecimal } from './soap-shape.ts';
import {
  XmlParseError,
  childNamed,
  elementChildren,
  parseXml,
  recordFromXml,
  recordToXml,
  xmlElement,
  type XmlElement,
} from './xml.ts';

const MAX_REQUEST_BYTES = 1_048_576;

export interface SoapHandlerContext {
  readonly request: Request;
  readonly operation: string;
  /** The username from a verified `UsernameToken`, when authentication is configured. */
  readonly principal: string | undefined;
  /** The `soap:Header`, for handlers that read WS-Addressing or a security token. */
  readonly header: XmlElement | undefined;
}

export interface SoapOperationHandler<TRequest = SoapRecord, TResponse = SoapRecord> {
  readonly operation: string;
  readonly namespace?: string | undefined;
  /** Body element → request. Default: `recordFromXml`. */
  readonly decode?: ((element: XmlElement) => TRequest) | undefined;
  /** Response → body element. Default: `recordToXml(operation + 'Response', response)`. */
  readonly encode?: ((response: TResponse) => XmlElement) | undefined;
  readonly handle: (
    request: TRequest,
    context: SoapHandlerContext,
  ) => TResponse | Promise<TResponse>;
}

export interface SoapServerEvent {
  readonly protocol: 'soap-server';
  readonly operation: string;
  readonly kind: string;
  readonly status: number;
  readonly elapsedMs: number;
}

export interface SoapServerOptions<
  Ops extends Record<string, SoapOperationHandler<never, unknown>>,
> {
  readonly version?: SoapVersion | undefined;
  readonly operations: Ops;
  /**
   * Verifies the `soap:Header` (see `verifyUsernameToken`). Returning `{ ok: false }`
   * becomes a `Client` fault; the handler is never called.
   */
  readonly authenticate?:
    | ((
        header: XmlElement | undefined,
      ) =>
        | { readonly ok: true; readonly username: string }
        | { readonly ok: false; readonly error: CallError }
        | Promise<
            | { readonly ok: true; readonly username: string }
            | { readonly ok: false; readonly error: CallError }
          >)
    | undefined;
  /** Served for `?wsdl`. A function is called per request, so a generated file can be lazy. */
  readonly wsdl?: { readonly document: string | (() => string | Promise<string>) } | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly onCall?: ((event: SoapServerEvent) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

export type SoapHandler = (request: Request) => Promise<Response>;

export function createSoapHandler<Ops extends Record<string, SoapOperationHandler<never, unknown>>>(
  options: SoapServerOptions<Ops>,
): SoapHandler {
  const version = options.version ?? '1.2';
  const maxBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
  const now = options.now ?? (() => Date.now());

  for (const [name, operation] of Object.entries(options.operations)) {
    if (operation.operation !== name) {
      // A CallError is a plain record on purpose: it is the shape that crosses the wire
      // (ADR-0022), so throwing one is how this module reports a configuration mistake.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw callError('invalid_argument', 'LNK_INVALID_CONFIG', {
        message: `operations["${name}"].operation is "${operation.operation}" — the key names the operation`,
      });
    }
  }

  const wsdl = async (): Promise<Response> => {
    const document = options.wsdl?.document;
    const text = typeof document === 'function' ? await document() : document;
    if (text === undefined)
      return fault(version, 'Client', 'no WSDL is served by this endpoint', 404);
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'text/xml; charset=utf-8' },
    });
  };

  return async (request: Request): Promise<Response> => {
    const startedAt = now();
    const url = new URL(request.url);
    if (url.searchParams.has('wsdl') || url.searchParams.has('WSDL')) return wsdl();

    if (request.method !== 'POST') {
      return fault(version, 'Client', `SOAP endpoints accept POST, not ${request.method}`, 405);
    }

    // `parseDecimal`, not `Number`: a Content-Length of `1e9` is a malformed header, and
    // `Number('')` is `0` — the guard has to reject rather than coerce (VLD-007).
    const declared = parseDecimal(request.headers.get('content-length') ?? '');
    if (declared !== undefined && declared > maxBytes)
      return fault(version, 'Client', `request body exceeds ${String(maxBytes)} bytes`, 413);

    let text: string;
    try {
      text = await request.text();
    } catch {
      return fault(version, 'Client', 'request body could not be read', 400);
    }
    if (new TextEncoder().encode(text).length > maxBytes) {
      return fault(version, 'Client', `request body exceeds ${String(maxBytes)} bytes`, 413);
    }

    const parsed = readEnvelope(text, version);
    if ('error' in parsed) {
      return respond(parsed.error, 400, 'unknown', options, version, startedAt, now);
    }
    const { body, header } = parsed;

    const operation = options.operations[body.localName];
    if (operation === undefined) {
      return respond(
        callError('not_found', 'LNK_SOAP_FAULT', {
          message: `this endpoint has no operation named "${body.localName}"`,
        }),
        500,
        body.localName,
        options,
        version,
        startedAt,
        now,
      );
    }

    let principal: string | undefined;
    if (options.authenticate !== undefined) {
      const result = await options.authenticate(header);
      if (!result.ok) {
        return respond(result.error, 500, operation.operation, options, version, startedAt, now);
      }
      principal = result.username;
    }

    const decode = operation.decode ?? ((element: XmlElement) => recordFromXml(element));
    let response: unknown;
    try {
      const decoded = decode(body);
      response = await operation.handle(decoded as never, {
        request,
        operation: operation.operation,
        principal,
        header,
      });
    } catch (error) {
      return respond(
        handlerError(error),
        500,
        operation.operation,
        options,
        version,
        startedAt,
        now,
      );
    }

    const encode =
      operation.encode ??
      ((value: unknown) =>
        recordToXml(`${operation.operation}Response`, value, operation.namespace));
    const document = envelope(version, encode(response));

    const event: SoapServerEvent = {
      protocol: 'soap-server',
      operation: operation.operation,
      kind: 'ok',
      status: 200,
      elapsedMs: now() - startedAt,
    };
    options.onCall?.(event);

    return new Response(document, {
      status: 200,
      headers: { 'content-type': contentType(version) },
    });
  };
}

/** Turns a failure into the wire's own error shape, and records one server event. */
function respond(
  error: CallError,
  status: number,
  operation: string,
  options: SoapServerOptions<Record<string, SoapOperationHandler<never, unknown>>>,
  version: SoapVersion,
  startedAt: number,
  now: () => number,
): Response {
  options.onCall?.({
    protocol: 'soap-server',
    operation,
    kind: error.kind,
    status,
    elapsedMs: now() - startedAt,
  });
  return fault(
    version,
    faultSide(error),
    error.message ?? `operation failed with ${error.code}`,
    status,
  );
}

/** § 9 kind → which side of the fault. A caller's mistake is not a server error. */
function faultSide(error: CallError): 'Client' | 'Server' {
  switch (error.kind) {
    case 'invalid_argument':
    case 'not_found':
    case 'conflict':
    case 'unauthenticated':
    case 'permission_denied':
    case 'cancelled':
      return 'Client';
    case 'timeout':
    case 'unavailable':
    case 'rate_limited':
    case 'protocol':
    case 'server':
    case 'unknown':
      return 'Server';
  }
}

function handlerError(error: unknown): CallError {
  if (isCallError(error)) return error;
  if (error instanceof Error) {
    return callError('server', 'LNK_SOAP_FAULT', {
      message: error.message,
      retryable: retryableKind('server'),
      cause: error,
    });
  }
  return callError('server', 'LNK_SOAP_FAULT', { message: 'the handler failed' });
}

function isCallError(value: unknown): value is CallError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'code' in value &&
    'retryable' in value &&
    !('ok' in value)
  );
}

function contentType(version: SoapVersion): string {
  return version === '1.1' ? 'text/xml; charset=utf-8' : 'application/soap+xml; charset=utf-8';
}

/** A `Fault` in the right dialect for the version, always HTTP 500 (or the given status). */
export function fault(
  version: SoapVersion,
  side: 'Client' | 'Server',
  message: string,
  status = 500,
): Response {
  const detail =
    version === '1.1'
      ? [
          xmlElement('faultcode', { children: [{ text: `soap:${side}` }] }),
          xmlElement('faultstring', { children: [{ text: message }] }),
        ]
      : [
          xmlElement('soap:Code', {
            children: [xmlElement('soap:Value', { children: [{ text: `soap:${side}` }] })],
          }),
          xmlElement('soap:Reason', {
            children: [xmlElement('soap:Text', { children: [{ text: message }] })],
          }),
        ];

  const body = xmlElement('soap:Fault', { children: detail });
  return new Response(envelope(version, body), {
    status,
    headers: { 'content-type': contentType(version) },
  });
}

/** Envelope, namespace and a single body element — or the `CallError` that says why not. */
function readEnvelope(
  text: string,
  version: SoapVersion,
):
  | { readonly body: XmlElement; readonly header: XmlElement | undefined }
  | { readonly error: CallError } {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (error) {
    const detail = error instanceof XmlParseError ? error.message : 'unreadable XML';
    return {
      error: callError('protocol', 'LNK_PROTOCOL', {
        message: `request is not acceptable XML: ${detail}`,
      }),
    };
  }

  const failed = (message: string): { readonly error: CallError } => ({
    error: callError('protocol', 'LNK_PROTOCOL', { message }),
  });

  if (root.localName !== 'Envelope') {
    return failed(`expected a SOAP Envelope, found <${root.name}>`);
  }

  const expected = SOAP_NAMESPACE[version];
  if (root.namespace !== undefined && root.namespace !== expected) {
    return failed(`this endpoint speaks SOAP ${version} (${expected}), not ${root.namespace}`);
  }

  const soapBody = childNamed(root, 'Body');
  if (soapBody === undefined) return failed('SOAP Envelope has no Body');

  const payload = elementChildren(soapBody)[0];
  if (payload === undefined) return failed('SOAP Body is empty');

  return { body: payload, header: childNamed(root, 'Header') };
}
