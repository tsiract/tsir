/**
 * Queue triggers in the deploy graph (`CAP-004`, `QUEUE-17`).
 *
 * The acceptance is two refusals and one shape:
 *
 *   · a connection with **no trigger** on a chosen target fails the build, naming the cell of
 *     the capability row it came from;
 *   · a **non-transactional** connection with **no outbox** fails the build, because the
 *     failure it prevents commits an order without its receipt job and nobody finds out;
 *   · a connection is **one unit**, named `queue:<connection>`, with the trigger its driver
 *     and target actually give it — native `queue`, or a cron drain.
 *
 * The table is asserted case by case, because a matrix that is only tested through one row is
 * a matrix that quietly grows a wrong cell.
 */

import { describe, expect, test } from 'bun:test';

import {
  checkQueueConnections,
  QUEUE_TRIGGER_MATRIX,
  queueUnitFor,
  triggerFor,
} from './queue-triggers.ts';
import { buildGraph } from './graph.ts';

describe('the § 4.2 trigger matrix', () => {
  test('every shipped driver has a row, and the cells are the table’s cells', () => {
    expect(triggerFor('database', 'bun')).toBe('drain');
    expect(triggerFor('database', 'cloudflare')).toBe('drain');
    expect(triggerFor('database', 'lambda')).toBe('drain');

    expect(triggerFor('cloudflare-queues', 'cloudflare')).toBe('native');
    expect(triggerFor('cloudflare-queues', 'lambda')).toBe('unsupported');
    expect(triggerFor('cloudflare-queues', 'bun')).toBe('unsupported');

    expect(triggerFor('sqs', 'lambda')).toBe('native');
    expect(triggerFor('sqs', 'bun')).toBe('drain');
    expect(triggerFor('sqs', 'cloudflare')).toBe('unsupported');

    // The development drivers are reachable nowhere, and that is not a build failure.
    expect(triggerFor('memory', 'bun')).toBe('unsupported');
    expect(triggerFor('sync', 'cloudflare')).toBe('unsupported');
    expect(triggerFor('something-new', 'bun')).toBe('unsupported');
  });

  test('the matrix is data, not prose: every driver has an entry', () => {
    for (const driver of ['database', 'cloudflare-queues', 'sqs', 'sync', 'memory']) {
      expect(QUEUE_TRIGGER_MATRIX[driver]).toBeDefined();
    }
  });
});

describe('queueUnitFor', () => {
  test('a native connection’s trigger is its queue name', () => {
    const unit = queueUnitFor({ name: 'default', driver: 'cloudflare-queues', outbox: true });

    expect(unit.name).toBe('queue:default');
    expect(unit.kind).toBe('queue');
    expect(unit.triggers).toEqual([{ kind: 'queue', detail: ['default'] }]);
    // A worker has no request surface: a queue unit with a public URL is a bug with a URL.
    expect(unit.private).toBe(true);
  });

  test('a drain connection is triggered by a one-minute cron, and says so', () => {
    const unit = queueUnitFor({ name: 'heavy', driver: 'database', queues: ['b', 'a', 'a'] });

    // `database` drains on every target, so the cron is the union without argument.
    expect(triggerFor('database', 'lambda')).toBe('drain');
    // Deduplicated and sorted: the graph is deterministic, so a diff means a change.
    expect(unit.triggers).toEqual([{ kind: 'cron', detail: ['* * * * *'] }]);
    expect(unit.reasons).toEqual([{ source: 'queues', from: 'heavy (database)' }]);
  });

  test('two connections are two units, not one merged “queue”', () => {
    const first = queueUnitFor({ name: 'default', driver: 'cloudflare-queues', outbox: true });
    const second = queueUnitFor({ name: 'heavy', driver: 'sqs', outbox: true });

    expect(first.name).not.toBe(second.name);
    expect(first.triggers).not.toEqual(second.triggers);
  });

  test('a connection that both drains and is pushed carries both triggers', () => {
    // `sqs` is native on Lambda and drained on Bun. A graph is one artefact for every target,
    // so the union is the only honest answer — and `checkGraph` refuses the impossible
    // pairings per target.
    expect(queueUnitFor({ name: 'heavy', driver: 'sqs', outbox: true }).triggers).toEqual([
      { kind: 'queue', detail: ['heavy'] },
      { kind: 'cron', detail: ['* * * * *'] },
    ]);
  });
});

describe('checkQueueConnections', () => {
  test('a connection the target cannot trigger is refused, naming the cell', () => {
    const problems = checkQueueConnections({
      connections: [{ name: 'default', driver: 'cloudflare-queues', outbox: true }],
      events: true,
      targets: ['lambda'],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('DPL_QUEUE_TRIGGER_MISSING');
    expect(problems[0]?.message).toContain(
      'queue connection "default" uses driver "cloudflare-queues"',
    );
    expect(problems[0]?.message).toContain('which lambda cannot trigger');
    // The message says where it *can* run, so the fix is one decision away.
    expect(problems[0]?.message).toContain('it runs on cloudflare');
    expect(problems[0]?.hint).toContain('declare the connection');
  });

  test('a non-transactional connection without an outbox is refused', () => {
    const problems = checkQueueConnections({
      connections: [{ name: 'default', driver: 'sqs' }],
      targets: ['lambda'],
    });

    expect(problems.map((problem) => problem.code)).toEqual(['DPL_QUEUE_OUTBOX_MISSING']);
    expect(problems[0]?.message).toContain('cannot enqueue inside your write');
    expect(problems[0]?.hint).toContain('outbox: true');
  });

  test('both refusals fire together, so one build prints both', () => {
    const problems = checkQueueConnections({
      connections: [{ name: 'default', driver: 'sqs' }],
      targets: ['cloudflare'],
    });

    expect(problems.map((problem) => problem.code).sort()).toEqual([
      'DPL_QUEUE_OUTBOX_MISSING',
      'DPL_QUEUE_TRIGGER_MISSING',
    ]);
  });

  test('a transactional driver needs no outbox: the write is already atomic', () => {
    expect(
      checkQueueConnections({
        connections: [{ name: 'default', driver: 'database' }],
        targets: ['bun', 'cloudflare', 'lambda'],
      }),
    ).toEqual([]);
  });

  test('an outbox satisfies the rule on either broker', () => {
    expect(
      checkQueueConnections({
        connections: [
          { name: 'default', driver: 'sqs', outbox: true },
          { name: 'jobs', driver: 'cloudflare-queues', outbox: true },
        ],
        events: true,
        targets: ['lambda'],
      }).map((problem) => problem.code),
    ).toEqual(['DPL_QUEUE_TRIGGER_MISSING']);
  });

  test('an outbox with nothing to write it is refused', () => {
    // `outbox: true` is a claim about durability. Without an events registry there is no writer,
    // so the claim would be false — and false in the direction nobody notices: the declaration says the
    // delivery is safe, and the table stays empty.
    const problems = checkQueueConnections({
      connections: [{ name: 'default', driver: 'cloudflare-queues', outbox: true }],
      targets: ['cloudflare'],
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('DPL_EVENTS_OUTBOX_MISSING');
    expect(problems[0]?.message).toContain('declares an outbox');
    expect(problems[0]?.message).toContain('no events registry');
    expect(problems[0]?.hint).toContain('publisher.record');
  });

  test('a missing outbox is reported once, not twice', () => {
    // One connection, one repair: "declare an outbox" already implies the writer, so firing both
    // codes for the same connection would be two lines for one fix.
    expect(
      checkQueueConnections({
        connections: [{ name: 'default', driver: 'sqs' }],
        targets: ['lambda'],
      }).map((problem) => problem.code),
    ).toEqual(['DPL_QUEUE_OUTBOX_MISSING']);
  });

  test('an events registry is not needed by a transactional connection', () => {
    expect(
      checkQueueConnections({
        connections: [{ name: 'default', driver: 'database' }],
        targets: ['bun'],
      }),
    ).toEqual([]);
  });

  test('development drivers are not build failures — boot refuses them instead', () => {
    expect(
      checkQueueConnections({
        connections: [
          { name: 'local', driver: 'sync' },
          { name: 'dev', driver: 'memory' },
        ],
        targets: ['bun', 'cloudflare', 'lambda'],
      }),
    ).toEqual([]);
  });

  test('a project with no queue has nothing to check', () => {
    expect(checkQueueConnections({ connections: [], targets: ['cloudflare'] })).toEqual([]);
  });
});

describe('the graph carries the queue checks', () => {
  const input = { appName: 'shop' };

  test('the problems reach `buildGraph`, which is what `deploy:plan` prints', () => {
    const { problems } = buildGraph(input, {
      targets: [{ target: 'lambda' }],
      queue: [{ name: 'default', driver: 'cloudflare-queues', outbox: true }],
    });

    expect(problems.map((problem) => problem.code)).toContain('DPL_QUEUE_TRIGGER_MISSING');
  });

  test('a project that declares no queue is unaffected', () => {
    const { problems } = buildGraph(input, { targets: [{ target: 'lambda' }] });
    expect(problems).toEqual([]);
  });
});

describe('the emitted configs carry the triggers', () => {
  // A trigger the graph records and the emitter forgets is a unit the dashboard shows and the
  // platform never calls — and `wrangler deploy` does not warn, because nothing in the bundle
  // says a queue was expected.
  const queueUnit = queueUnitFor({ name: 'default', driver: 'cloudflare-queues', outbox: true });
  const drainUnit = queueUnitFor({ name: 'heavy', driver: 'database' });

  test('a native consumer becomes a [[queues.consumers]] block', async () => {
    const { wranglerToml } = await import('./wrangler.ts');
    const toml = wranglerToml(queueUnit, 'shop', {
      compatibilityDate: '2026-09-01',
      resources: {},
    });

    expect(toml).toContain('[[queues.consumers]]');
    expect(toml).toContain('queue = "default"');
    expect(toml).toContain('dead_letter_queue = "default-dlq"');
    // A worker has no request surface, so nothing may reach it (`DPL-022`).
    expect(toml).toContain('workers_dev = false');
    // No cron: the platform hands this unit its batch.
    expect(toml).not.toContain('[triggers]');
  });

  test('a drain connection becomes a [triggers] crons entry', async () => {
    const { wranglerToml } = await import('./wrangler.ts');
    const toml = wranglerToml(drainUnit, 'shop', {
      compatibilityDate: '2026-09-01',
      resources: {},
    });

    expect(toml).toContain('[triggers]');
    expect(toml).toContain('crons = ["* * * * *"]');
    // Nothing to consume: a drain polls a table, it is not pushed a batch.
    expect(toml).not.toContain('[[queues.consumers]]');
  });

  test('a queue trigger on Lambda becomes an SQS event source', async () => {
    const { samTemplate } = await import('./sam.ts');
    const template = samTemplate(
      queueUnitFor({ name: 'heavy', driver: 'sqs', outbox: true }),
      'shop',
    );

    expect(template).toContain('QueueArn');
    expect(template).toContain('Consume');
  });
});
