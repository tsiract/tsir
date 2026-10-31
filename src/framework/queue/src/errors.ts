/**
 * Queue errors (`§ 4.2`, `§ 8`).
 *
 * The one that carries the design opinion is `CAP_OUTBOX_REQUIRED`: on a non-transactional
 * broker the outbox is not a best practice, it is the difference between "the order was
 * written and the receipt job exists" and "one of the two happened". A build that refuses is
 * cheaper than a support ticket that says the receipts are missing for some orders.
 *
 * Every message names the connection, because `queue.connection('heavy')` is the thing a
 * person typed and "the queue failed" is not an address.
 */

import { TsirError } from '@tsir/container';

export type QueueErrorCode =
  | 'CAP_UNKNOWN_CONNECTION'
  | 'CAP_UNKNOWN_JOB'
  | 'CAP_DISPATCH_FAILED'
  | 'CAP_JOB_TIMEOUT'
  | 'CAP_OUTBOX_REQUIRED'
  | 'CAP_DRIVER_MISSING'
  | 'CAP_FORBIDDEN_IN_PRODUCTION'
  | 'CAP_UNSUPPORTED_OPERATION';

const KIND = 'capability';

export function unknownConnection(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'CAP_UNKNOWN_CONNECTION',
    `unknown queue connection "${name}" (declared: ${known.length === 0 ? 'none' : known.join(', ')})`,
    {
      kind: KIND,
      hint: 'declare it under `queue.connections` in tsir.js — an undeclared name never falls back to the default queue',
      context: { connection: name },
    },
  );
}

export function unknownJob(name: string, known: readonly string[]): TsirError {
  return new TsirError(
    'CAP_UNKNOWN_JOB',
    `unknown job "${name}" (registered: ${known.length === 0 ? 'none' : known.join(', ')})`,
    {
      kind: KIND,
      hint: 'register it with `defineJob` in the app entry and export the list as `jobs`',
      context: { job: name },
    },
  );
}

export function dispatchFailed(connection: string, job: string, detail: string): TsirError {
  return new TsirError(
    'CAP_DISPATCH_FAILED',
    `could not dispatch "${job}" to connection "${connection}": ${detail}`,
    {
      kind: KIND,
      hint: 'the message was not accepted — retrying the dispatch is safe, dispatching something else may not be',
      context: { connection, job },
    },
  );
}

/** A job that ran past its own `timeoutMs`. The attempt counts as a failure. */
export function jobTimeout(job: string, timeoutMs: number, attempt: number): TsirError {
  return new TsirError(
    'CAP_JOB_TIMEOUT',
    `job "${job}" exceeded ${String(timeoutMs)} ms on attempt ${String(attempt)}`,
    {
      kind: KIND,
      hint: 'raise the job’s timeoutMs, or move the slow part to a smaller job — a timeout is retried like any other failure',
      context: { job, timeoutMs, attempt },
    },
  );
}

/** A non-transactional driver without an outbox. */
export function outboxRequired(connection: string, driver: string): TsirError {
  return new TsirError(
    'CAP_OUTBOX_REQUIRED',
    `queue connection "${connection}" uses driver "${driver}", which cannot enqueue inside your write — the outbox is required`,
    {
      kind: KIND,
      hint: 'write the job to the outbox in the same `batch()` as the business row, and let a relay dispatch it; `tsir queue:work` relays automatically',
      context: { connection, driver },
    },
  );
}

export function driverMissing(connection: string, driver: string, detail: string): TsirError {
  return new TsirError(
    'CAP_DRIVER_MISSING',
    `queue connection "${connection}" names driver "${driver}", which cannot be used: ${detail}`,
    {
      kind: KIND,
      hint: 'declare the driver this build ships, or pass the client/binding it needs',
      context: { connection, driver },
    },
  );
}

export function forbiddenInProduction(
  connection: string,
  driver: string,
  reason: string,
): TsirError {
  return new TsirError(
    'CAP_FORBIDDEN_IN_PRODUCTION',
    `queue connection "${connection}" uses driver "${driver}" in production: ${reason}`,
    {
      kind: KIND,
      hint: 'point the connection at a durable driver, or leave it out of what production resolves',
      context: { connection, driver },
    },
  );
}

export function unsupportedOperation(
  connection: string,
  driver: string,
  operation: string,
  detail?: string,
): TsirError {
  return new TsirError(
    'CAP_UNSUPPORTED_OPERATION',
    `queue connection "${connection}" (driver "${driver}") does not support ${operation}${detail === undefined ? '' : ` — ${detail}`}`,
    {
      kind: KIND,
      hint: 'use a connection whose driver supports it, or stop asking for it',
      context: { connection, driver, operation },
    },
  );
}
