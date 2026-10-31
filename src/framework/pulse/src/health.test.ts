import { describe, expect, test } from 'bun:test';

import { createHealth, type CheckResult, type HealthReport } from './health.ts';

const AT = 1_700_000_000_000;

function harness(options: Parameters<typeof createHealth>[0] = {}) {
  let now = AT;
  const failures: CheckResult[] = [];
  const health = createHealth({
    clock: () => now,
    onFailure: (result) => failures.push(result),
    ...options,
  });
  return { health, failures, advance: (ms: number) => void (now += ms), at: () => now };
}

describe('liveness', () => {
  test('it answers without touching a dependency — the checks are never run', () => {
    let ran = 0;
    const { health } = harness({
      checks: [{ name: 'db', critical: true, run: () => ((ran += 1), true) }],
    });

    expect(health.liveness()).toEqual({ status: 'ok', httpStatus: 200, uptimeMs: 0 });
    expect(ran).toBe(0);
  });

  test('uptime is measured from construction', () => {
    const { health, advance } = harness();
    advance(1_500);
    expect(health.liveness().uptimeMs).toBe(1_500);
  });
});

describe('readiness', () => {
  test('everything passing is `ok`/200, with one result per check', async () => {
    const { health } = harness({
      checks: [
        { name: 'config', run: () => true },
        { name: 'db', critical: true, run: () => Promise.resolve(true) },
        { name: 'cache', run: () => undefined },
      ],
      info: { version: '1.2.3', commit: 'abc123' },
    });

    const report = await health.ready();
    expect(report.status).toBe('ok');
    expect(report.httpStatus).toBe(200);
    expect(report.checks.map((check) => [check.name, check.status, check.critical])).toEqual([
      ['config', 'ok', false],
      ['db', 'ok', true],
      ['cache', 'ok', false],
    ]);
    expect(report.info).toEqual({ version: '1.2.3', commit: 'abc123' });
    expect(report.ts).toBe(new Date(AT).toISOString());
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a failed *optional* check is `degraded`/200 — traffic keeps flowing', async () => {
    const { health, failures } = harness({
      checks: [
        { name: 'db', critical: true, run: () => true },
        { name: 'cache', run: () => 'cache is cold' },
      ],
    });

    const report = await health.ready();
    expect(report.status).toBe('degraded');
    expect(report.httpStatus).toBe(200);
    expect(report.checks[1]).toMatchObject({
      name: 'cache',
      status: 'failed',
      reason: 'reported',
      detail: 'cache is cold',
    });
    expect(failures).toHaveLength(1);
  });

  test('a failed **critical** check is `failed`/503, and the failing check is named', async () => {
    const { health } = harness({
      checks: [
        { name: 'db', critical: true, run: () => Promise.reject(new Error('connection refused')) },
        { name: 'cache', run: () => true },
      ],
    });

    const report = await health.ready();
    expect(report.status).toBe('failed');
    expect(report.httpStatus).toBe(503);
    expect(report.checks[0]).toMatchObject({
      name: 'db',
      status: 'failed',
      critical: true,
      reason: 'threw',
    });
    expect(report.checks[0]?.detail).toBe('connection refused');
    // Every check runs even after a failure: a probe should report the whole picture.
    expect(report.checks[1]?.status).toBe('ok');
  });

  test('a check that throws a non-Error is still a described failure', async () => {
    const { health } = harness({
      // Deliberately not an `Error`: a check may reject with anything, and the report has to say so.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      checks: [{ name: 'odd', run: () => Promise.reject('nope') }],
    });
    const report = await health.ready();
    expect(report.checks[0]?.detail).toBe('nope');
  });

  test('a check that hangs is a failure with `reason: "timeout"`', async () => {
    const { health } = harness({
      checks: [
        {
          name: 'slow',
          critical: true,
          timeoutMs: 5,
          run: () => new Promise<boolean>(() => undefined),
        },
      ],
    });

    const report = await health.ready();
    expect(report.httpStatus).toBe(503);
    expect(report.checks[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(report.checks[0]?.detail).toContain('did not finish within 5 ms');
  });

  test('a per-check timeout overrides the registry default', async () => {
    const { health } = harness({
      timeoutMs: 10_000,
      checks: [{ name: 'fast', timeoutMs: 5, run: () => new Promise<boolean>(() => undefined) }],
    });
    const report = await health.ready();
    expect(report.checks[0]?.reason).toBe('timeout');
  });

  test('no checks is `ok`, which is the honest answer for a process with no dependencies', async () => {
    const { health } = harness();
    const report = await health.ready();
    expect(report.status).toBe('ok');
    expect(report.checks).toEqual([]);
  });

  test('a `false` return is a failure; a string is a failure with that reason', async () => {
    const { health } = harness({
      checks: [
        { name: 'a', run: () => false },
        { name: 'b', run: () => 'migrations pending' },
      ],
    });
    const report = await health.ready();
    expect(report.checks[0]?.status).toBe('failed');
    expect(report.checks[1]?.detail).toBe('migrations pending');
  });
});

describe('the HTTP response', () => {
  test('`toResponse` carries the status and the report, uncached', async () => {
    const { health } = harness({ checks: [{ name: 'db', critical: true, run: () => false }] });
    const report = await health.ready();
    const response = health.toResponse(report);

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'failed', httpStatus: 503 });
  });

  test('a healthy report is a 200 with the same body', async () => {
    const { health } = harness();
    const response = health.toResponse(await health.ready());
    expect(response.status).toBe(200);
    expect((await response.json()) as HealthReport).toMatchObject({ status: 'ok' });
  });
});
