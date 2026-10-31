import { describe, expect, test } from 'bun:test';

import {
  assertMetricName,
  createMetrics,
  looksConcrete,
  METRIC_NAMES,
  type MetricExporter,
  type MetricPoint,
  type MetricsWarning,
} from './metrics.ts';

const AT = 1_700_000_000_000;

function harness(options: Parameters<typeof createMetrics>[0] = {}) {
  const exported: MetricPoint[] = [];
  const warnings: MetricsWarning[] = [];
  const exporter: MetricExporter = {
    export(points) {
      exported.push(...points);
    },
  };
  const metrics = createMetrics({
    exporter,
    clock: () => AT,
    onWarning: (warning) => warnings.push(warning),
    ...options,
  });
  return { metrics, exported, warnings };
}

describe('the three kinds', () => {
  test('a counter defaults to 1 and keeps its labels', () => {
    const { metrics } = harness();
    metrics.counter('http_requests_total', 1, {
      method: 'GET',
      route: '/api/users/:id',
      status_class: '2xx',
    });
    const [point] = metrics.snapshot();

    expect(point).toEqual({
      name: 'http_requests_total',
      kind: 'counter',
      value: 1,
      labels: { method: 'GET', route: '/api/users/:id', status_class: '2xx' },
      ts: AT,
    });
  });

  test('label values may be numbers and booleans, and are stored as strings', () => {
    const { metrics } = harness();
    metrics.gauge('queue_depth', 12, { queue: 'mail', active: true });
    expect(metrics.snapshot()[0]?.labels).toEqual({ queue: 'mail', active: 'true' });
  });

  test('histograms and gauges record what they are given', () => {
    const { metrics } = harness();
    metrics.histogram('http_request_duration_ms', 12.5, { route: '/x' });
    metrics.gauge('db_pool_connections', 3, { state: 'idle' });
    metrics.counter('queue_jobs_total', 5, { queue: 'mail' });

    expect(metrics.snapshot().map((point) => [point.kind, point.value])).toEqual([
      ['histogram', 12.5],
      ['gauge', 3],
      ['counter', 5],
    ]);
  });

  test('a counter cannot decrease and a metric cannot carry a non-finite value', () => {
    const { metrics } = harness();
    expect(() => metrics.counter('http_requests_total', -1)).toThrow(/cannot decrease/u);
    expect(() => metrics.histogram('http_request_duration_ms', Number.NaN)).toThrow(/is NaN/u);
    expect(() => metrics.gauge('queue_depth', Number.POSITIVE_INFINITY)).toThrow(/is Infinity/u);
  });

  test('a name is snake_case, and the kind decides the suffix rule', () => {
    expect(assertMetricName('http_requests_total', 'counter')).toBe('http_requests_total');
    expect(assertMetricName('http_request_duration_ms', 'histogram')).toBe(
      'http_request_duration_ms',
    );
    expect(assertMetricName('queue_depth', 'gauge')).toBe('queue_depth');

    expect(() => assertMetricName('httpRequests')).toThrow(/not snake_case/u);
    expect(() => assertMetricName('http.requests.total')).toThrow(/not snake_case/u);
    expect(() => assertMetricName('http_requests', 'counter')).toThrow(
      /does not end with "_total"/u,
    );
    expect(() => assertMetricName('http_request_duration', 'histogram')).toThrow(/no unit suffix/u);
    expect(() => assertMetricName(42)).toThrow(/name "42"/u);
  });
});

describe('the cardinality guard', () => {
  test('a label past its budget is dropped, and the drop is counted and reported once', () => {
    const { metrics, warnings } = harness({ maxCardinality: 3 });

    for (let index = 0; index < 6; index += 1) {
      metrics.counter('queue_jobs_total', 1, { queue: `q${String(index)}` });
    }

    expect(metrics.snapshot()).toHaveLength(3);
    expect(metrics.droppedSeries).toBe(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      kind: 'cardinality',
      metric: 'queue_jobs_total',
      label: 'queue',
    });
    expect(warnings[0]?.detail).toContain('already has 3 distinct values');
  });

  test('an existing value is always accepted, even at the ceiling', () => {
    const { metrics } = harness({ maxCardinality: 1 });
    metrics.counter('queue_jobs_total', 1, { queue: 'mail' });
    metrics.counter('queue_jobs_total', 1, { queue: 'mail' });
    expect(metrics.snapshot()).toHaveLength(2);
    expect(metrics.droppedSeries).toBe(0);
  });

  test('the budget is per label name, across metrics', () => {
    const { metrics } = harness({ maxCardinality: 2 });
    metrics.counter('queue_jobs_total', 1, { queue: 'a' });
    metrics.counter('queue_jobs_total', 1, { queue: 'b' });
    // A different *label* has its own budget.
    metrics.counter('queue_jobs_total', 1, { result: 'ok' });
    metrics.counter('queue_jobs_total', 1, { queue: 'c' });
    expect(metrics.droppedSeries).toBe(1);
  });
});

describe('the route-label guard', () => {
  test('a concrete path is replaced with `[templated]` and warned about once', () => {
    const { metrics, warnings } = harness();
    metrics.counter('http_requests_total', 1, { route: '/api/users/123' });
    metrics.counter('http_requests_total', 1, { route: '/api/users/456' });

    const routes = metrics.snapshot().map((point) => point.labels['route']);
    expect(routes).toEqual(['[templated]', '[templated]']);
    expect(warnings).toHaveLength(2); // one per distinct concrete value, each seen once
    expect(warnings[0]?.kind).toBe('route-label');
    expect(warnings[0]?.detail).toContain('templates');
  });

  test('a template is left alone — `:id`, `{id}` and a static path', () => {
    const { metrics, warnings } = harness();
    metrics.counter('http_requests_total', 1, { route: '/api/users/:id' });
    metrics.counter('http_requests_total', 1, { route: '/api/users/{id}' });
    metrics.counter('http_requests_total', 1, { route: '/api/users/me' });
    metrics.counter('http_requests_total', 1, { route: '/' });

    expect(metrics.snapshot().map((point) => point.labels['route'])).toEqual([
      '/api/users/:id',
      '/api/users/{id}',
      '/api/users/me',
      '/',
    ]);
    expect(warnings).toHaveLength(0);
  });

  test('the heuristic recognises numbers, UUIDs and long ids', () => {
    expect(looksConcrete('/api/users/123')).toBe(true);
    expect(looksConcrete('/api/orders/2f1c9e7a-1111-4c3d-9a2b-8e7f6a5b4c3d')).toBe(true);
    expect(looksConcrete('/api/files/abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(looksConcrete('/api/users/:id')).toBe(false);
    expect(looksConcrete('/api/users/{id}')).toBe(false);
    expect(looksConcrete('/health')).toBe(false);
  });
});

describe('export', () => {
  test('points are buffered until flush, then handed over once', async () => {
    const { metrics, exported } = harness();
    metrics.counter('http_requests_total');
    metrics.counter('http_requests_total');
    expect(exported).toHaveLength(0);

    await metrics.flush();
    expect(exported).toHaveLength(2);
    expect(metrics.snapshot()).toHaveLength(0);

    await metrics.flush(); // nothing left: no second export
    expect(exported).toHaveLength(2);
  });

  test('a full buffer exports on its own, so a long-running process does not grow', () => {
    const { metrics, exported } = harness({ bufferSize: 2 });
    metrics.counter('http_requests_total');
    expect(exported).toHaveLength(0);
    metrics.counter('http_requests_total');
    expect(exported).toHaveLength(2);
  });

  test('an exporter that throws is fail-open, and the points are gone rather than retried', async () => {
    const throwing: MetricExporter = {
      export() {
        throw new Error('collector down');
      },
      flush() {
        throw new Error('collector down');
      },
    };
    const metrics = createMetrics({ exporter: throwing, clock: () => AT });
    metrics.counter('http_requests_total');
    await metrics.flush(); // a rejection would fail the test on its own

    metrics.counter('http_requests_total');
    expect(metrics.snapshot()).toHaveLength(1); // still usable after a failed export
  });

  test('the metric names fixed by the contract are exported as constants', () => {
    expect(METRIC_NAMES.httpRequests).toBe('http_requests_total');
    expect(METRIC_NAMES.httpDuration).toBe('http_request_duration_ms');
    expect(METRIC_NAMES.queueDepth).toBe('queue_depth');
    expect(METRIC_NAMES.sinkDropped).toBe('pulse_sink_dropped_total');
    // Every name fixed by the contract passes the rule its kind implies.
    expect(assertMetricName(METRIC_NAMES.queueDepth, 'gauge')).toBe('queue_depth');
    expect(assertMetricName(METRIC_NAMES.dbPoolConnections, 'gauge')).toBe('db_pool_connections');
    expect(assertMetricName(METRIC_NAMES.dbQueryDuration, 'histogram')).toBe(
      'db_query_duration_ms',
    );
    for (const name of Object.values(METRIC_NAMES)) {
      if (name.endsWith('_ms')) expect(assertMetricName(name, 'histogram')).toBe(name);
      else if (name.endsWith('_total')) expect(assertMetricName(name, 'counter')).toBe(name);
      else expect(assertMetricName(name, 'gauge')).toBe(name);
    }
  });
});
