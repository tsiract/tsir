/**
 * `tsir schedule:*` (`§ 4.6`, `SCHED-*`).
 *
 * Every command runs as a **subprocess**, one process per command, because the interesting
 * property is the one an in-process test cannot see: `schedule:run` in one process and
 * `schedule:work` in another must agree about who holds a lock. The fixture's lock is a JSON file
 * (`fixtures/schedule-app/src/file-lock.ts`), so the two processes really do race.
 *
 * What the commands decide, and therefore what is asserted:
 *
 *   · a task is **due** by its own cron *and its own offset* — `--at 03:00Z` does not run the
 *     task declared for 03:00 Manila;
 *   · `busy` is not a failure: `schedule:run` exits 0 when the lock says another run is going,
 *     and `--force` runs anyway **without** stealing the lock;
 *   · `--once` is a gate — a failed task exits non-zero, because a cron has no retry;
 *   · `--production` refuses a per-process lock, and passes a shared one;
 *   · `schedule:table` prints the SQL the `database` lock actually issues.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { tasksFrom } from './schedule.ts';
import { type CliRun, runCliInProcess, runCliSubprocess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'schedule-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliInProcess(args, { cwd });
}

type Edit = (parts: { config: string; entry: string }) => { config?: string; entry?: string };

async function copy(edit?: Edit): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-schedule-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  // State from a previous run in the source fixture must never leak into a test.
  await rm(join(dir, 'app', '.ran.log'), { force: true });
  await rm(join(dir, 'app', '.locks.json'), { force: true });

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

/** What the fixture's handlers wrote, one line per run: `name scheduledFor trigger`. */
async function ran(cwd: string): Promise<readonly string[]> {
  const path = join(cwd, '.ran.log');
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
}

/** A live lock on `hourly`, as another process would have left it. */
async function holdLock(cwd: string, name: string): Promise<void> {
  await writeFile(
    join(cwd, '.locks.json'),
    JSON.stringify({ [name]: { owner: 'other-process', expiresAt: Date.now() + 600_000 } }),
    'utf8',
  );
}

const AT = (iso: string): readonly string[] => ['--at', iso];

describe('the tasks a project declares', () => {
  test('a shape that is not a task list is ignored, not crashed into', async () => {
    // The registry is the app's declaration. A CLI that guessed would run a `cron` string it
    // never parsed, and the first symptom would be a task that never fires.
    expect(tasksFrom({ tasks: 'nope' }).length).toBe(0);
    expect(tasksFrom({}).length).toBe(0);
    expect(tasksFrom({ tasks: [{ name: 'x', cron: '0 3 * * *' }] }).length).toBe(0);
  });

  test('a real list comes back in declaration order', async () => {
    const task = {
      name: 'hourly',
      cron: '0 * * * *',
      spec: {},
      handle: () => undefined,
    };
    expect(tasksFrom({ tasks: [task] }).map((entry) => entry.name)).toEqual(['hourly']);
  });
});

describe('schedule:list', () => {
  test('one row per task, with the next run in the task’s own clock', async () => {
    const result = await runCli(
      ['schedule:list', '--json', ...AT('2026-11-01T00:30:00Z')],
      FIXTURE,
    );

    expect(result.code).toBe(EXIT.ok);
    const document = JSON.parse(result.output) as {
      lock: string;
      tasks: {
        name: string;
        cron: string;
        nextRunAt: string;
        localNextRun: string;
        overlap: string;
      }[];
    };

    expect(document.tasks.map((task) => task.name)).toEqual([
      'hourly',
      'nightly',
      'broken',
      'manila-report',
    ]);
    expect(document.lock).toContain('app.ts');

    const manila = document.tasks.find((task) => task.name === 'manila-report');
    // 03:00 Manila is 19:00 UTC the same day; the row prints both, because the two people
    // reading it are in different rooms.
    expect(manila?.nextRunAt).toBe('2026-11-01T19:00:00.000Z');
    expect(manila?.localNextRun).toBe('2026-11-02 03:00 UTC+08:00');
    expect(manila?.overlap).toBe('skip');

    const hourly = document.tasks.find((task) => task.name === 'hourly');
    expect(hourly?.nextRunAt).toBe('2026-11-01T01:00:00.000Z');
  });

  test('a held lock is shown against the task that holds it', async () => {
    const cwd = await copy();
    await holdLock(cwd, 'hourly');

    const result = await runCli(['schedule:list', '--json'], cwd);
    const document = JSON.parse(result.output) as {
      tasks: { name: string; lockedBy: string | null }[];
    };

    expect(document.tasks.find((task) => task.name === 'hourly')?.lockedBy).toBe('other-process');
    expect(document.tasks.find((task) => task.name === 'nightly')?.lockedBy).toBeNull();
  });

  test('the human output names the lock, so "overlap is prevented" is a fact or a caveat', async () => {
    const result = await runCli(['schedule:list'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('schedule:list');
    expect(result.output).toContain('skip-on-overlap');
    expect(result.output).toContain('next');
  });

  test('an app with no tasks is a message with the fix, not an empty table', async () => {
    const result = await runCli(['schedule:list'], join(import.meta.dir, 'fixtures', 'cache-app'));

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('no tasks are declared');
    expect(result.output).toContain('defineTask');
  });
});

describe('schedule:run', () => {
  test('runs the task, and says it was a manual run', async () => {
    const cwd = await copy();

    const result = await runCli(['schedule:run', 'hourly', ...AT('2026-11-01T00:00:00Z')], cwd);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('ran');
    // `manual` in the log is the difference between "the clock fired" and "a person did", and
    // it is the first thing anyone asks about a task that ran at an odd hour.
    expect(await ran(cwd)).toEqual(['hourly 1793491200000 manual']);
  });

  test('a failing task exits non-zero and prints what the handler said', async () => {
    const cwd = await copy();

    const result = await runCli(['schedule:run', 'broken'], cwd);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('the report endpoint answered 500');
  });

  test('an unknown name lists the ones that exist', async () => {
    const cwd = await copy();

    const result = await runCli(['schedule:run', 'nope'], cwd);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('SCHED_UNKNOWN_TASK');
    expect(result.output).toContain('manila-report');
  });

  test('no name is a usage error that points at the tick', async () => {
    const result = await runCli(['schedule:run'], FIXTURE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('schedule:work --once');
  });

  test('a lock held by another run is `busy`, which exits 0 — the lock did its job', async () => {
    const cwd = await copy();
    await holdLock(cwd, 'hourly');

    const result = await runCli(['schedule:run', 'hourly', '--json'], cwd);
    const outcome = JSON.parse(result.output) as { status: string };

    expect(result.code).toBe(EXIT.ok);
    expect(outcome.status).toBe('busy');
    expect(await ran(cwd)).toEqual([]);
  });

  test('--force runs anyway, and does not release a lock it never took', async () => {
    const cwd = await copy();
    await holdLock(cwd, 'hourly');

    const result = await runCli(['schedule:run', 'hourly', '--force'], cwd);

    expect(result.code).toBe(EXIT.ok);
    expect((await ran(cwd)).length).toBe(1);
    // The other process is still running it. Deleting its lock would be the overlap the lock
    // exists to prevent, one minute later.
    const locks = JSON.parse(await readFile(join(cwd, '.locks.json'), 'utf8')) as Record<
      string,
      { owner: string }
    >;
    expect(locks['hourly']?.owner).toBe('other-process');
  });

  test('--at that is not a time is refused before anything runs', async () => {
    const cwd = await copy();

    const result = await runCli(['schedule:run', 'hourly', ...AT('tomorrow-ish')], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('is not a time');
    expect(await ran(cwd)).toEqual([]);
  });
});

describe('schedule:work', () => {
  test('--once runs the tasks due at that minute and nothing else', async () => {
    const cwd = await copy();

    // 01:00 UTC: `hourly` and `broken` fire; `nightly` (03:00) and `manila-report` (03:00 +08 =
    // 19:00 UTC) do not. A tick that ran "everything" would be a scheduler that ignores crons.
    const result = await runCli(['schedule:work', '--once', ...AT('2026-11-01T01:00:00Z')], cwd);

    expect(result.code).toBe(EXIT.failure); // because `broken` failed
    expect(result.output).toContain('hourly ran');
    expect(result.output).toContain('broken failed');
    expect(result.output).toContain('the report endpoint answered 500');

    const lines = await ran(cwd);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('hourly');
    expect(lines[0]).toContain('cron');
  });

  test('a task declared in Manila time fires at 19:00 UTC, not at 03:00 UTC', async () => {
    const cwd = await copy();

    // 03:00 UTC is 11:00 in Manila, so this tick belongs to `nightly`, not to the Manila task.
    // (`broken` is due at every :00 too, which is why the exit code is not what is asserted
    // here — the log is.)
    await runCli(['schedule:work', '--once', ...AT('2026-11-01T03:00:00Z')], cwd);
    expect((await ran(cwd)).some((line) => line.startsWith('manila-report'))).toBe(false);

    await runCli(['schedule:work', '--once', ...AT('2026-11-01T19:00:00Z')], cwd);
    const lines = await ran(cwd);
    expect(lines.some((line) => line.startsWith('manila-report'))).toBe(true);
    // 03:00 in the task's own clock, and it is the *tick* that is recorded, not the start time.
    expect(lines.find((line) => line.startsWith('manila-report'))).toContain(
      String(Date.parse('2026-11-01T19:00:00Z')),
    );
  });

  test('a minute with nothing due exits 0 and says so', async () => {
    const cwd = await copy();

    const result = await runCli(['schedule:work', '--once', ...AT('2026-11-01T00:30:00Z')], cwd);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('nothing is due');
    expect(await ran(cwd)).toEqual([]);
  });

  test('--production refuses a per-process lock when a task relies on overlap prevention', async () => {
    const cwd = await copy(({ entry }) => ({
      // A project with no `lock` export gets `memoryLock()`, which cannot prevent overlap across
      // isolates — and a scheduler that *says* it prevents it is worse than one that says it
      // cannot.
      entry: entry.replace('export const lock = fileLock();', 'export const lock = fileLock;'),
    }));

    const result = await runCli(['schedule:work', '--once', '--production'], cwd);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('SCHED_LOCK_NOT_SHARED');
    expect(result.output).toContain('hourly');
  });

  test('--production with a shared lock is allowed and runs the tick', async () => {
    const cwd = await copy();

    const result = await runCli(
      ['schedule:work', '--once', '--production', ...AT('2026-11-01T07:00:00Z')],
      cwd,
    );

    expect(result.output).not.toContain('SCHED_LOCK_NOT_SHARED');
    expect(result.code).toBe(EXIT.failure); // `broken` is due at :00 too
  });
});

describe('the lock a project declares', () => {
  test('a database lock without the connection it names is a usage error', async () => {
    const cwd = await copy(({ config, entry }) => ({
      // The lock queries the same client the app runs on. Without one there is no honest way to
      // build it, so the command says which connection it looked for.
      entry: entry.replace('export const lock = fileLock();', 'export const lock = fileLock;'),
      config: config.replace(
        'export default {',
        "export default {\n  schedule: { lock: { driver: 'database', connection: 'primary' } },",
      ),
    }));

    const result = await runCli(['schedule:list'], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('connection "primary"');
    expect(result.output).toContain('does not export');
  });

  test('an unknown lock driver lists the ones that exist', async () => {
    const cwd = await copy(({ config, entry }) => ({
      entry: entry.replace('export const lock = fileLock();', 'export const lock = fileLock;'),
      config: config.replace(
        'export default {',
        "export default {\n  schedule: { lock: { driver: 'redis' } },",
      ),
    }));

    const result = await runCli(['schedule:list'], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('unknown schedule lock driver "redis"');
    expect(result.output).toContain('memory');
    expect(result.output).toContain('database');
  });
});

describe('schedule:table', () => {
  test('it prints the Postgres lock DDL the driver queries', async () => {
    const result = await runCli(['schedule:table'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('CREATE TABLE IF NOT EXISTS schedule_locks');
    expect(result.output).toContain('expires_at');
  });

  test('--engine d1 is the same table, integer time', async () => {
    const result = await runCli(['schedule:table', '--engine', 'd1', '--json'], FIXTURE);
    const document = JSON.parse(result.output) as { engine: string; statements: string[] };

    expect(document.engine).toBe('d1');
    expect(document.statements.join('\n')).toContain('INTEGER');
  });

  test('an engine the lock cannot use is refused, because MySQL has no conditional update', async () => {
    const result = await runCli(['schedule:table', '--engine', 'mysql'], FIXTURE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('postgres');
  });
});

describe('the schedule a deploy sees (`DPL`, § 4.6)', () => {
  test('the entry’s tasks become cron triggers, shifted to the platform’s UTC cron', async () => {
    const cwd = await copy(({ config }) => ({
      config: config.replace(
        'export default {',
        'export default {\n  deploy: { targets: { cloudflare: {} } },',
      ),
    }));

    const result = runCliSubprocess(['deploy:plan', '--json'], cwd);

    expect(result.code).toBe(EXIT.ok);
    const document = JSON.parse(result.output) as {
      units: { name: string; triggers: { kind: string; detail: string[] }[] }[];
    };

    const unit = document.units.find((candidate) => candidate.name === 'schedule');
    expect(unit?.triggers).toEqual([
      { kind: 'cron', detail: ['0 * * * *', '0 19 * * *', '0 3 * * *'] },
    ]);
  });
});
