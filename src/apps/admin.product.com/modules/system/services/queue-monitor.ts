/**
 * Horizon-style queue monitor — thin wrapper around `@tsir/telemetry`.
 *
 * The framework package owns the queue_jobs + queue_dead schema and state
 * derivation; the admin only re-exports the DI token.
 */
import { token } from '@tsir/container';
import { createQueueMonitor } from '@tsir/telemetry';
import type { DrizzleDb } from '../../../database.ts';

export type { JobState, JobCounts, QueueJobRow } from '@tsir/telemetry';
export type QueueMonitor = ReturnType<typeof createQueueMonitor>;

export const queueMonitorToken = token<ReturnType<typeof createQueueMonitor>>('QueueMonitor');

export function createAdminQueueMonitor(drizzle: DrizzleDb): ReturnType<typeof createQueueMonitor> {
  // This app's `config/database.ts` declares the `d1` driver and nothing else, so the engine is not
  // a decision it makes at runtime — but saying it is what keeps the tables and the queries on the
  // same dialect if that config ever gains a second connection (`INF-010`).
  return createQueueMonitor(drizzle, { engine: 'd1' });
}
