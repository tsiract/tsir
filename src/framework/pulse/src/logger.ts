/**
 * The logger (`OBS-001`…`OBS-009`).
 *
 * ```ts
 * const log = createLogger({ service: 'api' });
 * const requestLog = log.child({ requestId, traceId, route: 'POST /invoices' });
 *
 * requestLog.info('invoice.paid', { invoiceId, amountCents });
 * requestLog.error('http.request.failed', error, { status: 422 });
 * ```
 *
 * Five decisions worth naming, because each one is a bug when it is missing:
 *
 * · **`emit` never throws.** A sink, a clock, a redactor: all of them are wrapped. A logger that
 * fails a request is worse than a logger that loses a record, and the loss is counted and
 * reported rather than silent.
 * · **Context is inherited, not repeated.** `child` is how `requestId`, `traceId`, `unit` and
 * `route` reach every line of a request without a single call site remembering to add them, and
 * how a job's logs carry the request that enqueued it.
 * · **Redaction happens once, before the sink.** A sink receives a `SafeRecord`; there is no path
 * from an unredacted field to a driver.
 * · **Volume is bounded.** A per-event rate limit drops the flood and one summary line says how
 * much was dropped; repeated errors collapse by `fingerprint` within a window.
 * · **Reserved fields win.** A caller cannot set `level`, `ts`, `event` or `v` through `fields` —
 * otherwise a `fields` object built from user input could forge a record's severity.
 */

import { configInvalid, sinkFailed } from './errors.ts';
import type { LogFormat } from './formats.ts';
import { createRateLimiter, type DroppedCount, type RateLimiter } from './limits.ts';
import { createRedactor, type Redactor, type RedactionOptions } from './redact.ts';
import {
  fingerprintOf,
  LEVEL_SEVERITY,
  LOG_LEVELS,
  LOG_SCHEMA_VERSION,
  serializeError,
  summarize,
  type LogLevel,
  type SafeRecord,
  type SerializeOptions,
} from './record.ts';
import { stdoutSink, type Sink } from './sinks.ts';

export interface LogFields {
  readonly [field: string]: unknown;
}

export interface LoggerOptions {
  /** Production default `info`; framework internals log at `warn` unless `debugPackages` says otherwise. */
  readonly level?: LogLevel | undefined;
  /** Fields on every record this logger writes, including children of it. */
  readonly context?: LogFields | undefined;
  /** Default: `stdout` with the `tsir` format. */
  readonly sink?: Sink | undefined;
  /** Default format for the default sink. Ignored when `sink` is given. */
  readonly format?: LogFormat | undefined;
  readonly redaction?: RedactionOptions | undefined;
  readonly pii?: RedactionOptions['pii'] | undefined;
  /** Injected clock. Everything in this package takes one, so a test never sleeps. */
  readonly clock?: (() => number) | undefined;
  /** Records per event per second before the flood is dropped. Default 1 000. */
  readonly rateLimit?: number | undefined;
  /** Collapse repeated identical errors within `dedupeWindowMs`. Default true. */
  readonly dedupe?: boolean | undefined;
  /** Default 10 000 ms. */
  readonly dedupeWindowMs?: number | undefined;
  /** `service.name`-shaped context every record gets. Same as putting it in `context`. */
  readonly service?: string | undefined;
  readonly serialize?: SerializeOptions | undefined;
  /** Reported once per failing sink: the logger's own `onError`, so it can be routed. */
  readonly onSinkError?:
    ((failure: { readonly sink: string; readonly error: unknown }) => void) | undefined;
}

export interface Logger {
  readonly level: LogLevel;
  readonly context: Readonly<LogFields>;
  isEnabled(level: LogLevel): boolean;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
  fatal(event: string, fields?: LogFields): void;
  fatal(event: string, error: unknown, fields?: LogFields): void;
  /** A logger with more inherited context. Cheaper than passing the same three fields everywhere. */
  child(context: LogFields): Logger;
  /** Write any pending summaries and flush the sink. Call it at the end of an invocation. */
  flush(): Promise<void>;
}

/** The reserved keys a caller may not set through `fields`. */
const RESERVED = new Set(['ts', 'level', 'event', 'v', 'err', 'fingerprint', 'occurrences']);

const EVENT_PATTERN = /^[a-z][a-z0-9_.-]*$/u;

export function assertLevel(level: unknown): LogLevel {
  if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) {
    throw configInvalid(`level is "${String(level)}"; expected one of ${LOG_LEVELS.join(', ')}`);
  }
  return level as LogLevel;
}

/**
 * Event names are `dot.case` identifiers, enforced rather than documented.
 *
 * `'Invoice paid for inv_123'` would be a message with a value baked into it: unsearchable, and it
 * makes the `event` field useless for grouping. The check is at the call site that made the mistake.
 */
export function assertEvent(event: unknown): string {
  if (typeof event !== 'string' || !EVENT_PATTERN.test(event)) {
    throw configInvalid(
      `event is "${String(event)}"; expected a dot.case name such as "invoice.paid" (lowercase, no spaces)`,
    );
  }
  return event;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = assertLevel(options.level ?? 'info');
  const clock = options.clock ?? ((): number => Date.now());
  const redactor: Redactor = createRedactor({
    ...options.redaction,
    ...(options.pii === undefined ? {} : { pii: options.pii }),
  });
  const sink = options.sink ?? stdoutSink({ format: options.format ?? 'tsir' });
  const limiter: RateLimiter = createRateLimiter({
    perSecond: options.rateLimit ?? 1_000,
    exempt: ['pulse.log.dropped', 'pulse.log.repeated', 'pulse.sink.failed'],
  });
  const dedupe = options.dedupe ?? true;
  const dedupeWindowMs = options.dedupeWindowMs ?? 10_000;
  const serializeOptions = options.serialize ?? {};
  const baseContext: LogFields = {
    ...(options.service === undefined ? {} : { service: options.service }),
    ...options.context,
  };

  /** `fingerprint` → the window it started in, how many repeats were suppressed, and the record. */
  const repeats = new Map<string, { at: number; count: number; event: string }>();
  const emitSummaries: SafeRecord[] = [];
  /** When the first not-yet-reported drop of the current storm happened. */
  let firstDropAt: number | undefined;

  const write = (record: SafeRecord): void => {
    try {
      sink.write(record);
    } catch (error: unknown) {
      // A sink failure is reported and swallowed: the request path has already decided its status.
      options.onSinkError?.({ sink: sink.name, error });
      try {
        sink.write({
          ts: new Date(clock()).toISOString(),
          level: 'warn',
          event: 'pulse.sink.failed',
          v: LOG_SCHEMA_VERSION,
          sink: sink.name,
          err: serializeError(
            sinkFailed(sink.name, error instanceof Error ? error.message : String(error)),
          ),
        });
      } catch {
        // The sink is broken. Nothing left to do that cannot make it worse.
      }
    }
  };

  const drainRateLimit = (at: number, force = false): void => {
    if (limiter.pending === 0) return;
    // One summary per storm, and not before the window it describes has closed: a summary per
    // dropped record would be the storm again, wearing a hat.
    if (!force) {
      firstDropAt ??= at;
      if (at - firstDropAt < 1_000) return;
    }
    const dropped = limiter.drain();
    firstDropAt = undefined;
    if (dropped.length === 0) return;
    emitSummaries.push({
      ts: new Date(at).toISOString(),
      level: 'warn',
      event: 'pulse.log.dropped',
      v: LOG_SCHEMA_VERSION,
      reason: 'rate-limited',
      dropped: dropped.reduce((total: number, entry: DroppedCount) => total + entry.dropped, 0),
      events: dropped.map((entry) => ({ event: entry.event, dropped: entry.dropped })),
    });
  };

  const drainRepeats = (at: number): void => {
    for (const [fingerprint, entry] of repeats) {
      if (at - entry.at < dedupeWindowMs) continue;
      repeats.delete(fingerprint);
      if (entry.count === 0) continue;
      emitSummaries.push({
        ts: new Date(at).toISOString(),
        level: 'warn',
        event: 'pulse.log.repeated',
        v: LOG_SCHEMA_VERSION,
        fingerprint,
        originalEvent: entry.event,
        occurrences: entry.count + 1, // the first one was written
        windowMs: dedupeWindowMs,
      });
    }
  };

  const flushSummaries = (): void => {
    for (const summary of emitSummaries.splice(0)) write(summary);
  };

  const build = (
    recordLevel: LogLevel,
    event: string,
    errorOrFields: unknown,
    maybeFields: LogFields | undefined,
    context: LogFields,
  ): { record: SafeRecord; fingerprint: string | undefined } => {
    // Three arguments means "this is the error"; two arguments means "these are the fields" unless
    // the second is not a plain record (an `Error`, a thrown string, a `DOMException`).
    const hasError = maybeFields !== undefined || !isPlainFields(errorOrFields);
    const fields = hasError
      ? (maybeFields ?? {})
      : ((errorOrFields as LogFields | undefined) ?? {});
    const error = hasError ? errorOrFields : undefined;

    const payload: LogFields = { ...context, ...fields };
    for (const key of RESERVED) delete (payload as Record<string, unknown>)[key];

    const at = clock();
    const redacted = redactor.fields(payload);
    const message = redacted['msg'];
    delete redacted['msg'];

    const fingerprint =
      error === undefined
        ? undefined
        : fingerprintOf({
            error,
            origin: typeof redacted['unit'] === 'string' ? redacted['unit'] : undefined,
            route: typeof redacted['route'] === 'string' ? redacted['route'] : undefined,
            event,
          });

    const record: SafeRecord = {
      ts: new Date(at).toISOString(),
      level: recordLevel,
      event,
      v: LOG_SCHEMA_VERSION,
      ...(typeof message === 'string' ? { msg: message } : {}),
      ...redacted,
      ...(error === undefined ? {} : { err: serializeError(error, serializeOptions) }),
      ...(fingerprint === undefined ? {} : { fingerprint }),
    };
    return { record, fingerprint };
  };

  const emit = (
    recordLevel: LogLevel,
    event: string,
    errorOrFields: unknown,
    maybeFields: LogFields | undefined,
    context: LogFields,
  ): void => {
    try {
      assertEvent(event);
      const at = clock();
      drainRateLimit(at);
      drainRepeats(at);

      // Summaries are written before the record they summarise the gap before, so a reader sees the
      // flood announcement once rather than after a truncated window.
      flushSummaries();

      if (!limiter.admit(event, at)) return;

      const { record, fingerprint } = build(
        recordLevel,
        event,
        errorOrFields,
        maybeFields,
        context,
      );

      if (
        dedupe &&
        fingerprint !== undefined &&
        (recordLevel === 'error' || recordLevel === 'fatal')
      ) {
        const existing = repeats.get(fingerprint);
        if (existing !== undefined && at - existing.at < dedupeWindowMs) {
          existing.count += 1;
          return; // collapsed: the summary line carries the count
        }
        repeats.set(fingerprint, { at, count: 0, event });
      }

      write(record);
    } catch (error: unknown) {
      // `assertEvent` and `assertLevel` are configuration errors and should be loud; a redaction or
      // serialization failure is not allowed to escape into the request path.
      if (isConfigError(error)) throw error;
      options.onSinkError?.({ sink: sink.name, error });
    }
  };

  const make = (level: LogLevel, context: LogFields): Logger => {
    const logger: Logger = {
      level,
      context: Object.freeze({ ...context }),

      isEnabled(candidate) {
        return LEVEL_SEVERITY[candidate] >= LEVEL_SEVERITY[level];
      },

      debug(event, fields) {
        if (!logger.isEnabled('debug')) return;
        emit('debug', event, fields, undefined, context);
      },
      info(event, fields) {
        if (!logger.isEnabled('info')) return;
        emit('info', event, fields, undefined, context);
      },
      warn(event, fields) {
        if (!logger.isEnabled('warn')) return;
        emit('warn', event, fields, undefined, context);
      },
      error(event: string, errorOrFields?: unknown, fields?: LogFields) {
        if (!logger.isEnabled('error')) return;
        emit('error', event, errorOrFields, fields, context);
      },
      fatal(event: string, errorOrFields?: unknown, fields?: LogFields) {
        if (!logger.isEnabled('fatal')) return;
        emit('fatal', event, errorOrFields, fields, context);
      },

      child(more) {
        return make(level, { ...context, ...more });
      },

      async flush() {
        try {
          drainRateLimit(clock(), true);
          // A `flush` is the end of the window: report every suppressed repeat now.
          for (const entry of repeats.values()) entry.at = Number.NEGATIVE_INFINITY;
          drainRepeats(clock());
          flushSummaries();
          await sink.flush?.();
        } catch (error: unknown) {
          options.onSinkError?.({ sink: sink.name, error });
        }
      },
    };
    return logger;
  };

  return make(level, baseContext);
}

/**
 * `error(event, fields)` and `error(event, error, fields)` share one implementation.
 *
 * The distinguishing rule is deliberately narrow: an `Error` instance, or an object that is not a
 * plain record (a thrown `Response`, a `TsirError` subclass, a DOMException). A plain object is
 * always treated as fields, because `logger.error('x', { code: 'X' })` is the common case and must
 * not be mistaken for an error.
 */
function isPlainFields(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return false;
  if (value instanceof Error) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isConfigError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'PULSE_CONFIG_INVALID';
}

/** Re-exported for `child` users who want to pre-summarise a big object before logging it. */
export { summarize };
