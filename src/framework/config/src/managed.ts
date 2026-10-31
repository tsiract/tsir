/**
 * Managed regions in `tsir.js` (`CFG-120`).
 *
 * The project file is the one file a framework must not own. So automation is given a
 * **fence**: marked lines that `tsir bootstrap` may rewrite, and everything outside them is
 * someone else's code. That trade is what makes "automated configuration" safe — the tool
 * can maintain its own sections without becoming a generator that owns your file.
 *
 * The rules, and why each one is a refusal rather than a repair:
 *
 *   · **A malformed or unbalanced region is an error, not a guess.** If the fences do not
 *     pair up, every line between them is ambiguous — and "we think this is ours" is how a
 *     bootstrap deletes a `deploy` block someone hand-tuned.
 *   · **Nested regions are invalid.** Two owners of the same lines cannot both be right, and
 *     the failure would appear as whichever ran last winning.
 *   · **Duplicate ids are invalid** for the same reason.
 *   · **Writes are idempotent and formatting-preserving.** Replacing a region keeps the
 *     indentation of its opening fence, and a second identical run produces byte-identical
 *     output — otherwise `--plan` in CI can never be a check.
 *
 * This module is pure text in, text out. It knows nothing about deploy, targets or the
 * config schema; those live in the caller, which is what keeps it testable.
 */

import { configError } from './errors.ts';

/**
 * `// ── managed:deploy:start ─────────────────` — the documented form, and the plain
 * `// managed:deploy:start` that someone typing by hand will produce. Both are fences.
 */
const FENCE =
  /^(?<indent>[ \t]*)\/\/[ \t]*(?:─+[ \t]*)?managed:(?<id>[A-Za-z0-9_.:-]+?):(?<kind>start|end)\b/u;

/** One region, with the 0-based line indexes of its fences. */
export interface ManagedRegion {
  readonly id: string;
  /** Index of the `:start` line. */
  readonly start: number;
  /** Index of the `:end` line. */
  readonly end: number;
  /** Whitespace before `//` on the opening fence; body lines are written at this indent. */
  readonly indent: string;
}

function invalid(reason: string, detail: string): never {
  throw configError(
    'CFG_MANAGED_REGION_INVALID',
    `invalid managed region in tsir.js: ${reason}`,
    `${detail} — managed regions are delimited by \`// ── managed:<id>:start\` and \`// ── managed:<id>:end\`, and nothing else`,
  );
}

/**
 * Every region in a source, or a throw.
 *
 * Throws `CFG_MANAGED_REGION_INVALID` for an unpaired fence, a nested region or a duplicated
 * id: all three mean the file has two possible owners for the same lines.
 */
export function managedRegions(source: string): readonly ManagedRegion[] {
  const lines = source.split('\n');
  const regions: ManagedRegion[] = [];
  let open: { id: string; start: number; indent: string } | undefined;
  const seen = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const match = FENCE.exec(line);
    if (match === null) continue;
    const id = match.groups?.['id'] ?? '';
    const kind = match.groups?.['kind'];
    const indent = match.groups?.['indent'] ?? '';

    if (kind === 'start') {
      if (open !== undefined) {
        invalid(
          `managed:${id}:start is nested inside managed:${open.id} (line ${String(open.start + 1)})`,
          'nested regions have no defined owner; close one before opening the next',
        );
      }
      if (seen.has(id)) {
        invalid(
          `managed:${id} appears twice`,
          'two regions with the same id would be rewritten by whichever ran last',
        );
      }
      seen.add(id);
      open = { id, start: index, indent };
      continue;
    }

    if (open === undefined) {
      invalid(
        `line ${String(index + 1)} closes managed:${id} but nothing is open`,
        'remove the stray `:end` fence, or add the matching `:start`',
      );
    }
    if (open.id !== id) {
      invalid(
        `managed:${open.id} is closed by managed:${id}`,
        'a region must close with its own id',
      );
    }
    regions.push({ id, start: open.start, end: index, indent });
    open = undefined;
  }

  if (open !== undefined) {
    invalid(
      `managed:${open.id}:start at line ${String(open.start + 1)} is never closed`,
      'add the matching `:end` fence',
    );
  }

  return regions;
}

/** Whether a region exists — the question a caller asks before deciding to insert. */
export function hasManagedRegion(source: string, id: string): boolean {
  return managedRegions(source).some((region) => region.id === id);
}

/** The lines inside a region, fences excluded. Used to show what is already there. */
export function regionBody(source: string, id: string): string | undefined {
  const region = managedRegions(source).find((candidate) => candidate.id === id);
  if (region === undefined) return undefined;
  return source
    .split('\n')
    .slice(region.start + 1, region.end)
    .join('\n');
}

/** The fence line for a rendered region, padded the way `09-tsir-config.md` shows it. */
export function fence(id: string, kind: 'start' | 'end', indent = ''): string {
  const prefix = `${indent}// ── managed:${id}:${kind} `;
  const padding = Math.max(4, 58 - prefix.length);
  return `${prefix}${'─'.repeat(padding)}`;
}

/**
 * Render a region, body already indented relative to the fence.
 *
 * `body` is the *lines inside the fence*; the caller decides what they mean (for `deploy`,
 * one property of the default export).
 */
export function renderRegion(id: string, body: readonly string[], indent = '  '): string {
  const inner = body.map((line) => (line === '' ? '' : `${indent}${line}`));
  return [fence(id, 'start', indent), ...inner, fence(id, 'end', indent)].join('\n');
}

/**
 * Put `body` into the region `id`, creating it if it is absent.
 *
 * Where a new region goes: immediately after `export default {`, at that object's
 * indentation. That is the only place in the file that is unambiguously *config*, and a
 * bootstrap that guesses further than that is a bootstrap that edits someone's code.
 */
export function applyManagedRegion(source: string, id: string, body: readonly string[]): string {
  const lines = source.split('\n');
  const regions = managedRegions(source);
  const region = regions.find((candidate) => candidate.id === id);

  if (region !== undefined) {
    // Reuse the fences that are already there, byte for byte. Re-emitting them would give
    // the diff a line of noise on every run whose padding differs, and a plan nobody can
    // read is a plan nobody reviews.
    const inner = body.map((line) => (line === '' ? '' : `${region.indent}${line}`));
    return [...lines.slice(0, region.start + 1), ...inner, ...lines.slice(region.end)].join('\n');
  }

  const opens = lines.findIndex((line) => /^\s*export\s+default\s*\{\s*$/u.test(line));
  if (opens === -1) {
    invalid(
      `no \`export default {\` to attach managed:${id} to`,
      'either add the region fences by hand where the deploy block belongs, or write `export default { … }` as an object literal',
    );
  }

  // Append rather than prepend: `deploy` reads naturally after `app`, and matching the last
  // top-level `}`/`};` keeps the region inside the object. A file whose default export is
  // written some other way (an identifier, a function call) has no such line, and inserting
  // right after `export default {` is then the only unambiguous place.
  const closesFrom = lines.findLastIndex((line) => /^\}\s*;?\s*$/u.test(line));
  const at = closesFrom > opens ? closesFrom : opens + 1;

  const indent = `${/^(\s*)/u.exec(lines[opens] ?? '')?.[1] ?? ''}  `;
  const rendered = renderRegion(id, body, indent).split('\n');
  return [...lines.slice(0, at), ...rendered, ...lines.slice(at)].join('\n');
}

/** Remove a region entirely, fences included. Used when a plan decides it must go. */
export function removeManagedRegion(source: string, id: string): string {
  const lines = source.split('\n');
  const region = managedRegions(source).find((candidate) => candidate.id === id);
  if (region === undefined) return source;
  return [...lines.slice(0, region.start), ...lines.slice(region.end + 1)].join('\n');
}

export interface LineDiff {
  readonly removed: readonly string[];
  readonly added: readonly string[];
  /** First line index that differs; `-1` when the two texts are equal. */
  readonly at: number;
}

/**
 * A minimal line diff: common prefix and suffix stripped, the rest reported.
 *
 * Enough for its only job — showing a managed-region rewrite in `bootstrap --plan` — and
 * deliberately not a general diff: a real merge algorithm here would be a maintenance cost
 * with no caller.
 */
export function diffLines(before: string, after: string): LineDiff {
  const a = before.split('\n');
  const b = after.split('\n');
  if (before === after) return { removed: [], added: [], at: -1 };

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    removed: a.slice(prefix, a.length - suffix),
    added: b.slice(prefix, b.length - suffix),
    at: prefix,
  };
}

/** The diff as the two blocks a reader scans: `-` what goes, `+` what arrives. */
export function formatDiff(before: string, after: string): string {
  const diff = diffLines(before, after);
  if (diff.at === -1) return '  (no change)\n';
  return `${[...diff.removed.map((line) => `  - ${line}`), ...diff.added.map((line) => `  + ${line}`)].join('\n')}\n`;
}
