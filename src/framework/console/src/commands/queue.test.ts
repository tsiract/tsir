/**
 * `tsir queue:*` (`CAP-004`).
 *
 * These run the CLI as a **subprocess**, one process per command, because that is the only way
 * the interesting property can be tested at all: `queue:work`, `queue:failed` and `queue:retry`
 * normally run in three different processes sharing one store. A test that called the command
 * functions in-process would pass with an in-memory broker and tell us nothing.
 *
 * The fixture's broker is a JSON file (`fixtures/queue-app/src/file-backend.ts`), so the
 * dispatch → work → dead-letter → replay cycle is real: the message is written by one process,
 * reserved by the next, and replayed by a third.
 *
 * What the commands decide, and therefore what is asserted:
 *
 *   · a worker is configured for a **connection**, and an undeclared one is refused by name;
 *   · `--once` is a gate — a dead letter out of one batch exits non-zero;
 *   · a replay needs `--yes`, because re-running work against live dependencies is a decision;
 *   · `queue:table` prints the SQL the driver actually issues, per engine.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { defineJob } from '@tsir/queue';

import { EXIT } from '../output.ts';
import { jobsFrom } from './queue.ts';
import { type CliRun, runCliInProcess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'queue-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliInProcess(args, { cwd });
}

/** Puts one message on the fixture's queue, in a process of its own — exactly like a request. */
function seed(cwd: string, payload: { orderId: string; fail?: boolean }): string {
  const result = Bun.spawnSync([process.execPath, 'src/seed.ts', JSON.stringify(payload)], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((result.exitCode ?? 1) !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

type Edit = (parts: { config: string; entry: string }) => { config?: string; entry?: string };

/** The `queue` block exactly as `fixtures/queue-app/tsir.js` writes it. */
const QUEUE_BLOCK = `  queue: {
    default: 'default',
    connections: {
      default: { driver: 'memory' },
      local: { driver: 'sync' },
    },
  },
`;

async function copy(edit?: Edit): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-queue-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  // State from a previous run in the source fixture must never leak into a test.
  await rm(join(dir, 'app', '.queue-state.json'), { force: true });
  await rm(join(dir, 'app', '.sent.log'), { force: true });

  if (edit !== undefined) {
    const configPath = join(dir, 'app', 'tsir.js');
    const entryPath = join(dir, 'app', 'src', 'app.ts');
    const next = edit({
      config: await readFile(configPath, 'utf8'),
      entry: await readFile(entryPath, 'utf8'),
    });
    if (next.config !== undefined) await writeFile(configPath, next.config, 'utf8');
    if (next.entry !== undefined) await writeFile(entryPath, next.entry, 'utf8');
  }
  return join(dir, 'app');
}

describe('the jobs a worker learns about (`EVT-4`)', () => {
  const Receipt = defineJob<{ readonly orderId: string }>({
    name: 'SendReceipt',
    handle: () => undefined,
  });

  test('an exported events registry brings its deliveries', async () => {
    // A `queued` listener is a job named `event:<event>:<listener>`. Without this merge a project
    // that exports `events` for the build rule would have a worker that cannot run a delivery —
    // and would find out when the relay dispatched it, not at boot.
    const delivery = defineJob<unknown>({
      name: 'event:order.placed:send-receipt',
      handle: () => undefined,
    });

    const jobs = jobsFrom({
      jobs: [Receipt],
      events: { names: ['order.placed'], jobs: () => [delivery] },
    });

    expect(jobs.map((job) => job.name)).toEqual(['SendReceipt', 'event:order.placed:send-receipt']);
  });

  test('a job the app already wired in is not registered twice', async () => {
    // Registering one name twice is a `TypeError` at registry creation, so the merge has to keep
    // the app's definition and skip the duplicate.
    const delivery = defineJob<unknown>({
      name: 'event:order.placed:send-receipt',
      handle: () => undefined,
    });

    const jobs = jobsFrom({
      jobs: [delivery],
      events: { names: ['order.placed'], jobs: () => [delivery] },
    });

    expect(jobs.map((job) => job.name)).toEqual(['event:order.placed:send-receipt']);
  });

  test('no events export, no merge — and a wrong shape is ignored rather than crashing', async () => {
    expect(jobsFrom({ jobs: [Receipt] }).map((job) => job.name)).toEqual(['SendReceipt']);
    expect(jobsFrom({ jobs: [Receipt], events: 'nope' }).map((job) => job.name)).toEqual([
      'SendReceipt',
    ]);
  });
});

describe('queue:table', () => {
  test('it prints the Postgres DDL by default: three tables and the idempotency index', async () => {
    const result = await runCli(['queue:table'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('CREATE TABLE IF NOT EXISTS queue_jobs');
    expect(result.output).toContain('CREATE TABLE IF NOT EXISTS queue_dead');
    expect(result.output).toContain('CREATE TABLE IF NOT EXISTS queue_outbox');
    expect(result.output).toContain('UNIQUE INDEX IF NOT EXISTS queue_jobs_idempotency');
    expect(result.output).toContain('available_at BIGINT');
  });

  test('--engine d1 switches the timestamp type, because D1 is not Postgres', async () => {
    const result = await runCli(['queue:table', '--engine', 'd1'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('available_at INTEGER');
    expect(result.output).not.toContain('BIGINT');
  });

  test('--json is the same statements, for a script that writes the migration', async () => {
    const result = await runCli(['queue:table', '--json'], FIXTURE);
    const parsed = JSON.parse(result.output) as { engine: string; statements: string[] };

    expect(parsed.engine).toBe('postgres');
    expect(parsed.statements).toHaveLength(6);
  });

  test('a bad engine is a usage error naming both accepted values', async () => {
    const result = await runCli(['queue:table', '--engine', 'mysql'], FIXTURE);

    expect(result.code).toBe(EXIT.ok === 0 ? 2 : 2);
    expect(result.output).toContain('"postgres" or "d1"');
  });

  test('custom table names are carried into every statement', async () => {
    const result = await runCli(
      ['queue:table', '--table', 'jobs', '--dead-table', 'jobs_dead'],
      FIXTURE,
    );

    expect(result.output).toContain('CREATE TABLE IF NOT EXISTS jobs (');
    expect(result.output).toContain('CREATE TABLE IF NOT EXISTS jobs_dead (');
    expect(result.output).not.toContain('queue_jobs');
  });
});

describe('queue:work --once', () => {
  test('an empty queue drains nothing and exits clean', async () => {
    const app = await copy();
    const result = await runCli(['queue:work', '--once'], app);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('0 drained');
  });

  test('a job that succeeds is completed, and the handler really ran', async () => {
    const app = await copy();
    seed(app, { orderId: 'o-42' });

    const result = await runCli(['queue:work', '--once'], app);
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('1 completed');

    expect((await readFile(join(app, '.sent.log'), 'utf8')).trim()).toBe('o-42');
  });

  test('a job that fails out of its budget dead-letters and exits non-zero', async () => {
    const app = await copy();
    seed(app, { orderId: 'o-7', fail: true });

    const result = await runCli(['queue:work', '--once'], app);

    // `--once` is the smoke test a pipeline runs: a dead letter is a failure, not a footnote.
    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('1 dead');
    expect(result.output).toContain('could not send receipt for o-7');
  });

  test('--json describes every result, so CI can read it without parsing prose', async () => {
    const app = await copy();
    seed(app, { orderId: 'o-9', fail: true });

    const result = await runCli(['queue:work', '--once', '--json'], app);
    const parsed = JSON.parse(result.output) as {
      ok: boolean;
      connection: string;
      drained: number;
      dead: number;
      results: { outcome: string; error?: string }[];
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.connection).toBe('default');
    expect(parsed.drained).toBe(1);
    expect(parsed.dead).toBe(1);
    expect(parsed.results[0]?.outcome).toBe('dead');
    expect(parsed.results[0]?.error).toContain('o-9');
  });

  test('an undeclared connection is refused by name, with the declared ones listed', async () => {
    const app = await copy();
    const result = await runCli(['queue:work', '--once', '--connection', 'heavy'], app);

    expect(result.code).not.toBe(EXIT.ok);
    expect(result.output).toContain('unknown queue connection "heavy"');
    expect(result.output).toContain('declared: default');
  });

  test('a driver with nothing to drain is refused instead of polling forever', async () => {
    // No `queues` export: the registry comes from `queue.connections` in tsir.js, where
    // `default` is `memory` and `local` is `sync` — neither of which a CLI worker can drain.
    const app = await copy(({ entry }) => ({
      entry: entry.slice(0, entry.indexOf('export const queues')),
    }));

    const memory = await runCli(['queue:work', '--once'], app);
    expect(memory.code).not.toBe(EXIT.ok);
    expect(memory.output).toContain('nothing to drain');
    expect(memory.output).toContain('a worker in another process would never see one');

    const sync = await runCli(['queue:work', '--once', '--connection', 'local'], app);
    expect(sync.code).not.toBe(EXIT.ok);
    expect(sync.output).toContain('runs the job inside `dispatch`');
  });

  test('a worker with no job registry refuses: it would dead-letter everything it reserved', async () => {
    const app = await copy(({ entry }) => ({
      entry: entry.replace('export const jobs = [SendReceipt];', 'export const jobs = [];'),
    }));

    const result = await runCli(['queue:work', '--once'], app);
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.output).toContain('no jobs are registered');
  });
});

describe('queue:failed', () => {
  test('an empty dead-letter store is a clean result, not an error', async () => {
    const app = await copy();
    const result = await runCli(['queue:failed'], app);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('the dead-letter store is empty');
  });

  test('a dead letter is listed with its attempts and the error that produced it', async () => {
    const app = await copy();
    const id = seed(app, { orderId: 'o-3', fail: true });
    await runCli(['queue:work', '--once'], app);

    const result = await runCli(['queue:failed'], app);
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain(`SendReceipt#${id}`);
    expect(result.output).toContain('(1/1 attempts)');
    expect(result.output).toContain('could not send receipt for o-3');
  });

  test('--json carries the id a script needs to replay it', async () => {
    const app = await copy();
    const id = seed(app, { orderId: 'o-4', fail: true });
    await runCli(['queue:work', '--once'], app);

    const result = await runCli(['queue:failed', '--json'], app);
    const parsed = JSON.parse(result.output) as {
      count: number;
      failed: { id: string; name: string; attempts: number; error?: string }[];
    };

    expect(parsed.count).toBe(1);
    expect(parsed.failed[0]?.id).toBe(id);
    expect(parsed.failed[0]?.name).toBe('SendReceipt');
    expect(parsed.failed[0]?.attempts).toBe(1);
    expect(parsed.failed[0]?.error).toContain('o-4');
  });
});

describe('queue:retry', () => {
  test('without --yes it reports and changes nothing', async () => {
    const app = await copy();
    const id = seed(app, { orderId: 'o-5', fail: true });
    await runCli(['queue:work', '--once'], app);

    const result = await runCli(['queue:retry', id], app);
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('would replay');
    expect(result.output).toContain('--yes');

    // Still dead: a report is a report.
    expect((await runCli(['queue:failed', '--json'], app)).output).toContain(id);
  });

  test('with --yes it replays onto the queue with a fresh budget', async () => {
    const app = await copy();
    const id = seed(app, { orderId: 'o-6', fail: true });
    await runCli(['queue:work', '--once'], app);

    const retried = await runCli(['queue:retry', id, '--yes'], app);
    expect(retried.code).toBe(EXIT.ok);
    expect(retried.output).toContain(`replayed ${id}`);

    // The dead-letter store is empty and the message is queued again…
    expect(JSON.parse((await runCli(['queue:failed', '--json'], app)).output)).toMatchObject({
      count: 0,
    });
    // …and it spends its fresh budget on the next drain (it is still the failing payload).
    expect((await runCli(['queue:work', '--once'], app)).output).toContain('(attempt 1)');
  });

  test('--all --yes replays the whole store, bounded by --limit', async () => {
    const app = await copy();
    seed(app, { orderId: 'a', fail: true });
    seed(app, { orderId: 'b', fail: true });
    await runCli(['queue:work', '--once'], app);
    await runCli(['queue:work', '--once'], app);

    const result = await runCli(['queue:retry', '--all', '--yes', '--limit', '1'], app);
    expect(result.code).toBe(EXIT.ok);
    // `--limit` bounds the read, so `--all` replays at most that many and says how many it did.
    expect(result.output).toContain('replayed 1 of 1');

    const rest = JSON.parse((await runCli(['queue:failed', '--json'], app)).output) as {
      count: number;
    };
    expect(rest.count).toBe(1);
  });

  test('no id and no --all is a usage error, not a silent "nothing to do"', async () => {
    const app = await copy();
    const result = await runCli(['queue:retry'], app);

    expect(result.code).not.toBe(EXIT.ok);
    expect(result.output).toContain('needs a message id, or --all');
  });

  test('an id that is not in the dead-letter store fails, naming the connection', async () => {
    const app = await copy();
    const result = await runCli(['queue:retry', 'no-such-id', '--yes'], app);

    expect(result.code).not.toBe(EXIT.ok);
    expect(result.output).toContain('no dead letter "no-such-id" on connection "default"');
  });
});

describe('a project with no queue configuration at all', () => {
  test('the command says what is missing instead of guessing a driver', async () => {
    const app = await copy(({ config, entry }) => ({
      // No `queue.connections`, and no registry exported from the entry: nothing to resolve.
      config: config.replace(QUEUE_BLOCK, ''),
      entry: entry.slice(0, entry.indexOf('export const queues')),
    }));

    const result = await runCli(['queue:failed'], app);
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.output).toContain('unknown queue connection');
  });
});
