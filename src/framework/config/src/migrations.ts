/**
 * Config-format migrations (CFG-106, CFG-122).
 *
 * Each step moves a project file from one format version to the next. A step is a pure function
 * over the file's object, so it can be snapshot-tested without touching disk. The file itself is
 * not rewritten here: `tsir bootstrap --migrate-config` prints the migrated block, and the user
 * applies it, because the flat block is unmanaged text.
 */

import { TsirError } from '@tsir/container';

import { PROJECT_FORMAT_VERSION } from './project-file.ts';

export type ProjectValue = Readonly<Record<string, unknown>>;

export interface ProjectMigration {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly migrate: (raw: ProjectValue) => ProjectValue;
}

function isRecord(value: unknown): value is ProjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Name given to the connection a flat `database` block becomes. */
export const FLAT_CONNECTION_NAME = 'primary';

/**
 * Format 1 → 2. `database: { driver, url, binding, journal, … }` becomes
 * `database: { default: 'primary', connections: { primary: { driver, url, binding, … } } }`.
 * Every value is carried over unchanged; only the position moves.
 */
export function flatDatabaseToRegistry(raw: ProjectValue): ProjectValue {
  const database = raw['database'];
  if (!isRecord(database) || database['driver'] === undefined) return raw;
  if (database['connections'] !== undefined) return raw;
  return {
    ...raw,
    database: {
      default: FLAT_CONNECTION_NAME,
      connections: { [FLAT_CONNECTION_NAME]: { ...database } },
    },
  };
}

export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [
  {
    id: 'flat-database-to-registry',
    from: 1,
    to: 2,
    migrate: flatDatabaseToRegistry,
  },
];

/** The format a file is written in. A file with no flat database block is already current. */
export function detectProjectFormat(raw: ProjectValue): number {
  const database = raw['database'];
  if (isRecord(database) && database['driver'] !== undefined) return 1;
  return PROJECT_FORMAT_VERSION;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  /** Ids of the steps that ran, in order. Empty when the file is already current. */
  readonly steps: readonly string[];
  readonly value: ProjectValue;
}

/** Runs every step from the file's format up to the current one. Throws if a step is missing. */
export function migrateProject(raw: ProjectValue): MigrationResult {
  const from = detectProjectFormat(raw);
  let value = raw;
  let version = from;
  const steps: string[] = [];
  while (version < PROJECT_FORMAT_VERSION) {
    const step = PROJECT_MIGRATIONS.find((candidate) => candidate.from === version);
    if (step === undefined) {
      throw new TsirError('CFG_INVALID', `no migration from format ${String(version)}`, {
        kind: 'config',
        context: { format: version },
      });
    }
    value = step.migrate(value);
    steps.push(step.id);
    version = step.to;
  }
  return { from, to: version, steps, value };
}

/** Renders a value as a JS object literal, with keys unquoted when they are identifiers. */
export function renderLiteral(value: unknown, indent = ''): string {
  if (typeof value === 'string') return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderLiteral(item, indent)).join(', ')}]`;
  }
  if (isRecord(value)) {
    const inner = `${indent}  `;
    const entries = Object.entries(value).map(([key, item]) => {
      const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : `'${key}'`;
      return `${inner}${name}: ${renderLiteral(item, inner)},`;
    });
    return entries.length === 0 ? '{}' : `{\n${entries.join('\n')}\n${indent}}`;
  }
  return 'undefined';
}
