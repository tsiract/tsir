import { TsirError } from '@tsir/container';
import { inlinedSecrets } from './secrets.ts';

/**
 * Validation for the shape of a project file (`tsir.js`), before any value is read.
 *
 * Three rules, all pure so the console loader, `tsir doctor`, and tests share one answer:
 *
 *   1. **Unknown keys are refused** (`CFG_UNKNOWN_KEY`) unless the file sets `strict: false`.
 *      A typo like `databse` must not be silently dropped. A near miss gets a suggestion.
 *   2. **A named registry has a valid default** (`CFG_MISSING_DEFAULT`, `CFG_UNKNOWN_DEFAULT`).
 *      Every database, cache, and queue that is used by name needs an explicit default, so
 *      nothing is chosen by declaration order.
 *   3. **A connection has one transport** (`CFG_AMBIGUOUS_CONNECTION`). A D1 `binding` and a
 *      Postgres/MySQL `url` cannot both be set.
 *
 * The flat `database: { driver, … }` form (before registries) is refused with
 * `CFG_CONFIG_VERSION_STALE`. `tsir bootstrap --migrate-config` rewrites it.
 */

/** The current format. Format 1 was the flat database block; format 2 is registries. */
export const PROJECT_FORMAT_VERSION = 2;

/** Keys a project file may set at the top level. Anything else is an error. */
export const PROJECT_TOP_LEVEL_KEYS: readonly string[] = [
  'app',
  'console',
  'deploy',
  'database',
  'cache',
  'queue',
  'storage',
  'mail',
  'notify',
  'broadcast',
  'search',
  'schedule',
  'paths',
  'modules',
  'moduleDefaults',
  'http',
  'vault',
  'presets',
  'strict',
];

/**
 * Every named registry: the section, and the key its entries live under. Each one has a `default`
 * and entries, and each is validated the same way (CFG-121).
 */
export const NAMED_REGISTRIES: readonly { readonly section: string; readonly entries: string }[] = [
  { section: 'database', entries: 'connections' },
  { section: 'cache', entries: 'stores' },
  { section: 'queue', entries: 'connections' },
  { section: 'storage', entries: 'disks' },
  { section: 'mail', entries: 'mailers' },
  { section: 'broadcast', entries: 'connections' },
  { section: 'search', entries: 'engines' },
];

/** Keys allowed inside each nested object that is validated (nested objects not listed are not checked). */
const NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  app: ['name', 'entry'],
  console: ['commands', 'topology', 'includeModules', 'units'],
  database: ['default', 'connections'],
  'database.connections.*': [
    'driver',
    'binding',
    'url',
    'journal',
    'logging',
    'slowQueryMs',
    'pool',
    'required',
  ],
  broadcast: ['default', 'connections'],
  'broadcast.connections.*': ['driver', 'connection', 'prefix', 'required'],
  search: ['default', 'engines'],
  'search.engines.*': [
    'driver',
    'connection',
    'collection',
    'host',
    'apiKey',
    'searchApiKey',
    'required',
  ],
};

/** The database connection-entry keys that carry a transport (binding or url). */
const TRANSPORT_KEYS = ['binding', 'url'] as const;

export interface NamedRegistry {
  /** Dotted section name for messages, e.g. `database`. */
  readonly section: string;
  readonly default?: unknown;
  readonly entries: Readonly<Record<string, unknown>>;
}

/** Levenshtein distance, small inputs only (keys). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** The nearest known key, or `undefined` when nothing is close enough to be a typo. */
export function suggestKey(name: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(name.length / 3))
    ? best
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeyLines(
  path: string,
  value: Record<string, unknown>,
  known: readonly string[],
): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(value).sort()) {
    if (known.includes(key)) continue;
    const near = suggestKey(key, known);
    const hint = near === undefined ? '' : ` (did you mean "${near}"?)`;
    lines.push(`${path === '' ? key : `${path}.${key}`}: unknown key${hint}`);
  }
  return lines;
}

/** Every unknown key in the file, with a nearest-key suggestion. Empty when the file is clean. */
export function unknownProjectKeys(raw: Readonly<Record<string, unknown>>): string[] {
  const lines = unknownKeyLines('', raw, PROJECT_TOP_LEVEL_KEYS);
  const app = raw['app'];
  if (isRecord(app)) lines.push(...unknownKeyLines('app', app, NESTED_KEYS['app'] ?? []));
  const consoleSection = raw['console'];
  if (isRecord(consoleSection)) {
    lines.push(...unknownKeyLines('console', consoleSection, NESTED_KEYS['console'] ?? []));
  }
  // Each registry is checked as a section, then entry by entry: `broadcast.connections.*` has its
  // own key list, and a `connections.realtime.prefix` the driver does not read is exactly the
  // typo this catch exists for.
  const nested: readonly (readonly [string, string])[] = [
    ['database', 'connections'],
    ['broadcast', 'connections'],
    ['search', 'engines'],
  ];
  for (const [section, entries] of nested) {
    const block = raw[section];
    if (!isRecord(block)) continue;
    lines.push(...unknownKeyLines(section, block, NESTED_KEYS[section] ?? []));
    const found = block[entries];
    if (!isRecord(found)) continue;
    for (const [name, entry] of Object.entries(found)) {
      if (!isRecord(entry)) continue;
      lines.push(
        ...unknownKeyLines(
          `${section}.${entries}.${name}`,
          entry,
          NESTED_KEYS[`${section}.${entries}.*`] ?? [],
        ),
      );
    }
  }
  return lines;
}

function list(names: readonly string[]): string {
  return names.length === 0 ? '(none declared)' : names.join(', ');
}

/**
 * Checks one named registry (database, cache, queue). Throws the first failing rule as a
 * `TsirError`, with the declared names in the hint so the fix is one edit.
 */
export function checkNamedRegistry(registry: NamedRegistry): void {
  const names = Object.keys(registry.entries);
  const context = { section: registry.section };
  if (registry.default === undefined) {
    throw new TsirError('CFG_MISSING_DEFAULT', `${registry.section} has no default connection`, {
      kind: 'config',
      hint: `set ${registry.section}.default to one of: ${list(names)}`,
      context,
    });
  }
  if (typeof registry.default !== 'string' || !names.includes(registry.default)) {
    throw new TsirError(
      'CFG_UNKNOWN_DEFAULT',
      `${registry.section}.default names ${JSON.stringify(registry.default) ?? 'undefined'}, which is not declared`,
      { kind: 'config', hint: `declared: ${list(names)}`, context },
    );
  }
  for (const name of names) {
    const entry = registry.entries[name];
    if (!isRecord(entry)) continue;
    const transports = TRANSPORT_KEYS.filter((key) => entry[key] !== undefined);
    if (transports.length > 1) {
      throw new TsirError(
        'CFG_AMBIGUOUS_CONNECTION',
        `${registry.section}.${name} sets both ${transports.join(' and ')}`,
        {
          kind: 'config',
          hint: 'keep one transport: a D1 binding, or a url for postgres and mysql',
          context: { section: registry.section, connection: name },
        },
      );
    }
  }
}

/**
 * Validates the whole project file. Throws the first failure: unknown keys, then the stale flat
 * database form, then the registries. Pass `strict: false` in the file to skip the key check.
 */
export function checkProjectFile(raw: Readonly<Record<string, unknown>>): void {
  const database = raw['database'];
  if (isRecord(database)) {
    if (database['driver'] !== undefined && database['connections'] === undefined) {
      throw new TsirError(
        'CFG_CONFIG_VERSION_STALE',
        'database uses the flat format (format 1), which this version no longer reads',
        {
          kind: 'config',
          hint: 'run tsir bootstrap --migrate-config to move it to database.connections',
          context: { format: 1, expected: PROJECT_FORMAT_VERSION },
        },
      );
    }
  }
  // CFG-016: a secret belongs in the environment. Every literal is listed by key path; the value is never printed.
  const secrets = inlinedSecrets(raw);
  if (secrets.length > 0) {
    throw new TsirError(
      'CFG_SECRET_INLINED',
      `tsir.js holds a secret literal, which must not be committed: ${secrets
        .map((secret) => `${secret.where} (${secret.kind})`)
        .join(', ')}`,
      {
        kind: 'config',
        hint: 'move each value to the environment and read it with { fromEnv: "NAME" }, then set NAME in .env',
        context: { secrets: secrets.length },
      },
    );
  }

  if (raw['strict'] !== false) {
    const lines = unknownProjectKeys(raw);
    if (lines.length > 0) {
      throw new TsirError('CFG_UNKNOWN_KEY', `tsir.js has unknown keys:\n${lines.join('\n')}`, {
        kind: 'config',
        hint: 'fix the key names, or set strict: false to allow them',
        context: { keys: lines.length },
      });
    }
  }
  for (const registry of NAMED_REGISTRIES) {
    const section = raw[registry.section];
    if (!isRecord(section)) continue;
    const found = section[registry.entries];
    const entries: Readonly<Record<string, unknown>> = isRecord(found) ? found : {};
    checkNamedRegistry({
      section: registry.section,
      ...(section['default'] === undefined ? {} : { default: section['default'] }),
      entries,
    });
  }
}
