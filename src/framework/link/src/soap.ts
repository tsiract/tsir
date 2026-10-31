/**
 * SOAP client (`LNK-017`, `LNK-018`): SOAP 1.1 and 1.2 over `fetch`, with faults,
 * deadlines, retries and a circuit breaker behaving exactly like the REST client's.
 *
 * Three things are deliberately unlike the usual SOAP library:
 *
 *   1. **Operations are data, not parsing.** An operation says how its body element is
 *      built and decoded. Nothing here reads a WSDL at runtime, so a cold start never
 *      fetches a contract and a contract cannot change under a running process
 *      (`LNK-016` compiles WSDLs into these descriptors at build time).
 *   2. **A fault is a `CallError`, with the protocol's own words kept.** SOAP sends HTTP
 *      500 with a `Fault` in the body, which is why status-mapping alone gets this wrong;
 *      the body is parsed first, and the `faultcode` decides the kind through the same
 *      table REST and gRPC use (§ 9).
 *   3. **The XML is parsed by our own bounds-checked reader** (`./xml.ts`, ADR-0023).
 *      DTDs, entity declarations and external references are refused by construction, so
 *      the hardening tests are about what *cannot* happen rather than about options.
 */

import { createCircuitBreaker, type CircuitBreaker } from './breaker.ts';
import { preflight, withTimeout } from './deadline.ts';
import {
  assertHttpsUrl,
  callError,
  invalidLinkConfig,
  kindForHttpStatus,
  kindForSoapFault,
  parseRetryAfter,
  retryableKind,
} from './errors.ts';
import { NO_RETRY, decideRetry, type RetryPolicy } from './retry.ts';
import { outboundHeaders } from './trace.ts';
import { SOAP_NAMESPACE, envelope, type SoapRecord, type SoapVersion } from './soap-core.ts';
import { securityHeader, type UsernameTokenOptions } from './wsse.ts';
import {
  fail,
  ok,
  type CallContext,
  type CallErrorKind,
  type CallMeta,
  type CallResult,
} from './types.ts';
import {
  XmlParseError,
  childNamed,
  elementChildren,
  parseXml,
  recordFromXml,
  recordToXml,
  textOf,
  xmlElement,
  type XmlElement,
} from './xml.ts';

export { recordFromXml, recordToXml };
export {
  XmlParseError,
  attributeNamed,
  childNamed,
  childrenNamed,
  elementChildren,
  escapeXmlText,
  isElement,
  parseXml,
  serializeXml,
  textOf,
  xmlElement,
  xmlLeaf,
  type XmlElement,
  type XmlNode,
  type XmlRecord,
  type XmlValue,
} from './xml.ts';
export {
  parseDecimal,
  shapeFromXml,
  shapeToXml,
  type SoapFieldShape,
  type SoapScalar,
  type SoapShapeRecord,
  type SoapShapeValue,
} from './soap-shape.ts';
export { SOAP_NAMESPACE, envelope, withNamespace } from './soap-core.ts';
export {
  createSoapHandler,
  fault,
  type SoapHandler,
  type SoapHandlerContext,
  type SoapOperationHandler,
  type SoapServerEvent,
  type SoapServerOptions,
} from './soap-server.ts';
export type { SoapObject, SoapRecord, SoapValue, SoapVersion } from './soap-core.ts';
export {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_TOKEN_MAX_AGE_MS,
  base64Decode,
  base64Encode,
  passwordDigest,
  randomNonce,
  securityHeader,
  serializeSecurityHeader,
  verifyUsernameToken,
  type PasswordMode,
  type UsernameTokenOptions,
  type UsernameTokenResult,
  type UsernameTokenVerifier,
} from './wsse.ts';

export interface SoapOperation<TRequest = SoapRecord, TResponse = SoapRecord> {
  /** The body element name, e.g. `GetTaxRate`. Also what appears in logs. */
  readonly operation: string;
  /** Target namespace, emitted as `xmlns` on the body element. */
  readonly namespace?: string | undefined;
  /** `SOAPAction` (1.1) or the `action` media-type parameter (1.2). */
  readonly action?: string | undefined;
  /** Builds the body element. Default: `recordToXml(operation, request)`. */
  readonly encode?: ((request: TRequest) => XmlElement) | undefined;
  /** Decodes the body element. Default: `recordFromXml`. */
  readonly decode?: ((element: XmlElement) => TResponse) | undefined;
  /** Per-operation fault mapping, merged over the client's. */
  readonly faults?: Readonly<Record<string, CallErrorKind>> | undefined;
}

export interface SoapClientDeps {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random: () => number;
}

/** One event per call: the `link_calls_total` counter and the client span. */
export interface SoapCallEvent {
  readonly protocol: 'soap';
  readonly target: string;
  readonly operation: string;
  readonly kind: string;
  readonly status: number | undefined;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly traceId: string;
}

export interface SoapClientOptions<Ops extends Record<string, SoapOperation<never, unknown>>> {
  /** Absolute URL of the endpoint. `http:` is refused outside loopback. */
  readonly endpoint: string;
  /** Default `1.2` — 1.1 is supported, not preferred. */
  readonly version?: SoapVersion | undefined;
  readonly operations: Ops;
  /** Default context for calls; a call may pass its own. */
  readonly ctx?: CallContext | undefined;
  readonly timeoutMs?: number | undefined;
  readonly retry?: RetryPolicy | undefined;
  readonly breaker?:
    { readonly threshold?: number; readonly cooldownMs?: number } | false | undefined;
  /** Hard cap on a response body. 8 MiB, matching the REST client. */
  readonly maxResponseBytes?: number | undefined;
  /** Client-wide fault mapping (`{ 'app:QuotaExceeded': 'rate_limited' }`). */
  readonly faults?: Readonly<Record<string, CallErrorKind>> | undefined;
  readonly onCall?: ((event: SoapCallEvent) => void) | undefined;
  /** WS-Security for every call on this client (`LNK-019`). */
  readonly security?: SoapSecurity | undefined;
  readonly deps?: Partial<SoapClientDeps> | undefined;
}

export interface SoapSecurity {
  readonly usernameToken: UsernameTokenOptions;
  /** Default true: a server that does not understand the header must fail loudly. */
  readonly mustUnderstand?: boolean | undefined;
}

export interface SoapCallOptions {
  readonly ctx?: CallContext | undefined;
  readonly timeoutMs?: number | undefined;
  /** SOAP calls are POSTs: a retry needs the caller to say the operation is safe. */
  readonly idempotent?: boolean | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

// Inferred from the hooks rather than from `SoapOperation<infer R, infer S>`: a function
// parameter is contravariant, so `encode: (request: { a: number }) => …` is *not*
// assignable to `SoapOperation<unknown, …>` and that inference silently fell back to the
// default. Reading the hooks directly keeps the caller's shapes.
type RequestOf<O> = O extends { readonly encode?: ((request: infer R) => XmlElement) | undefined }
  ? unknown extends R
    ? SoapRecord
    : R
  : SoapRecord;
type ResponseOf<O> = O extends {
  readonly decode?: ((element: XmlElement) => infer S) | undefined;
}
  ? unknown extends S
    ? SoapRecord
    : S
  : SoapRecord;

export interface SoapClient<Ops extends Record<string, SoapOperation<never, unknown>>> {
  readonly endpoint: string;
  readonly version: SoapVersion;
  call<K extends keyof Ops & string>(
    operation: K,
    request: RequestOf<Ops[K]>,
    options?: SoapCallOptions,
  ): Promise<CallResult<ResponseOf<Ops[K]>>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1_048_576;

export function createSoapClient<Ops extends Record<string, SoapOperation<never, unknown>>>(
  options: SoapClientOptions<Ops>,
): SoapClient<Ops> {
  const version = options.version ?? '1.2';
  const endpoint = parseEndpoint(options.endpoint);
  const deps: SoapClientDeps = {
    fetch: options.deps?.fetch ?? ((input, init) => fetch(input, init)),
    now: options.deps?.now ?? (() => Date.now()),
    sleep:
      options.deps?.sleep ??
      ((ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        })),
    random: options.deps?.random ?? Math.random,
  };

  const retryPolicy = options.retry ?? NO_RETRY;
  const breaker: CircuitBreaker | undefined =
    options.breaker === false
      ? undefined
      : createCircuitBreaker({
          ...(options.breaker ?? {}),
          now: deps.now,
        });
  const target = endpoint.origin;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  for (const [name, operation] of Object.entries(options.operations)) {
    if (operation.operation !== name) {
      throw invalidLinkConfig(
        `operations["${name}"].operation is "${operation.operation}" — the key names the operation, and a mismatch makes logs lie`,
      );
    }
  }

  return {
    endpoint: endpoint.href,
    version,

    async call<K extends keyof Ops & string>(
      name: K,
      request: RequestOf<Ops[K]>,
      callOptions: SoapCallOptions = {},
    ): Promise<CallResult<ResponseOf<Ops[K]>>> {
      const operation = options.operations[name];
      if (operation === undefined) {
        throw invalidLinkConfig(`operation "${name}" is not declared on this client`);
      }

      const ctx = callOptions.ctx ?? options.ctx;
      if (ctx === undefined) {
        throw invalidLinkConfig(
          `call("${name}") has no CallContext — pass one at construction or per call`,
        );
      }

      const startedAt = deps.now();
      const meta = (extra: Partial<CallMeta> = {}): CallMeta => ({
        protocol: 'soap',
        target,
        attempts: 1,
        elapsedMs: deps.now() - startedAt,
        ...extra,
      });

      const early = preflight(ctx, deps.now());
      if (early !== undefined) return settle(fail(early, meta()), operation, options, ctx.traceId);

      if (breaker !== undefined && !breaker.allow()) {
        return settle(fail(breaker.openError(target), meta()), operation, options, ctx.traceId);
      }

      // The record key and the operation agree (checked above), so this cast is about the
      // generic parameter, not about the value: `Ops[K]` is inferred as its base shape.
      // Built once per call: the nonce and the timestamp are per-message, and a digest
      // replayed across retries would defeat the freshness window on the server.
      const header =
        options.security === undefined
          ? undefined
          : await securityHeader(options.security.usernameToken, {
              ...(options.security.mustUnderstand === undefined
                ? {}
                : { mustUnderstand: options.security.mustUnderstand }),
              envelopeNamespace: SOAP_NAMESPACE[version],
            });

      const body = encodeRequest(operation as SoapOperation<RequestOf<Ops[K]>, unknown>, request);
      const scoped = withTimeout(ctx, callOptions.timeoutMs ?? defaultTimeoutMs, deps.now());
      const faults = { ...options.faults, ...operation.faults };

      try {
        let result: CallResult<ResponseOf<Ops[K]>> | undefined;

        for (let attempt = 1; attempt <= retryPolicy.attempts; attempt += 1) {
          const expired = preflight(scoped.ctx, deps.now());
          if (expired !== undefined) {
            result = fail(expired, meta({ attempts: Math.max(1, attempt - 1) }));
            break;
          }

          const response = await exchange<Ops, K>({
            version,
            operation,
            operationName: name,
            body,
            header,
            endpoint,
            ctx: scoped.ctx,
            headers: callOptions.headers ?? {},
            faults,
            maxBytes,
            target,
            deps,
          });
          result = { ...response, meta: { ...response.meta, attempts: attempt } };

          if (result.ok || attempt === retryPolicy.attempts) break;

          const decision = decideRetry({
            policy: retryPolicy,
            attempt,
            error: result.error,
            idempotent: callOptions.idempotent ?? false,
            elapsedMs: deps.now() - startedAt,
            random: deps.random,
          });
          if (!decision.retry) break;

          await deps.sleep(decision.delayMs, scoped.ctx.signal);
        }

        const settled =
          result ?? fail<ResponseOf<Ops[K]>>(callError('unknown', 'LNK_UNKNOWN'), meta());

        if (settled.ok) breaker?.onSuccess();
        else if (retryableKind(settled.error.kind)) breaker?.onFailure();

        return settle(
          { ...settled, meta: { ...settled.meta, elapsedMs: deps.now() - startedAt } },
          operation,
          options,
          ctx.traceId,
        );
      } finally {
        scoped.dispose();
      }
    },
  };
}

interface ExchangeInput<
  Ops extends Record<string, SoapOperation<never, unknown>>,
  K extends keyof Ops & string,
> {
  readonly version: SoapVersion;
  readonly operation: Ops[K];
  readonly operationName: string;
  readonly body: XmlElement;
  readonly header: XmlElement | undefined;
  readonly endpoint: URL;
  readonly ctx: CallContext;
  readonly headers: Readonly<Record<string, string>>;
  readonly faults: Readonly<Record<string, CallErrorKind>>;
  readonly maxBytes: number;
  readonly target: string;
  readonly deps: SoapClientDeps;
}

/** One round trip. Retries call this again; nothing here is stateful. */
async function exchange<
  Ops extends Record<string, SoapOperation<never, unknown>>,
  K extends keyof Ops & string,
>(input: ExchangeInput<Ops, K>): Promise<CallResult<ResponseOf<Ops[K]>>> {
  const startedAt = input.deps.now();
  const meta = (status?: number): CallMeta => ({
    protocol: 'soap',
    target: input.target,
    attempts: 1,
    elapsedMs: input.deps.now() - startedAt,
    ...(status === undefined ? {} : { status }),
  });

  const headers = outboundHeaders(input.ctx, {
    extra: { ...contentHeaders(input.version, input.operation.action), ...input.headers },
  }).headers;

  let response: Response;
  try {
    response = await input.deps.fetch(input.endpoint.href, {
      method: 'POST',
      headers,
      body: envelope(input.version, input.body, input.header),
      signal: input.ctx.signal,
      redirect: 'manual',
    });
  } catch (error) {
    const reason = preflight(input.ctx, input.deps.now());
    if (reason !== undefined) return fail(reason, meta());
    return fail(
      callError('unavailable', 'LNK_NETWORK', {
        retryable: true,
        cause: error,
        message: `the request to ${input.target} never completed`,
      }),
      meta(),
    );
  }

  const declaredLength = contentLength(response.headers.get('content-length'));
  const tooLarge =
    declaredLength !== undefined && declaredLength > input.maxBytes
      ? fail<ResponseOf<Ops[K]>>(
          callError('protocol', 'LNK_PROTOCOL', {
            message: `response body exceeds the ${String(input.maxBytes)}-byte limit`,
          }),
          meta(response.status),
        )
      : undefined;
  if (tooLarge !== undefined) return tooLarge;

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    const reason = preflight(input.ctx, input.deps.now());
    if (reason !== undefined) return fail(reason, meta(response.status));
    return fail(
      callError('protocol', 'LNK_PROTOCOL', { cause: error, message: 'response body was cut off' }),
      meta(response.status),
    );
  }

  if (text.length > input.maxBytes) {
    return fail(
      callError('protocol', 'LNK_PROTOCOL', {
        message: `response body exceeds the ${String(input.maxBytes)}-byte limit`,
      }),
      meta(response.status),
    );
  }

  const parsed = parseEnvelope(text, input, meta(response.status));
  if (!parsed.ok) {
    // A non-2xx that is not a SOAP envelope is a gateway or a load balancer answering,
    // not the service: its status is the only signal there is, and `503` must read as
    // "unavailable, retry" rather than as a malformed contract.
    if (!response.ok) {
      const kind = kindForHttpStatus(response.status);
      return fail(
        callError(kind, `HTTP_${String(response.status)}`, {
          message: `SOAP endpoint answered ${String(response.status)} without a SOAP Envelope`,
        }),
        meta(response.status),
      );
    }
    return parsed;
  }

  const { body } = parsed.value;
  if (body.localName === 'Fault') {
    return fail<ResponseOf<Ops[K]>>(
      faultError(body, input.version, input.faults),
      meta(response.status),
    );
  }

  if (!response.ok) {
    const kind = kindForHttpStatus(response.status);
    return fail(
      callError(kind, `HTTP_${String(response.status)}`, {
        message: `SOAP endpoint answered ${String(response.status)} without a Fault element`,
      }),
      meta(response.status),
    );
  }

  const decode = input.operation.decode ?? ((element: XmlElement) => recordFromXml(element));
  try {
    return ok(decode(body) as ResponseOf<Ops[K]>, meta(response.status));
  } catch (error) {
    return fail(
      callError('protocol', 'LNK_PROTOCOL', {
        cause: error,
        message: `response body could not be decoded into the operation's shape`,
      }),
      meta(response.status),
    );
  }
}

/**
 * `Content-Length` as a number, or `undefined` when it is absent or not a decimal.
 *
 * Written by hand rather than with `Number()`: a header is attacker-adjacent text, and
 * `Number(' 12 ')`, `Number('1e9')` and `Number('')` are all "helpful" in ways a length
 * check cannot afford (VLD-007).
 */
function contentLength(header: string | null): number | undefined {
  if (header === null || !/^\d{1,15}$/u.test(header)) return undefined;
  let value = 0;
  for (const digit of header) value = value * 10 + '0123456789'.indexOf(digit);
  return value;
}

/** The envelope, its namespace, and the body element — or a `protocol` failure. */
function parseEnvelope<
  Ops extends Record<string, SoapOperation<never, unknown>>,
  K extends keyof Ops & string,
>(
  text: string,
  input: ExchangeInput<Ops, K>,
  meta: CallMeta,
): CallResult<{ readonly body: XmlElement }> {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (error) {
    const detail = error instanceof XmlParseError ? error.message : 'unreadable XML';
    return fail(
      callError('protocol', 'LNK_PROTOCOL', {
        cause: error,
        message: `response is not acceptable XML: ${detail}`,
      }),
      meta,
    );
  }

  if (root.localName !== 'Envelope') {
    return fail(
      callError('protocol', 'LNK_PROTOCOL', {
        message: `expected a SOAP Envelope, found <${root.name}>`,
      }),
      meta,
    );
  }

  const expected = SOAP_NAMESPACE[input.version];
  if (root.namespace !== undefined && root.namespace !== expected) {
    return fail(
      callError('protocol', 'LNK_PROTOCOL', {
        message: `client speaks SOAP ${input.version} (${expected}) but the response uses ${root.namespace}`,
      }),
      meta,
    );
  }

  const body = childNamed(root, 'Body');
  if (body === undefined) {
    return fail(
      callError('protocol', 'LNK_PROTOCOL', { message: 'SOAP Envelope has no Body' }),
      meta,
    );
  }

  const payload = elementChildren(body)[0];
  if (payload === undefined) {
    return fail(callError('protocol', 'LNK_PROTOCOL', { message: 'SOAP Body is empty' }), meta);
  }

  return ok({ body: payload }, meta);
}

/** SOAP 1.1 `faultcode`/`faultstring`; SOAP 1.2 `Code/Value` + `Reason/Text`. */
function faultError(
  fault: XmlElement,
  version: SoapVersion,
  mapping: Readonly<Record<string, CallErrorKind>>,
): ReturnType<typeof callError> {
  const code =
    version === '1.1'
      ? textOf(childNamed(fault, 'faultcode') ?? xmlElement('faultcode'))
      : textOf(
          childNamed(childNamed(fault, 'Code') ?? xmlElement('Code'), 'Value') ??
            xmlElement('Value'),
        );

  const reason =
    version === '1.1'
      ? textOf(childNamed(fault, 'faultstring') ?? xmlElement('faultstring'))
      : textOf(
          childNamed(childNamed(fault, 'Reason') ?? xmlElement('Reason'), 'Text') ??
            xmlElement('Text'),
        );

  const retryAfterMs = retryAfterFromFault(fault);
  const kind = kindForSoapFault(code, mapping);
  // `detail` carries whatever the service put there; it is the one part of a SOAP fault
  // that is actually diagnostic, so it is preserved verbatim as the cause.
  const detail = childNamed(fault, 'detail');

  return callError(kind, 'LNK_SOAP_FAULT', {
    cause: detail ?? fault,
    message: code === '' ? reason || 'SOAP fault without a code' : `${code}: ${reason}`,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** A service that says "come back in 30" in a header or a detail element is obeyed. */
function retryAfterFromFault(fault: XmlElement): number | undefined {
  // SOAP 1.1 spells it `detail`, 1.2 spells it `Detail`; both are optional.
  const detail = childNamed(fault, 'detail') ?? childNamed(fault, 'Detail');
  if (detail === undefined) return undefined;
  const retryAfter = childNamed(detail, 'retryAfter');
  if (retryAfter === undefined) return undefined;
  return parseRetryAfter(textOf(retryAfter));
}

function settle<
  Ops extends Record<string, SoapOperation<never, unknown>>,
  K extends keyof Ops & string,
>(
  result: CallResult<ResponseOf<Ops[K]>>,
  operation: Ops[K],
  options: SoapClientOptions<Ops>,
  traceId: string,
): CallResult<ResponseOf<Ops[K]>> {
  options.onCall?.({
    protocol: 'soap',
    target: result.meta.target,
    operation: operation.operation,
    kind: result.ok ? 'ok' : result.error.kind,
    status: result.meta.status,
    attempts: result.meta.attempts,
    elapsedMs: result.meta.elapsedMs,
    traceId,
  });
  return result;
}

function contentHeaders(version: SoapVersion, action?: string): Record<string, string> {
  if (version === '1.1') {
    return {
      'content-type': 'text/xml; charset=utf-8',
      // SOAP 1.1: the action is a separate header, quoted by spec.
      ...(action === undefined ? {} : { soapaction: `"${action}"` }),
    };
  }
  // SOAP 1.2 moved the action into the media type; sending SOAPAction as well is what
  // produces the "wrong version" errors people file bugs about.
  const base = 'application/soap+xml; charset=utf-8';
  return {
    'content-type': action === undefined ? base : `${base}; action="${action}"`,
  };
}

function encodeRequest<TRequest>(
  operation: SoapOperation<TRequest, unknown>,
  request: TRequest,
): XmlElement {
  if (operation.encode !== undefined) return operation.encode(request);
  return recordToXml(operation.operation, request, operation.namespace);
}

function parseEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalidLinkConfig(`endpoint "${endpoint}" is not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidLinkConfig(`endpoint "${url.href}" must be http or https`);
  }
  assertHttpsUrl(url, 'endpoint');
  return url;
}
