/**
 * `tsir storage:*` (`STOR-*`).
 *
 * These run the CLI as a **subprocess**, one process per command, like `queue:*` and
 * `schedule:*`, because `storage:probe` is the thing a deploy pipeline runs: a probe that passed
 * in-process and failed on the machine would be a probe that tests the test.
 *
 * The fixture declares two disks — a real directory and a `memory` disk — so the assertions can
 * be about the difference between them: capability honesty (`publicUrls: false` is printed, not
 * discovered later) and a refusal that names both the disk and the driver.
 */

import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { type CliRun, runCliInProcess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'storage-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliInProcess(args, { cwd });
}

type Edit = (parts: { config: string; entry: string }) => { config?: string; entry?: string };

async function copy(edit?: Edit): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-storage-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });
  await rm(join(dir, 'app', '.storage'), { recursive: true, force: true });

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

describe('storage:disks', () => {
  test('it prints the driver and the capabilities, because "is this shareable?" is the question', async () => {
    const result = await runCli(['storage:disks'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('assets');
    expect(result.output).toContain('local');
    expect(result.output).toContain('durable');
    expect(result.output).toContain('no-signed-urls');
    expect(result.output).toContain('scratch');
    expect(result.output).toContain('ephemeral');
  });

  test('--json is the same facts, with the default marked', async () => {
    const result = await runCli(['storage:disks', '--json'], FIXTURE);
    const document = JSON.parse(result.output) as {
      default: string;
      source: string;
      disks: {
        name: string;
        driver: string;
        default: boolean;
        capabilities: { persistent: boolean };
      }[];
    };

    expect(document.default).toBe('assets');
    expect(document.source).toContain('app.ts');
    expect(document.disks.map((disk) => [disk.name, disk.driver, disk.default])).toEqual([
      ['assets', 'local', true],
      ['scratch', 'memory', false],
    ]);
  });

  test('with no `disks` export it falls back to `storage.disks` in tsir.js', async () => {
    const cwd = await copy(({ entry }) => ({
      // The entry stops exporting a registry, so the command has to build one from config — which
      // is what a project that has not wired storage yet looks like.
      entry: entry.replace(
        'export const disks = createDisks({',
        'const unusedDisks = createDisks({',
      ),
    }));

    const result = await runCli(['storage:disks', '--json'], cwd);
    const document = JSON.parse(result.output) as { source: string; disks: { driver: string }[] };

    expect(result.code).toBe(EXIT.ok);
    expect(document.source).toContain('tsir.js');
    expect(document.disks.map((disk) => disk.driver)).toEqual(['local', 'memory']);
  });
});

describe('storage:probe', () => {
  test('every disk round-trips a key, and the key is gone afterwards', async () => {
    const cwd = await copy();

    const result = await runCli(['storage:probe'], cwd);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('assets');
    expect(result.output).toContain('scratch');
    expect(result.output).toContain('2 disk(s) answered');

    // A probe that left its own object behind is a probe nobody runs twice.
    const root = join(cwd, '.storage');
    const leftovers = existsSync(root) ? await readdir(root) : [];
    expect(leftovers).toEqual([]);
  });

  test('--json reports bytes round-tripped, per disk', async () => {
    const result = await runCli(['storage:probe', '--json'], FIXTURE);
    const document = JSON.parse(result.output) as {
      ok: boolean;
      disks: { disk: string; driver: string; ok: boolean; bytes: number }[];
    };

    expect(document.ok).toBe(true);
    expect(document.disks.map((disk) => [disk.disk, disk.ok])).toEqual([
      ['assets', true],
      ['scratch', true],
    ]);
    expect(document.disks.every((disk) => disk.bytes > 0)).toBe(true);
  });

  test('--disk names one, and an undeclared one lists what exists', async () => {
    const cwd = await copy();

    const one = await runCli(['storage:probe', '--disk', 'scratch', '--json'], cwd);
    const document = JSON.parse(one.output) as { disks: { disk: string }[] };
    expect(document.disks.map((disk) => disk.disk)).toEqual(['scratch']);

    const missing = await runCli(['storage:probe', '--disk', 'cdn', '--json'], cwd);
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.output).toContain('STO_UNKNOWN_DISK');
    expect(missing.output).toContain('assets, scratch');
  });

  test('a disk that cannot be written is a failed probe, not a crash', async () => {
    const cwd = await copy(({ entry }) => ({
      // The entry exports the registry, so that is where the root lives. It is pointed at a
      // *file*, so the first `mkdir` fails the same way on every platform. A disk that cannot be
      // written must report a failed probe with a message and exit non-zero — that is what the
      // command exists for.
      entry: entry.replace("root: '.storage'", "root: './tsir.js'"),
    }));

    const result = await runCli(['storage:probe', '--disk', 'assets', '--json'], cwd);
    const document = JSON.parse(result.output) as {
      ok: boolean;
      disks: { ok: boolean; detail?: string }[];
    };

    expect(result.code).toBe(EXIT.failure);
    expect(document.ok).toBe(false);
    expect(document.disks[0]?.ok).toBe(false);
    expect(document.disks[0]?.detail).toBeString();
  });
});

describe('storage:url', () => {
  test('a disk that can neither publish nor sign refuses, naming disk and driver', async () => {
    const result = await runCli(['storage:url', 'uploads/report.pdf'], FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('does not support a signed URL');
    expect(result.output).toContain('disk "assets" (driver "local")');
  });

  test('a key is required, and the message shows the shape of one', async () => {
    const result = await runCli(['storage:url'], FIXTURE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('storage:url needs a key');
    expect(result.output).toContain('--disk assets');
  });

  test('--expires must be a positive whole number of seconds', async () => {
    const result = await runCli(['storage:url', 'a.png', '--expires', '0'], FIXTURE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('positive number of seconds');
  });

  test('an invalid key is refused before any driver sees it', async () => {
    const result = await runCli(['storage:url', '../secrets.env', '--disk', 'scratch'], FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('STO_INVALID_KEY');
    expect(result.output).toContain('escape the disk root');
  });
});
