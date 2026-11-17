/**
 * `tsir storage:*` (`STOR-*`).
 *
 * Three commands, each answering one question a person asks with a terminal open:
 *
 *   · `storage:disks` — "what is declared, and what can each disk actually do?" Capabilities are
 *     printed as facts, because "are these URLs shareable?" is the question behind every leak.
 *   · `storage:probe` — "does this disk work here?" A put, a head, a get and a delete, per disk,
 *     non-zero exit if any failed. This is the health check a deploy pipeline runs, not a smoke
 *     test someone remembers.
 *   · `storage:url <key>` — "give me a link." A public URL where the disk has one, a signed URL
 *     where it can sign, and a refusal that names the disk and the driver where it can do neither.
 *
 * Where the registry comes from: the app entry's `disks` export when there is one (the same
 * contract as `caches`/`queues`), otherwise `storage.disks` in `tsir.js` built with
 * `disksFromConfig` — which is enough for a fresh project to see the commands work.
 */

import { pathToFileURL } from 'node:url';

import { disksFromConfig, utf8, type Disk, type Disks } from '@tsir/storage';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, style, UsageError, jsonDocument, symbols } from '../output.ts';
import { loadProject, type LoadedProject } from '../project.ts';

/** Duck-types the exported registry, so a wrong export is a message and not a crash. */
function isDisks(value: unknown): value is Disks {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['disk'] === 'function' &&
    typeof candidate['all'] === 'function' &&
    typeof candidate['default'] === 'string' &&
    Array.isArray(candidate['names'])
  );
}

async function resolveDisks(project: LoadedProject): Promise<{ disks: Disks; source: string }> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly disks?: unknown;
  };
  if (isDisks(module.disks)) {
    return { disks: module.disks, source: `${project.entryPath} (disks)` };
  }

  const disks = disksFromConfig({
    ...(project.config.storage === undefined ? {} : { storage: project.config.storage }),
    env: process.env,
    // The environment is `APP_ENV`, checked by `bootProject`; a probe must work in every env.
  });
  return { disks, source: `${project.configPath} (storage.disks)` };
}

/** Which disk a command means: `--disk`, else the default. */
function diskFlag(args: ReturnType<typeof parseArgs>, disks: Disks): Disk {
  const name = stringFlag(args, '--disk');
  return disks.disk(name);
}

const describeCapabilities = (disk: Disk): string =>
  [
    disk.capabilities.persistent ? 'durable' : 'ephemeral',
    disk.capabilities.sharedAcrossInstances ? 'shared' : 'per-process',
    disk.capabilities.publicUrls ? 'public-urls' : 'no-public-urls',
    disk.capabilities.signedUrls ? 'signed-urls' : 'no-signed-urls',
    disk.capabilities.filesystem ? 'filesystem' : 'no-filesystem',
  ].join(' · ');

// ─── storage:disks ──────────────────────────────────────────────────────────

export async function storageDisksCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'machine-readable list' },
  });
  const json = boolFlag(args, '--json');

  try {
    const { disks, source } = await resolveDisks(await loadProject(process.cwd()));
    const all = disks.all();

    if (json) {
      info(
        jsonDocument({
          source,
          default: disks.default,
          disks: all.map((disk) => ({
            name: disk.name,
            driver: disk.driver,
            default: disk.name === disks.default,
            capabilities: disk.capabilities,
          })),
        }),
      );
      return EXIT.ok;
    }

    info(`  ${style.bold('storage:disks')} ${style.dim(`· ${source}`)}`);
    info('');
    const width = Math.max(...all.map((disk) => disk.name.length), 4);
    for (const disk of all) {
      const mark = disk.name === disks.default ? style.bold(disk.name) : disk.name;
      info(
        `  ${mark.padEnd(width)}  ${style.dim(disk.driver.padEnd(7))}  ${describeCapabilities(disk)}`,
      );
    }
    info('');
    info(
      `  ${style.dim('next: `tsir storage:probe` proves one works · `tsir storage:url <key>` mints a link')}`,
    );
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── storage:probe ──────────────────────────────────────────────────────────

interface ProbeResult {
  readonly disk: string;
  readonly driver: string;
  readonly ok: boolean;
  readonly bytes: number;
  readonly detail?: string | undefined;
}

/**
 * A put, a head, a get and a delete — the four calls every upload path makes.
 *
 * The key is random, so two probes running at once cannot collide, and it is deleted on every
 * path including failure: a probe that leaves rubbish in a bucket is a probe nobody runs twice.
 */
async function probe(disk: Disk): Promise<ProbeResult> {
  // At the disk's root, not in a folder: deleting the object would leave the folder behind, and
  // a directory named `.tsir-probe` in someone's bucket is exactly the kind of thing a probe
  // should not create.
  const key = `.tsir-probe-${crypto.randomUUID()}.txt`;
  const body = utf8(`tsir storage probe ${disk.name}`);

  try {
    const stored = await disk.put(key, body, { contentType: 'text/plain' });
    if (stored.size !== body.length) {
      return {
        disk: disk.name,
        driver: disk.driver,
        ok: false,
        bytes: 0,
        detail: `put reported ${String(stored.size)} bytes, wrote ${String(body.length)}`,
      };
    }

    const head = await disk.head(key);
    if (head === undefined) {
      return {
        disk: disk.name,
        driver: disk.driver,
        ok: false,
        bytes: 0,
        detail: 'the object is missing immediately after a successful put',
      };
    }

    const read = await disk.get(key);
    if (read === undefined || read.body.length !== body.length) {
      return {
        disk: disk.name,
        driver: disk.driver,
        ok: false,
        bytes: 0,
        detail: 'get returned a different length than put wrote',
      };
    }

    return { disk: disk.name, driver: disk.driver, ok: true, bytes: read.body.length };
  } catch (error: unknown) {
    return {
      disk: disk.name,
      driver: disk.driver,
      ok: false,
      bytes: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await disk.delete(key).catch(() => undefined);
  }
}

export async function storageProbeCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--disk': { type: 'string', description: 'probe one disk (default: all of them)' },
    '--json': { type: 'boolean', description: 'machine-readable results' },
  });
  const json = boolFlag(args, '--json');

  try {
    const { disks, source } = await resolveDisks(await loadProject(process.cwd()));
    const targets =
      stringFlag(args, '--disk') === undefined ? disks.all() : [diskFlag(args, disks)];

    const results: ProbeResult[] = [];
    for (const disk of targets) results.push(await probe(disk));
    const failed = results.filter((result) => !result.ok);

    if (json) {
      info(jsonDocument({ ok: failed.length === 0, source, disks: results }));
      return failed.length === 0 ? EXIT.ok : EXIT.failure;
    }

    info(`  ${style.bold('storage:probe')} ${style.dim(`· ${source}`)}`);
    info('');
    for (const result of results) {
      const mark = result.ok ? style.green(symbols.check) : style.red(symbols.cross);
      const detail =
        result.detail === undefined
          ? style.dim(`${result.driver} · ${String(result.bytes)} bytes round-tripped`)
          : ` ${style.dim(result.detail)}`;
      info(`  ${mark} ${result.disk.padEnd(8)} ${detail}`);
    }
    info('');
    info(
      failed.length === 0
        ? `  ${style.dim(`${String(results.length)} disk(s) answered`)}`
        : `  ${style.red(`${String(failed.length)} of ${String(results.length)} disk(s) failed`)}`,
    );
    return failed.length === 0 ? EXIT.ok : EXIT.failure;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── storage:url ────────────────────────────────────────────────────────────

export async function storageUrlCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--disk': { type: 'string', description: 'which disk (default: the declared default)' },
    '--expires': {
      type: 'string',
      description: 'signed URL lifetime in seconds (default 3600; ignored for a public URL)',
    },
    '--json': { type: 'boolean', description: 'machine-readable result' },
  });
  const json = boolFlag(args, '--json');
  const key = args.positionals[0];

  if (key === undefined) {
    return fail(
      new UsageError(
        'storage:url needs a key',
        'pass the object key: `tsir storage:url uploads/report.pdf --disk assets`',
      ),
      json,
    );
  }

  const expires = stringFlag(args, '--expires');
  // coercion-ok: a CLI flag is the one place a string is *meant* to be a number. The digits are
  // checked first, so `Number` here can only ever see `"0"`…`"99999"` — never `""` or `"12abc"`.
  if (expires !== undefined && (!/^\d+$/u.test(expires) || Number(expires) < 1)) {
    return fail(
      new UsageError(`--expires must be a positive number of seconds (got "${expires}")`),
      json,
    );
  }

  try {
    const { disks } = await resolveDisks(await loadProject(process.cwd()));
    const disk = diskFlag(args, disks);

    // A public disk answers `url()`; the rest have to sign, and a disk that can do neither says
    // why (`STO_UNSUPPORTED_OPERATION`, with the disk and the driver).
    const url =
      disk.capabilities.publicUrls && expires === undefined
        ? disk.url(key)
        : await disk.temporaryUrl(key, Number(expires ?? '3600') * 1000);

    if (json) {
      info(
        jsonDocument({
          disk: disk.name,
          driver: disk.driver,
          key,
          url,
          kind: disk.capabilities.publicUrls && expires === undefined ? 'public' : 'signed',
        }),
      );
      return EXIT.ok;
    }

    info(url);
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}
