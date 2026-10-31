/**
 * The journal (`MIG-002`, ADR-0007).
 *
 * Drizzle's `meta/_journal.json` stays authoritative: same file, same `when`
 * keys, same `__drizzle_migrations` table. Tsir does not invent a second journal,
 * because a second journal is a second truth — and the day they disagree is the
 * day nobody knows which one the production database followed.
 *
 * What Tsir adds is everything Drizzle's own applier leaves implicit: a checksum
 * per file (drift is a hard error), a per-migration transaction policy, and the
 * statements a file actually contains.
 *
 * The join key is `when`: Drizzle stores the journal entry's millisecond
 * timestamp as `created_at`, and that is the only durable link between a row in
 * `__drizzle_migrations` and a file on disk. The tag is not stored, which is why
 * renaming a migration file is safe and editing one is not.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One `entries[]` element of `meta/_journal.json`. */
export interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  /** Milliseconds since epoch. This — not `idx`, not `tag` — is the identity. */
  readonly when: number;
  readonly tag: string;
  readonly breakpoints?: boolean;
}

export interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly JournalEntry[];
}

/**
 * A journal entry joined with what is on disk, as far as the planner needs it.
 *
 * The planner takes this shape and nothing more, so a plan can be computed from
 * fixtures in a unit test without touching a filesystem.
 */
export interface MigrationFile {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly sql: string;
  /** SHA-256 of the file contents, hex. Compared against `__drizzle_migrations.hash`. */
  readonly checksum: string;
  /** `-- tsir:transaction=off` in the header. Default `true`. */
  readonly transaction: boolean;
}

/** A `MigrationFile` as read from a folder: statements, down sibling, warnings. */
export interface Migration extends MigrationFile {
  /** The file split on Drizzle's `--> statement-breakpoint` marker. */
  readonly statements: readonly string[];
  /** `<tag>.down.sql` when one was written. Rollback refuses without it. */
  readonly downPath?: string;
  /** The contents of `downPath`, read once so rollback does not re-read under a lock. */
  readonly downSql?: string;
  /** Non-fatal complaints about the file (an unknown transaction header, say). */
  readonly warnings: readonly string[];
}

/** Everything `migrate`, `migrate:status` and `migrate:rollback` read up front. */
export interface MigrationFolder {
  readonly folder: string;
  readonly journal: Journal;
  readonly migrations: readonly Migration[];
}

/** Thrown for anything that makes the journal unusable. */
export class JournalError extends Error {
  override readonly name = 'JournalError';
}

/** Where Drizzle keeps the ordered list, relative to a migrations folder. */
export const JOURNAL_PATH = 'meta/_journal.json';

const MARKER = '--> statement-breakpoint';
const HEADER = /^\s*--\s*tsir:transaction=(\w+)\s*$/i;

/**
 * `sha256` of the file text, hex.
 *
 * Drizzle's migrator hashes the SQL it reads (`__drizzle_migrations.hash`), so a
 * row written by `drizzle-kit migrate` compares equal here. The algorithm is not a
 * free choice: it is the one already in the table.
 */
export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Splits a migration into the statements it will run.
 *
 * The split uses Drizzle's own separator rather than a SQL parser. That is a
 * deliberate refusal: a regex that splits on `;` breaks on a `;` inside a string
 * literal or a `$$` body, and a migration runner that mangles SQL is worse than
 * one that requires the marker `drizzle-kit generate` already writes.
 */
export function splitStatements(sql: string): readonly string[] {
  return sql
    .split('\n')
    .filter((line) => !HEADER.test(line))
    .join('\n')
    .split(MARKER)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '');
}

export interface TransactionPolicy {
  /** False when the file declares `-- tsir:transaction=off`. */
  readonly transaction: boolean;
  /** Complaints worth printing, never worth refusing over. */
  readonly warnings: readonly string[];
}

/**
 * Reads the per-migration transaction header (`MIG-006`).
 *
 * Default `on`. Only a whole comment line counts — a mention of
 * `tsir:transaction=off` inside prose must not silently turn the transaction off,
 * which is exactly the kind of mistake that surfaces after a partial apply.
 */
export function parseTransactionPolicy(sql: string, tag = 'migration'): TransactionPolicy {
  const warnings: string[] = [];
  let transaction = true;

  const headers = sql.split('\n').filter((line) => HEADER.test(line));
  if (headers.length > 1) {
    warnings.push(`${tag}: more than one tsir:transaction header; the first one wins`);
  }
  for (const line of headers) {
    const value = HEADER.exec(line)?.[1]?.toLowerCase();
    if (value === 'off') transaction = false;
    else if (value !== 'on') {
      warnings.push(`${tag}: unknown tsir:transaction value "${value ?? ''}" — expected on or off`);
    }
  }

  return { transaction, warnings };
}

/**
 * Parses `meta/_journal.json`.
 *
 * Validation is strict on purpose: a journal with a duplicate `when` silently
 * loses a migration (the second one is "already applied" by key), a duplicate tag
 * makes the down file ambiguous, and a gap in `idx` means a file was deleted by
 * hand.
 */
export function parseJournal(text: string, source = JOURNAL_PATH): Journal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new JournalError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new JournalError(`${source} must be a JSON object`);
  }
  const journal = parsed as Record<string, unknown>;
  const entries = journal['entries'];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new JournalError(`${source} has no entries`);
  }

  const seen = new Set<string>();
  const seenWhen = new Set<number>();
  const result: JournalEntry[] = [];

  entries.forEach((entry, position) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new JournalError(`${source} entry ${String(position)} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const tag = record['tag'];
    const when = record['when'];
    const idx = record['idx'];
    const version = record['version'];

    if (typeof tag !== 'string' || tag.trim() === '') {
      throw new JournalError(`${source} entry ${String(position)} has no tag`);
    }
    if (typeof when !== 'number' || !Number.isFinite(when)) {
      throw new JournalError(`${source} entry "${tag}" has no numeric "when"`);
    }
    if (typeof idx !== 'number' || !Number.isInteger(idx)) {
      throw new JournalError(`${source} entry "${tag}" has no integer "idx"`);
    }
    if (typeof version !== 'string' || version.trim() === '') {
      throw new JournalError(
        `${source} entry "${tag}" has no "version" — the journal was written by something other than drizzle-kit`,
      );
    }
    if (idx !== position) {
      throw new JournalError(
        `${source} entry "${tag}" has idx ${String(idx)} but sits at position ${String(position)} — the journal was renumbered`,
      );
    }
    if (seen.has(tag)) {
      throw new JournalError(`${source} lists "${tag}" twice — tag and file would be ambiguous`);
    }
    if (seenWhen.has(when)) {
      throw new JournalError(
        `${source} lists "when" ${String(when)} twice — the key must be unique, or two migrations cannot be told apart`,
      );
    }
    seen.add(tag);
    seenWhen.add(when);

    result.push({
      idx,
      tag,
      when,
      version,
      ...(record['breakpoints'] === false ? { breakpoints: false } : { breakpoints: true }),
    });
  });

  // Drizzle writes entries in application order. If `when` is not ascending, the
  // applier would apply a later migration first — refuse rather than sort, because
  // sorting would hide a hand-edited journal.
  for (let index = 1; index < result.length; index += 1) {
    const previous = result[index - 1];
    const current = result[index];
    if (previous !== undefined && current !== undefined && current.when <= previous.when) {
      throw new JournalError(
        `${source} is out of order: "${current.tag}" (when ${String(current.when)}) must come after "${previous.tag}" (when ${String(previous.when)})`,
      );
    }
  }

  return {
    version: typeof journal['version'] === 'string' ? journal['version'] : '7',
    dialect: typeof journal['dialect'] === 'string' ? journal['dialect'] : 'sqlite',
    entries: result,
  };
}

/**
 * Reads a migrations folder: the journal, every migration it names, and the down
 * sibling when one exists.
 *
 * A journal entry with no `.sql` file is an error, not a skip: the database may
 * already have that migration applied, and a run that quietly ignores it reports
 * success for a schema it never checked. A missing `.down.sql` is fine — rollback
 * is what refuses, later, and only if it is asked.
 */
export async function readMigrationFolder(folder: string): Promise<MigrationFolder> {
  const journalPath = join(folder, JOURNAL_PATH);
  let text: string;
  try {
    text = await readFile(journalPath, 'utf8');
  } catch {
    throw new JournalError(
      `no journal at ${journalPath} — run \`tsir make:migration\` so drizzle-kit writes one`,
    );
  }

  const journal = parseJournal(text, journalPath);
  const migrations: Migration[] = [];

  for (const entry of journal.entries) {
    const sqlPath = join(folder, `${entry.tag}.sql`);
    let sql: string;
    try {
      sql = await readFile(sqlPath, 'utf8');
    } catch {
      throw new JournalError(
        `"${entry.tag}" is in ${journalPath} but ${sqlPath} is not in the folder — a migration file is missing`,
      );
    }

    const policy = parseTransactionPolicy(sql, entry.tag);
    const downPath = join(folder, `${entry.tag}.down.sql`);
    const downSql = await readOptional(downPath);
    const statements = splitStatements(sql);
    const warnings = [...policy.warnings];

    if (statements.length === 0) {
      warnings.push(`${entry.tag}: contains no statements`);
    }

    migrations.push({
      idx: entry.idx,
      version: entry.version,
      when: entry.when,
      tag: entry.tag,
      sql,
      checksum: checksum(sql),
      transaction: policy.transaction,
      statements,
      ...(downSql === undefined ? {} : { downPath, downSql }),
      warnings,
    });
  }

  return { folder, journal, migrations };
}

/** `readFile`, but a missing file is `undefined` rather than an error. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
