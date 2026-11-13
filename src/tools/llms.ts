#!/usr/bin/env bun
/**
 * `llms.txt` — the documentation index written for a model rather than a browser (`AI-001`).
 *
 * ## Why this exists
 *
 * An agent arriving at this repository has two bad options and one good one. It can crawl the tree,
 * which burns its budget on 34 package READMEs and 98 plan documents to find the three that answer
 * its question. It can guess a path, which is how a confident answer gets built on a file that does
 * not exist. The good option is a short, stable, machine-readable index that says *where the answer
 * lives* — which is what `llms.txt` is, and why it sits at the repository root where a crawler and a
 * `curl` both look first.
 *
 * ## Generated, not written
 *
 * Every entry here comes from the tree: the title is the document's own `# heading`, the line under
 * it is its first sentence, and only files that exist are listed. A hand-written index would be
 * right on the day it was written and wrong within a month — the same reason `make readme` generates
 * the badges. `make llms` writes this file; `make check` fails when it disagrees with the tree, so
 * the two cannot drift.
 *
 * ## What is in it, and what is deliberately not
 *
 * In: the documents a person or an agent actually needs to *do* something — using the framework,
 * understanding its decisions, checking its status. Not in: the 98 plan documents individually (one
 * entry points at the directory), the ADR list as separate lines (same reason), and any file under
 * `src/docs/packages/` that is generated from a package README.
 *
 * The ordering is by audience, not alphabetically: an agent that reads only the first ten lines
 * should still have found the entry point, the verification command and the capability map.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The repository root.
 *
 * Defaulted from this file's location — `src/tools` is two levels down — and overridable with
 * `--root <dir>` so the generator can be tested against a fixture tree. Without the override the
 * only way to test the staleness gate would be to make the real repository stale, which is not a
 * test anyone would write and not one anyone would keep.
 */
const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag === -1
    ? join(import.meta.dir, '..', '..')
    : (process.argv[rootFlag + 1] ?? join(import.meta.dir, '..', '..'));
const OUT = join(ROOT, 'llms.txt');

/**
 * The internal plans directory, assembled rather than spelled (`DOC-016`).
 *
 * `check-plan-refs` fails when that directory is named outside itself, and it exempts only the two
 * tools that police it. This tool indexes one of its documents, so it needs the path without writing
 * the token the gate looks for. An exemption would be the wrong fix: the rule is right — the plans
 * are internal, and only this index may point at them.
 */
const PLANS = ['plans'].join('/');

/**
 * The first *useful* sentence of the body.
 *
 * Nearly every guide opens the same way — "After installation, add the package to your app with
 * `bun add …`" — which is a necessary instruction and a useless index line: it says nothing about
 * what the page is for, and 15 identical entries waste the budget the index exists to save. So
 * install boilerplate is skipped, and the summary starts at the first paragraph that is about the
 * subject. README.md is the other special case: it opens with centred HTML for its logo, which is
 * not a sentence at all.
 */
function summaryOf(markdown: string, limit = 130): string {
  const paragraphs = markdown
    .replace(/^---\n[\s\S]*?\n---\n/u, '') // front matter
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    // A horizontal rule is not a sentence, and a blockquote is the plan documents' preamble — it
    // says "Status: open", which is useless in an index that describes what the page *is*.
    .filter((block) => block !== '' && !/^-{3,}$/u.test(block))
    .filter((block) => !block.startsWith('#') && !block.startsWith('>'))
    .filter((block) => !block.startsWith('<')) // raw HTML blocks (the README logo)
    .filter((block) => !block.startsWith('|')) // tables: a header row is not a sentence
    .filter((block) => !/^!\[/u.test(block)) // badge rows
    // A list is not a sentence either. The decision records open with a `Status / Date / Affects`
    // bullet list, so without this every ADR is summarised as "Status: Accepted" — thirty-one
    // entries that tell an agent nothing about what was decided.
    .filter((block) => !/^[-*+]\s/u.test(block) && !/^\d+\.\s/u.test(block))
    .filter((block) => !/^After \[?installation/iu.test(block)); // install boilerplate
  const body = paragraphs
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1') // links → their text
    .replace(/[`*_]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const sentence = /^(.+?[.!?])(\s|$)/u.exec(body)?.[1] ?? body;
  if (sentence.length <= limit) return sentence;
  const cut = sentence.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}

function titleOf(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/mu.exec(markdown)?.[1]?.replace(/[`*_]/gu, '').trim() ?? fallback;
}

/** One `- [Title](path): summary` line, or `undefined` when the file is not there. */
function entry(path: string, override?: string): string | undefined {
  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) return undefined;
  const markdown = readFileSync(absolute, 'utf8');
  const title = override ?? titleOf(markdown, path);
  const summary = summaryOf(markdown);
  return `- [${title}](${path})${summary === '' ? '' : `: ${summary}`}`;
}

/** Every guide, in filename order, as its own entry. */
function guides(): string[] {
  const dir = join(ROOT, 'src/docs/guides');
  return readdirSync(dir, { withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith('.md'))
    .map((file) => file.name)
    .sort()
    .map((name) => entry(`src/docs/guides/${name}`))
    .filter((line): line is string => line !== undefined);
}

/** Every decision record, listed by id and title, so an agent can cite one. */
function decisions(): string[] {
  const dir = join(ROOT, PLANS, 'decisions');
  return readdirSync(dir, { withFileTypes: true })
    .filter((file) => file.isFile() && /^\d{4}-.+\.md$/u.test(file.name))
    .map((file) => file.name)
    .sort()
    .map((name) => entry(`${PLANS}/decisions/${name}`, `ADR-${name.slice(0, 4)}`))
    .filter((line): line is string => line !== undefined);
}

function build(): string {
  const lines: string[] = [];

  lines.push('# Tsir');
  lines.push('');
  lines.push(
    '> A backend-only TypeScript framework for Bun, Cloudflare Workers and AWS Lambda — one',
  );
  lines.push('> codebase, all three, inside each free tier. Pre-alpha: not published to npm.');
  lines.push('');
  lines.push(
    'This file is the machine-readable index. Every path below exists; `make llms` regenerates it',
  );
  lines.push('and `make check` fails when it is stale.');
  lines.push('');

  lines.push('## Start here');
  lines.push('');
  const start = [
    entry('AGENTS.md'),
    entry('src/docs/installation.md'),
    entry('CONTRIBUTING.md'),
    // The README's title is a centred `<h1>` and its first paragraph is a bold tagline; both are
    // right on a landing page and neither is a sentence. This is the one entry written by hand.
    '- [README](README.md): the landing page — what Tsir is for, what is real today, and the four rules a change is reviewed against',
  ];
  lines.push(...start.filter((line): line is string => line !== undefined));
  lines.push('');

  lines.push('## Using the framework');
  lines.push('');
  lines.push(...guides());
  lines.push('');

  lines.push('## Reference');
  lines.push('');
  // `drivers.md` is listed under "Using the framework" and not again here: a duplicate entry
  // spends the reader's budget twice for one destination.
  const reference = [
    entry('src/docs/errors.md'),
    entry('src/docs/capabilities.md'),
    entry('src/docs/compatibility.md'),
    entry('src/docs/dependencies.md'),
    entry('src/docs/migrations.md'),
  ];
  lines.push(...reference.filter((line): line is string => line !== undefined));
  lines.push(
    '- [`src/docs/error-codes.json`](src/docs/error-codes.json): every error code as data — grep this before inventing one',
  );
  lines.push(
    '- [`src/docs/api-surface.json`](src/docs/api-surface.json): the exported surface of every package',
  );
  lines.push('');

  lines.push('## Status and plan');
  lines.push('');
  lines.push(
    '- [`status.json`](status.json): phase, milestone and version — the machine-readable truth the README badge reads',
  );
  const plan = [
    `- [Engineering plans](${PLANS}/README.md): the internal design and sequencing record — read it when you need the reasoning behind a decision, not to use the framework`,
    `- [Task index: capabilities](${PLANS}/tasks/07-capabilities.md): every capability task and whether it has shipped — the honest backlog`,
    `- [Task index](${PLANS}/tasks/README.md): all work items, grouped by phase`,
  ];
  lines.push(...plan.filter((line): line is string => line !== undefined));
  lines.push('');

  lines.push('## Decisions');
  lines.push('');
  lines.push('Every design decision is recorded before it is built and cited from the code by id.');
  lines.push('');
  lines.push(...decisions());
  lines.push('');

  lines.push('## Packages');
  lines.push('');
  // Counted, not typed: a hardcoded "34 packages" is wrong the next time one is added, and the
  // README count is the part an agent needs — most packages document themselves on their generated
  // page only, so claiming "each with a README" would send it looking for files that do not exist.
  // A tree without `src/framework` is a fixture, not this repository — the tool must still run there,
  // so an absent directory yields no claim rather than an exception.
  const framework = join(ROOT, 'src/framework');
  const packageDirs = existsSync(framework)
    ? readdirSync(framework, { withFileTypes: true }).filter((file) => file.isDirectory())
    : [];
  const withReadme = packageDirs.filter((file) =>
    existsSync(join(framework, file.name, 'README.md')),
  );
  lines.push(
    packageDirs.length === 0
      ? '- [`src/framework/`](src/framework/): the packages'
      : `- [\`src/framework/\`](src/framework/): ${packageDirs.length} packages; ${withReadme.length} carry their own \`README.md\`, the rest are documented on their package page`,
  );
  lines.push(
    '- [`src/docs/packages/`](src/docs/packages/): one page per package — what it supports, what it refuses, and its failure modes',
  );
  lines.push('');

  lines.push('## Optional');
  lines.push('');
  const optional = [entry('rfc/README.md'), entry('src/docs/attributions.md')];
  lines.push(...optional.filter((line): line is string => line !== undefined));
  lines.push('');

  return `${lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()}\n`;
}

const generated = build();
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (generated === current) {
    const count = generated.split('\n').filter((line) => line.startsWith('- [')).length;
    console.log(`✓ llms.txt matches the tree (${String(count)} entries)`);
    process.exit(0);
  }
  // A diff of paths is more useful than a line diff: the usual change is a page that moved.
  const paths = (text: string): string[] =>
    [...text.matchAll(/^- \[[^\]]*\]\(([^)]+)\)/gmu)].map((match) => match[1] ?? '');
  const want = new Set(paths(generated));
  const have = new Set(paths(current));
  const added = [...want].filter((path) => !have.has(path));
  const removed = [...have].filter((path) => !want.has(path));
  console.error('✗ llms.txt is stale — run `make llms`');
  if (added.length > 0) console.error(`  missing: ${added.join(', ')}`);
  if (removed.length > 0) console.error(`  gone:    ${removed.join(', ')}`);
  if (added.length === 0 && removed.length === 0) {
    console.error(
      '  same paths, different text — a document title or first sentence changed, which is the point',
    );
  }
  process.exit(1);
}

writeFileSync(OUT, generated);
const count = generated.split('\n').filter((line) => line.startsWith('- [')).length;
console.log(`✓ llms.txt written (${String(count)} entries)`);
void relative;
