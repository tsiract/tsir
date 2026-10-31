/**
 * @tsir/pulse — logging, metrics, tracing and health.
 *
 * Four concerns, one package, and one rule that shapes all of them: **telemetry never fails a
 * request**. A sink that throws is disabled and reported; an exporter that is down loses a batch and
 * counts it; a readiness check that hangs is a failed check, not a hung probe. The only errors this
 * package raises are configuration errors, at boot.
 *
 * ```ts
 * import { createLogger, createMetrics, createTracer, createHealth, stdoutSink } from '@tsir/pulse';
 *
 * const log = createLogger({ service: 'api', level: 'info', sink: stdoutSink({ format: 'ecs' }) });
 * const requestLog = log.child({ requestId, traceId, route: 'POST /invoices' });
 *
 * requestLog.info('invoice.paid', { invoiceId, amountCents });
 * requestLog.error('http.request.failed', error, { status: 422 });
 * await requestLog.flush();
 * ```
 *
 * What is deliberately *not* here: a vendor SDK, a `console.log`, and any code that runs in a request
 * path and can block. Drivers are protocols and a `fetch` call;
 * explains why.
 */

export { configInvalid, metricInvalid, redactionFailed, sinkFailed } from './errors.ts';
export type { PulseErrorCode } from './errors.ts';

// ── logging ─────────────────────────────────────────────────────────────────

export { assertEvent, assertLevel, createLogger } from './logger.ts';
export type { LogFields, Logger, LoggerOptions } from './logger.ts';

export {
  fingerprintOf,
  LEVEL_SEVERITY,
  LOG_LEVELS,
  LOG_SCHEMA_VERSION,
  serializeError,
  summarize,
} from './record.ts';
export type { LogLevel, SafeRecord, SerializedError, SerializeOptions } from './record.ts';

export {
  createRedactor,
  isRedacted,
  OMITTED,
  REDACTED,
  REDACTION_ERROR,
  redacted,
  Redacted,
  reveal,
  SECRET_KEY,
} from './redact.ts';
export type { PiiPolicy, RedactionOptions, Redactor } from './redact.ts';

export { createRateLimiter } from './limits.ts';
export type { DroppedCount, RateLimiter, RateLimitOptions } from './limits.ts';

export { assertFormat, formatRecord, LOG_FORMATS } from './formats.ts';
export type { LogFormat } from './formats.ts';

export { fanoutSink, memorySink, stdoutSink } from './sinks.ts';
export type { FanoutOptions, FanoutSink, MemorySink, Sink, StdoutSinkOptions } from './sinks.ts';

// ── metrics ─────────────────────────────────────────────────────────────────

export { assertMetricName, createMetrics, looksConcrete, METRIC_NAMES } from './metrics.ts';
export type {
  Labels,
  MetricExporter,
  MetricKind,
  MetricPoint,
  Metrics,
  MetricsOptions,
  MetricsWarning,
} from './metrics.ts';

// ── tracing ─────────────────────────────────────────────────────────────────

export {
  createSampler,
  createTracer,
  formatTraceparent,
  parseTraceparent,
  SPAN_ATTRIBUTES,
} from './tracing.ts';
export type {
  Sampler,
  SamplerKind,
  SamplerOptions,
  Span,
  SpanData,
  SpanEvent,
  SpanExporter,
  Tracer,
  TracerOptions,
  TraceContext,
} from './tracing.ts';

// ── health ──────────────────────────────────────────────────────────────────

export { createHealth } from './health.ts';
export type {
  CheckResult,
  CheckStatus,
  Health,
  HealthCheck,
  HealthOptions,
  HealthReport,
} from './health.ts';

/** The synchronous digest a pseudonymised field uses; exported for a test that asserts the vectors. */
export { sha256Hex, sha256Text } from './hash.ts';
