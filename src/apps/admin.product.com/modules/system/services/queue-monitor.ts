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
  return createQueueMonitor(drizzle);
}
