/**
 * Documentation drift, measured (`DOCS-*`).
 *
 * The documentation set has three parts that can disagree with each other and with the code:
 *
 *   1. **Generated pages** — `src/docs/packages/*.md`, `errors.md`, `capabilities.md`,
 *      `api-surface.json`, `llms.txt`, the README counts. These are derived, so drift is a stale
 *      build, and every one of them already has a `--check` in `make check`.
 *   2. **Prose** — the guides and package narratives a person wrote. Drift here is a claim about a
 *      version that no longer exists: a command that was renamed, an example that no longer runs.
 *      `guides.test.ts` executes the fenced blocks, which covers the examples and not the sentences.
 *   3. **Coverage** — a package with no prose page, a guide nobody links, a document no index
 *      mentions. This is not drift, it is absence, and it is what a reader notices first.
 *
 * This tool measures (3) and reports (1) and (2) as counts, because a number is the only honest way
 * to say "there is a lot of stale documentation" without arguing about adjectives. It does not
 * rewrite anything: the work is `DOCS-001`…`DOCS-017`.
 *
 * ```
 * bun src/tools/doc-inventory.ts            # the inventory, human-readable
 * bun src/tools/doc-inventory.ts --json     # for tooling
 * ```
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

/** `src/tools/doc-inventory.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');

export interface PackageDoc {
  readonly name: string;
  readonly dir: string;
  /** The generated reference page exists. */
  readonly page: boolean;
  /** Hand-written prose exists (Example, Failure modes, Security notes). */
  readonly prose: boolean;
  /** Exported symbols, from `api-surface.json`. */
  readonly exports: number;
  /** Error codes the package can throw, from `error-codes.json`. */
  readonly codes: number;
}

export interface GuideDoc {
  readonly file: string;
  readonly lines: number;
  /** Headings with no body — a stub nobody finished. */
  readonly emptySections: number;
  /** Fenced ```ts blocks that `guides.test.ts` executes. */
  readonly examples: number;
  /** True when `src/docs/index.md` links it. */
  readonly linked: boolean;
}

export interface Inventory {
  readonly packages: readonly PackageDoc[];
  readonly guides: readonly GuideDoc[];
  readonly rootDocs: readonly { readonly file: string; readonly lines: number }[];
  readonly totals: {
    readonly packages: number;
    readonly withProse: number;
    readonly withoutProse: number;
    readonly guides: number;
    readonly unlinkedGuides: number;
    readonly emptySections: number;
    readonly examples: number;
  };
  /** Prose files whose package no longer exists. */
  readonly orphans: readonly string[];
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(dir, name))
    .sort();
}

function lineCount(file: string): number {
  return readFileSync(file, 'utf8').split('\n').length;
}

/** Headings followed immediately by another heading, or by the end of the file. */
export function emptySectionsIn(source: string): number {
  const lines = source.split('\n');
  let empty = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^#{2,3}\s/u.test(lines[index] ?? '')) continue;
    let next = index + 1;
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1;
    if (next >= lines.length || /^#{2,3}\s/u.test(lines[next] ?? '')) empty += 1;
  }
  return empty;
}

export function countExamples(source: string): number {
  return [...source.matchAll(/^```(?:ts|tsx|js)\b/gmu)].length;
}

export function buildInventory(root: string = ROOT): Inventory {
  const docsDir = join(root, 'src', 'docs');
  const proseDir = join(docsDir, 'packages', 'prose');
  const surface = JSON.parse(readFileSync(join(docsDir, 'api-surface.json'), 'utf8')) as Record<
    string,
    string[]
  >;
  const codes = (
    JSON.parse(readFileSync(join(docsDir, 'error-codes.json'), 'utf8')) as {
      codes: Record<string, string>;
    }
  ).codes;

  const packages: PackageDoc[] = [];
  for (const entry of readdirSync(join(root, 'src', 'framework'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, 'src', 'framework', entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string };
    const page = join(docsDir, 'packages', `${entry.name}.md`);
    const prose = join(proseDir, `${entry.name}.md`);
    packages.push({
      name,
      dir: entry.name,
      page: existsSync(page),
      prose: existsSync(prose),
      // `api-surface.json` and `error-codes.json` are keyed by package *directory*, not by npm
      // name. Reading them the other way reported every package as having zero exports, which is
      // the kind of wrong that looks like a finding.
      exports: surface[entry.name]?.length ?? 0,
      codes: Object.entries(codes).filter(([, dir]) => dir === entry.name).length,
    });
  }

  const index = existsSync(join(docsDir, 'index.md'))
    ? readFileSync(join(docsDir, 'index.md'), 'utf8')
    : '';
  const guides: GuideDoc[] = markdownFiles(join(docsDir, 'guides')).map((file) => {
    const source = readFileSync(file, 'utf8');
    return {
      file: relative(root, file),
      lines: source.split('\n').length,
      emptySections: emptySectionsIn(source),
      examples: countExamples(source),
      linked: index.includes(`guides/${basename(file)}`),
    };
  });

  const rootDocs = markdownFiles(docsDir)
    .filter((file) => statSync(file).isFile())
    .map((file) => ({ file: relative(root, file), lines: lineCount(file) }));

  const known = new Set(packages.map((pkg) => `${pkg.dir}.md`));
  const orphans = markdownFiles(proseDir)
    .map((file) => basename(file))
    .filter((name) => !known.has(name));

  const withProse = packages.filter((pkg) => pkg.prose).length;

  return {
    packages,
    guides,
    rootDocs,
    totals: {
      packages: packages.length,
      withProse,
      withoutProse: packages.length - withProse,
      guides: guides.length,
      unlinkedGuides: guides.filter((guide) => !guide.linked).length,
      emptySections: guides.reduce((sum, guide) => sum + guide.emptySections, 0),
      examples: guides.reduce((sum, guide) => sum + guide.examples, 0),
    },
    orphans,
  };
}

export function render(inventory: Inventory): string {
  const { packages, guides, totals, orphans } = inventory;
  const lines = [
    `Documentation inventory (${String(totals.packages)} packages, ${String(totals.guides)} guides)`,
    '',
    `  packages with prose:   ${String(totals.withProse)}/${String(totals.packages)}`,
    `  guides               ${String(totals.guides)} (${String(totals.unlinkedGuides)} not linked from index.md)`,
    `  empty sections       ${String(totals.emptySections)}`,
    `  runnable examples    ${String(totals.examples)}`,
    '',
  ];

  if (totals.withoutProse > 0) {
    lines.push(`Packages with no prose page (${String(totals.withoutProse)}):`);
    for (const pkg of packages.filter((entry) => !entry.prose)) {
      const why = [
        pkg.page ? '' : 'no generated page',
        pkg.codes > 0 ? `${String(pkg.codes)} codes undocumented` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(
        `  - ${pkg.name.padEnd(22)} ${String(pkg.exports).padStart(3)} exports${why === '' ? '' : `  — ${why}`}`,
      );
    }
    lines.push('');
  }

  const weak = guides.filter((guide) => guide.emptySections > 0 || guide.examples === 0);
  if (weak.length > 0) {
    lines.push('Guides that are thin or unexecuted:');
    for (const guide of weak) {
      const notes = [
        guide.emptySections > 0 ? `${String(guide.emptySections)} empty section(s)` : '',
        guide.examples === 0 ? 'no runnable example' : '',
        guide.linked ? '' : 'not linked from index.md',
      ].filter(Boolean);
      lines.push(`  - ${guide.file.padEnd(34)} ${notes.join(', ')}`);
    }
    lines.push('');
  }

  if (orphans.length > 0) {
    lines.push(
      `Prose for a package that does not exist (${String(orphans.length)}): ${orphans.join(', ')}`,
    );
    lines.push('');
  }

  return lines.join('\n');
}

if (import.meta.main) {
  const inventory = buildInventory();
  if (process.argv.includes('--json'))
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  else process.stdout.write(render(inventory));
}
