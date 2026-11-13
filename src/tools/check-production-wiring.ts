/**
 * Every capability a real app bootstraps must pass `production` (`CAP-007`).
 *
 * The guards in cache, queue, mail, storage, notify, broadcast, search and media are all
 * implemented, all tested, and all keyed on `options.production`. For as long as nothing passed it,
 * they were unreachable — an app deployed with a `memory` cache worked exactly as before, because
 * the code that would have said no was never asked.
 *
 * That is not a bug in any one bootstrap; it is a property of the *set* of them, which is what this
 * gate checks. It reads the apps under `src/apps` — code we ship as an example and an application
 * we deploy — and fails when a bootstrap call does not pass `production`. It cannot see a
 * bootstrap built in a consumer's application, and it does not pretend to: the framework's job is
 * to make the correct call the easy one and to keep our own examples honest, not to police a file
 * we never read.
 *
 *   bun src/tools/check-production-wiring.ts        # gate (CI, `make check`)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The bootstraps that accept `production`, and the package each comes from. */
export const PRODUCTION_AWARE_BOOTSTRAPS: readonly string[] = [
  'createCacheBootstrap',
  'createQueueBootstrap',
  'createMailBootstrap',
  'createStorageBootstrap',
  'createNotifyBootstrap',
  'createBroadcastBootstrap',
  'createScoutBootstrap',
  'createMediaBootstrap',
  // `createDatabaseBootstrap` is deliberately absent: it has no `production` option, and it does
  // not need one. Every way it could resolve to nothing is already refused at boot — a `d1`
  // connection with no binding is `DB_D1_NO_BINDING`, a url connection with no url is
  // `DB_URL_REQUIRED`, and `mysql` is refused by the ports whose SQL it cannot speak. Listing it
  // here would be a gate asking for a flag that does not exist.
];

export interface WiringGap {
  readonly file: string;
  readonly line: number;
  readonly call: string;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // `node_modules` holds linked copies of the *framework*, including the bootstrap definitions
    // themselves. Walking it would report our own declarations as an application's mistake, 185
    // times, and teach the reader to ignore the gate.
    if (entry === 'node_modules' || entry === '.tsir' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(path);
  }
  return out;
}

/**
 * The text of the call starting at `index`, from its `(` to the matching `)`.
 *
 * A regex cannot do this: the argument object contains strings, comments and nested calls, and a
 * `[^)]*` match stops at the first inner parenthesis — which is how a check like this ends up
 * passing while the real call is wrong.
 */
function callText(text: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return text.slice(openIndex);
}

/**
 * `text` with comments blanked, keeping every newline so line numbers still line up.
 *
 * A `production:` written inside a comment is not an argument, and reading it as one would certify
 * a call that the guard would still refuse. Blanking rather than deleting keeps the line numbers
 * the report prints honest.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '))
    .replace(
      /(^|[^:\\])\/\/[^\n]*/gu,
      (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length),
    );
}

/** Every bootstrap call in `file`'s text that does not pass `production`. */
export function findUnwiredBootstraps(file: string, raw: string): WiringGap[] {
  const text = withoutComments(raw);
  const gaps: WiringGap[] = [];
  for (const name of PRODUCTION_AWARE_BOOTSTRAPS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(name, from);
      if (at === -1) break;
      from = at + name.length;
      // Skip the import and the declaration: only a call has an opening parenthesis next (or
      // after whitespace). A `function createCacheBootstrap(` is the declaration, and this file
      // lives outside `src/apps`, so it can never be the definition being read.
      const open = text.indexOf('(', from);
      if (open === -1) continue;
      if (text.slice(from, open).trim() !== '') continue;
      // A declaration (`export function createCacheBootstrap(`) has no production flag by
      // definition. Only a call site is the subject here.
      const before = text.slice(Math.max(0, at - 20), at);
      if (/\bfunction\s+$/u.test(before)) continue;
      const body = callText(text, open);
      if (/\bproduction\s*:/u.test(body)) continue;
      const line = text.slice(0, at).split('\n').length;
      gaps.push({ file, line, call: name });
    }
  }
  return gaps;
}

/** Every app file under `root` that bootstraps a capability without the production flag. */
export function checkProductionWiring(root: string): WiringGap[] {
  const apps = join(root, 'src', 'apps');
  const gaps: WiringGap[] = [];
  let files: string[];
  try {
    files = sources(apps);
  } catch {
    // No apps directory is not a failure: the gate has nothing to say.
    return gaps;
  }
  for (const file of files) {
    gaps.push(
      ...findUnwiredBootstraps(
        relative(root, file).split(sep).join('/'),
        readFileSync(file, 'utf8'),
      ),
    );
  }
  return gaps.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const gaps = checkProductionWiring(root);

  if (gaps.length === 0) {
    console.log(
      `✓ every app bootstrap passes \`production\` (${String(PRODUCTION_AWARE_BOOTSTRAPS.length)} bootstraps, CAP-007)`,
    );
  } else {
    for (const gap of gaps) {
      console.error(`✗ ${gap.file}:${String(gap.line)} — ${gap.call} does not pass \`production\``);
    }
    console.error(
      `\n${String(gaps.length)} bootstrap(s). Pass \`production: isProduction()\` from @tsir/core, or the` +
        ' guard that package implements can never fire.',
    );
    process.exit(1);
  }
}
