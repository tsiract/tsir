/**
 * Type-level tests for `@tsir/pulse` (`TST-009`).
 *
 * Compiled, not executed. The four guarantees below are the ones an application depends on:
 *
 * 1. a **sink receives a redacted record**, and a `SafeRecord` cannot be built from raw fields;
 * 2. a **`Redacted<T>` is not a `T`** — passing one where a string is expected is a compile error,
 * which is what forces the `reveal` to be visible in review;
 * 3. `logger.error` has two call shapes, and neither accepts nonsense;
 * 4. the **formats and levels are closed unions** — a typo is a compile error, not a runtime one.
 */

import {
  createHealth,
  createLogger,
  createMetrics,
  createTracer,
  createRedactor,
  formatRecord,
  memorySink,
  redacted,
  reveal,
  stdoutSink,
  type CheckResult,
  type HealthCheck,
  type LogFields,
  type LogFormat,
  type LogLevel,
  type Logger,
  type MetricPoint,
  type Redacted,
  type SafeRecord,
  type Sink,
  type Span,
  type TraceContext,
} from '../src/index.ts';

// ── 1. a sink receives a SafeRecord ────────────────────────────────────────

const sink: Sink = {
  name: 'test',
  write(record: SafeRecord) {
    const ts: string = record.ts;
    const level: LogLevel = record.level;
    const extra: unknown = record['invoiceId'];
    void ts;
    void level;
    void extra;

    // @ts-expect-error — a sink is given a redacted record; `ts` is a string, not a number
    const wrong: number = record.ts;
    void wrong;
  },
};

createLogger({ sink });
createLogger({ sink: memorySink(), level: 'warn', rateLimit: 10 });

// @ts-expect-error — `verbose` is not a level
createLogger({ level: 'verbose' });

// @ts-expect-error — a format is one of four literals
stdoutSink({ format: 'logfmt' });

const format: LogFormat = 'ecs';
void formatRecord({ ts: '', level: 'info', event: 'a.b', v: 1 }, format);

// ── 2. Redacted<T> is not T ────────────────────────────────────────────────

declare const token: Redacted<string>;

// @ts-expect-error — a redacted value cannot be passed as a string
const leak: string = token;
void leak;

const revealed: string = token.reveal();
const unwrapped: string = reveal(token);
void revealed;
void unwrapped;

const maybe: string = reveal('plain');
void maybe;

const typed = redacted({ id: 'user_1' }, 'principal');
// @ts-expect-error — `reveal` keeps the type it was given, so `id` is a string
const wrongId: number = typed.reveal().id;
void wrongId;
const rightId: string = typed.reveal().id;
void rightId;

// ── 3. the two `error` shapes ──────────────────────────────────────────────

declare const log: Logger;

log.info('invoice.paid', { invoiceId: 'inv_1', amountCents: 4200 });
log.error('order.failed', new Error('boom'));
log.error('order.failed', new Error('boom'), { status: 500 });
log.error('order.rejected', { status: 422 });

// @ts-expect-error — the event name is required
log.info();

// @ts-expect-error — fields are an object
log.info('a.b', 'not fields');

const child: Logger = log.child({ requestId: 'req_1' });
const context: Readonly<LogFields> = child.context;
void context;

const enabled: boolean = log.isEnabled('debug');
void enabled;

// ── 4. closed unions everywhere else ───────────────────────────────────────

const redactor = createRedactor({ pii: 'hash', paths: ['body.password'], piiSalt: 'x' });
const value: unknown = redactor.value({ a: 1 });
void value;

// @ts-expect-error — the PII policy is `omit` | `hash` | `allow`
createRedactor({ pii: 'sometimes' });

const metrics = createMetrics({
  exporter: {
    export(points: readonly MetricPoint[]) {
      for (const point of points) {
        const name: string = point.name;
        const labels: Readonly<Record<string, string>> = point.labels;
        void name;
        void labels;
      }
    },
  },
});

metrics.counter('http_requests_total', 1, { route: '/x' });
// @ts-expect-error — a label value is a scalar, not an object
metrics.counter('http_requests_total', 1, { route: { nested: true } });

declare const parent: TraceContext | undefined;
const tracer = createTracer();
const span: Span = tracer.startSpan('http.request', { parent });
const data = span.end();
const traceId: string = data.traceId;
void traceId;

const check: HealthCheck = { name: 'db', critical: true, run: () => Promise.resolve(true) };
const health = createHealth({ checks: [check], timeoutMs: 500 });
void health.ready().then((report) => {
  const results: readonly CheckResult[] = report.checks;
  const status: 'ok' | 'degraded' | 'failed' = report.status;
  void results;
  void status;
});
