/** The in-process runner the console command tests use. It must leave the process as it found it. */

import { afterEach, describe, expect, test } from 'bun:test';

import { runCliInProcess } from '../test-support/in-process.ts';

const KEY = 'TSIR_IN_PROCESS_PROBE';
const before = process.cwd();

afterEach(() => {
  delete process.env[KEY];
  process.chdir(before);
});

describe('runCliInProcess', () => {
  test('captures what the command writes, and restores the working directory', async () => {
    const run = await runCliInProcess(['help'], { cwd: '/' });
    expect(run.code).toBe(0);
    expect(run.output).toContain('tsir');
    expect(process.cwd()).toBe(before);
  });

  test('an environment override is set for the run and removed afterwards', async () => {
    process.env[KEY] = 'original';
    await runCliInProcess(['help'], { cwd: '/', env: { [KEY]: 'overridden' } });
    expect(process.env[KEY]).toBe('original');
  });

  test('an undefined override removes a variable for the run, then puts it back', async () => {
    process.env[KEY] = 'present';
    await runCliInProcess(['help'], { cwd: '/', env: { [KEY]: undefined } });
    expect(process.env[KEY]).toBe('present');
  });

  test('stdout and stderr are kept apart, and output is their concatenation', async () => {
    const run = await runCliInProcess(['no-such-command'], { cwd: '/' });
    expect(run.code).not.toBe(0);
    expect(run.output).toBe(`${run.stdout}${run.stderr}`);
    expect(run.stderr.length).toBeGreaterThan(0);
  });
});
