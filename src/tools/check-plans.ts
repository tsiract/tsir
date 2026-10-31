/**
 * The plans directory's own integrity gate (DOC-017).
 *
 * A plan set rots in four specific ways, and all four are mechanical:
 *
 *   1. **An orphan.** A document nobody links is a document nobody reads, and it silently
 *      drifts from the code until someone finds it and trusts it.
 *   2. **An unindexed decision.** An ADR that is not in the index is invisible from the
 *      orientation page, which is the page everybody starts on.
 *   3. **A status that disagrees.** `decisions/README.md` says Accepted while the ADR's own
 *      front matter still says Proposed. This one shipped: `ADR-0015` claimed its decision was
 *      unanswered months after it was answered, because nothing compared the two.
 *   4. **A plan that stopped being a plan.** The four-section contract in `README.md` § 3
 *      (failure modes, security, open questions, task index) is what makes a document usable
 *      rather than descriptive. A document missing one of them is incomplete by definition.
 *   5. **A question id defined twice.** `Q12` means one question in this repository. When two
 *      documents each define `Q12`, a task citing it can mean either, and the register stops
 *      being a register. A second mention belongs in backticks as a reference, not as a table
 *      row — which is also why the id space is global rather than per document.
 *
 *   bun src/tools/check-plans.ts
 *
 * Nothing here judges whether a plan is *good*. It cannot. It judges whether the directory is
 * internally consistent, which is the part a machine is honest about.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

/** `src/tools/check-plans.ts` → repository root. */
const ROOT = resolve(import.meta.dir, '..', '..');
const PLANS = join(ROOT, 'plans');

const problems: string[] = [];

const rel = (path: string): string => relative(ROOT, path);

// ── Collect the tree ────────────────────────────────────────────────────────

function markdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdown(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

const documents = markdown(PLANS);
const byName = new Set(documents);

// ── 1. Every document is reachable from plans/README.md within two hops ─────

/** Relative markdown link targets in a file, resolved to absolute paths. */
function links(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const href = match[1];
    if (href === undefined) continue;
    const path = href.split('#')[0] ?? '';
    if (path === '' || /^[a-z]+:/iu.test(path)) continue;
    found.push(resolve(file, '..', path));
  }
  return found;
}

const INDEX = join(PLANS, 'README.md');
if (!existsSync(INDEX)) {
  problems.push('plans/README.md is missing — there is no orientation page to check against');
} else {
  const seen = new Set<string>([INDEX]);
  let frontier = new Set<string>([INDEX]);
  for (let hop = 0; hop < 2; hop += 1) {
    const next = new Set<string>();
    for (const file of frontier) {
      for (const target of links(file)) {
        if (byName.has(target) && !seen.has(target)) next.add(target);
      }
    }
    for (const file of next) seen.add(file);
    frontier = next;
  }
  for (const file of documents) {
    if (!seen.has(file)) {
      problems.push(`${rel(file)} — not reachable from plans/README.md within two hops`);
    }
  }
}

// ── 2. Every ADR and task file is listed in its index, and vice versa ───────

for (const [folder, label] of [
  ['decisions', 'ADR'],
  ['tasks', 'task file'],
  ['reviews', 'review'],
] as const) {
  const dir = join(PLANS, folder);
  const index = join(dir, 'README.md');
  if (!existsSync(index)) continue;

  const listed = new Set(links(index).filter((path) => byName.has(path)));
  const present = markdown(dir).filter((path) => path !== index);

  for (const file of present) {
    if (!listed.has(file)) {
      problems.push(
        `${rel(file)} — ${label} exists but is not listed in plans/${folder}/README.md`,
      );
    }
  }
  for (const file of listed) {
    if (!existsSync(file)) {
      problems.push(`plans/${folder}/README.md links ${rel(file)}, which does not exist`);
    }
  }
}

// ── 3. An ADR's own status agrees with the index table ──────────────────────

const DECISIONS = join(PLANS, 'decisions');
const decisionsIndex = join(DECISIONS, 'README.md');

/** `- **Status:** Accepted — note` → `accepted`. */
function statusOf(file: string): string | undefined {
  const text = readFileSync(file, 'utf8');
  const match = /^\s*[-*]?\s*\*\*Status:\*\*\s*\**([A-Za-z]+)/mu.exec(text);
  return match?.[1]?.toLowerCase();
}

if (existsSync(decisionsIndex)) {
  const indexText = readFileSync(decisionsIndex, 'utf8');
  for (const file of markdown(DECISIONS)) {
    if (file === decisionsIndex) continue;
    const own = statusOf(file);
    if (own === undefined) {
      problems.push(`${rel(file)} — no \`**Status:**\` line in the front matter`);
      continue;
    }
    // The index row for this file: `| [`0001`](./0001-x.md) | Title | Accepted |`
    const row = new RegExp(
      `\\|\\s*\\[[^\\]]*\\]\\(\\./${basename(file).replaceAll('.', '\\.')}\\)[^|]*\\|[^|]*\\|\\s*\\**([A-Za-z]+)`,
      'u',
    ).exec(indexText);
    if (row === null) continue; // already reported by check 2
    const claimed = row[1]?.toLowerCase() ?? '';
    if (claimed !== own && !claimed.startsWith(own)) {
      problems.push(
        `plans/decisions/README.md says ${basename(file)} is "${claimed}", the file says "${own}"`,
      );
    }
  }
}

// ── 4. Every numbered plan document carries its four closing sections ───────

const REQUIRED: readonly (readonly [string, string])[] = [
  ['failure mode', 'Failure modes'],
  ['security', 'Security considerations'],
  ['open question', 'Open questions'],
  ['task index', 'Task index'],
];

for (const folder of ['modules', 'operations', 'architecture']) {
  for (const file of markdown(join(PLANS, folder))) {
    if (basename(file) === 'README.md') continue;
    const headings = [...readFileSync(file, 'utf8').matchAll(/^#{2,4}\s*(.+)$/gmu)].map((match) =>
      (match[1] ?? '').toLowerCase(),
    );
    const missing = REQUIRED.filter(
      ([needle]) => !headings.some((heading) => heading.includes(needle)),
    ).map(([, label]) => label);
    if (missing.length > 0) {
      problems.push(`${rel(file)} — missing section(s): ${missing.join(', ')}`);
    }
  }
}

// ── 5. A question id is defined once, and mentions elsewhere are references ─

/** `| Q12 | … |` — a definition. `` | `Q12` | … | `` — a reference to one defined elsewhere. */
const DEFINITION = /^\|\s*\**Q(\d+)\**\s*\|/u;

const definitions = new Map<number, string[]>();
for (const file of documents) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const match = DEFINITION.exec(line);
    if (match === null) continue;
    const id = Number(match[1]);
    const where = `${rel(file)}:${String(index + 1)}`;
    definitions.set(id, [...(definitions.get(id) ?? []), where]);
  }
}

for (const [id, places] of [...definitions].sort(([a], [b]) => a - b)) {
  if (places.length > 1) {
    problems.push(
      `Q${String(id)} is defined in ${String(places.length)} places: ${places.join(', ')}`,
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  process.stderr.write(`\nplans/ is inconsistent (${String(problems.length)})\n\n`);
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.stderr.write(
    '\n  Run `make links` too: a link that resolves is not the same as one that is indexed.\n\n',
  );
  process.exit(1);
}

const adrs = markdown(DECISIONS).length - 1;
const questions = definitions.size;
process.stdout.write(
  `✓ plans/ is consistent (${String(documents.length)} documents, ${String(adrs)} ADRs, ` +
    `${String(questions)} open questions: indexed, linked, statuses agree, sections complete)\n`,
);
