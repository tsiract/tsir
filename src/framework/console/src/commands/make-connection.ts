/**
 * `tsir make:connection <name> --kind <kind> --driver <driver>` (CLI-017).
 *
 * Adds exactly one entry to a named registry (ADR-0019): a database connection, cache store,
 * queue connection, storage disk, or mailer. The entry goes inside a managed region that the
 * command creates on first use (`managed:<section>.<entries>`), so the rest of `tsir.js` keeps
 * its comments and its order. A second entry lands in the same region.
 *
 * A D1 binding is only accepted when `wrangler.toml` declares it under `[[d1_databases]]`.
 * Otherwise the project would boot with a binding that does not exist at deploy time.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DRIVERS } from '@tsir/cache';
import { managedRegions, renderLiteral, renderRegion } from '@tsir/config';
import { DATABASE_ENGINES } from '@tsir/database';
import { MAIL_DRIVERS } from '@tsir/mail';
import { QUEUE_DRIVERS } from '@tsir/queue';
import { STORAGE_DRIVERS } from '@tsir/storage';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, info, ok, style, UsageError } from '../output.ts';
import { findConfigFile } from '../project.ts';

export interface KindSpec {
  /** The top-level section in `tsir.js`, e.g. `database`. */
  readonly section: string;
  /** The key under the section that holds the entries, e.g. `connections`. */
  readonly entries: string;
  readonly drivers: readonly string[] | undefined;
}

/**
 * The driver list for each kind comes from the package that owns the registry, never from a copy.
 *
 * It said `['d1', 'postgres', 'mysql']` here while `DATABASE_ENGINES` was `['d1', 'postgres']`, so
 * `--driver mysql` wrote a `tsir.js` that the schema rejected at boot — the command validated
 * against a list that was not the list. A driver added to a package is now writable by the command
 * the same day, and one removed stops being writable.
 */
export const KINDS: Readonly<Record<string, KindSpec>> = {
  database: { section: 'database', entries: 'connections', drivers: DATABASE_ENGINES },
  cache: { section: 'cache', entries: 'stores', drivers: CACHE_DRIVERS },
  queue: { section: 'queue', entries: 'connections', drivers: QUEUE_DRIVERS },
  storage: { section: 'storage', entries: 'disks', drivers: STORAGE_DRIVERS },
  mail: { section: 'mail', entries: 'mailers', drivers: MAIL_DRIVERS },
};

const NAME = /^[a-z][a-z0-9-]*$/u;

/** The D1 bindings a `wrangler.toml` declares: `binding = "X"` inside a `[[d1_databases]]` table. */
export function declaredD1Bindings(toml: string): readonly string[] {
  const bindings: string[] = [];
  let inD1 = false;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inD1 = line === '[[d1_databases]]';
      continue;
    }
    const match = /^binding\s*=\s*"([^"]+)"/u.exec(line);
    if (inD1 && match?.[1] !== undefined) bindings.push(match[1]);
  }
  return bindings;
}

/** The entry object one command adds, validated for its kind. */
export function entryFor(
  kind: string,
  driver: string,
  options: {
    binding?: string | undefined;
    urlEnv?: string | undefined;
    connection?: string | undefined;
  },
): Record<string, unknown> {
  const spec = KINDS[kind];
  if (spec === undefined) {
    throw new UsageError(`unknown kind "${kind}"`, `use one of: ${Object.keys(KINDS).join(', ')}`);
  }
  if (spec.drivers !== undefined && !spec.drivers.includes(driver)) {
    throw new UsageError(
      `"${driver}" is not a ${kind} driver`,
      `use one of: ${spec.drivers.join(', ')}`,
    );
  }
  if (driver === 'd1') {
    if (kind !== 'database') {
      throw new UsageError('D1 is a database driver', 'use --kind database');
    }
    if (options.binding === undefined) {
      throw new UsageError('a D1 connection needs --binding', 'the name in wrangler.toml, e.g. DB');
    }
    return { driver, binding: options.binding };
  }
  if (options.binding !== undefined) {
    throw new UsageError('--binding is only for D1', 'postgres and mysql take --url-env');
  }
  if (kind === 'database') {
    if (options.urlEnv === undefined) {
      throw new UsageError(
        `a ${driver} connection needs --url-env`,
        'the environment variable that holds the URL, e.g. DATABASE_URL',
      );
    }
    return { driver, url: { fromEnv: options.urlEnv } };
  }
  return options.connection === undefined ? { driver } : { driver, connection: options.connection };
}

/** Checks the D1 binding against `wrangler.toml` at the project root. */
export function requireDeclaredBinding(root: string, binding: string): void {
  const path = join(root, 'wrangler.toml');
  if (!existsSync(path)) {
    throw new UsageError(
      `cannot use D1 binding "${binding}": no wrangler.toml at the project root`,
      'add the [[d1_databases]] table to wrangler.toml first, or use a different driver',
    );
  }
  const declared = declaredD1Bindings(readFileSync(path, 'utf8'));
  if (!declared.includes(binding)) {
    throw new UsageError(
      `wrangler.toml does not declare the D1 binding "${binding}"`,
      declared.length === 0
        ? 'wrangler.toml has no [[d1_databases]] table'
        : `declared: ${declared.join(', ')}`,
    );
  }
}

function keyText(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : `'${name}'`;
}

/**
 * Returns `source` with `name` added to the entries of `kind`. The first call inserts the
 * region right after `<entries>: {`; later calls add a line to it. Throws when the section or its
 * entries key is missing, or when the name already exists.
 */
export function insertEntry(
  source: string,
  kind: string,
  name: string,
  entry: Readonly<Record<string, unknown>>,
): string {
  const spec = KINDS[kind];
  if (spec === undefined) throw new UsageError(`unknown kind "${kind}"`);
  const lines = source.split('\n');
  const sectionAt = lines.findIndex((line) =>
    new RegExp(`^ {2}${spec.section}: \\{\\s*$`, 'u').test(line),
  );
  if (sectionAt === -1) {
    throw new UsageError(
      `tsir.js has no \`${spec.section}\` block`,
      `add \`${spec.section}: { default: '${name}', ${spec.entries}: {} }\` to the export, then run this again`,
    );
  }
  const entriesAt = lines.findIndex(
    (line, index) =>
      index > sectionAt && new RegExp(`^ {4}${spec.entries}: \\{\\s*$`, 'u').test(line),
  );
  if (entriesAt === -1) {
    throw new UsageError(
      `\`${spec.section}\` has no \`${spec.entries}\` block`,
      `add \`${spec.entries}: {}\` inside \`${spec.section}\`, then run this again`,
    );
  }
  // The entries block ends at the first line that closes it: four spaces, a brace.
  let closeAt = lines.length;
  for (let index = entriesAt + 1; index < lines.length; index += 1) {
    if (/^ {4}\},?\s*$/u.test(lines[index] ?? '')) {
      closeAt = index;
      break;
    }
  }
  const block = lines.slice(entriesAt + 1, closeAt);
  const key = keyText(name);
  if (block.some((line) => line.startsWith(`      ${key}:`))) {
    throw new UsageError(
      `${spec.section}.${spec.entries} already has "${name}"`,
      'pick another name',
    );
  }

  const id = `${spec.section}.${spec.entries}`;
  // The entry as body lines, unindented: renderRegion and the region splice add the indent.
  const body = `${key}: ${renderLiteral(entry)},`.split('\n');
  const existing = managedRegions(source).find((region) => region.id === id);
  if (existing !== undefined) {
    // New entries go at the end of the region, just before its closing fence.
    const indented = body.map((line) => (line === '' ? '' : `      ${line}`));
    lines.splice(existing.end, 0, ...indented);
    return lines.join('\n');
  }
  // A new region goes last in the block, so existing entries keep their order.
  lines.splice(closeAt, 0, ...renderRegion(id, body, '      ').split('\n'));
  return lines.join('\n');
}

/** `tsir make:connection <name> --kind <kind> --driver <driver> [...]`. */
export async function makeConnectionCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--kind': { type: 'string', description: 'database, cache, queue, storage or mail' },
    '--driver': { type: 'string', description: 'd1, postgres or mysql for a database' },
    '--binding': { type: 'string', description: 'D1 binding (must be in wrangler.toml)' },
    '--url-env': { type: 'string', description: 'environment variable holding the URL' },
    '--connection': {
      type: 'string',
      description: 'the database connection a cache or queue uses',
    },
    '--dry-run': { type: 'boolean', description: 'print the change, write nothing' },
  });
  const name = args.positionals[0];
  if (name === undefined) {
    throw new UsageError('tsir make:connection <name> --kind <kind> --driver <driver>');
  }
  if (!NAME.test(name)) {
    throw new UsageError(`"${name}" is not a valid connection name`, 'use lowercase kebab-case');
  }
  const kind = stringFlag(args, '--kind');
  const driver = stringFlag(args, '--driver');
  if (kind === undefined || driver === undefined) {
    throw new UsageError(
      '--kind and --driver are required',
      'e.g. --kind database --driver d1 --binding DB',
    );
  }
  const binding = stringFlag(args, '--binding');
  const root = process.cwd();
  const configPath = findConfigFile(root);
  const entry = entryFor(kind, driver, {
    binding,
    urlEnv: stringFlag(args, '--url-env'),
    connection: stringFlag(args, '--connection'),
  });
  if (driver === 'd1') requireDeclaredBinding(root, binding ?? '');

  const source = readFileSync(configPath, 'utf8');
  const next = insertEntry(source, kind, name, entry);
  const spec = KINDS[kind];
  const shown = configPath.slice(root.length + 1);
  if (boolFlag(args, '--dry-run')) {
    info(`  ${style.dim('would add')} ${name} to ${spec?.section}.${spec?.entries} in ${shown}`);
    return EXIT.ok;
  }
  writeFileSync(configPath, next, 'utf8');
  ok(`added ${name} to ${spec?.section}.${spec?.entries} in ${shown}`);
  info(
    `  ${style.dim('next:')} set ${spec?.section}.default to "${name}" if it should be the default`,
  );
  return EXIT.ok;
}
