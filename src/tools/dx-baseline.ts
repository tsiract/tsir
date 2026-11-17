/**
 * The boilerplate a data-layer call site pays, counted rather than described (`DX-000`).
 *
 * ADR-0032 says every capability resolves from `tsir.js` and a call site should not have to name
 * the default connection. Today it does: a controller injects `drizzleToken`, declares the field as
 * `DrizzleDb`, writes `this.drizzle.select().from(users)`, and repeats `eq(table.id, id)` for the
 * four-hundredth time. That cost is invisible in a diff and invisible in a review, which is why the
 * first task in the DX file is a *measurement*: every later task is judged by whether it moves one
 * of these numbers.
 *
 * Four counts, per application, from the source:
 *
 *   · **`drizzle` constructor parameters** — how many constructors ask for the database directly;
 *   · **`drizzleToken` provider entries** — how many DI lists have to name it;
 *   · **`as` casts on a database value** — how often the type has to be re-asserted;
 *   · **query call sites** — how many places write query code, and against how many tables.
 *
 * The number is committed (`src/docs/dx-baseline.json`) and `make check` fails when it *rises*. It
 * is allowed to fall without a `--write`: the point is a ratchet, not a snapshot, and forcing a
 * write on every improvement would make the file churn instead of measure.
 *
 *   bun src/tools/dx-baseline.ts            # compare against the committed baseline
 *   bun src/tools/dx-baseline.ts --write    # accept the current numbers (after a task lands)
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const BASELINE = resolve(ROOT, 'src/docs/dx-baseline.json');

/** The applications a caller writes. `src/examples` counts: an example is documentation. */
const APPLICATIONS = ['src/apps', 'src/examples'];

export interface AppCount {
  /** Constructor parameters typed as the Drizzle instance. */
  readonly drizzleParams: number;
  /** `drizzleToken`/`dbToken` entries in a provider list. */
  readonly tokenEntries: number;
  /** `as` casts whose target is a database type — the type had to be re-asserted. */
  readonly casts: number;
  /** Lines that start a query on the injected instance. */
  readonly querySites: number;
  /** Distinct table identifiers those call sites read from. */
  readonly tables: number;
  /** Source files that mention Drizzle at all. */
  readonly files: number;
}

export interface Baseline {
  readonly applications: Readonly<Record<string, AppCount>>;
  readonly totals: AppCount;
}

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.build') continue;
      found.push(...sources(path));
    } else if (/\.(?:ts|svelte)$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
}

const ZERO: AppCount = {
  drizzleParams: 0,
  tokenEntries: 0,
  casts: 0,
  querySites: 0,
  tables: 0,
  files: 0,
};

/** Counts for one file. Empty counts mean the file is not a data-layer call site. */
function countFile(file: string): AppCount {
  return countSource(readFileSync(file, 'utf8'));
}

/** Counts for one source text — the rules, without the filesystem, so they can be tested. */
export function countSource(source: string): AppCount {
  // A file that only *says* Drizzle (a package blurb, a template) has no call site in it; the
  // number is about code that queries, and the per-line rules below decide that, not the mention.
  if (!/drizzle/iu.test(source)) return ZERO;
  let drizzleParams = 0;
  let tokenEntries = 0;
  let casts = 0;
  let querySites = 0;
  const tables = new Set<string>();

  for (const line of source.split('\n')) {
    // The import is where the name comes from, not a place a provider list names it.
    const isImport = /^\s*import\b/u.test(line);
    // A constructor parameter that asks for the raw instance: `private readonly drizzle: DrizzleDb`.
    //
    // The modifier is required, and that is the whole rule: TypeScript only allows `private readonly`
    // in a *parameter property*, so the modifier is what distinguishes an injected dependency from a
    // property in an options object. Without it, `createQueryMonitor({ drizzle, engine })` — a
    // factory call that hands over an instance it already has — counted as a new injection site and
    // this gate failed on the change that introduced it. A rule that counts calls as costs measures
    // the wrong thing, and a gate that fires on correct work gets switched off.
    if (
      /\b(?:private|protected|public)\s+(?:readonly\s+)?\w*drizzle\w*\s*:\s*(?:typeof\s+)?drizzle/iu.test(
        line,
      )
    ) {
      drizzleParams += 1;
    }
    // A provider list naming the token: `[drizzleToken, authToken, …]`. Counted per occurrence,
    // because a list that asks for both `dbToken` and `drizzleToken` asks twice.
    if (!isImport) tokenEntries += line.match(/\b(?:drizzleToken|dbToken)\b/gu)?.length ?? 0;
    // `as DrizzleDb`, `as typeof drizzle` — the type asserted back rather than inferred.
    if (/\bas\s+(?:unknown\s+as\s+)?(?:Drizzle\w*|typeof\s+drizzle)/u.test(line)) casts += 1;
    // A query call site: `this.drizzle.select(`, `db.insert(`, `drizzle.execute(`.
    if (
      /\b(?:this\.)?(?:drizzle|\w*[dD]b)\s*\.\s*(?:select|insert|update|delete|query|execute)\s*\(/u.test(
        line,
      )
    ) {
      querySites += 1;
    }
    // The table a query reads: `from(users)`, and `from('users')`.
    for (const match of line.matchAll(/\bfrom\(\s*([A-Za-z_]\w*)\s*\)/gu)) {
      if (match[1] !== undefined) tables.add(match[1]);
    }
    for (const match of line.matchAll(/\bfrom\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*\)/gu)) {
      if (match[1] !== undefined) tables.add(match[1]);
    }
  }

  const touch = drizzleParams + tokenEntries + casts + querySites;
  if (touch === 0) return ZERO;
  return { drizzleParams, tokenEntries, casts, querySites, tables: tables.size, files: 1 };
}

/** Counts for one application directory — the sum of its files. */
export function countApplication(dir: string): AppCount {
  let sum = ZERO;
  for (const file of sources(dir)) {
    const count = countFile(file);
    sum = {
      drizzleParams: sum.drizzleParams + count.drizzleParams,
      tokenEntries: sum.tokenEntries + count.tokenEntries,
      casts: sum.casts + count.casts,
      querySites: sum.querySites + count.querySites,
      tables: sum.tables + count.tables,
      files: sum.files + count.files,
    };
  }
  return sum;
}

/**
 * An application is a directory with a `tsir.js` — that file is what makes it one. Walking for it
 * rather than listing one level means `src/apps/examples/http/` counts as an application and
 * `src/apps/examples/` does not, which is the difference between a measurement and a directory
 * listing.
 */
export function applicationsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (path: string, depth: number): void => {
    if (existsSync(join(path, 'tsir.js'))) {
      found.push(path);
      return;
    }
    if (depth === 0) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      walk(join(path, entry.name), depth - 1);
    }
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), 2);
  }
  return found.sort();
}

export function currentBaseline(root: string = ROOT): Baseline {
  const applications: Record<string, AppCount> = {};
  for (const base of APPLICATIONS) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const app of applicationsUnder(dir)) {
      applications[relative(root, app)] = countApplication(app);
    }
  }
  const totals = Object.values(applications).reduce<AppCount>(
    (sum, count) => ({
      drizzleParams: sum.drizzleParams + count.drizzleParams,
      tokenEntries: sum.tokenEntries + count.tokenEntries,
      casts: sum.casts + count.casts,
      querySites: sum.querySites + count.querySites,
      tables: sum.tables + count.tables,
      files: sum.files + count.files,
    }),
    ZERO,
  );
  return { applications, totals };
}

const LABELS: Readonly<Record<keyof AppCount, string>> = {
  drizzleParams: 'drizzle constructor parameters',
  tokenEntries: 'drizzle/db token provider entries',
  casts: 'database `as` casts',
  querySites: 'query call sites',
  tables: 'distinct tables queried',
  files: 'files touching Drizzle',
};

/**
 * Numbers that went up, per application and in total.
 *
 * A fall is not a problem and is not silent either: it is printed, because a drop is the evidence a
 * `DX-*` task worked and the writer should then re-record the baseline so the next task is measured
 * from the new floor.
 */
export function regressions(
  before: Baseline,
  after: Baseline,
): readonly {
  readonly scope: string;
  readonly field: keyof AppCount;
  readonly was: number;
  readonly now: number;
}[] {
  const found: { scope: string; field: keyof AppCount; was: number; now: number }[] = [];
  for (const scope of new Set([
    ...Object.keys(before.applications),
    ...Object.keys(after.applications),
  ])) {
    const was = before.applications[scope] ?? ZERO;
    const now = after.applications[scope] ?? ZERO;
    for (const field of Object.keys(LABELS) as (keyof AppCount)[]) {
      if (now[field] > was[field]) found.push({ scope, field, was: was[field], now: now[field] });
    }
  }
  for (const field of Object.keys(LABELS) as (keyof AppCount)[]) {
    if (after.totals[field] > before.totals[field]) {
      found.push({
        scope: 'total',
        field,
        was: before.totals[field],
        now: after.totals[field],
      });
    }
  }
  return found;
}

function print(baseline: Baseline): void {
  for (const [scope, count] of Object.entries(baseline.applications)) {
    process.stdout.write(`  ${scope}\n`);
    for (const [field, label] of Object.entries(LABELS)) {
      const value = count[field as keyof AppCount];
      if (value > 0) process.stdout.write(`    ${String(value).padStart(4)}  ${label}\n`);
    }
  }
  process.stdout.write('  total\n');
  for (const [field, label] of Object.entries(LABELS)) {
    process.stdout.write(
      `    ${String(baseline.totals[field as keyof AppCount]).padStart(4)}  ${label}\n`,
    );
  }
}

if (import.meta.main) {
  const after = currentBaseline();

  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE, `${JSON.stringify(after, null, 2)}\n`);
    process.stdout.write('✓ src/docs/dx-baseline.json written\n\n');
    print(after);
    process.exit(0);
  }

  if (!existsSync(BASELINE)) {
    process.stderr.write(
      '✗ src/docs/dx-baseline.json is missing — run `bun src/tools/dx-baseline.ts --write`\n',
    );
    process.exit(1);
  }

  const before = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
  const grown = regressions(before, after);
  if (grown.length > 0) {
    process.stderr.write(`\n${String(grown.length)} data-layer cost(s) went up:\n\n`);
    for (const entry of grown) {
      process.stderr.write(
        `  ✗ ${entry.scope}: ${LABELS[entry.field]} ${String(entry.was)} → ${String(entry.now)}\n`,
      );
    }
    process.stderr.write(
      '\n  This is the ratchet from ADR-0032: a call site must not pay more than it did.\n' +
        '  If the increase is the point (a new module, a new query), say so in the commit and run\n' +
        '  `bun src/tools/dx-baseline.ts --write`.\n\n',
    );
    process.exit(1);
  }

  const shrank = Object.keys(after.totals).filter(
    (field) => after.totals[field as keyof AppCount] < before.totals[field as keyof AppCount],
  );
  process.stdout.write(
    `✓ data-layer cost did not rise (${String(after.totals.querySites)} query site(s), ` +
      `${String(after.totals.drizzleParams)} drizzle parameter(s), ${String(after.totals.tokenEntries)} token entr(ies))\n`,
  );
  if (shrank.length > 0) {
    process.stdout.write(
      `  · lower than the baseline (${shrank.join(', ')}) — re-record with --write to move the floor\n`,
    );
  }
}
