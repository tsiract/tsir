/**
 * The Makefile's own gate, plus the documentation that names its targets.
 *
 * `make check` is the command that answers "is my branch sane?", and it cannot answer that
 * about itself. Three specific failures shipped at once, and all three were silent:
 *
 *   1. **A variable lost its definition.** `COMPOSE` was detected at the top of the file and
 *      referenced by `db-up` / `db-down`; a refactor deleted the detection line and kept the
 *      references, so `make db-up` printed "no Compose found: install the docker compose plugin"
 *      on a machine that had Docker. Make expands an undefined variable to the empty string, and
 *      every guard written as `test -n "$(X)"` therefore fails with a message about the wrong
 *      cause. An undefined variable is not a warning in Make; it is a load-bearing empty string.
 *   2. **A target's documentation line was merged into its neighbour.** A rebase glued
 *      `db-up: ## …` onto a second `db-up: ## …`, which Make reads as one rule whose `##` text
 *      carries a stale copy of itself — `make help` then advertises a target twice, in two
 *      different wordings, and the file claims two definitions where it has one.
 *   3. **The docs kept naming targets that no longer exist.** `make migrate`, `make seed`,
 *      `make openapi APP=…` and `make deploy-*` were removed when application verbs moved behind
 *      `dist/tsir` (ADR-0031); the prose and the plan ledger went on instructing people to run
 *      them, because prose is not compiled.
 *
 * The rule is mechanical, so it is checked rather than remembered:
 *
 *   · every `$(VARIABLE)` used is defined in the file or is one make provides;
 *   · every variable defined is used (an unused definition is what a lost reference looks like);
 *   · no target is defined twice, and no documentation line holds a second target definition;
 *   · every target is declared `.PHONY`, and every `.PHONY` name is a real target;
 *   · every `make <target>` named by `README.md` and `docs/` exists.
 *
 * The internal plan tree is deliberately out of scope for the last rule: it is a historical
 * ledger, and a document that records "this target existed in Phase 3" is telling the truth about
 * the past.
 * The ledger is corrected by hand when a decision changes it; the current-facing docs are not
 * allowed to rot.
 *
 *   bun src/tools/check-make.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** `src/tools/check-make.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');

/**
 * Variables the Makefile may read without defining.
 *
 * Each is either provided by make itself or by the environment the gate runs in. This list is
 * small on purpose: a variable that needs a definition gets one, which is the whole point.
 */
const PROVIDED = new Map<string, string>([
  ['MAKE', 'make provides the invoked make'],
  ['CURDIR', 'make provides the working directory'],
  ['SHELL', 'make provides the shell, and `.SHELLFLAGS` beside it'],
  ['MAKEFLAGS', 'make provides the command-line flags'],
  ['MAKELEVEL', 'make provides the recursion depth'],
  ['CI', 'the CI runner sets it (and `CI=1 make …` sets it by hand)'],
]);

/** A target definition: `name:` at the start of a line, with an optional `## doc`. */
interface Target {
  readonly line: number;
  readonly name: string;
  readonly doc?: string;
}

/** One `name op value` assignment. `conditional` is `?=`, which may legitimately leave a name unset. */
interface Assignment {
  readonly line: number;
  readonly name: string;
  readonly op: string;
  readonly value: string;
}

export interface MakefileParse {
  readonly targets: readonly Target[];
  readonly assignments: readonly Assignment[];
  /** Names assigned unconditionally, or declared with a bare `export NAME`. */
  readonly defined: ReadonlySet<string>;
  /** Names the reader supplies (`make target NAME=…`), usually documented with `?=`. */
  readonly inputs: ReadonlySet<string>;
  /** Variable names read anywhere in the file. */
  readonly used: ReadonlySet<string>;
  /** The names listed by `.PHONY`. */
  readonly phony: ReadonlySet<string>;
}

/** Automatic variables make fills in for a rule; they are read, never assigned. */
const AUTOMATIC = new Set(['@', '<', '^', '+', '?', '*', '$']);

/** `NAME = value`, `NAME ?= value`, `NAME := value`, `NAME ::= value`. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*(::=|:=|\?=|=)\s*(.*)$/u;

/** `export NAME` with no value: an inherited variable, not a definition. */
const BARE_EXPORT = /^export\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/u;

/** Reads the file into the facts the rules need. Pure: no filesystem, no `make` process. */
export function parseMakefile(source: string): MakefileParse {
  const targets: Target[] = [];
  const assignments: Assignment[] = [];
  const defined = new Set<string>();
  const inputs = new Set<string>();
  const used = new Set<string>();
  const phony = new Set<string>();

  // `.PHONY` and multi-line values are continued with a trailing backslash.
  const logical: { readonly line: number; text: string }[] = [];
  const raw = source.split('\n');
  for (let index = 0; index < raw.length; index += 1) {
    const start = index + 1;
    let text = raw[index] ?? '';
    // A recipe's continuation belongs to the recipe; only join top-level lines.
    if (!text.startsWith('\t')) {
      while (text.endsWith('\\') && index + 1 < raw.length) {
        index += 1;
        text = `${text.slice(0, -1)} ${raw[index] ?? ''}`.trimEnd();
      }
    }
    logical.push({ line: start, text });
  }

  for (const { line, text } of logical) {
    const phonyMatch = /^\.PHONY:\s*(.*)$/u.exec(text);
    if (phonyMatch !== null) {
      for (const name of (phonyMatch[1] ?? '').split(/\s+/u)) if (name !== '') phony.add(name);
      continue;
    }

    // A recipe line begins with a tab; it never defines a target or a variable.
    if (text.startsWith('\t')) {
      collectVariables(text, used);
      continue;
    }

    // Comments are prose. Make's own comment syntax means a `#` anywhere outside a recipe
    // starts the comment, which is what keeps `# make up ...` from reading as a mention. The
    // `## doc` half of a target line is read *before* that, because it is documentation and
    // dropping it would silence the rule that looks for a definition buried inside one.
    const docAt = text.indexOf('##');
    const code = (docAt === -1 ? text : text.slice(0, docAt)).replace(/(^|\s)#.*$/u, '').trimEnd();
    const doc = docAt === -1 ? undefined : text.slice(docAt + 2).trim();
    if (code.trim() === '') continue;

    const assignment = ASSIGNMENT.exec(code);
    if (assignment !== null) {
      const [, name = '', op = '=', value = ''] = assignment;
      assignments.push({ line, name, op, value });
      if (op === '?=') inputs.add(name);
      else defined.add(name);
      collectVariables(value, used);
      continue;
    }

    const exported = BARE_EXPORT.exec(code);
    if (exported !== null) {
      defined.add(exported[1] ?? '');
      continue;
    }

    const target = /^([A-Za-z0-9_][A-Za-z0-9_.%/-]*)\s*:(?!=)\s*(.*)$/u.exec(code);
    if (target !== null) {
      const [, name = '', rest = ''] = target;
      if (doc !== undefined && doc !== '') targets.push({ line, name, doc });
      else targets.push({ line, name });
      // The remainder of a target line is prerequisites; it may read variables too.
      collectVariables(rest, used);
      continue;
    }

    collectVariables(code, used);
  }

  return { targets, assignments, defined, inputs, used, phony };
}

function collectVariables(text: string, into: Set<string>): void {
  for (const match of text.matchAll(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/gu)) {
    const name = match[1];
    if (name === undefined || AUTOMATIC.has(name)) continue;
    into.add(name);
  }
}

/** Every problem in one Makefile's source. Empty when the file is consistent with itself. */
export function makefileProblems(source: string): readonly string[] {
  const problems: string[] = [];
  const { targets, assignments, defined, inputs, used, phony } = parseMakefile(source);

  for (const name of [...used].sort()) {
    if (defined.has(name) || inputs.has(name) || PROVIDED.has(name)) continue;
    problems.push(
      `$(${name}) is read but never defined — make expands it to the empty string, so every guard on it passes or fails for the wrong reason`,
    );
  }
  // An unused definition is what a lost reference looks like. A `?=` input is exempt: it exists
  // so the reader can override a default the file may legitimately not read back.
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (seen.has(assignment.name) || assignment.op === '?=') continue;
    seen.add(assignment.name);
    if (used.has(assignment.name)) continue;
    if (PROVIDED.has(assignment.name)) continue;
    problems.push(
      `${'$'}${assignment.name} is defined on line ${String(assignment.line)} but never read — an unused definition is what a lost reference looks like`,
    );
  }

  const byName = new Map<string, Target[]>();
  for (const target of targets) {
    const existing = byName.get(target.name) ?? [];
    existing.push(target);
    byName.set(target.name, existing);
  }
  for (const [name, definitions] of byName) {
    if (definitions.length > 1) {
      const lines = definitions.map((target) => target.line).join(', ');
      problems.push(
        `target "${name}" is defined ${String(definitions.length)} times (lines ${lines})`,
      );
    }
  }

  for (const target of targets) {
    // A doc line that holds a second `<name>: ## …` is a merge accident, not prose.
    const nested = /([a-z0-9][a-z0-9_.-]*):\s*##/u.exec(target.doc ?? '');
    if (nested !== null) {
      problems.push(
        `target "${target.name}" (line ${String(target.line)}) has a second definition buried in its doc line: ${nested[0]?.trim() ?? ''}`,
      );
    }
  }

  for (const target of targets) {
    if (target.name.includes('/') || target.name.includes('.') || target.name === 'Makefile')
      continue;
    if (!phony.has(target.name)) {
      problems.push(
        `target "${target.name}" is not declared .PHONY — a file with that name in the checkout would make the target a no-op`,
      );
    }
  }
  for (const name of [...phony].sort()) {
    if (name.includes('/') || name.includes('.')) continue;
    if (!byName.has(name)) problems.push(`.PHONY declares "${name}", which is not a target`);
  }

  return problems;
}

/** Target names in one Makefile. Used by the documentation rule. */
export function targetNames(source: string): ReadonlySet<string> {
  return new Set(parseMakefile(source).targets.map((target) => target.name));
}

/**
 * `make <target>` mentions a document makes.
 *
 * Prose is the reason this is deliberately strict. "…make the user wait…" and "…no test can make
 * it so…" are ordinary English, and a rule that reads every `make <word>` as a command reports
 * them as broken targets, which is how a gate gets switched off. A mention counts only when it is
 * unambiguous:
 *
 *   · inside a code span (`` `make check` ``) or a fenced block — the docs' own convention for a
 *     command;
 *   · a link the docs use to point at a target from prose (``[`make check`](…)``);
 *   · a line that starts with it (a bare command line in a shell transcript).
 *
 * Arguments and variable overrides are stripped, so `make check CI=1` names `check`. A namespaced
 * CLI command (`make:controller`) and a glob are not repository targets.
 */
export function makeMentions(
  source: string,
): readonly { readonly line: number; readonly name: string }[] {
  const found: { line: number; name: string }[] = [];
  const lines = source.split('\n');
  let fence: string | undefined;

  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(text);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '';
      if (fence === undefined) fence = marker;
      else if (marker.startsWith(fence.slice(0, 1))) fence = undefined;
      continue;
    }

    const inCode =
      fence !== undefined || /`[^`\n]*\bmake\s/u.test(text) || /^\s*make\s/u.test(text);
    if (!inCode) continue;

    for (const match of text.matchAll(/(?:^|[\s`([])make\s+([a-z][a-z0-9_-]*)/gu)) {
      const name = match[1] ?? '';
      if (name === '') continue;
      found.push({ line, name });
    }
  }
  return found;
}

/** Every `make <target>` in the current-facing docs that the Makefile does not define. */
export function documentationProblems(
  targets: ReadonlySet<string>,
  documents: readonly { readonly path: string; readonly source: string }[],
): readonly string[] {
  const problems: string[] = [];
  for (const document of documents) {
    for (const mention of makeMentions(document.source)) {
      if (targets.has(mention.name)) continue;
      problems.push(
        `${document.path}:${String(mention.line)} tells the reader to run \`make ${mention.name}\`, which is not a target`,
      );
    }
  }
  return problems;
}

// ── Running it ──────────────────────────────────────────────────────────────

function markdown(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdown(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

function main(): number {
  const problems: string[] = [];
  const source = readFileSync(join(ROOT, 'Makefile'), 'utf8');
  const targets = targetNames(source);
  problems.push(...makefileProblems(source));

  const documents = [
    join(ROOT, 'README.md'),
    ...markdown(join(ROOT, 'docs')),
    ...markdown(join(ROOT, 'src', 'docs')),
  ].map((path) => ({ path: relative(ROOT, path), source: readFileSync(path, 'utf8') }));
  problems.push(...documentationProblems(targets, documents));

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error(`\n  ✗ ${String(problems.length)} Makefile problem(s)`);
    return 1;
  }
  process.stdout.write(
    `  \u001b[32m✓\u001b[0m Makefile is consistent: ${String(targets.size)} targets, ${String(documents.length)} documents name only targets that exist\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(main());
