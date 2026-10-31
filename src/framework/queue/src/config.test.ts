/**
 * `queue.connections` in `tsir.js` (`CAP-001`, `§ 2.2`).
 *
 * The registry is lazy: a connection is built the first time something asks for it, so an app
 * that declares a `database` connection it never uses does not need the SQL client at boot —
 * but the moment it *is* asked for, a missing client is a startup failure and not a dispatch
 * that silently does nothing.
 *
 * The production guard is the case worth the test: `memory` and `sync` are legitimate
 * everywhere a developer works and refused where durability is the point.
 */

import { describe, expect, test } from 'bun:test';

import { createQueues, QUEUE_DRIVERS } from './config.ts';
import { createJobRegistry, defineJob } from './job.ts';
import type { QueueSql } from './sql.ts';

/** A `QueueSql` that will never be asked anything: config only opens the driver. */
const sql: QueueSql = {
  capabilities: { engine: 'postgres', placeholder: 'dollar', skipLocked: true },
  query: () => Promise.resolve({ rows: [], changes: 0 }),
};

const noop = defineJob<Record<string, never>>({ name: 'Noop', handle: async () => undefined });

describe('createQueues', () => {
  test('the default is the declared one, and it is the one used when no name is given', () => {
    const queues = createQueues({
      queue: {
        default: 'default',
        connections: { default: { driver: 'memory' }, heavy: { driver: 'memory' } },
      },
    });

    expect(queues.default).toBe('default');
    expect(queues.names).toEqual(['default', 'heavy']);
    expect(queues.connection().driver).toBe('memory');
    expect(queues.connection('heavy').connection).toBe('heavy');
  });

  test('with no explicit default the first declared connection wins, in declaration order', () => {
    const queues = createQueues({
      queue: { connections: { first: { driver: 'memory' }, second: { driver: 'memory' } } },
    });
    expect(queues.default).toBe('first');
    expect(queues.names).toEqual(['first', 'second']);
  });

  test('an unknown default is refused, and the message lists what is declared', () => {
    expect(() =>
      createQueues({
        queue: { default: 'nope', connections: { default: { driver: 'memory' } } },
      }),
    ).toThrow(/unknown queue connection "nope" \(declared: default\)/u);
  });

  test('a non-default connection is lazy: declaring one that is never used costs nothing', () => {
    // `heavy` names a `database` driver with no client bound. It must not fail the boot…
    const queues = createQueues({
      queue: { connections: { default: { driver: 'memory' }, heavy: { driver: 'database' } } },
    });
    expect(queues.names).toEqual(['default', 'heavy']);
    // …only the moment something actually asks for it.
    expect(() => queues.connection('heavy')).toThrow(/databases\.default/u);
  });

  test('a required connection is validated at boot, not at its first dispatch', () => {
    // The failure this prevents: a production app whose cron drains a `memory` connection boots
    // cleanly, then throws on the first tick — hours later, in a log nobody is watching.
    expect(() =>
      createQueues({
        queue: {
          // A durable default, so the refusal under test is the one `beat` earns and not the
          // default's — the two would otherwise look identical.
          connections: {
            default: { driver: 'database' },
            beat: { driver: 'memory', required: true },
          },
        },
        bindings: { databases: { default: sql } },
        production: true,
      }),
    ).toThrow(/beat.*memory.*die with the process/u);

    // And it is not a ban: the same connection in development boots, and is merely opened.
    const queues = createQueues({
      queue: {
        connections: { default: { driver: 'sync' }, beat: { driver: 'memory', required: true } },
      },
      bindings: { executors: { default: async () => undefined } },
      production: false,
    });
    expect(queues.names).toEqual(['default', 'beat']);
    expect(queues.connection('beat').driver).toBe('memory');
  });

  test('a non-transactional driver without an outbox is refused at boot', () => {
    // The same rule the deploy graph enforces (`DPL_QUEUE_OUTBOX_MISSING`), applied where a
    // developer meets it first: a `cloudflare-queues` connection with no outbox loses messages
    // it believes it dispatched, in development as well as production.
    expect(() =>
      createQueues({
        queue: { connections: { default: { driver: 'cloudflare-queues' } } },
        bindings: { queues: { default: { send: async () => undefined } } },
      }),
    ).toThrow(/cannot enqueue inside your write — the outbox is required/u);

    // Declared, the same connection builds.
    expect(() =>
      createQueues({
        queue: { connections: { default: { driver: 'cloudflare-queues', outbox: true } } },
        bindings: { queues: { default: { send: async () => undefined } } },
      }),
    ).not.toThrow();
  });

  test('a required connection that needs a client fails at boot for the same reason', () => {
    // The other half of "validated at boot": a `database` connection with no SQL client is a
    // startup error, not a surprise inside the first job.
    expect(() =>
      createQueues({
        queue: {
          connections: {
            default: { driver: 'memory' },
            heavy: { driver: 'database', required: true },
          },
        },
      }),
    ).toThrow(/databases\.default/u);
  });

  test('an unknown connection is refused rather than falling back to the default', () => {
    const queues = createQueues({ queue: { connections: { default: { driver: 'memory' } } } });
    expect(() => queues.connection('heavy')).toThrow(/unknown queue connection "heavy"/u);
  });

  test('no connections at all is a refusal, not an empty registry', () => {
    expect(() => createQueues({})).toThrow(
      /unknown queue connection "\(none\)" \(declared: none\)/u,
    );
  });

  test('an unknown driver lists the ones that exist', () => {
    expect(() =>
      createQueues({ queue: { connections: { default: { driver: 'kafka' } } } }),
    ).toThrow(/driver "kafka".*expected one of memory, sync, database, cloudflare-queues, sqs/su);
    expect(QUEUE_DRIVERS).toEqual(['memory', 'sync', 'database', 'cloudflare-queues', 'sqs']);
  });

  test('a database connection needs the SQL client it names, and says which one is missing', () => {
    expect(() =>
      createQueues({ queue: { connections: { default: { driver: 'database' } } } }),
    ).toThrow(/databases\.default/u);

    expect(() =>
      createQueues({
        queue: { connections: { default: { driver: 'database', connection: 'reporting' } } },
        bindings: { databases: { default: sql } },
      }),
    ).toThrow(/databases\.reporting/u);
  });

  test('a database connection opens against the client it names', () => {
    const queues = createQueues({
      queue: { connections: { default: { driver: 'database', connection: 'reporting' } } },
      bindings: { databases: { reporting: sql } },
    });

    expect(queues.connection().driver).toBe('database');
    expect(queues.connection().capabilities.delay).toBe(true);
  });

  test('a sync connection without an executor is a startup failure', () => {
    expect(() => createQueues({ queue: { connections: { default: { driver: 'sync' } } } })).toThrow(
      /sync.*bindings\.executors\.default/u,
    );

    const queues = createQueues({
      queue: { connections: { default: { driver: 'sync' } } },
      bindings: { executors: { default: async () => undefined } },
    });
    expect(queues.connection().driver).toBe('sync');
  });

  test('production refuses memory and sync, and says why in the units of the harm', () => {
    expect(() =>
      createQueues({ queue: { connections: { default: { driver: 'memory' } } }, production: true }),
    ).toThrow(/memory.*die with the process/u);

    expect(() =>
      createQueues({
        queue: { connections: { default: { driver: 'sync' } } },
        bindings: { executors: { default: async () => undefined } },
        production: true,
      }),
    ).toThrow(/sync.*inside the request/u);

    // The same declarations are fine everywhere else — this is a production guard, not a ban.
    expect(() =>
      createQueues({
        queue: { connections: { default: { driver: 'memory' } } },
        production: false,
      }),
    ).not.toThrow();
  });

  test('production accepts a durable connection', () => {
    const queues = createQueues({
      queue: { connections: { default: { driver: 'database' } } },
      bindings: { databases: { default: sql } },
      production: true,
    });
    expect(queues.connection().driver).toBe('database');
  });

  test('a connection is built once and shared, so two dispatches share one backend', () => {
    const queues = createQueues({ queue: { connections: { default: { driver: 'memory' } } } });
    expect(queues.connection()).toBe(queues.connection());
    expect(queues.backend()).toBe(queues.backend());
    expect(queues.backend('default')).toBe(queues.backend());
  });

  test('the backend is reachable without a job registry, which is what queue:failed needs', async () => {
    const queues = createQueues({ queue: { connections: { default: { driver: 'memory' } } } });
    const backend = queues.backend();
    expect(await backend.size()).toBe(0);
    expect(await backend.dead(10)).toEqual([]);
  });

  test('the registry is the one the queues dispatch through', () => {
    const queues = createQueues({
      queue: { connections: { default: { driver: 'memory' } } },
      jobs: [noop],
    });
    expect(queues.jobs.names).toEqual(['Noop']);
    expect(createJobRegistry([noop]).names).toEqual(queues.jobs.names);
  });

  test('a duplicate job name is refused at registry creation', () => {
    expect(() => createQueues({ jobs: [noop, noop] })).toThrow(/duplicate job name "Noop"/u);
  });

  test('a worker is bound to the connection it names, not to "the queue"', () => {
    const queues = createQueues({
      queue: { connections: { default: { driver: 'memory' }, heavy: { driver: 'memory' } } },
    });

    expect(queues.worker().running).toBe(false);
    expect(queues.worker('heavy', { concurrency: 2 }).inFlight).toBe(0);
    // A worker for a connection that does not exist is the same refusal as a queue for one.
    expect(() => queues.worker('ghost')).toThrow(/unknown queue connection "ghost"/u);
  });
});
