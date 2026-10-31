/** Handle-leak detection (TST-007): a timer that outlives its app fails the dispose. */

import { describe, expect, test } from 'bun:test';
import { defineApp, defineModule } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';

import { beginHandleTracking } from './handles.ts';
import { createTestApp } from './index.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
});

describe('beginHandleTracking', () => {
  test('a timer that is cleared before the end is not a leak', () => {
    const end = beginHandleTracking();
    const timer = setInterval(() => undefined, 1_000);
    clearInterval(timer);
    expect(end()).toEqual([]);
  });

  test('a timeout that fires before the end is not a leak', async () => {
    const end = beginHandleTracking();
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(end()).toEqual([]);
  });

  test('a referenced interval still running at the end is reported, with its delay', () => {
    const end = beginHandleTracking();
    const timer = setInterval(() => undefined, 1_234);
    try {
      expect(end()).toEqual([{ kind: 'interval', delayMs: 1_234 }]);
    } finally {
      clearInterval(timer);
    }
  });

  test('an unreferenced timer does not keep the process alive, so it is not reported', () => {
    const end = beginHandleTracking();
    const timer = setTimeout(() => undefined, 60_000);
    timer.unref();
    try {
      expect(end()).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });

  test('ending twice reports nothing the second time', () => {
    const end = beginHandleTracking();
    end();
    expect(end()).toEqual([]);
  });

  test('the global timer functions are restored when the last caller ends', () => {
    const before = setTimeout;
    const end = beginHandleTracking();
    end();
    expect(setTimeout).toBe(before);
  });
});

describe('createTestApp dispose (TST-007)', () => {
  test('an app that leaves an interval running fails dispose with TEST_HANDLE_LEAK', async () => {
    let stray: ReturnType<typeof setInterval> | undefined;
    const leaky = defineModule({
      name: 'leaky-timer',
      onReady: () => {
        stray = setInterval(() => undefined, 5_000);
      },
    });
    const app = defineApp({
      name: 'leaky-timer-app',
      config: spec,
      modules: [leaky],
    });
    const harness = await createTestApp(app, { env: { APP_ENV: 'test' } });
    try {
      let code: string | undefined;
      try {
        await harness.dispose();
      } catch (error: unknown) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe('TEST_HANDLE_LEAK');
    } finally {
      if (stray !== undefined) clearInterval(stray);
    }
  });
});
