/**
 * Tracing (`OBS-016`, `OBS-017`).
 *
 * W3C `traceparent`, a sampler, and spans — the three pieces a trace needs, over an exporter
 * interface rather than an SDK. The rules this file exists to enforce:
 *
 * · **A malformed `traceparent` is replaced, never forwarded.** Version `ff`, an all-zero trace or
 * span id, a wrong length, non-hex: all of them produce a *new* trace and a debug note, because
 * propagating garbage turns one broken client into a trace that spans half the internet.
 * · **Sampling is parent-based by default.** A trace already sampled upstream stays sampled —
 * otherwise a distributed trace becomes a set of disconnected fragments, and the operator who
 * asked for 10 % gets 10 % of every *service* instead of 10 % of every *request*.
 * · **A span carries OTel semantic-convention attributes**, not invented ones (`http.request.method`,
 * `db.system`, `messaging.operation`). A custom attribute is namespaced (`tsir.…`) and noted.
 *
 * Time is injected, ids are injected: a test asserts a parent/child relationship without a clock or
 * a random source, and a span's duration is an exact number rather than "roughly zero".
 */

import { configInvalid } from './errors.ts';

export interface TraceContext {
  /** 16 bytes, hex — 32 characters. */
  readonly traceId: string;
  /** 8 bytes, hex — 16 characters. */
  readonly spanId: string;
  /** The upstream sampling decision, from the `traceparent` flags byte. */
  readonly sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;

/**
 * Parse `version-traceid-spanid-flags`.
 *
 * Returns `undefined` for **every** invalid form — including the ones that look harmless. A caller
 * that cannot parse a header must start a new trace; there is no "best effort" trace id.
 */
export function parseTraceparent(header: string | null | undefined): TraceContext | undefined {
  if (typeof header !== 'string') return undefined;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (match === null) return undefined;

  const [, version, traceId, spanId, flags] = match;
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined
  ) {
    return undefined;
  }
  if (version === 'ff') return undefined; // reserved as invalid by the spec
  if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId)) return undefined; // all-zero ids are invalid

  // The flags byte is already known to be two hex characters, so it is decoded by a table rather
  // than by a parser: `parseInt` on attacker-supplied text is the kind of coercion this repo bans.
  const flagByte = (HEX_VALUES[flags[0] ?? '0'] ?? 0) * 16 + (HEX_VALUES[flags[1] ?? '0'] ?? 0);
  return { traceId, spanId, sampled: (flagByte & 0x01) === 0x01 };
}

const HEX_VALUES: Readonly<Record<string, number>> = Object.fromEntries(
  [...'0123456789abcdef'].map((digit, value) => [digit, value]),
);

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

export type SamplerKind = 'always' | 'never' | 'ratio' | 'parent-based';

export interface Sampler {
  readonly kind: SamplerKind;
  /** `parentSampled` is the upstream decision, `undefined` when this process starts the trace. */
  shouldSample(parentSampled: boolean | undefined): boolean;
}

export interface SamplerOptions {
  readonly kind?: SamplerKind | undefined;
  /** Used by `ratio` (and by `parent-based` for a *root* span). Default 1. */
  readonly ratio?: number | undefined;
  /** Injected for tests: a `ratio` sampler must be deterministic when the test says so. */
  readonly random?: (() => number) | undefined;
}

export function createSampler(options: SamplerOptions = {}): Sampler {
  const kind = options.kind ?? 'parent-based';
  const ratio = options.ratio ?? 1;
  if (ratio < 0 || ratio > 1)
    throw configInvalid(`sampler ratio is ${String(ratio)}; expected 0…1`);
  const random = options.random ?? Math.random;

  switch (kind) {
    case 'always':
      return { kind, shouldSample: () => true };
    case 'never':
      return { kind, shouldSample: () => false };
    case 'ratio':
      return { kind, shouldSample: () => random() < ratio };
    case 'parent-based':
      return {
        kind,
        // A parent's decision is authoritative, sampled **or** not: respecting only the positive
        // case is how a 10 % head sample becomes a 100 % tail in the next service.
        shouldSample: (parentSampled) =>
          parentSampled === undefined ? random() < ratio : parentSampled,
      };
    default:
      throw configInvalid(`unknown sampler "${String(kind)}"`);
  }
}

export interface SpanEvent {
  readonly name: string;
  readonly at: number;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface SpanData {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string | undefined;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number | undefined;
  readonly sampled: boolean;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly SpanEvent[];
  readonly status: 'unset' | 'ok' | 'error';
  readonly error?: { readonly type: string; readonly message: string } | undefined;
}

export interface SpanExporter {
  export(spans: readonly SpanData[]): void;
  flush?(): void | Promise<void>;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
  setAttribute(key: string, value: unknown): Span;
  addEvent(name: string, attributes?: Readonly<Record<string, unknown>>): Span;
  recordException(error: unknown): Span;
  setStatus(status: 'ok' | 'error'): Span;
  /** Ends the span: computes the duration and hands it to the exporter. Idempotent. */
  end(): SpanData;
  /** A child span in the same trace, inheriting the sampling decision. */
  span(name: string, attributes?: Readonly<Record<string, unknown>>): Span;
}

export interface TracerOptions {
  readonly exporter?: SpanExporter | undefined;
  readonly sampler?: Sampler | undefined;
  readonly clock?: (() => number) | undefined;
  readonly newTraceId?: (() => string) | undefined;
  readonly newSpanId?: (() => string) | undefined;
  readonly service?: string | undefined;
}

export interface Tracer {
  /** Start a span. `parent` may come straight from `parseTraceparent`. */
  startSpan(
    name: string,
    options?: {
      readonly attributes?: Readonly<Record<string, unknown>>;
      readonly parent?: TraceContext | undefined;
    },
  ): Span;
  /** Run a function inside a span, ending it — and recording the exception — either way. */
  withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    options?: {
      readonly attributes?: Readonly<Record<string, unknown>>;
      readonly parent?: TraceContext | undefined;
    },
  ): Promise<T>;
  flush(): Promise<void>;
}

const HEX = '0123456789abcdef';

/** `bytes` of CSPRNG output as lowercase hex: 16 bytes → a trace id, 8 → a span id. */
function randomHex(bytes: number, source: (array: Uint8Array) => Uint8Array): string {
  const buffer = new Uint8Array(bytes);
  source(buffer);
  let hex = '';
  for (const byte of buffer) hex += (HEX[byte >> 4] ?? '0') + (HEX[byte & 0x0f] ?? '0');
  return hex;
}

const fill = (array: Uint8Array): Uint8Array => crypto.getRandomValues(array);

export function createTracer(options: TracerOptions = {}): Tracer {
  const clock = options.clock ?? ((): number => Date.now());
  const sampler = options.sampler ?? createSampler();
  const newTraceId = options.newTraceId ?? ((): string => randomHex(16, fill));
  const newSpanId = options.newSpanId ?? ((): string => randomHex(8, fill));
  const exporter = options.exporter;
  /** Finished spans, buffered until `flush` so an exporter outage cannot touch a request. */
  const finished: SpanData[] = [];

  const makeSpan = (
    name: string,
    attributes: Readonly<Record<string, unknown>>,
    parent: TraceContext | undefined,
    traceId: string,
    sampled: boolean,
    spanId: string,
  ): Span => {
    const startTime = clock();
    const ownAttributes: Record<string, unknown> = { ...attributes };
    const events: SpanEvent[] = [];
    let status: SpanData['status'] = 'unset';
    let error: SpanData['error'];
    let ended: SpanData | undefined;

    const span: Span = {
      traceId,
      spanId,
      sampled,
      setAttribute(key, value) {
        ownAttributes[key] = value;
        return span;
      },
      addEvent(eventName, eventAttributes) {
        events.push({
          name: eventName,
          at: clock(),
          ...(eventAttributes === undefined ? {} : { attributes: eventAttributes }),
        });
        return span;
      },
      recordException(thrown) {
        const asError = thrown instanceof Error ? thrown : new Error(String(thrown));
        error = { type: asError.name, message: asError.message };
        status = 'error';
        // OTel's exception event: the type and message, never the stack as an attribute (a stack is
        // not a queryable value, and it is large).
        events.push({
          name: 'exception',
          at: clock(),
          attributes: { 'exception.type': asError.name, 'exception.message': asError.message },
        });
        return span;
      },
      setStatus(next) {
        status = next;
        return span;
      },
      end() {
        if (ended !== undefined) return ended;
        const data: SpanData = {
          traceId,
          spanId,
          ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
          name,
          startTime,
          endTime: clock(),
          sampled,
          attributes: { ...ownAttributes },
          events: [...events],
          status,
          ...(error === undefined ? {} : { error }),
        };
        ended = data;
        if (sampled) finished.push(data);
        return data;
      },
      span(childName, childAttributes) {
        return makeSpan(
          childName,
          childAttributes ?? {},
          { traceId, spanId, sampled },
          traceId,
          sampled,
          newSpanId(),
        );
      },
    };
    return span;
  };

  return {
    startSpan(name, startOptions = {}) {
      const parent = startOptions.parent;
      const sampled = sampler.shouldSample(parent?.sampled);
      const traceId = parent?.traceId ?? newTraceId();
      return makeSpan(name, startOptions.attributes ?? {}, parent, traceId, sampled, newSpanId());
    },

    async withSpan(name, fn, spanOptions = {}) {
      const span = this.startSpan(name, spanOptions);
      try {
        const result = await fn(span);
        if (span.sampled) span.setStatus('ok');
        return result;
      } catch (thrown: unknown) {
        span.recordException(thrown);
        throw thrown;
      } finally {
        span.end();
      }
    },

    async flush() {
      if (finished.length > 0 && exporter !== undefined) {
        const spans = finished.splice(0);
        try {
          exporter.export(spans);
          await exporter.flush?.();
        } catch {
          // Fail-open: losing spans is a worse dashboard, not a worse request.
        }
        return;
      }
      try {
        await exporter?.flush?.();
      } catch {
        // Same rule.
      }
    },
  };
}

/** The OTel attributes names, so instrumentation and a collector agree. */
export const SPAN_ATTRIBUTES = {
  httpMethod: 'http.request.method',
  httpRoute: 'http.route',
  httpStatus: 'http.response.status_code',
  dbSystem: 'db.system',
  dbOperation: 'db.operation.name',
  messagingOperation: 'messaging.operation',
  messagingDestination: 'messaging.destination.name',
} as const;
