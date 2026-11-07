import { describe, expect, test } from 'bun:test';
import { createQueueMonitor, createRequestLogger } from './index.ts';

/** An in-memory Drizzle-like store that returns empty results. */
function createMockDrizzle() {
  const empty = {
    from: () => empty,
    where: () => empty,
    orderBy: () => empty,
    limit: () => empty,
    offset: () => Promise.resolve([]),
  };
  return {
    select: () => empty,
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  } as unknown as Parameters<typeof createQueueMonitor>[0];
}

describe('telemetry request logger', () => {
  test('record inserts a row without throwing', async () => {
    const drizzle = createMockDrizzle();
    const logger = createRequestLogger(drizzle);
    await logger.record({ method: 'GET', path: '/', status: 200, durationMs: 5 });
    expect(true).toBe(true);
  });
});

describe('telemetry queue monitor', () => {
  test('countsByState returns zeros for empty store', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const counts = await monitor.countsByState();
    expect(counts).toEqual({ pending: 0, running: 0, delayed: 0, failed: 0 });
  });

  test('getJob returns null for unknown id', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const job = await monitor.getJob('nope');
    expect(job).toBeNull();
  });

  test('listJobs returns empty array', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const rows = await monitor.listJobs();
    expect(rows).toEqual([]);
  });

  test('retryJob returns false when not found', async () => {
    const drizzle = createMockDrizzle();
    const monitor = createQueueMonitor(drizzle);
    const ok = await monitor.retryJob('nope');
    expect(ok).toBe(false);
  });
});
