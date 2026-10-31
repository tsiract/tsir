/**
 * The scheduler (`§ 4.6`).
 *
 * What has to be true, and is therefore what is tested:
 *
 *   · **a tick owns exactly the tasks whose cron fires now** — computed from the parsed spec, in
 *     the task's own offset, and not from "everything, every minute";
 *   · **overlap is prevented, and refusing to overlap is not a failure** — `busy` is a distinct
 *     outcome, because "still running" and "ran and threw" are different pages;
 *   · **a failure is reported, never swallowed, and never stops the next task** — a cron has no
 *     retry, so the report is the only record;
 *   · **the lock is released on every path** — failure and timeout included, otherwise one bad
 *     tick silences the task until the TTL expires;
 *   · **a per-process lock is refused in production**, because a cron fires in every isolate.
 */

import { describe, expect, test } from 'bun:test';

import { memoryLock } from './lock.ts';
import { createScheduler } from './scheduler.ts';
import { defineTask, type TaskDefinition } from './task.ts';

const MINUTE = 60_000;
/** 2026-01-01T00:00:00Z — a Thursday, and a round minute. */
const MIDNIGHT = Date.UTC(2026, 0, 1);

function task(
  name: string,
  cron: string,
  handle: () => Promise<void> | void,
  extra: { readonly overlap?: 'skip' | 'allow'; readonly timeoutMs?: number } = {},
): TaskDefinition {
  return defineTask({ name, cron, handle, ...extra });
}

describe('due tasks', () => {
  test('only the tasks whose cron fires at that minute are due', () => {
    const nightly = task('nightly', '0 0 * * *', () => undefined);
    const hourly = task('hourly', '0 * * * *', () => undefined);
    const everyMinute = task('every-minute', '* * * * *', () => undefined);

    const scheduler = createScheduler({
      tasks: [nightly, hourly, everyMinute],
      lock: memoryLock(),
    });

    // Midnight: all three fire.
    expect(scheduler.due(MIDNIGHT).map((entry) => entry.name)).toEqual([
      'nightly',
      'hourly',
      'every-minute',
    ]);
    // 00:01: only the every-minute one.
    expect(scheduler.due(MIDNIGHT + MINUTE).map((entry) => entry.name)).toEqual(['every-minute']);
  });

  test('the offset decides the wall clock, not the host’s clock', () => {
    // 09:00 in UTC+8 is 01:00 UTC.
    const manila = defineTask({
      name: 'manila-report',
      cron: '0 9 * * *',
      utcOffsetMinutes: 480,
      handle: () => undefined,
    });
    const scheduler = createScheduler({ tasks: [manila], lock: memoryLock() });

    expect(scheduler.due(Date.UTC(2026, 0, 1, 1, 0))).toHaveLength(1);
    expect(scheduler.due(Date.UTC(2026, 0, 1, 9, 0))).toHaveLength(0);
  });
});

describe('running', () => {
  test('a run gets the tick it belongs to, and its outcome is reported', async () => {
    const seen: { scheduledFor: number; trigger: string; name: string }[] = [];
    const nightly = defineTask({
      name: 'nightly',
      cron: '0 0 * * *',
      handle: (context) => {
        seen.push({
          scheduledFor: context.scheduledFor,
          trigger: context.trigger,
          name: context.name,
        });
      },
    });

    const scheduler = createScheduler({
      tasks: [nightly],
      lock: memoryLock(),
      now: () => MIDNIGHT,
    });
    const outcomes = await scheduler.runDue(MIDNIGHT);

    expect(outcomes).toEqual([
      { task: 'nightly', status: 'ran', scheduledFor: MIDNIGHT, trigger: 'cron', durationMs: 0 },
    ]);
    // `scheduledFor` is the cron's time, not "now": a task that backfills needs to know which
    // tick it is filling in for.
    expect(seen).toEqual([{ scheduledFor: MIDNIGHT, trigger: 'cron', name: 'nightly' }]);
  });

  test('a failure is reported, and does not stop the next task in the same tick', async () => {
    const first = task('first', '* * * * *', () => {
      throw new Error('the report endpoint is down');
    });
    const second = task('second', '* * * * *', () => undefined);

    const errors: { readonly code: string; readonly task: string }[] = [];
    const scheduler = createScheduler({
      tasks: [first, second],
      lock: memoryLock(),
      now: () => MIDNIGHT,
      onError: (error, outcome) => {
        errors.push({ code: (error as { code: string }).code, task: outcome.task });
      },
    });

    const outcomes = await scheduler.runDue(MIDNIGHT);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'ran']);
    expect(outcomes[0]?.error).toContain('the report endpoint is down');
    // The observer gets a coded error, so "this task failed" and "the lock could not be taken"
    // are distinguishable without parsing a message.
    expect(errors).toEqual([{ code: 'SCHED_TASK_FAILED', task: 'first' }]);
  });

  test('a task that overruns its timeout is cancelled and reported as a timeout', async () => {
    // Ten milliseconds, and a handler that never resolves within them.
    const slow = task(
      'slow',
      '* * * * *',
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        }),
      { timeoutMs: 10 },
    );

    const scheduler = createScheduler({ tasks: [slow], lock: memoryLock(), now: () => MIDNIGHT });
    const [outcome] = await scheduler.runDue(MIDNIGHT);

    expect(outcome?.status).toBe('timeout');
    expect(outcome?.error).toContain('did not finish within 10 ms');
  });

  test('the lock is released after a failure, so the next tick is not blocked', async () => {
    let attempts = 0;
    const flaky = task('flaky', '* * * * *', () => {
      attempts += 1;
      throw new Error('first attempt fails');
    });

    const lock = memoryLock();
    const scheduler = createScheduler({ tasks: [flaky], lock, now: () => MIDNIGHT });

    await scheduler.runDue(MIDNIGHT);
    const second = await scheduler.runDue(MIDNIGHT + MINUTE);

    expect(attempts).toBe(2);
    expect(second[0]?.status).toBe('failed');
    // Nothing is left behind: a released lock is absent, not expired.
    expect(await lock.inspect('flaky', MIDNIGHT)).toBeUndefined();
  });
});

describe('overlap prevention', () => {
  test('a tick that arrives mid-run is `busy`, not a second run and not a failure', async () => {
    let release: (() => void) | undefined;
    let runs = 0;
    const slow = task('slow', '* * * * *', () => {
      runs += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const scheduler = createScheduler({ tasks: [slow], lock: memoryLock(), now: () => MIDNIGHT });

    // Start the first run and let it reach the handler, then tick again while it is in flight.
    const first = scheduler.runDue(MIDNIGHT);
    await Promise.resolve();
    const second = await scheduler.runDue(MIDNIGHT + MINUTE);

    expect(second).toEqual([
      {
        task: 'slow',
        status: 'busy',
        scheduledFor: MIDNIGHT + MINUTE,
        trigger: 'cron',
        durationMs: 0,
      },
    ]);
    expect(runs).toBe(1);

    release?.();
    expect((await first)[0]?.status).toBe('ran');
  });

  test('`overlap: allow` runs anyway, and holds no lock while it does', async () => {
    const runs: number[] = [];
    const warm = task(
      'warm',
      '* * * * *',
      () => {
        runs.push(1);
      },
      { overlap: 'allow' },
    );

    const lock = memoryLock();
    const scheduler = createScheduler({ tasks: [warm], lock, now: () => MIDNIGHT });

    await scheduler.runDue(MIDNIGHT);
    await scheduler.runDue(MIDNIGHT + MINUTE);

    expect(runs).toHaveLength(2);
    // No lock at all: taking and releasing one immediately would only hide that two copies can
    // run at once, which is what the declaration asks for.
    expect(await lock.inspect('warm', MIDNIGHT)).toBeUndefined();
  });

  test('a manual run is guarded too, and `force` is the way past a stuck lock', async () => {
    const runs: string[] = [];
    const nightly = task('nightly', '0 0 * * *', () => {
      runs.push('run');
    });

    const lock = memoryLock();
    const scheduler = createScheduler({ tasks: [nightly], lock, now: () => MIDNIGHT });

    // Pretend another process is mid-run.
    await lock.acquire({ name: 'nightly', owner: 'someone-else', ttlMs: 60_000, now: MIDNIGHT });

    expect((await scheduler.run('nightly')).status).toBe('busy');
    expect(runs).toEqual([]);

    // `--force` does not take the lock at all, and does not release someone else's.
    expect((await scheduler.run('nightly', { force: true })).status).toBe('ran');
    expect(runs).toEqual(['run']);
    expect((await lock.inspect('nightly', MIDNIGHT))?.owner).toBe('someone-else');
  });

  test('an unknown task is refused, listing the ones that exist', async () => {
    const scheduler = createScheduler({
      tasks: [task('nightly', '0 0 * * *', () => undefined)],
      lock: memoryLock(),
    });

    const error = await scheduler
      .run('nightlly')
      .then(() => undefined)
      .catch((caught: unknown) => caught as { code?: string; message: string });

    expect(error?.code).toBe('SCHED_UNKNOWN_TASK');
    expect(error?.message).toContain('declared: nightly');
  });
});

describe('production', () => {
  test('a per-process lock is refused when a task relies on it', () => {
    const nightly = task('nightly', '0 0 * * *', () => undefined);

    expect(() =>
      createScheduler({ tasks: [nightly], lock: memoryLock(), production: true }),
    ).toThrow(/per-process.*nightly/u);

    const codeOf = (): string | undefined => {
      try {
        createScheduler({ tasks: [nightly], lock: memoryLock(), production: true });
      } catch (caught: unknown) {
        return (caught as { code?: string }).code;
      }
      return undefined;
    };
    expect(codeOf()).toBe('SCHED_LOCK_NOT_SHARED');
  });

  test('an `overlap: allow` task does not need a shared lock, because it needs no lock', () => {
    const warm = task('warm', '* * * * *', () => undefined, { overlap: 'allow' });

    expect(() =>
      createScheduler({ tasks: [warm], lock: memoryLock(), production: true }),
    ).not.toThrow();
  });

  test('development is unaffected — this is a production guard, not a ban', () => {
    expect(() =>
      createScheduler({
        tasks: [task('nightly', '0 0 * * *', () => undefined)],
        lock: memoryLock(),
        production: false,
      }),
    ).not.toThrow();
  });
});

describe('describe', () => {
  test('every task reports its cron, next run and lock state', async () => {
    const lock = memoryLock();
    const scheduler = createScheduler({
      tasks: [
        task('nightly', '0 3 * * *', () => undefined, {}),
        task('warm', '*/5 * * * *', () => undefined, { overlap: 'allow' }),
      ],
      lock,
      now: () => MIDNIGHT,
    });
    await lock.acquire({ name: 'nightly', owner: 'run-1', ttlMs: 60_000, now: MIDNIGHT });

    const [nightly, warm] = await scheduler.describe(MIDNIGHT);

    expect(nightly).toMatchObject({
      name: 'nightly',
      cron: '0 3 * * *',
      overlap: 'skip',
      lockedBy: 'run-1',
      lockedUntil: MIDNIGHT + 60_000,
    });
    expect(new Date(nightly?.nextRunAt ?? 0).toISOString()).toBe('2026-01-01T03:00:00.000Z');
    // An `overlap: allow` task never holds a lock, so it has nothing to report.
    expect(warm?.lockedBy).toBeUndefined();
    expect(new Date(warm?.nextRunAt ?? 0).toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });
});
