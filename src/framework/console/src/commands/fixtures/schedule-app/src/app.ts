// The schedule fixture (`§ 4.6`): a task that succeeds, one that fails, and a file-backed lock
// so two CLI processes see one another. Every handler writes to `.ran.log`, because "the command
// exited 0" is not the same claim as "the handler ran".
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from '@tsir/config';
import { defineApp } from '@tsir/core';
import { defineTask } from '@tsir/schedule';

import { fileLock } from './file-lock.ts';

export const spec = defineConfig({});

export default defineApp({
  name: 'schedule-app',
  config: spec,
  modules: [],
});

/**
 * Where "the handler really ran" is recorded.
 *
 * `.ran.log` for the CLI tests, which read it after the process has exited. A *bundle* replaces
 * it: a Worker has no filesystem — `node:fs` there is a stub whose members are undefined — and a
 * fixture that ignored that would fail every task in the emitted Worker and pass in the CLI.
 */
export const sink: { record: (line: string) => void } = {
  record: (line) => {
    appendFileSync(join(process.cwd(), '.ran.log'), `${line}\n`, 'utf8');
  },
};

const record = (line: string): void => {
  sink.record(line);
};

/** Fires every hour at :00, and says so. */
export const Hourly = defineTask({
  name: 'hourly',
  cron: '@hourly',
  description: 'records that it ran',
  handle: (context) => {
    record(`${context.name} ${String(context.scheduledFor)} ${context.trigger}`);
  },
});

/** Fires at 03:00 UTC daily. Declared in UTC, so the deployer can emit it verbatim. */
export const Nightly = defineTask({
  name: 'nightly',
  cron: '0 3 * * *',
  timeoutMs: 2_000,
  handle: (context) => {
    record(`${context.name} ${String(context.scheduledFor)} ${context.trigger}`);
  },
});

/** Fails, so `schedule:work --once` has something to exit non-zero about. */
export const Broken = defineTask({
  name: 'broken',
  cron: '@hourly',
  handle: () => {
    throw new Error('the report endpoint answered 500');
  },
});

/** Declared in Manila time: `schedule:list` shows both clocks, `deploy` shows the shift. */
export const Manila = defineTask({
  name: 'manila-report',
  cron: '0 3 * * *',
  utcOffsetMinutes: 480,
  handle: (context) => {
    record(`${context.name} ${String(context.scheduledFor)} ${context.trigger}`);
  },
});

export const tasks = [Hourly, Nightly, Broken, Manila];

export const lock = fileLock();
