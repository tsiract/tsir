/**
 * Task declarations (`§ 4.6`).
 *
 * The validation is cheap, and the mistakes it prevents are a task that never runs and a task
 * that runs twice: a bad cron is only visible at the first tick, and two tasks with one name
 * share a lock without either of them saying so.
 */

import { describe, expect, test } from 'bun:test';

import { createTaskRegistry, defineTask, TASK_DEFAULTS } from './task.ts';

describe('defineTask', () => {
  test('the defaults are the opinionated ones', () => {
    const task = defineTask({ name: 'nightly', cron: '@daily', handle: () => undefined });

    expect(task.cron).toBe('0 0 * * *');
    expect(task.overlap).toBe('skip');
    expect(task.timeoutMs).toBe(TASK_DEFAULTS.timeoutMs);
    expect(task.utcOffsetMinutes).toBe(0);
  });

  test('the cron is parsed at declaration, so a bad one fails where it is written', () => {
    expect(() => defineTask({ name: 'nightly', cron: '0 0 * *', handle: () => undefined })).toThrow(
      /task "nightly"/u,
    );
    expect(() =>
      defineTask({ name: 'nightly', cron: '0 0 1 * 1', handle: () => undefined }),
    ).toThrow(/both restricted/u);
  });

  test('a name that is not addressable is refused', () => {
    const handle = (): void => undefined;

    expect(() => defineTask({ name: 'Nightly', cron: '@daily', handle })).toThrow(/lowercase/u);
    expect(() => defineTask({ name: 'night ly', cron: '@daily', handle })).toThrow(/lowercase/u);
    expect(() => defineTask({ name: 'nightly.report', cron: '@daily', handle })).not.toThrow();
    expect(() => defineTask({ name: 'billing:close', cron: '@daily', handle })).not.toThrow();
  });

  test('an offset is a whole number of minutes, bounded by real offsets', () => {
    expect(() =>
      defineTask({ name: 'x', cron: '@daily', utcOffsetMinutes: 481.5, handle: () => undefined }),
    ).toThrow(/not a whole number of minutes/u);
    expect(() =>
      defineTask({ name: 'x', cron: '@daily', utcOffsetMinutes: 900, handle: () => undefined }),
    ).toThrow(/-840 and 840/u);
    expect(() =>
      defineTask({ name: 'x', cron: '@daily', utcOffsetMinutes: 480, handle: () => undefined }),
    ).not.toThrow();
  });

  test('a timeout must be a positive whole number of milliseconds', () => {
    expect(() =>
      defineTask({ name: 'x', cron: '@daily', timeoutMs: 0, handle: () => undefined }),
    ).toThrow(/timeoutMs 0/u);
  });

  test('the handler is called with the context it was given, never with a `this`', () => {
    // `handle` is wrapped rather than assigned by reference: a task whose handler used `this`
    // would work in the object literal it was written in and break the moment the scheduler
    // called it, which is the kind of bug that only appears in production.
    const received: string[] = [];
    const task = defineTask({
      name: 'x',
      cron: '@daily',
      handle: (context) => {
        received.push(context.name);
      },
    });

    void task.handle({
      name: 'x',
      scheduledFor: 0,
      startedAt: 0,
      trigger: 'cron',
      signal: new AbortController().signal,
      log: () => undefined,
    });

    expect(received).toEqual(['x']);
  });
});

describe('createTaskRegistry', () => {
  test('two tasks with one name are refused: the name is the lock key', () => {
    const first = defineTask({ name: 'nightly', cron: '@daily', handle: () => undefined });
    const second = defineTask({ name: 'nightly', cron: '@hourly', handle: () => undefined });

    expect(() => createTaskRegistry([first, second])).toThrow(/both named "nightly"/u);
    expect(() => createTaskRegistry([first, second])).toThrow(/share one lock/u);
  });

  test('the registry keeps declaration order and answers by name', () => {
    const nightly = defineTask({ name: 'nightly', cron: '@daily', handle: () => undefined });
    const hourly = defineTask({ name: 'hourly', cron: '@hourly', handle: () => undefined });
    const registry = createTaskRegistry([nightly, hourly]);

    expect(registry.names).toEqual(['nightly', 'hourly']);
    expect(registry.get('hourly')).toBe(hourly);
    expect(registry.get('missing')).toBeUndefined();
  });

  test('an empty registry is valid — a project may declare no tasks yet', () => {
    expect(createTaskRegistry([]).names).toEqual([]);
  });
});
