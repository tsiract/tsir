/**
 * The quickstart is a sequence, and a sequence can be wrong in a way no link check sees
 * (`DOCS-020`).
 *
 * `check-links` proves every page a document names exists. It cannot prove that the *commands* in a
 * code block work in the order they are written — and the fast path on `index.md`, `README.md`,
 * `installation.md` and the frontpage is the first thing a reader runs. It said:
 *
 *   tsir new hello
 *   cd hello            ← the command creates `apps/hello/`
 *
 * Every step was a valid command, every link resolved, and the fourth line failed with "no such
 * directory". `tsir dev` then reported a missing project file, which reads as a broken app rather
 * than a broken document.
 *
 * The rule here is narrow and mechanical: in any shell block that scaffolds an application, the
 * `cd` after `tsir new <name>` must be `apps/<name>`. It reads the blocks rather than the prose, so
 * it fires on the command a reader copies and not on the sentence around it.
 *
 *   bun src/tools/check-quickstart.ts        # gate (CI, `make check`)
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');

/** Where the fast path is written. The frontpage template is included: it is the same block. */
export const QUICKSTART_DOCUMENTS: readonly string[] = [
  'README.md',
  'src/docs/index.md',
  'src/docs/installation.md',
  'src/apps/frontpage/template.html',
];

/** `tsir new hello` → the directory the scaffold writes. */
const SCAFFOLD = /\btsir\s+new\s+([a-z0-9][a-z0-9-]*)/u;
/**
 * `cd apps/hello`, `cd "apps/hello"`, `cd ./apps/hello && …`, and the markup form
 * `<code>cd apps/hello</code>` on the frontpage. The closing tag has to be excluded twice — it is
 * not whitespace and it is not `&`, so without it the captured path ends in `</code>`.
 */
const CHANGE_DIR = /\bcd\s+["']?([^\s"';&|<]+)/u;

export interface QuickstartProblem {
  readonly file: string;
  readonly name: string;
  readonly found: string;
  readonly expected: string;
}

/**
 * The first `cd` that follows a `tsir new <name>` in the same document, and what it should be.
 *
 * "Follows" is by position, not by line: the frontpage keeps the two commands as adjacent `<code>`
 * elements, and a rule that only read line-oriented blocks would miss the page most readers land
 * on.
 */
export function quickstartProblems(
  source: string,
  file = 'document',
): readonly QuickstartProblem[] {
  const problems: QuickstartProblem[] = [];
  const scaffold = SCAFFOLD.exec(source);
  if (scaffold === null) return problems;

  const name = scaffold[1] ?? '';
  const after = source.slice((scaffold.index ?? 0) + scaffold[0].length);
  const cd = CHANGE_DIR.exec(after);
  if (cd === null) {
    // Scaffolding and then never entering the directory is a complete sequence only when the next
    // step takes `--app` or an absolute path; nothing in this repository does, so an absent `cd` is
    // reported rather than assumed.
    problems.push({ file, name, found: '(no cd)', expected: `apps/${name}` });
    return problems;
  }

  const found = cd[1] ?? '';
  const normalised = found.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalised !== `apps/${name}`) {
    problems.push({ file, name, found, expected: `apps/${name}` });
  }
  return problems;
}

/** Every documented fast path, checked. Exported for the test. */
export function problemsIn(root: string): readonly QuickstartProblem[] {
  const problems: QuickstartProblem[] = [];
  for (const file of QUICKSTART_DOCUMENTS) {
    let source: string;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    problems.push(...quickstartProblems(source, file));
  }
  return problems;
}

if (import.meta.main) {
  const problems = problemsIn(ROOT);
  if (problems.length > 0) {
    process.stderr.write(`\n${String(problems.length)} quickstart step(s) cannot be run:\n\n`);
    for (const problem of problems) {
      process.stderr.write(
        `  ✗ ${problem.file}: \`tsir new ${problem.name}\` is followed by \`cd ${problem.found}\`` +
          ` — the scaffold writes ${problem.expected}\n`,
      );
    }
    process.stderr.write('\n  `tsir new` creates apps/<name>/; every quickstart says so.\n\n');
    process.exit(1);
  }
  process.stdout.write(
    `✓ quickstarts run in order (${String(QUICKSTART_DOCUMENTS.length)} documents)`,
  );
  process.stdout.write('\n');
}
