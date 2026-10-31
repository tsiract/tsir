/**
 * `DPL-010` — the Durable Object half that a `wrangler.toml` cannot do alone.
 *
 * The binding names a class; the runtime looks for that class among the *bundle's* exports.
 * So the test that matters is not "the toml has `class_name`" (that shipped long ago) but
 * "import the bundle and find `Room` in it".
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { unitEntrySource } from './deploy-build.ts';
import { type CliRun, runCliSubprocess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'durable-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliSubprocess(args, cwd);
}

async function outDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tsir-durable-'));
  cleanup.push(dir);
  return dir;
}

/** A copy of the fixture whose entry does not export `Room`. */
async function copyWithoutRoom(): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-durable-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  const entry = join(dir, 'app', 'src', 'app.ts');
  const text = await readFile(entry, 'utf8');
  expect(text).toContain('export class Room {');
  await writeFile(entry, text.replace('export class Room {', 'class Room {'), 'utf8');
  return join(dir, 'app');
}

describe('the generated entry', () => {
  test('it re-exports each class the unit binds', async () => {
    const source = unitEntrySource({
      target: 'cloudflare',
      unit: 'ws',
      triggers: ['fetch'],
      durables: ['Room', 'Lobby'],
      adapter: '/abs/cloudflare.ts',
      entry: '/abs/src/app.ts',
    });

    expect(source).toContain('export { Lobby } from "/abs/src/app.ts";');
    expect(source).toContain('export { Room } from "/abs/src/app.ts";');
    // Sorted, so two builds of the same unit are byte-identical.
    expect(source.indexOf('Lobby')).toBeLessThan(source.indexOf('Room'));
  });

  test('without a binding there is nothing extra to export', async () => {
    const source = unitEntrySource({
      target: 'cloudflare',
      unit: 'http',
      triggers: ['fetch'],
      adapter: '/abs/cloudflare.ts',
      entry: '/abs/src/app.ts',
    });

    expect(source).not.toContain('export {');
  });
});

describe('a real build', () => {
  test('the bundle exports the class and the fetch handler, and nothing else', async () => {
    const out = await outDir();
    const build = await runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);
    expect(build.code).toBe(EXIT.ok);

    const bundle = (await import(join(out, 'cloudflare', 'ws', 'index.js'))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(bundle).sort()).toEqual(['Room', 'fetch']);
    expect(typeof bundle['Room']).toBe('function');
  });

  test('the wrangler config and the bundle agree about the class name', async () => {
    const out = await outDir();
    await runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    const toml = await readFile(join(out, 'cloudflare', 'ws', 'wrangler.ws.toml'), 'utf8');
    expect(toml).toContain('[[durable_objects.bindings]]');
    expect(toml).toContain('class_name = "Room"');
    expect(toml).toContain('new_sqlite_classes = ["Room"]');

    const entry = await readFile(join(out, 'cloudflare', 'ws', 'index.js'), 'utf8');
    expect(entry).toContain('Room');
  });

  test('the gate accepts it: the class is not a secret and the config agrees', async () => {
    const out = await outDir();
    await runCli(['deploy:build', '--target', 'cloudflare', '--out', out], FIXTURE);

    const result = await runCli(['deploy:validate', '--out', out], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('no secret values in');
  });
});

describe('a binding the bundle cannot honour', () => {
  test('the build stops and names the class, the binding and the fix', async () => {
    const cwd = await copyWithoutRoom();
    const out = await outDir();

    const result = await runCli(['deploy:build', '--target', 'cloudflare', '--out', out], cwd);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('DPL_CLASS_MISSING');
    expect(result.output).toContain('class "Room"');
    expect(result.output).toContain('"ROOMS"');
  });
});
