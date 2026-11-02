/**
 * AWS Lambda adapter (`DPL-013`, `DPL-015`).
 *
 * Lambda differs from Workers in the one way that matters: **one function handles many
 * event shapes**, and the platform tells you which by the shape of the event, not by an
 * export name. So this adapter is an event router with three responsibilities:
 *
 *   · **Translate the event into the framework's own vocabulary.** API Gateway v2 (and a
 *     Function URL, which sends the same v2 envelope) becomes a `Request`; SQS becomes a
 *     batch of messages; EventBridge becomes a `ScheduledController`. A unit's code never
 *     sees `event.body`, `isBase64Encoded` or `Records`.
 *   · **Translate the outcome back.** A `Response` becomes `{ statusCode, headers, body }`,
 *     base64-encoded when the body is binary. SQS returns **partial batch failures** —
 *     only the messages that should be retried — instead of failing the whole batch, which
 *     is the difference between one poison message and a redelivered fifty.
 *   · **Give the handler the deadline it actually has.** `context.getRemainingTimeInMillis()`
 *     becomes an `AbortSignal` that fires `graceMs` before the platform kills the function,
 *     so in-flight work can drain instead of disappearing mid-write (`DPL-015`).
 *
 * Nothing here imports `aws-sdk` or `@types/aws-lambda`: the event shapes are declared as
 * the narrow slices this file reads, which keeps the adapter testable with plain objects,
 * bundleable for Node without a vendor runtime, and honest about what it depends on.
 */

/** The slice of `Context` a handler may use. */
import { TsirError } from '@tsir/core';
export interface LambdaContextLike {
  readonly functionName?: string;
  readonly awsRequestId?: string;
  getRemainingTimeInMillis?(): number;
}

export interface ApiGatewayV2Event {
  readonly version?: string;
  readonly routeKey?: string;
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly cookies?: readonly string[];
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly http?: {
      readonly method: string;
      readonly path?: string;
      readonly sourceIp?: string;
      readonly protocol?: string;
    };
    readonly requestId?: string;
  };
}

export interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
  readonly eventSource?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly eventSourceARN?: string;
}

export interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

export interface EventBridgeEvent {
  readonly source: string;
  readonly 'detail-type': string;
  readonly time: string;
  readonly detail: unknown;
}

/**
 * An SNS notification event. SNS delivers to Lambda as a single-record batch;
 * the record carries the topic ARN, the message id, and the message body
 * (which may itself be JSON or a raw string when `RawMessageDelivery` is on).
 */
export interface SnsRecord {
  readonly EventSource: string;
  readonly Sns: {
    readonly TopicArn: string;
    readonly MessageId: string;
    readonly Message: string;
    readonly Subject?: string;
    readonly Timestamp?: string;
  };
}

export interface SnsEvent {
  readonly Records: readonly SnsRecord[];
}

export interface LambdaResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: boolean;
  /** SQS partial-batch failures; absent for HTTP and schedule invocations. */
  readonly batchItemFailures?: readonly { readonly itemIdentifier: string }[];
}

/** What one unit serves on Lambda. Members are optional, as in `CloudflareUnit`. */
export interface LambdaUnit {
  readonly unit: string;
  readonly fetch?:
    ((request: Request, context: LambdaContextLike) => Promise<Response>) | undefined;
  readonly queue?:
    | ((
        message: { readonly id: string; readonly body: unknown; readonly record: SqsRecord },
        context: LambdaContextLike,
      ) => Promise<void>)
    | undefined;
  readonly scheduled?:
    | ((
        event: {
          readonly source: string;
          readonly detail: unknown;
          readonly time: string;
          readonly signal: AbortSignal;
        },
        context: LambdaContextLike,
      ) => Promise<void>)
    | undefined;
  /**
   * Custom EventBridge events (`@OnEventBridge`). Dispatched by `detail-type` inside the unit;
   * the bus-level filtering happens in the emitted rule. Scheduled EventBridge events
   * (`aws.events` / `aws.scheduler`) still go to `scheduled`, not here.
   */
  readonly eventbridge?:
    | ((
        event: {
          readonly source: string;
          readonly 'detail-type': string;
          readonly detail: unknown;
          readonly time: string;
          readonly signal: AbortSignal;
        },
        context: LambdaContextLike,
      ) => Promise<void>)
    | undefined;
  readonly sns?:
    | ((
        message: {
          readonly id: string;
          readonly topicArn: string;
          readonly subject?: string;
          readonly body: unknown;
          readonly record: SnsRecord;
        },
        context: LambdaContextLike,
      ) => Promise<void>)
    | undefined;
  /**
   * Direct invoke — Step Functions tasks and any other synchronous call that does not
   * arrive through an AWS event envelope. The `event` is whatever the caller passed.
   */
  readonly invoke?:
    | ((
        event: unknown,
        context: LambdaContextLike,
      ) => Promise<unknown>)
    | undefined;
}

export interface LambdaOptions {
  readonly onError?:
    | ((
        error: unknown,
        info: {
          readonly unit: string;
          readonly trigger: 'fetch' | 'queue' | 'scheduled' | 'sns' | 'eventbridge';
        },
      ) => void)
    | undefined;
  /** Milliseconds of headroom kept before the platform's own timeout. Default 500. */
  readonly graceMs?: number | undefined;
  /** Content types that are sent as text rather than base64. */
  readonly textContentTypes?: readonly string[] | undefined;
}

export type LambdaHandler = (event: unknown, context: LambdaContextLike) => Promise<LambdaResponse>;

const TEXT_HINT = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/u;

/**
 * The deadline a Lambda has.
 *
 * The signal is created per invocation and aborted on a timer rather than checked
 * lazily: code that awaits a database write needs an abort, not a boolean it forgot to
 * read. `graceMs` exists because "abort at the same millisecond the platform kills the
 * process" is not a deadline, it is a race.
 */
export function deadlineSignal(
  context: LambdaContextLike,
  graceMs = 500,
): { readonly signal: AbortSignal; readonly remainingMs: number; readonly dispose: () => void } {
  const remainingMs = context.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();

  if (!Number.isFinite(remainingMs)) {
    return { signal: controller.signal, remainingMs, dispose: () => undefined };
  }

  const budget = Math.max(0, remainingMs - graceMs);
  const timer = setTimeout(() => {
    controller.abort(new Error(`lambda deadline: ${String(budget)} ms budget exhausted`));
  }, budget);
  (timer as { unref?: () => void }).unref?.();

  return {
    signal: controller.signal,
    remainingMs: budget,
    dispose: () => clearTimeout(timer),
  };
}

function isApiGatewayV2(event: unknown): event is ApiGatewayV2Event {
  if (typeof event !== 'object' || event === null) return false;
  const candidate = event as Partial<ApiGatewayV2Event>;
  if (typeof candidate.rawPath === 'string') return true;
  return candidate.requestContext?.http !== undefined;
}

function isSqs(event: unknown): event is SqsEvent {
  if (typeof event !== 'object' || event === null) return false;
  const records = (event as { Records?: unknown }).Records;
  if (!Array.isArray(records) || records.length === 0) return false;
  // Every record carries `eventSource`, but checking all of them rather than the first
  // costs nothing and survives a hand-written fixture that only set it once.
  return records.some(
    (record) =>
      typeof (record as { eventSource?: unknown }).eventSource === 'string' &&
      (record as { eventSource: string }).eventSource.toUpperCase() === 'AWS:SQS',
  );
}

function isEventBridge(event: unknown): event is EventBridgeEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as EventBridgeEvent)['detail-type'] === 'string' &&
    typeof (event as EventBridgeEvent).source === 'string'
  );
}

function isSns(event: unknown): event is SnsEvent {
  if (typeof event !== 'object' || event === null) return false;
  const records = (event as { Records?: unknown }).Records;
  if (!Array.isArray(records) || records.length === 0) return false;
  return records.some((record) => {
    const source = (record as { EventSource?: unknown }).EventSource;
    return typeof source === 'string' && source.toUpperCase() === 'AWS:SNS';
  });
}

/**
 * Scheduled EventBridge sources. A cron rule sends `aws.events`; EventBridge
 * Scheduler sends `aws.scheduler`. Anything else is a custom-bus event and
 * must not reach the `scheduled` handler (DPL-025): a custom-bus event routed
 * to a cron handler runs the wrong code with no way to detect it.
 */
const SCHEDULED_SOURCES: ReadonlySet<string> = new Set(['aws.events', 'aws.scheduler']);

function isScheduledEventBridge(event: EventBridgeEvent): boolean {
  return SCHEDULED_SOURCES.has(event.source);
}

/** API Gateway v2 (and a Function URL) → the `Request` the pipeline expects. */
export function requestFromApiGatewayV2(event: ApiGatewayV2Event): Request {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath.startsWith('/') ? event.rawPath : `/${event.rawPath}`;
  const query =
    event.rawQueryString === undefined || event.rawQueryString === ''
      ? ''
      : `?${event.rawQueryString}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value === undefined) continue;
    headers.set(name, value);
  }
  // v2 puts cookies in their own array; the pipeline only ever reads `cookie`.
  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.set('cookie', event.cookies.join('; '));
  }

  const body = event.body === undefined ? null : event.body;
  const init: RequestInit = { method, headers };
  if (body !== null) {
    init.body = event.isBase64Encoded === true ? decodeBase64(body) : body;
  }

  // The host is synthetic: the pipeline routes on `pathname`, and every hop that matters
  // (API Gateway, a Function URL) terminates TLS before the function sees the request.
  return new Request(`https://lambda.test${path}${query}`, init);
}

/** The pipeline's `Response` → the JSON envelope API Gateway v2 returns. */
export async function responseToApiGatewayV2(
  response: Response,
  options: LambdaOptions = {},
): Promise<LambdaResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    // API Gateway v2 forbids multi-value headers here and owns the encoding headers.
    if (name === 'content-length' || name === 'transfer-encoding') return;
    headers[name] = value;
  });

  const contentType = response.headers.get('content-type') ?? '';
  const declared = (options.textContentTypes ?? []).some((allowed) =>
    contentType.startsWith(allowed),
  );

  const bytes = new Uint8Array(await response.arrayBuffer());
  // Three ways to decide "is this text": a declared text type, a type the caller forced,
  // or the bytes surviving a UTF-8 round-trip unchanged. The third is what saves
  // `new Response('ok')` — no content-type, and base64 of a greeting helps nobody — while
  // still refusing to call an actual image text.
  const textish = TEXT_HINT.test(contentType) || declared || utf8RoundTrips(bytes);

  // `text()` on a binary body is how an image comes out as `\uFFFD` sequences: base64 is
  // the only way bytes survive a JSON envelope intact.
  return textish
    ? {
        statusCode: response.status,
        headers,
        body: new TextDecoder().decode(bytes),
        isBase64Encoded: false,
      }
    : {
        statusCode: response.status,
        headers,
        body: encodeBase64(bytes),
        isBase64Encoded: true,
      };
}

/**
 * The handler.
 *
 * Routing is by event shape, in the order a request is most likely to arrive: HTTP first
 * (the overwhelming majority), then SQS, then EventBridge, and anything else is a
 * configuration error rather than a silent 200.
 */
export function toLambdaHandler(unit: LambdaUnit, options: LambdaOptions = {}): LambdaHandler {
  const report = (
    error: unknown,
    trigger: 'fetch' | 'queue' | 'scheduled' | 'sns' | 'eventbridge',
  ): void => {
    options.onError?.(error, { unit: unit.unit, trigger });
  };

  return async (event, context) => {
    if (isApiGatewayV2(event)) {
      const serve = unit.fetch;
      if (serve === undefined) {
        throw unitHasNo('fetch handler', 'an HTTP event', unit.unit);
      }
      const response = await serve(requestFromApiGatewayV2(event), context);
      return await responseToApiGatewayV2(response, options);
    }

    if (isSqs(event)) {
      const consume = unit.queue;
      if (consume === undefined) {
        throw unitHasNo('queue handler', 'an SQS event', unit.unit);
      }

      // Partial batch failures: a message that cannot be handled is reported by id and
      // redelivered alone. Failing the invocation instead means the whole batch returns,
      // including the messages that succeeded — the classic duplicate-processing bug.
      const failures: { itemIdentifier: string }[] = [];
      for (const record of event.Records) {
        const deadline = deadlineSignal(context, options.graceMs);
        try {
          const body = parseBody(record.body);
          await consume({ id: record.messageId, body, record }, context);
        } catch (error) {
          report(error, 'queue');
          if (isRetryable(error)) failures.push({ itemIdentifier: record.messageId });
        } finally {
          deadline.dispose();
        }
      }

      return {
        statusCode: 200,
        headers: {},
        body: '',
        isBase64Encoded: false,
        batchItemFailures: failures,
      };
    }

    if (isEventBridge(event)) {
      // Scheduled EventBridge events (`aws.events`, `aws.scheduler`) go to `scheduled`.
      // Everything else is a custom-bus event and goes to `eventbridge`, where the unit
      // dispatches by `detail-type` (DPL-025 + the `@OnEventBridge` listener path).
      if (isScheduledEventBridge(event)) {
        const run = unit.scheduled;
        if (run === undefined) {
          throw unitHasNo('scheduled handler', 'a schedule event', unit.unit);
        }
        const deadline = deadlineSignal(context, options.graceMs);
        try {
          await run(
            {
              source: event.source,
              detail: event.detail,
              time: event.time,
              signal: deadline.signal,
            },
            context,
          );
        } catch (error) {
          // A cron has no retry to trigger: report it, and the next tick is the retry.
          report(error, 'scheduled');
        } finally {
          deadline.dispose();
        }
        return { statusCode: 200, headers: {}, body: '', isBase64Encoded: false };
      }

      const run = unit.eventbridge;
      if (run === undefined) {
        throw unitHasNo('eventbridge handler', 'a custom EventBridge event', unit.unit);
      }
      const deadline = deadlineSignal(context, options.graceMs);
      try {
        await run(
          {
            source: event.source,
            'detail-type': event['detail-type'],
            detail: event.detail,
            time: event.time,
            signal: deadline.signal,
          },
          context,
        );
      } catch (error) {
        // EventBridge has no retry either: report it and let the rule's retry policy decide.
        report(error, 'eventbridge');
        throw error;
      } finally {
        deadline.dispose();
      }
      return { statusCode: 200, headers: {}, body: '', isBase64Encoded: false };
    }

    if (isSns(event)) {
      const notify = unit.sns;
      if (notify === undefined) {
        throw unitHasNo('sns handler', 'an SNS event', unit.unit);
      }
      const deadline = deadlineSignal(context, options.graceMs);
      try {
        for (const record of event.Records) {
          const sns = record.Sns;
          await notify(
            {
              id: sns.MessageId,
              topicArn: sns.TopicArn,
              ...(sns.Subject !== undefined ? { subject: sns.Subject } : {}),
              body: parseBody(sns.Message),
              record,
            },
            context,
          );
        }
      } catch (error) {
        // SNS retries on Lambda failure, so an unhandled error becomes a redelivery.
        report(error, 'sns');
        throw error;
      } finally {
        deadline.dispose();
      }
      return { statusCode: 200, headers: {}, body: '', isBase64Encoded: false };
    }

    // Direct invoke — Step Functions tasks, console test invokes, and any caller that
    // passes a raw payload without an AWS event envelope (DPL-029).
    const invoke = unit.invoke;
    if (invoke !== undefined) {
      const result = await invoke(event, context);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: result === undefined ? '' : JSON.stringify(result),
        isBase64Encoded: false,
      };
    }

    throw eventUnrecognised(
      `unit "${unit.unit}" received an event it does not recognise: pass an API Gateway v2 ` +
        'request, an SQS batch, an SNS notification, an EventBridge schedule event, or a ' +
        'direct invoke payload',
    );
  };
}

/** An SQS body is whatever the producer wrote: JSON when it parses, the raw string otherwise. */
function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/**
 * Whether an error should send an SQS message back to the queue.
 *
 * The same contract as the Workers adapter: one duck-typed field, and absence means "do
 * not retry". Exported because a unit may want to decide per message rather than per throw.
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const retryable = (error as { retryable?: unknown }).retryable;
  if (retryable === true) return true;
  if (retryable === false) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === 'unavailable' || kind === 'timeout' || kind === 'rate_limited';
}

/* ── base64 without a runtime ───────────────────────────────────────────────────── */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A body is text if decoding and re-encoding it changes nothing. */
function utf8RoundTrips(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const again = new TextEncoder().encode(text);
    if (again.byteLength !== bytes.byteLength) return false;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== again[index]) return false;
    }
    return true;
  } catch {
    // Invalid UTF-8: a PNG, a gzip stream, a protobuf — base64 is the only honest encoding.
    return false;
  }
}

/**
 * Base64 by hand.
 *
 * `Buffer` is a Node global and `btoa` a browser one; the adapter runs on Node but is
 * bundled and unit-tested everywhere, and a 20-line encoder is cheaper than a conditional
 * polyfill that fails in exactly one of the three runtimes.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;

    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : '=';
    out += index + 2 < bytes.length ? ALPHABET[triple & 63] : '=';
  }
  return out;
}

export function decodeBase64(text: string): Uint8Array {
  const cleaned = text.replace(/\s+/gu, '');
  const bytes: number[] = [];

  for (let index = 0; index < cleaned.length; index += 4) {
    const chunk = cleaned.slice(index, index + 4);
    const values = [...chunk].map((char) => (char === '=' ? 0 : ALPHABET.indexOf(char)));
    const triple =
      ((values[0] ?? 0) << 18) |
      ((values[1] ?? 0) << 12) |
      ((values[2] ?? 0) << 6) |
      (values[3] ?? 0);

    bytes.push((triple >> 16) & 255);
    if (chunk[2] !== undefined && chunk[2] !== '=') bytes.push((triple >> 8) & 255);
    if (chunk[3] !== undefined && chunk[3] !== '=') bytes.push(triple & 255);
  }

  return new Uint8Array(bytes);
}

function unitHasNo(what: string, event: string, unit: string): TsirError {
  return new TsirError('DPL_UNIT_EMPTY', `unit "${unit}" has no ${what} but received ${event}`, {
    kind: 'deploy',
    hint: 'the unit was built without this trigger; add it to the unit, or route the event elsewhere',
  });
}

function eventUnrecognised(message: string): TsirError {
  return new TsirError('DPL_EVENT_UNRECOGNISED', message, { kind: 'deploy' });
}
