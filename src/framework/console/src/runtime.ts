/**
 * Runtime floor (FND-016).
 *
 * Tsir is developed against a specific Bun. Older runtimes are missing APIs the
 * framework takes for granted (`Bun.nanoseconds`, `Bun.color`, the current
 * `bun test` runner), and the failure mode is not a clean error — it is an
 * `undefined is not a function` inside a stack trace three layers deep, which
 * reads as a Tsir bug.
 *
 * So the CLI refuses to start, names the floor, and says what it has.
 *
 * The comparison is a pure function and tested; nothing here depends on the
 * clock, the network, or the filesystem.
 */

export const MINIMUM = { bun: '1.2.0', node: '21.0.0' } as const;

export interface RuntimeVersions {
  readonly bun?: string;
  readonly node?: string;
}

export interface VersionProblem {
  readonly runtime: 'bun' | 'node';
  readonly required: string;
  readonly actual: string;
}

function parse(version: string): readonly number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10)) // coercion-ok: Bun.version is framework-controlled
    .filter((part) => Number.isFinite(part));
}

/** `actual >= required`, comparing numeric segments. Unparsable input loses. */
export function atLeast(actual: string, required: string): boolean {
  const [a, b] = [parse(actual), parse(required)];
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** Every runtime below the floor, in the order they are checked. */
export function checkVersions(versions: RuntimeVersions): readonly VersionProblem[] {
  const problems: VersionProblem[] = [];
  if (versions.bun !== undefined && !atLeast(versions.bun, MINIMUM.bun)) {
    problems.push({ runtime: 'bun', required: MINIMUM.bun, actual: versions.bun });
  }
  if (versions.node !== undefined && !atLeast(versions.node, MINIMUM.node)) {
    problems.push({ runtime: 'node', required: MINIMUM.node, actual: versions.node });
  }
  return problems;
}

/** Throws a `TypeError` a human can act on, rather than failing an import later. */
export function assertRuntime(
  versions: RuntimeVersions = {
    ...(typeof Bun === 'undefined' ? {} : { bun: Bun.version }),
    ...(typeof process === 'undefined' ? {} : { node: process.versions.node }),
  },
): void {
  const problems = checkVersions(versions);
  if (problems.length === 0) return;

  const detail = problems
    .map((p) => `  ${p.runtime} ${p.actual} — Tsir needs >= ${p.required}`)
    .join('\n');

  throw new TypeError(
    `tsir: unsupported runtime\n${detail}\n\n` +
      'Upgrade Bun (`bun upgrade`) and re-run. The floor exists because the framework ' +
      'uses APIs older runtimes do not have; running anyway produces failures that look ' +
      'like framework bugs.\n',
  );
}
