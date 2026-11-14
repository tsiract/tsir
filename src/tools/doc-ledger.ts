/**
 * What documentation each task added (`DOCS-019`).
 *
 * Two failures live in the same place, and both are the reason a README goes stale:
 *
 *   · **A task that added documentation nobody can find.** `DOCS-002` says it wrote the media
 *     page; the page is `src/docs/packages/prose/media.md`, which a reader only reaches by knowing
 *     the convention. The ledger is the index, so the ledger should say where.
 *   · **A task marked done that added no documentation at all** while everything around it claims
 *     "documented". That is not a defect in the task — plenty of tasks are code — so it is counted
 *     and printed, never failed. A gate here would be one everybody passes by writing "`README.md`"
 *     in the cell.
 *
 * The citation is read, not trusted: a path in backticks that resolves to a file with a document
 * extension is a document. A path that resolves to nothing is reported, so a renamed page becomes a
 * dangling citation instead of a sentence that used to be true.
 *
 *   bun src/tools/doc-ledger.ts            # what each ledger documents, and what cites nothing
 *   bun src/tools/doc-ledger.ts --write    # plans/tasks/docs/<ledger>.md
 *   bun src/tools/doc-ledger.ts --check    # exit 1 when a generated page is stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { buildReport, type Task } from './task-status.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const TASKS = join(ROOT, 'plans', 'tasks');
const PAGES = join(TASKS, 'docs');

/**
 * Where a cited document may live. First match wins, so a full path beats a suffix.
 *
 * `packages/prose` is on the list because that directory *is* where the hand-written package pages
 * live, and the citation in the ledger that added one is written `prose/media.md` — the shortest
 * form that is unambiguous. `src` is last so a stale path under it is reported rather than silently
 * resolving to something else.
 */
const SEARCH: readonly string[] = [
  '',
  'src/docs/packages/prose',
  'src/docs/packages',
  'src/docs/guides',
  'src/docs',
  'plans/tasks',
  'plans/modules',
  'plans/architecture',
  'plans/roadmap',
  'src',
];

/**
 * A backticked path with no spaces and no glob — the two shapes that are never a real file.
 *
 * The extension is part of the pattern, and `.ts`/`.json` are absent on purpose: `api-surface.json`
 * is generated from the code, so a task that changes an export cites a source file, and counting
 * that as documentation is how "documented" becomes a word with no meaning.
 */
const PATH = /`([A-Za-z0-9_@][A-Za-z0-9_./-]*\.(?:md|txt|html))`/gu;

/**
 * The file a citation means, or `undefined` when nothing by that path exists.
 *
 * Acceptance notes write `prose/media.md` to keep a long path out of a table cell, so a suffix is
 * resolved against a fixed list of roots rather than by guessing: `docs/index.md` could mean
 * `src/docs/index.md` or a future `plans/docs/index.md`, and saying "unresolved" is better than
 * citing the wrong one.
 */
export function resolveCitation(written: string, root: string = ROOT): string | undefined {
  for (const base of SEARCH) {
    const candidate = base === '' ? written : join(base, written);
    if (existsSync(join(root, candidate))) return candidate;
  }
  return undefined;
}

export function citationsIn(acceptance: string): readonly string[] {
  const found = new Set<string>();
  for (const match of acceptance.matchAll(PATH)) {
    const written = match[1];
    if (written === undefined) continue;
    const resolved = resolveCitation(written);
    if (resolved !== undefined) found.add(resolved);
  }
  return [...found].sort();
}

export interface DocIndex {
  /** Tasks whose acceptance note cites at least one document that exists. */
  readonly cited: number;
  /** Done tasks that cite none — counted, not failed. */
  readonly uncited: readonly Task[];
  /**
   * Citations that resolve to nothing, split by who wrote them.
   *
   * An **open** task naming a page that does not exist yet is the ledger working: `DOCS-010` says
   * it will write `guides/models.md`, and that file appears the day it is written. A **done** task
   * naming a page that does not exist is a broken reference — the page was renamed or the task was
   * never finished — and only that one is a finding.
   */
  readonly planned: readonly { readonly id: string; readonly written: string }[];
  readonly broken: readonly { readonly id: string; readonly written: string }[];
  /** Resolved path → the task ids that cite it, sorted. */
  readonly pages: ReadonlyMap<string, readonly string[]>;
}

/** The index over any set of tasks, so a page can describe one ledger and the CLI all of them. */
export function indexFor(tasks: readonly Task[]): DocIndex {
  const pages = new Map<string, string[]>();
  const uncited: Task[] = [];
  const planned: { id: string; written: string }[] = [];
  const broken: { id: string; written: string }[] = [];
  let cited = 0;

  for (const task of tasks) {
    const resolved = citationsIn(task.acceptance);
    for (const match of task.acceptance.matchAll(PATH)) {
      const written = match[1];
      if (written === undefined) continue;
      if (resolveCitation(written) !== undefined) continue;
      const entry = { id: task.id, written };
      if (task.state === 'done') broken.push(entry);
      else planned.push(entry);
    }
    if (resolved.length > 0) {
      cited += 1;
      for (const page of resolved) pages.set(page, [...(pages.get(page) ?? []), task.id]);
    } else if (task.state === 'done') {
      uncited.push(task);
    }
  }

  for (const [page, ids] of pages) pages.set(page, [...new Set(ids)].sort());
  return { cited, uncited, planned, broken, pages };
}

export function documentationIndex(dir: string = TASKS): DocIndex {
  return indexFor(buildReport(dir).tasks);
}

/** `plans/tasks/28-docs-inventory.md` → `plans/tasks/docs/28-docs-inventory.md`. */
export function indexPath(file: string): string {
  return `plans/tasks/docs/${basename(file, '.md')}.md`;
}

/**
 * One page per ledger: the documents it cites, then the done tasks that cite none.
 *
 * Grouped by document rather than by task, because the question is "what does this ledger add to
 * the documentation tree" — an answer checked against the tree, not against the table.
 */
export function renderIndex(index: DocIndex, file: string): string {
  const lines = [
    `# Documentation index — ${basename(file)}`,
    '',
    `> Generated by \`make docs-index\` from [\`${basename(file)}\`](../${basename(file)}). Do not edit.`,
    '> Every document a task in this ledger cites, and every done task that cites none — read from',
    '> the acceptance notes, not from a list somebody keeps by hand.',
    '',
    `**${String(index.pages.size)} document(s) cited by ${String(index.cited)} task(s).**`,
    '',
  ];

  if (index.pages.size > 0) {
    lines.push('## Documents', '', '| Document | Cited by |', '| --- | --- |');
    for (const [page, ids] of [...index.pages].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| \`${page}\` | ${ids.map((id) => `\`${id}\``).join(', ')} |`);
    }
    lines.push('');
  }

  if (index.uncited.length > 0) {
    lines.push(
      '## Done tasks that cite no document',
      '',
      'Not failures: a task can be pure code. They are listed because a task marked done whose',
      'acceptance note names no page is the one place a claim of "documented" can hide.',
      '',
    );
    for (const task of index.uncited) lines.push(`- \`${task.id}\` ${task.title}`);
    lines.push('');
  }

  if (index.planned.length > 0) {
    lines.push('## Pages an open task says it will write', '');
    for (const entry of index.planned) {
      lines.push(`- \`${entry.id}\` → \`${entry.written}\` (does not exist yet)`);
    }
    lines.push('');
  }

  if (index.broken.length > 0) {
    lines.push('## Citations that resolve to nothing', '');
    for (const entry of index.broken) {
      lines.push(`- \`${entry.id}\` cites \`${entry.written}\`, which does not exist`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Every index page `--write` emits, keyed by the ledger it describes. */
export function pagesToWrite(
  dir: string = TASKS,
): readonly { readonly path: string; readonly page: string }[] {
  const report = buildReport(dir);
  return report.files.map((entry) => ({
    path: indexPath(entry.file),
    page: renderIndex(
      indexFor(report.tasks.filter((task) => task.file === entry.file)),
      entry.file,
    ),
  }));
}

if (import.meta.main) {
  if (process.argv.includes('--write') || process.argv.includes('--check')) {
    const write = process.argv.includes('--write');
    const pages = pagesToWrite();
    if (write) mkdirSync(PAGES, { recursive: true });
    const stale = pages.filter(
      (page) => (existsSync(page.path) ? readFileSync(page.path, 'utf8') : '') !== page.page,
    );
    if (write) {
      for (const page of stale) writeFileSync(page.path, page.page);
      const index = documentationIndex();
      process.stdout.write(
        `✓ ${String(pages.length)} documentation indexes written (${String(index.cited)} task(s) cite a document)\n`,
      );
      process.exit(0);
    }
    if (stale.length > 0) {
      process.stderr.write(
        `✗ ${String(stale.length)} documentation index page(s) stale or missing — run \`make docs-index\`\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`✓ documentation indexes are current (${String(pages.length)} pages)\n`);
    process.exit(0);
  }

  const index = documentationIndex();
  process.stdout.write(
    `Documentation ledger (${String(index.pages.size)} documents cited by ${String(index.cited)} task(s))\n\n`,
  );
  for (const [page, ids] of [...index.pages].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`  ${page}\n    ← ${ids.join(', ')}\n`);
  }
  if (index.uncited.length > 0) {
    process.stdout.write(
      `\n${String(index.uncited.length)} done task(s) cite no document — not failures, but where a\n` +
        'claim of "documented" can hide:\n',
    );
    for (const task of index.uncited.slice(0, 20)) {
      process.stdout.write(`  - ${task.id} ${task.title.slice(0, 64)}\n`);
    }
  }
  if (index.planned.length > 0) {
    process.stdout.write(
      `\n${String(index.planned.length)} page(s) an open task says it will write:\n`,
    );
    for (const entry of index.planned) {
      process.stdout.write(`  · ${entry.id} → ${entry.written}\n`);
    }
  }
  if (index.broken.length > 0) {
    process.stderr.write(
      `\n${String(index.broken.length)} done task(s) cite a document that does not exist:\n`,
    );
    for (const entry of index.broken) {
      process.stderr.write(`  ✗ ${entry.id} cites \`${entry.written}\`\n`);
    }
    process.exit(1);
  }
}
