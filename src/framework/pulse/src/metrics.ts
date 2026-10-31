/**
 * Metrics (`OBS-013`…`OBS-015`).
 *
 * A counter, a histogram and a gauge, over an exporter interface that is OpenTelemetry-shaped but
 * does not depend on it — `@tsir/pulse` cannot ship an SDK, and a metric that needs a 300 kB
 * dependency to leave the process is a metric nobody turns on.
 *
 * The interesting part is not the three functions; it is the **cardinality guard**. A metric label
 * is a promise to a time-series database: every distinct combination is a stored series, forever. So
 * this module enforces two rules mechanically:
 *
 * · **A label has a budget.** Past `maxCardinality` distinct values a series is dropped rather than
 * created, and `pulse_metric_cardinality_dropped_total` counts it. Ten thousand is the point at
 * which one careless `userId` label turns a dashboard into a bill.
 * · **`route` is a template.** `/api/users/123` and `/api/users/456` are one series; the guard
 * refuses a `route` label that looks like a concrete path (`:id`-free, containing a number or a
 * UUID) and replaces it with `[templated]`, with one warning per metric. That is the difference
 * between a `http_requests_total` chart and 4 000 charts.
 *
 * Metric names are checked too, because `http_requests_total` and `http_requests` being two metrics
 * is how a dashboard quietly reads zero. The rule follows Prometheus' conventions, which is the one
 * every collector already speaks: a **counter** ends `_total`, a **histogram** carries its unit
 * (`_ms`, `_bytes`), and a **gauge** is the quantity itself (`queue_depth`, `db_pool_connections`) —
 * requiring a suffix there would rename the very metrics names.
 */

import { metricInvalid } from './errors.ts';

export type MetricKind = 'counter' | 'histogram' | 'gauge';

export interface MetricPoint {
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly ts: number;
}

/** An exporter receives points in batches. OTLP, Prometheus, Analytics Engine — all fit here. */
export interface MetricExporter {
  export(points: readonly MetricPoint[]): void;
  flush?(): void | Promise<void>;
}

export type Labels = Readonly<Record<string, string | number | boolean>>;

export interface MetricsOptions {
  /** Default: points are buffered until `flush`. */
  readonly exporter?: MetricExporter | undefined;
  /** Distinct values per label name, across all metrics. Default 10 000. */
  readonly maxCardinality?: number | undefined;
  /** Called once per metric that hit the ceiling, and once per concrete-looking `route`. */
  readonly onWarning?: ((warning: MetricsWarning) => void) | undefined;
  readonly clock?: (() => number) | undefined;
  /** Buffer size before an implicit flush. Default 1 000 points. */
  readonly bufferSize?: number | undefined;
}

export interface MetricsWarning {
  readonly kind: 'cardinality' | 'route-label';
  readonly metric: string;
  readonly label?: string | undefined;
  readonly value?: string | undefined;
  readonly detail: string;
}

export interface Metrics {
  counter(name: string, value?: number, labels?: Labels): void;
  /** Records one observation, in milliseconds or whatever unit the name says. */
  histogram(name: string, value: number, labels?: Labels): void;
  /** Records the current value of something, not a delta. */
  gauge(name: string, value: number, labels?: Labels): void;
  /** The buffered points, without flushing — for a test or an in-process exporter. */
  snapshot(): readonly MetricPoint[];
  flush(): Promise<void>;
  /** How many series were refused by the cardinality guard. */
  readonly droppedSeries: number;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const UNIT_SUFFIXES = ['_ms', '_bytes', '_seconds', '_count', '_ratio'] as const;
const DEFAULT_MAX_CARDINALITY = 10_000;

export function assertMetricName(name: unknown, kind: MetricKind = 'counter'): string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw metricInvalid(
      `name "${String(name)}" is not snake_case (expected e.g. "http_requests_total")`,
    );
  }
  if (kind === 'counter' && !name.endsWith('_total')) {
    throw metricInvalid(
      `counter "${name}" does not end with "_total" — a counter that is not named as one is summed by nobody`,
    );
  }
  if (kind === 'histogram' && !UNIT_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throw metricInvalid(
      `histogram "${name}" has no unit suffix; expected one of ${UNIT_SUFFIXES.join(', ')} — a duration in an unknown unit is a number whose meaning is a guess`,
    );
  }
  return name;
}

/**
 * True when a `route` label is a concrete path rather than a template.
 *
 * Heuristic and deliberately conservative: a template has a `:` or `{`/`}` segment, a concrete path
 * usually has a number or a UUID in it. A route with neither (`/api/users/me`) is not flagged —
 * `/me` is bounded, and refusing it would make the guard cry wolf on the paths that are fine.
 */
export function looksConcrete(route: string): boolean {
  if (/[:{}]/u.test(route)) return false;
  return (
    /\/\d+/u.test(route) ||
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/iu.test(route) ||
    /\/[A-Za-z0-9_-]{16,}$/u.test(route)
  );
}

export function createMetrics(options: MetricsOptions = {}): Metrics {
  const clock = options.clock ?? ((): number => Date.now());
  const maxCardinality = options.maxCardinality ?? DEFAULT_MAX_CARDINALITY;
  const bufferSize = options.bufferSize ?? 1_000;

  /** label name → every value seen, so the budget is per label and not per metric. */
  const seen = new Map<string, Set<string>>();
  const warned = new Set<string>();
  let buffer: MetricPoint[] = [];
  let droppedSeries = 0;

  const warnOnce = (key: string, warning: MetricsWarning): void => {
    if (warned.has(key)) return;
    warned.add(key);
    options.onWarning?.(warning);
  };

  const normalize = (
    name: string,
    labels: Labels | undefined,
  ): Record<string, string> | undefined => {
    const output: Record<string, string> = {};
    for (const [label, raw] of Object.entries(labels ?? {})) {
      let value = String(raw);

      if (label === 'route' && looksConcrete(value)) {
        warnOnce(`${name}\u0000route\u0000${value}`, {
          kind: 'route-label',
          metric: name,
          label,
          value,
          detail:
            'route labels are templates (`/api/users/:id`); a concrete path makes one series per id',
        });
        value = '[templated]';
      }

      let values = seen.get(label);
      if (values === undefined) {
        values = new Set();
        seen.set(label, values);
      }
      if (!values.has(value)) {
        if (values.size >= maxCardinality) {
          droppedSeries += 1;
          warnOnce(`${name}\u0000${label}\u0000cardinality`, {
            kind: 'cardinality',
            metric: name,
            label,
            value,
            detail: `label "${label}" already has ${String(maxCardinality)} distinct values; the new series was dropped`,
          });
          return undefined;
        }
        values.add(value);
      }
      output[label] = value;
    }
    return output;
  };

  const push = (
    kind: MetricKind,
    name: string,
    value: number,
    labels: Labels | undefined,
  ): void => {
    assertMetricName(name, kind);
    if (!Number.isFinite(value)) throw metricInvalid(`value for "${name}" is ${String(value)}`);
    if (kind === 'counter' && value < 0) {
      throw metricInvalid(`counter "${name}" cannot decrease; use a gauge`);
    }
    const normalized = normalize(name, labels);
    if (normalized === undefined) return;

    buffer.push({ name, kind, value, labels: normalized, ts: clock() });
    if (buffer.length >= bufferSize && options.exporter !== undefined) {
      const points = buffer;
      buffer = [];
      try {
        options.exporter.export(points);
      } catch {
        // Fail-open: an exporter that throws must not fail the request that produced the metric.
      }
    }
  };

  return {
    get droppedSeries() {
      return droppedSeries;
    },
    counter(name, value = 1, labels) {
      push('counter', name, value, labels);
    },
    histogram(name, value, labels) {
      push('histogram', name, value, labels);
    },
    gauge(name, value, labels) {
      push('gauge', name, value, labels);
    },
    snapshot() {
      return [...buffer];
    },
    async flush() {
      if (buffer.length === 0) {
        await options.exporter?.flush?.();
        return;
      }
      const points = buffer;
      buffer = [];
      try {
        options.exporter?.export(points);
        await options.exporter?.flush?.();
      } catch {
        // Same rule as above, one level up.
      }
    },
  };
}

/** The metric names fixes, so instrumentation and dashboards cannot drift apart. */
export const METRIC_NAMES = {
  httpRequests: 'http_requests_total',
  httpDuration: 'http_request_duration_ms',
  dbQueryDuration: 'db_query_duration_ms',
  dbPoolConnections: 'db_pool_connections',
  vaultOperations: 'vault_operations_total',
  vaultRotationRemaining: 'vault_rotation_remaining',
  queueJobs: 'queue_jobs_total',
  queueDepth: 'queue_depth',
  linkCalls: 'link_calls_total',
  linkDuration: 'link_call_duration_ms',
  /** Emitted by this package about itself, under the same rules as everything else. */
  logDropped: 'pulse_log_dropped_total',
  sinkDropped: 'pulse_sink_dropped_total',
  cardinalityDropped: 'pulse_metric_cardinality_dropped_total',
} as const;
