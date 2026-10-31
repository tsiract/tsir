/**
 * The flake quarantine (TST-018).
 *
 * A flaky test may be quarantined, but never for long: each entry has an owner and the date it
 * was quarantined, and it must be fixed or removed within `MAX_DAYS`. An overdue entry fails the
 * check, so a quarantine cannot quietly become the permanent state of a test.
 *
 *   bun src/tools/flakes.ts [--today YYYY-MM-DD]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MAX_DAYS = 7;
const DAY_MS = 86_400_000;
const REGISTRY = resolve(import.meta.dirname, 'flakes.json');

export interface FlakeEntry {
  readonly test: string;
  readonly owner: string;
  /** ISO date, `YYYY-MM-DD`, when the test was quarantined. */
  readonly since: string;
  readonly reason: string;
}

export interface FlakeReport {
  readonly problems: readonly string[];
}

/** Days between two ISO dates, counting whole days. */
export function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** Validates the registry shape. A malformed entry is a problem, not a silent skip. */
export function validateRegistry(raw: unknown): {
  readonly entries: readonly FlakeEntry[];
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const list = (raw as { quarantined?: unknown } | null)?.quarantined;
  if (!Array.isArray(list))
    return { entries: [], problems: ['flakes.json needs a "quarantined" array'] };

  const entries: FlakeEntry[] = [];
  list.forEach((item: unknown, index) => {
    const entry = item as Partial<FlakeEntry> | null;
    const label = `quarantined[${String(index)}]`;
    for (const field of ['test', 'owner', 'since', 'reason'] as const) {
      if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') {
        problems.push(`${label} needs a non-empty "${field}"`);
      }
    }
    if (typeof entry?.since === 'string' && !Number.isFinite(Date.parse(entry.since))) {
      problems.push(`${label} "since" is not a date: "${entry.since}"`);
    }
    const complete = (['test', 'owner', 'since', 'reason'] as const).every((field) => {
      const value = entry?.[field];
      return typeof value === 'string' && value.trim() !== '';
    });
    if (complete && entry !== null && Number.isFinite(Date.parse(entry.since ?? ''))) {
      entries.push({
        test: entry.test ?? '',
        owner: entry.owner ?? '',
        since: entry.since ?? '',
        reason: entry.reason ?? '',
      });
    }
  });
  return { entries, problems };
}

/** The problems with the registry on `today`: malformed entries, and entries past `MAX_DAYS`. */
export function checkFlakes(raw: unknown, today: string): FlakeReport {
  const { entries, problems: found } = validateRegistry(raw);
  const problems = [...found];
  for (const entry of entries) {
    const age = daysBetween(entry.since, today);
    if (age > MAX_DAYS) {
      problems.push(
        `"${entry.test}" has been quarantined for ${String(age)} days (owner ${entry.owner}); ` +
          `the limit is ${String(MAX_DAYS)}. Fix it or remove it from src/tools/flakes.json.`,
      );
    }
  }
  return { problems };
}

function main(): number {
  const flag = process.argv.indexOf('--today');
  const today =
    flag === -1 ? new Date().toISOString().slice(0, 10) : (process.argv[flag + 1] ?? '');
  const raw: unknown = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const { problems } = checkFlakes(raw, today);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
    return 1;
  }
  const count = validateRegistry(raw).entries.length;
  process.stdout.write(
    `✓ flake quarantine clean (${String(count)} quarantined, none past ${String(MAX_DAYS)} days)\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(main());
