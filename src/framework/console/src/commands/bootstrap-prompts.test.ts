/**
 * `tsir bootstrap` prompts (`CFG-111`): a terminal is asked, a run without one aborts politely,
 * and a question that the flags already answered is never asked.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { bootstrap, type BootstrapIO } from './bootstrap.ts';

/** A terminal that answers from a queue and records every question it was asked. */
function fakeTerminal(answers: readonly string[], isTTY = true): BootstrapIO & { asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  return {
    isTTY,
    asked,
    ask: (question: string) => {
      asked.push(question);
      return Promise.resolve(queue.shift() ?? '');
    },
  };
}

const EXIT_USAGE = 2;

describe('bootstrap prompts (CFG-111)', () => {
  let root: string;
  const source = "export default {\n  app: { name: 'prompts', entry: './src/app.ts' },\n};\n";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tsir-prompts-'));
    await writeFile(join(root, 'tsir.js'), source);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('no terminal and no --yes or --plan: aborts with a usage exit, and writes nothing', async () => {
    const io = fakeTerminal([], false);
    expect(await bootstrap([], root, io)).toBe(EXIT_USAGE);
    expect(io.asked).toEqual([]);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(source);
  });

  test('a terminal is asked for the topology, then for approval, and applies on yes', async () => {
    const io = fakeTerminal(['single', 'y']);
    expect(await bootstrap([], root, io)).toBe(0);
    expect(io.asked).toHaveLength(2);
    expect(io.asked[0]).toContain('topology');
    expect(io.asked[1]).toContain('apply this change');
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toContain("topology: 'single'");
  });

  test('an empty topology answer keeps the default, and a no answer writes nothing', async () => {
    const io = fakeTerminal(['', 'n']);
    expect(await bootstrap([], root, io)).toBe(0);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(source);
  });

  test('a topology that is not separate or single is refused before the plan', async () => {
    const io = fakeTerminal(['many']);
    expect(await bootstrap([], root, io)).toBe(EXIT_USAGE);
    expect(io.asked).toHaveLength(1);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toBe(source);
  });

  test('a topology already given by a flag is not asked again', async () => {
    const io = fakeTerminal(['y']);
    expect(await bootstrap(['--topology', 'single'], root, io)).toBe(0);
    expect(io.asked).toHaveLength(1);
    expect(io.asked[0]).toContain('apply this change');
  });

  test('--plan never asks, even on a terminal', async () => {
    const io = fakeTerminal([]);
    expect(await bootstrap(['--plan'], root, io)).toBe(0);
    expect(io.asked).toEqual([]);
  });

  test('--yes never asks, even on a terminal', async () => {
    const io = fakeTerminal([]);
    expect(await bootstrap(['--yes'], root, io)).toBe(0);
    expect(io.asked).toEqual([]);
    expect(await readFile(join(root, 'tsir.js'), 'utf8')).toContain('managed:deploy:start');
  });
});
