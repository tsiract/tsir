/**
 * Frontpage truthfulness checks (DOC-004, DOC-005).
 *
 * The marketing page is allowed to be ambitious about what Tsir will do — but it
 * must never describe the repository as further along than it is. These checks
 * are mechanical, so the page cannot drift away from `src/framework/` unnoticed:
 *
 *   1. a card claiming `implemented` must have a package directory on disk;
 *   2. a card claiming `designed`/`planned` must NOT have one;
 *   3. every `data-src` path must exist;
 *   4. the page must contain no unqualified superlatives.
 *
 * Exits non-zero with a file-and-line reference for each violation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = 'src/apps/frontpage/public/index.html';
const html = readFileSync(PAGE, 'utf8');

interface Card {
  readonly pkg: string;
  readonly status: string;
  readonly phase: string;
  readonly src: string;
  readonly line: number;
}

function lineOf(index: number): number {
  return html.slice(0, index).split('\n').length;
}

function cards(): Card[] {
  const found: Card[] = [];
  const article = /<article\b[^>]*>[\s\S]*?<\/article>/g;

  for (const match of html.matchAll(article)) {
    const body = match[0];
    const offset = match.index ?? 0;
    const attr = (name: string): string => new RegExp(`${name}="([^"]*)"`).exec(body)?.[1] ?? '';
    const pkg = /<span class="pkg">([^<]+)<\/span>/.exec(body)?.[1] ?? '(unnamed)';

    found.push({
      pkg,
      status: attr('data-status'),
      phase: attr('data-phase'),
      src: attr('data-src'),
      line: lineOf(offset),
    });
  }
  return found;
}

/** `@tsir/core` → `src/framework/core`; `tsir.js` has no package of its own. */
function directoryFor(pkg: string): string | undefined {
  if (!pkg.startsWith('@tsir/')) return undefined;
  return join('src', 'framework', pkg.slice('@tsir/'.length).split('/')[0] ?? '');
}

const problems: string[] = [];
const all = cards();

if (all.length === 0) problems.push(`${PAGE}: no ecosystem cards found`);

for (const card of all) {
  const dir = directoryFor(card.pkg);
  const exists = dir !== undefined && existsSync(join(dir, 'package.json'));

  if (card.status === 'implemented' && !exists) {
    problems.push(
      `${PAGE}:${String(card.line)} — ${card.pkg} is marked "implemented" but ${dir ?? 'no package'} does not exist`,
    );
  }
  if ((card.status === 'designed' || card.status === 'planned') && exists) {
    problems.push(
      `${PAGE}:${String(card.line)} — ${card.pkg} is implemented in ${dir ?? ''} but the card says "${card.status}"`,
    );
  }
  if (!['implemented', 'partial', 'designed', 'planned'].includes(card.status)) {
    problems.push(`${PAGE}:${String(card.line)} — ${card.pkg} has unknown status "${card.status}"`);
  }
  if (card.src !== '' && !existsSync(card.src)) {
    problems.push(
      `${PAGE}:${String(card.line)} — ${card.pkg} points at missing source ${card.src}`,
    );
  }
}

// ── Claims that need evidence, not adjectives ──────────────────────────────
const BANNED: readonly (readonly [RegExp, string])[] = [
  [
    /\b(fastest|quickest|most secure|safest|most typed|best[- ]in[- ]class|world[- ]class)\b/gi,
    'superlative',
  ],
  [/\bblazing(ly)?[- ]fast\b/gi, 'benchmark-free claim'],
  [/\b\d+(\.\d+)?x (faster|smaller|safer)\b/gi, 'unmeasured multiplier'],
  [/\b(guarantees?|guaranteed) (security|performance|zero|no)\b/gi, 'unqualified guarantee'],
  [/\bproduction[- ]ready\b/gi, 'pre-alpha repository'],
];

const text = html.replace(/<[^>]+>/g, ' ');
for (const [pattern, label] of BANNED) {
  for (const match of text.matchAll(pattern)) {
    const before = html.slice(0, html.indexOf(match[0]));
    problems.push(`${PAGE}:${String(lineOf(before.length))} — banned ${label}: "${match[0]}"`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`\nfrontpage check failed (${String(problems.length)})\n\n`);
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(
  `✓ frontpage honest (${String(all.length)} cards: ` +
    `${String(all.filter((c) => c.status === 'implemented').length)} implemented, ` +
    `${String(all.filter((c) => c.status === 'partial').length)} partial)\n`,
);
