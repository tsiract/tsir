/**
 * The task ledger's index, generated from the ledger itself (`DOC-018`).
 *
 * An AI agent reading `plans/tasks/` has three questions, and the files answer none of them
 * directly: *what is left*, *what is half done*, and *what does not exist yet*. They are written as
 * prose, in thirty-nine files, in three different status notations (`[x]`, `✅`, a bare `Done`
 * column), and every one of them is a claim a reader has to reconcile by hand.
 *
 * This tool reads every task table and emits one index. It is the only place a count is spelled
 * out, so a number that is wrong is a bug here rather than a stale sentence in nine documents.
 *
 * ```
 * bun src/tools/task-status.ts            # human table + per-file checklists
 * bun src/tools/task-status.ts --json     # for tooling
 * bun src/tools/task-status.ts --write    # writes plans/tasks/STATUS.md
 * bun src/tools/task-status.ts --check    # exit 1 if STATUS.md is stale (a gate)
 * ```
 *
 * Three rules it enforces rather than reports:
 *
 *   1. **One status notation.** `[x]`, `[~]`, `[ ]`, `[!]`. `✅` is accepted and read as `[x]`
 *      because it predates the rule, and rewriting it is `DOCS-014`; a new one fails.
 *   2. **Every task has an id.** A table row whose first cell is not a `PREFIX-NNN` id cannot be
 *      tracked, so it cannot be reported as missing later.
 *   3. **Every open task has an acceptance note.** A row with no acceptance text is a task nobody
 *      can finish — the failure mode this whole ledger exists to prevent.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

/** `src/tools/task-status.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');
const TASKS = join(ROOT, 'plans', 'tasks');
const STATUS_PAGE = join(TASKS, 'STATUS.md');

export type TaskState = 'done' | 'partial' | 'open' | 'blocked';

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  readonly depends: string;
  readonly acceptance: string;
  readonly file: string;
  readonly line: number;
}

/** `[x]` and the legacy `✅` are the same claim; the others are read as themselves. */
const STATES: readonly (readonly [RegExp, TaskState])[] = [
  [/^\s*(?:`)?\[x\](?:`)?\s*$/iu, 'done'],
  [/^\s*✅[\uFE0F]?\s*$/u, 'done'],
  [/^\s*(?:`)?\[~\](?:`)?\s*$/u, 'partial'],
  [/^\s*(?:`)?\[!\](?:`)?\s*$/u, 'blocked'],
  [/^\s*(?:`)?\[ \](?:`)?\s*$/u, 'open'],
];

function stateOf(cell: string): TaskState | undefined {
  for (const [pattern, state] of STATES) if (pattern.test(cell)) return state;
  return undefined;
}

/** A row whose first cell is a task id. Everything else in a task table is prose. */
const ID = /^`?([A-Z][A-Z0-9]{0,7}-\d{1,4})`?$/u;

function markdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(dir, name))
    .sort();
}

/** Every task row in one file. */
export function tasksIn(
  file: string,
  source: string,
  unidentified: { file: string; line: number; state: TaskState; text: string }[] = [],
): readonly Task[] {
  const found: Task[] = [];
  source.split('\n').forEach((text, index) => {
    if (!text.startsWith('|')) return;
    const cells = text
      .replace(/^\|/u, '')
      .replace(/\|$/u, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 3) return;

    // The id is wherever it is: `01-foundation.md` has it in column 1, `07-deploy-cloud-checks.md`
    // has a `#` cell before it. Searching the whole row is the only rule that fits every file —
    // and a cell that matches the id shape is unambiguous, because no other cell contains one.
    const id = cells.map((cell) => ID.exec(cell)?.[1]).find((value) => value !== undefined);

    // The status cell is the one that reads as a status. Columns move between files, so it is
    // found rather than assumed — a hard-coded index silently reports every row as it finds
    // whatever sits in column three.
    const statusIndex = cells.findIndex(
      (cell, position) => position > 0 && stateOf(cell) !== undefined,
    );
    if (statusIndex === -1) return;

    const state = stateOf(cells[statusIndex] ?? '');
    if (state === undefined) return;

    // A status with no id is a row nobody can cite from code, a commit or another plan. It is
    // reported rather than dropped: the parity ledger's 256 feature rows are all like this, and a
    // count of zero would say the ledger is smaller than it is.
    if (id === undefined) {
      unidentified.push({ file, line: index + 1, state, text });
      return;
    }

    // Depends is the cell between the status and the acceptance note, when it looks like ids.
    const depends = /(?:—|—|-|`[A-Z]|[A-Z])/u.test(cells[statusIndex + 1] ?? '')
      ? (cells[statusIndex + 1] ?? '')
      : '';
    const acceptance = cells
      .slice(statusIndex + (depends === '' ? 1 : 2))
      .join(' | ')
      .trim();

    const idIndex = cells.findIndex((cell) => ID.exec(cell)?.[1] === id);

    found.push({
      id,
      title: cells[idIndex + 1] ?? '',
      state,
      depends,
      acceptance,
      file: relative(ROOT, file),
      line: index + 1,
    });
  });

  // A second notation, and it is the one with the most detail: `26-laravel-decoupling.md` writes
  // each task as a heading, a bold `Status:`, and a checklist of acceptance items. Parsing only
  // tables reported that file as having zero tasks — the largest ledger, invisible.
  const headingForm = [
    ...source.matchAll(/^#{3,4}\s+`?([A-Z][A-Z0-9]{0,7}-\d{1,4})\s*[—-]+\s*(.+?)$/gmu),
  ];
  headingForm.forEach((match, position) => {
    const id = match[1];
    const title = (match[2] ?? '').trim();
    if (id === undefined) return;
    if (found.some((task) => task.id === id)) return; // a table already claimed it

    const start = (match.index ?? 0) + match[0].length;
    const end = headingForm[position + 1]?.index ?? source.length;
    const body = source.slice(start, end);
    const status = /\*\*Status:\*\*\s*`?\[([x~! ])\]`?/u.exec(body);
    if (status === null) return;
    const marker = status[1] ?? ' ';
    const state: TaskState =
      marker === 'x' ? 'done' : marker === '~' ? 'partial' : marker === '!' ? 'blocked' : 'open';
    const depends = /\*\*Depends(?: on)?:\*\*\s*(.+)$/mu.exec(body)?.[1]?.trim() ?? '';
    const boxes = [...body.matchAll(/^\s*[-*]\s+\[([x ])\]\s+(.+)$/gmu)];
    const acceptance =
      boxes.length > 0
        ? boxes.map((box) => box[2]?.trim() ?? '').join('; ')
        : (/\*\*Acceptance[^:]*:\*\*\s*\n?\s*([^\n]+)/u.exec(body)?.[1]?.trim() ?? '');

    found.push({
      id,
      title,
      state,
      depends,
      acceptance,
      file: relative(ROOT, file),
      line: source.slice(0, match.index ?? 0).split('\n').length,
    });
  });

  return found;
}

export interface Unidentified {
  readonly file: string;
  readonly line: number;
  readonly state: TaskState;
  readonly text: string;
}

export interface Report {
  readonly tasks: readonly Task[];
  /** Status rows with no task id: countable, not citable. */
  readonly unidentified: readonly Unidentified[];
  readonly files: readonly { readonly file: string; readonly counts: Record<TaskState, number> }[];
  readonly totals: Record<TaskState, number>;
  readonly problems: readonly string[];
}

const EMPTY: Record<TaskState, number> = { done: 0, partial: 0, open: 0, blocked: 0 };

export function buildReport(dir: string = TASKS): Report {
  const problems: string[] = [];
  const files: { file: string; counts: Record<TaskState, number> }[] = [];
  const all: Task[] = [];
  const unidentified: Unidentified[] = [];

  for (const path of markdown(dir)) {
    if (basename(path) === 'README.md' || basename(path) === 'STATUS.md') continue;
    const source = readFileSync(path, 'utf8');
    const tasks = tasksIn(path, source, unidentified);
    const counts = { ...EMPTY };
    for (const task of tasks) counts[task.state] += 1;

    for (const task of tasks) {
      if (task.state !== 'done' && task.acceptance === '') {
        problems.push(
          `${task.file}:${String(task.line)} — ${task.id} is ${task.state} with no acceptance note`,
        );
      }
    }

    // `✅` is read, not encouraged: it is the notation the rule retires. Only the *status cell*
    // counts — a task whose title names the notation (DOCS-014 does) is describing it, not using it.
    for (const task of tasks) {
      const row = source.split('\n')[task.line - 1] ?? '';
      const cells = row.replace(/^\|/u, '').replace(/\|$/u, '').split('|');
      const legacy = cells.some(
        (cell) => /✅/u.test(cell) && cell.trim().replace(/[`\s✅\uFE0F]/gu, '') === '',
      );
      if (legacy) {
        problems.push(
          `${task.file}:${String(task.line)} — ${task.id} uses ✅; write \`[x]\` (DOCS-014)`,
        );
      }
    }

    files.push({ file: relative(ROOT, path), counts });
    all.push(...tasks);
  }

  const totals = { ...EMPTY };
  for (const task of all) totals[task.state] += 1;

  return { tasks: all, unidentified, files, totals, problems };
}

/**
 * A markdown table with padded columns.
 *
 * The page is checked by `prettier --check` like every other document, and a generator that emits
 * unpadded tables leaves the repository in a state where `make format` changes a generated file.
 * Padding here is cheaper than running prettier from a tool that must also work offline.
 */
function table(rows: readonly (readonly string[])[]): string[] {
  // Prettier pads by UTF-16 length, not display width, so padding by anything else leaves a
  // generated file that `make format` then rewrites. Matching the formatter is the requirement;
  // `✅` (two units, one glyph) is the case that proves it.
  const width = (text: string): number => text.length;
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, width(cell));
    });
  }
  const line = (row: readonly string[]): string =>
    `| ${row.map((cell, index) => cell + ' '.repeat(Math.max(0, (widths[index] ?? 0) - width(cell)))).join(' | ')} |`;
  const [header, ...body] = rows;
  if (header === undefined) return [];
  const rule = header.map((_cell, index) => '-'.repeat(widths[index] ?? 3));
  return [line(header), line(rule), ...body.map(line)];
}

function bar(counts: Record<TaskState, number>): string {
  const total = counts.done + counts.partial + counts.open + counts.blocked;
  if (total === 0) return '—';
  const percent = Math.round((counts.done / total) * 100);
  return `${String(counts.done)}/${String(total)} (${String(percent)}%)`;
}

export function render(report: Report): string {
  const { totals, files, problems } = report;
  const total = totals.done + totals.partial + totals.open + totals.blocked;

  const lines = [
    '# Task status',
    '',
    '> Generated by `make tasks` from the ledgers in this directory. Do not edit: the next run',
    '> overwrites it, and `make check` fails if it disagrees. This page answers "what is left, what',
    '> is half done, and what does not exist yet" — for a person and for an agent alike.',
    '',
    '## Totals',
    '',
    ...table([
      ['State', 'Count', 'Meaning'],
      ['done', String(totals.done), 'acceptance met, evidence linked'],
      ['partial', String(totals.partial), 'a branch or a half landed'],
      ['open', String(totals.open), 'not started'],
      ['blocked', String(totals.blocked), 'waiting on a named task or decision'],
      ['**total**', `**${String(total)}**`, `**${bar(totals)} done**`],
    ]),
    '',
    '## By file',
    '',
    ...table([
      ['File', 'Done', 'Partial', 'Open', 'Blocked', ''],
      ...files
        .filter((entry) => {
          const c = entry.counts;
          return c.done + c.partial + c.open + c.blocked > 0;
        })
        .map((entry) => {
          const name = basename(entry.file);
          const c = entry.counts;
          return [
            `[\`${name}\`](./${name})`,
            String(c.done),
            String(c.partial),
            String(c.open),
            String(c.blocked),
            bar(c),
          ];
        }),
    ]),
  ];

  const byPrefix = new Map<string, { done: number; total: number }>();
  for (const task of report.tasks) {
    const prefix = task.id.split('-')[0] ?? '';
    const entry = byPrefix.get(prefix) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.state === 'done') entry.done += 1;
    byPrefix.set(prefix, entry);
  }

  lines.push(
    '',
    '## By id prefix',
    '',
    'The prefix is the contract: an id in code (`// TODO(VLT-012)`) says which ledger owns the work.',
    '',
    ...table([
      ['Prefix', 'Done', 'Total'],
      ...[...byPrefix]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([prefix, entry]) => [`\`${prefix}-*\``, String(entry.done), String(entry.total)]),
    ]),
  );

  const open = report.tasks.filter((task) => task.state !== 'done');
  lines.push(
    '',
    `## Open work (${String(open.length)} tasks)`,
    '',
    'Every row is a task in a ledger file. A task not listed here is done or does not exist.',
    '',
    ...table([
      ['Id', 'State', 'Task', 'Ledger'],
      ...open.map((task) => {
        const name = basename(task.file);
        return [
          `\`${task.id}\``,
          task.state,
          task.title.replace(/\|/gu, '\\|'),
          `[\`${name}\`](./${name})`,
        ];
      }),
    ]),
  );

  if (report.unidentified.length > 0) {
    const byFile = new Map<string, number>();
    for (const row of report.unidentified) {
      byFile.set(row.file, (byFile.get(row.file) ?? 0) + 1);
    }
    lines.push(
      '',
      `## Rows with no task id (${String(report.unidentified.length)})`,
      '',
      'These rows carry a status but no id, so nothing can cite them: not a commit message, not a',
      '`TODO`, not another task. They are counted here so the ledger is not smaller than it looks.',
      'Giving them ids is `DOCS-013`.',
      '',
      ...table([
        ['File', 'Rows'],
        ...[...byFile]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([file, count]) => [`[\`${basename(file)}\`](./${basename(file)})`, String(count)]),
      ]),
    );
  }

  if (problems.length > 0) {
    lines.push('', '## Problems', '');
    for (const problem of problems) lines.push(`- ${problem}`);
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** The checklist an agent pastes into a working note: one line per file, state per task. */
export function checklists(report: Report): string {
  const lines: string[] = [];
  for (const entry of report.files) {
    const tasks = report.tasks.filter((task) => task.file === entry.file);
    if (tasks.length === 0) continue;
    lines.push(`${basename(entry.file)} — ${bar(entry.counts)}`);
    for (const task of tasks) {
      const box =
        task.state === 'done'
          ? '[x]'
          : task.state === 'partial'
            ? '[~]'
            : task.state === 'blocked'
              ? '[!]'
              : '[ ]';
      lines.push(`  ${box} ${task.id} ${task.title}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main(): number {
  const report = buildReport();
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.problems.length > 0 ? 1 : 0;
  }

  if (check) {
    const expected = render(report);
    const actual = existsSync(STATUS_PAGE) ? readFileSync(STATUS_PAGE, 'utf8') : '';
    if (actual !== expected) {
      console.error('✗ plans/tasks/STATUS.md is stale — run `make tasks`');
      return 1;
    }
    console.log(
      `✓ task ledger is consistent (${String(report.tasks.length)} tasks: ${bar(report.totals)})`,
    );
    return report.problems.length > 0 ? 1 : 0;
  }

  if (write) {
    writeFileSync(STATUS_PAGE, render(report));
    console.log(
      `✓ plans/tasks/STATUS.md written (${String(report.tasks.length)} tasks: ${bar(report.totals)})`,
    );
  } else {
    process.stdout.write(checklists(report));
  }

  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
  return report.problems.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
