/**
 * Telescope-style request logger — thin wrapper around `@tsir/telemetry`.
 *
 * The framework package owns the schema + insertion logic; the admin only
 * re-exports the DI token so existing controllers keep working.
 */
import { token } from '@tsir/container';
import { createRequestLogger, requestLogs } from '@tsir/telemetry';
import type { DrizzleDb } from '../../../database.ts';

export type { RequestLogEntry } from '@tsir/telemetry';

export const requestLoggerToken = token<ReturnType<typeof createRequestLogger>>('RequestLogger');

export function createAdminRequestLogger(
  drizzle: DrizzleDb,
): ReturnType<typeof createRequestLogger> {
  return createRequestLogger(drizzle);
}

export { requestLogs };
