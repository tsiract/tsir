/**
 * Queue errors (`§ 8`).
 *
 * Every one of these is read by a person at the worst possible moment, so each is asserted on
 * the two things that make an error actionable: the **code** (for a program) and the sentence
 * that names the connection or job (for a human). A `CAP_UNKNOWN_CONNECTION` that says "queue
 * not found" sends someone to the source; one that lists the declared names ends the search.
 *
 * These constructors **return** a `TsirError`; throwing is the caller's decision — a dispatch
 * refuses by rejecting, a boot refuses by throwing — so nothing here is wrapped in `expect(…)
 * .toThrow`.
 */

import { describe, expect, test } from 'bun:test';

import {
  dispatchFailed,
  driverMissing,
  forbiddenInProduction,
  jobTimeout,
  outboxRequired,
  unknownConnection,
  unknownJob,
  unsupportedOperation,
} from './errors.ts';

describe('queue errors', () => {
  test('an unknown connection lists the declared ones, and never suggests a fallback', () => {
    const error = unknownConnection('heavy', ['default', 'mail']);
    expect(error.code).toBe('CAP_UNKNOWN_CONNECTION');
    expect(error.message).toBe('unknown queue connection "heavy" (declared: default, mail)');
    expect(error.hint).toContain('never falls back to the default queue');
  });

  test('with nothing declared the message says so rather than printing an empty list', () => {
    expect(unknownConnection('default', []).message).toBe(
      'unknown queue connection "default" (declared: none)',
    );
  });

  test('an unknown job lists what is registered', () => {
    const error = unknownJob('SendReciept', ['SendReceipt']);
    expect(error.code).toBe('CAP_UNKNOWN_JOB');
    expect(error.message).toBe('unknown job "SendReciept" (registered: SendReceipt)');
    expect(error.hint).toContain('defineJob');
  });

  test('a dispatch failure keeps the backend’s own words', () => {
    const error = dispatchFailed('default', 'SendReceipt', 'network unreachable');
    expect(error.code).toBe('CAP_DISPATCH_FAILED');
    expect(error.message).toBe(
      'could not dispatch "SendReceipt" to connection "default": network unreachable',
    );
  });

  test('a timeout names the budget and the attempt', () => {
    const error = jobTimeout('SlowReport', 30_000, 2);
    expect(error.code).toBe('CAP_JOB_TIMEOUT');
    expect(error.message).toBe('job "SlowReport" exceeded 30000 ms on attempt 2');
    expect(error.hint).toContain('retried like any other failure');
  });

  test('a missing outbox names the driver that made it mandatory', () => {
    const error = outboxRequired('default', 'sqs');
    expect(error.code).toBe('CAP_OUTBOX_REQUIRED');
    expect(error.message).toContain('uses driver "sqs"');
    expect(error.message).toContain('the outbox is required');
    expect(error.hint).toContain('batch()');
  });

  test('a missing client says which binding to supply', () => {
    const error = driverMissing(
      'default',
      'database',
      'no `databases.default` SQL client was supplied',
    );
    expect(error.code).toBe('CAP_DRIVER_MISSING');
    expect(error.message).toContain('queue connection "default" names driver "database"');
    expect(error.message).toContain('databases.default');
  });

  test('a production refusal names the harm, not the rule', () => {
    const error = forbiddenInProduction(
      'default',
      'memory',
      'the queue would die with the process',
    );
    expect(error.code).toBe('CAP_FORBIDDEN_IN_PRODUCTION');
    expect(error.message).toContain('queue connection "default"');
    expect(error.message).toContain('die with the process');
  });

  test('an unsupported operation names the operation and offers the way out', () => {
    const error = unsupportedOperation(
      'local',
      'sync',
      'a delayed dispatch',
      'this driver has no delay support',
    );
    expect(error.code).toBe('CAP_UNSUPPORTED_OPERATION');
    expect(error.message).toBe(
      'queue connection "local" (driver "sync") does not support a delayed dispatch — this driver has no delay support',
    );
    expect(error.hint).toContain('use a connection whose driver supports it');
  });

  test('an unsupported operation without a detail still reads as a sentence', () => {
    expect(unsupportedOperation('local', 'sync', 'cancel').message).toBe(
      'queue connection "local" (driver "sync") does not support cancel',
    );
  });
});
