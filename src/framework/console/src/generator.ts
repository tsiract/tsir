/**
 * The generator engine (CLI-009). Every `make:*` and `new` command writes through here, so the
 * rules are the same everywhere:
 *
 *   · **Refuse before touching anything.** Every target is checked first. If one exists and
 *     `--force` is not set, the command names that path and writes nothing — a half-scaffolded
 *     project is worse than no project.
 *   · **Dry run.** `--dry-run` returns the plan and writes nothing.
 *   · **Atomic per file.** Each file is written to a temporary sibling and renamed into place,
 *     so a reader never sees a truncated file. Directories are created first, so a path that
 *     cannot exist fails before any file is written.
 *
 * Across files the commit is not one transaction: if the process dies during the rename phase,
 * some files may be in place. The window is the rename loop, which is short and leaves no
 * temporary files behind on a handled failure.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { CliError, EXIT } from './output.ts';

export interface GeneratedFile {
  /** Absolute path. */
  readonly path: string;
  readonly contents: string;
}

export interface PlannedWrite {
  readonly path: string;
  readonly action: 'create' | 'overwrite';
}

export interface WriteOptions {
  readonly force: boolean;
  readonly dryRun: boolean;
}

/** A path for people: relative to the working directory when that is shorter. */
export function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith('..') || rel === '' ? path : rel;
}

/** Checks every target. Throws before anything is written. */
export function planWrites(files: readonly GeneratedFile[], options: WriteOptions): PlannedWrite[] {
  const plan: PlannedWrite[] = [];
  for (const file of files) {
    const exists = existsSync(file.path);
    if (exists && !options.force) {
      throw new CliError(
        `refusing to overwrite ${displayPath(file.path)}`,
        EXIT.failure,
        'pass --force if you really mean to replace it; nothing was written',
      );
    }
    plan.push({ path: file.path, action: exists ? 'overwrite' : 'create' });
  }
  return plan;
}

/** Plans, then (unless `dryRun`) writes. Returns what was or would be written. */
export async function commitWrites(
  files: readonly GeneratedFile[],
  options: WriteOptions,
): Promise<PlannedWrite[]> {
  const plan = planWrites(files, options);
  if (options.dryRun) return plan;

  // 1. Directories first: a path that cannot be created fails before any file is touched.
  for (const dir of new Set(files.map((file) => dirname(resolve(file.path))))) {
    await mkdir(dir, { recursive: true });
  }

  // 2. Each file to a temporary sibling. On failure, remove every temporary and rethrow.
  const staged: Array<{ temp: string; target: string }> = [];
  try {
    for (const file of files) {
      const temp = `${file.path}.${randomUUID()}.tmp`;
      await Bun.write(temp, file.contents);
      staged.push({ temp, target: file.path });
    }
  } catch (error: unknown) {
    await Promise.all(staged.map((entry) => rm(entry.temp, { force: true })));
    throw error;
  }

  // 3. Rename into place. A rename is atomic per file.
  for (const [index, entry] of staged.entries()) {
    try {
      await rename(entry.temp, entry.target);
    } catch (error: unknown) {
      await Promise.all(staged.slice(index).map((rest) => rm(rest.temp, { force: true })));
      throw error;
    }
  }
  return plan;
}
