import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import type { D1ResultLike, D1StatementLike } from '@tsir/database';

import {
  dbSeedCommand,
  lintMigration,
  makeMigrationCommand,
  migrateCommand,
  migrateStatusCommand,
  migrateVerifyCommand,
} from './db.ts';

const temporary: string[] = [];
const originalCwd = process.cwd();
/**
 * Fixtures live inside this package's `node_modules/.cache` on purpose: the fake
 * project's entry imports `@tsir/database`, and Bun resolves that from the
 * nearest `node_modules` — a `/tmp` directory is not under one.
 */
const ROOT = join(import.meta.dir, '..', '..', 'node_modules', '.cache', 'tsir-cli-db');

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A D1 binding shaped like Cloudflare's: `prepare()` returns a statement that is
 * also a promise, and `batch()` is the transaction wrapper. Writes go through
 * `run()`, which is what `createD1Driver` uses inside `batch()`.
 */
function projectBinding() {
  const journal: { hash: string; created_at: number }[] = [];

  function read<T = Record<string, unknown>>(sql: string): D1ResultLike<T> {
    if (/select .* from "__drizzle_migrations"/i.test(sql)) {
      return {
        // coercion-ok: the fake hands back the row shape the driver would receive.
        results: journal.map((row, index) => ({ id: index + 1, ...row })) as T[],
        success: true,
      };
    }
    return { results: [], success: true };
  }

  function write<T = never>(sql: string, params: readonly unknown[]): D1ResultLike<T> {
    if (/insert into "__drizzle_migrations"/i.test(sql)) {
      journal.push({
        // coercion-ok: the fake mirrors the column the driver would bind into.
        hash: typeof params[0] === 'string' ? params[0] : '',
        created_at: Number(params[1] ?? 0),
      });
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }

  const binding = {
    journal,
    prepare(sql: string) {
      let params: readonly unknown[] = [];
      const statement = {
        sql,
        bind: (...values: readonly unknown[]) => {
          params = values;
          return statement;
        },
        all: async <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => read<T>(sql),
        raw: async () => [],
        run: async <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> =>
          write<T>(sql, params),
      };
      return statement;
    },
    // One batch is one transaction. Each entry ran for real, so a failing write
    // surfaces exactly like it would on D1.
    async batch<T = Record<string, unknown>>(
      statements: readonly D1StatementLike[],
    ): Promise<readonly D1ResultLike<T>[]> {
      const results: D1ResultLike<T>[] = [];
      for (const entry of statements) results.push(await entry.run());
      return results;
    },
    exec: async () => ({ count: 0, duration: 0 }),
  };
  return binding;
}

interface Fixture {
  readonly dir: string;
  readonly binding: ReturnType<typeof projectBinding>;
}

/**
 * A complete project on disk: `tsir.js`, an entry that exports the database the
 * CLI is supposed to find, one migration, and one seeder.
 */
async function project(): Promise<Fixture> {
  await mkdir(ROOT, { recursive: true });
  const dir = await mkdtemp(join(ROOT, 'project-'));
  temporary.push(dir);
  const binding = projectBinding();

  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'drizzle', 'meta'), { recursive: true });

  await writeFile(
    join(dir, 'tsir.js'),
    'export default { app: { name: "acme", entry: "./src/app.ts" } };\n',
  );

  // The entry is TypeScript, like a real project: the CLI imports it directly.
  await writeFile(
    join(dir, 'src', 'app.ts'),
    `import { defineApp } from '@tsir/core';
import { createDatabase, createD1Driver } from '@tsir/database';
import { defineSeeder } from '@tsir/seed';

const binding = (globalThis as { __binding?: unknown }).__binding;
const seeded = globalThis as { __seeded?: string[] };

export const database = createDatabase({
  driver: createD1Driver({ binding: binding as never }),
});

export const seeders = [
  defineSeeder({
    name: 'UsersSeeder',
    order: 10,
    idempotent: true,
    environments: ['development', 'test'],
    run: async (context) => {
      seeded.__seeded = [...(seeded.__seeded ?? []), context.env];
    },
  }),
];

export default defineApp({ name: 'acme', config: {}, modules: [] });
`,
  );

  await writeFile(
    join(dir, 'drizzle', 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [
        { idx: 0, version: '6', when: 1_700_000_000_000, tag: '0000_init', breakpoints: true },
      ],
    }),
  );
  await writeFile(join(dir, 'drizzle', '0000_init.sql'), 'create table "users" ("id" integer);\n');

  (globalThis as { __binding?: unknown }).__binding = binding;
  process.chdir(dir);
  return { dir, binding };
}

/**
 * Runs a command with stdout captured. Commands print human lines unless
 * `--json` is passed, and a test that does not assert on them should not spray
 * them through the test output.
 */
async function quiet(run: () => Promise<number>): Promise<number> {
  const output = capture();
  const code = await run();
  output.text();
  return code;
}

function capture(): { readonly text: () => string } {
  const chunks: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const absorb = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stdout.write = absorb;
  process.stderr.write = absorb;
  return {
    text: () => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      return chunks.join('');
    },
  };
}

describe('tsir migrate', () => {
  test('applies the journal and is idempotent on a second run', async () => {
    const { binding } = await project();

    expect(await quiet(() => migrateCommand([]))).toBe(0);
    expect(binding.journal).toHaveLength(1);

    expect(await quiet(() => migrateCommand([]))).toBe(0);
    expect(binding.journal).toHaveLength(1);
  });

  test('--json reports the applied tag', async () => {
    await project();
    const output = capture();

    expect(await migrateCommand(['--json'])).toBe(0);
    const parsed = JSON.parse(output.text()) as { ok: boolean; applied: { tag: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.applied.map((entry) => entry.tag)).toEqual(['0000_init']);
  });

  test('a driver that cannot pin a connection is reported through the result', async () => {
    await project();
    const output = capture();
    expect(await migrateCommand(['--json'])).toBe(0);
    const parsed = JSON.parse(output.text()) as { lockSupported: boolean; lockVerified: boolean };
    // D1: there is no advisory lock at all, so the flag is not "unverified".
    expect(parsed.lockSupported).toBe(false);
    expect(parsed.lockVerified).toBe(true);
  });

  test('--dry-run writes nothing', async () => {
    const { binding } = await project();

    expect(await quiet(() => migrateCommand(['--dry-run']))).toBe(0);
    expect(binding.journal).toHaveLength(0);
  });
});

describe('tsir migrate:status', () => {
  test('prints applied tags as JSON', async () => {
    await project();
    await quiet(() => migrateCommand([]));

    const output = capture();
    expect(await migrateStatusCommand(['--json'])).toBe(0);
    const parsed = JSON.parse(output.text()) as {
      applied: string[];
      pending: string[];
      ok: boolean;
    };
    expect(parsed.applied).toEqual(['0000_init']);
    expect(parsed.pending).toEqual([]);
    expect(parsed.ok).toBe(true);
  });

  test('fails when a migration drifted', async () => {
    const { dir } = await project();
    await quiet(() => migrateCommand([]));
    // Someone edited an applied migration.
    await writeFile(join(dir, 'drizzle', '0000_init.sql'), 'create table "users" ("id" text);\n');

    const output = capture();
    expect(await migrateStatusCommand(['--json'])).toBe(1);
    const parsed = JSON.parse(output.text()) as { drifted: string[]; ok: boolean };
    expect(parsed.drifted).toEqual(['0000_init']);
    expect(parsed.ok).toBe(false);
  });
});

describe('tsir migrate:verify', () => {
  test('refuses a database that is not empty', async () => {
    await project();
    await quiet(() => migrateCommand([]));

    // `EXIT.environment`: verify is a CI command, so "not empty" is a
    // misconfiguration to fix, not a transient failure to retry.
    expect(await quiet(() => migrateVerifyCommand([]))).toBe(3);
  });

  test('applies the journal to an empty database', async () => {
    const { binding } = await project();

    expect(await quiet(() => migrateVerifyCommand(['--json']))).toBe(0);
    expect(binding.journal).toHaveLength(1);
  });
});

describe('tsir db:seed', () => {
  test('runs the exported seeders for the environment', async () => {
    await project();
    delete (globalThis as { __seeded?: string[] }).__seeded;
    process.env['APP_ENV'] = 'test';

    expect(await quiet(() => dbSeedCommand(['--json']))).toBe(0);

    expect((globalThis as { __seeded?: string[] }).__seeded).toEqual(['test']);
    delete process.env['APP_ENV'];
  });

  test('--class selects one seeder and an unknown class fails', async () => {
    await project();
    process.env['APP_ENV'] = 'test';

    const selected = capture();
    expect(await dbSeedCommand(['--class=UsersSeeder', '--json'])).toBe(0);
    expect(selected.text()).toContain('"UsersSeeder"');

    const unknown = capture();
    expect(await dbSeedCommand(['--class=Nope', '--json'])).toBe(1);
    expect(unknown.text()).toContain('SED_UNKNOWN_CLASS');
    delete process.env['APP_ENV'];
  });

  test('refuses production without --reference-data', async () => {
    await project();
    process.env['APP_ENV'] = 'production';

    const output = capture();
    expect(await dbSeedCommand(['--json'])).toBe(1);
    expect(output.text()).toContain('SED_PRODUCTION_REFUSED');
    delete process.env['APP_ENV'];
  });
});

describe('tsir make:migration', () => {
  test('requires a usable name', async () => {
    await project();

    expect(makeMigrationCommand([])).rejects.toThrow('needs a name');
    expect(makeMigrationCommand(['Add Users!'])).rejects.toThrow('not a usable migration name');
  });

  test('lints an empty file and a missing trailing newline', () => {
    expect(lintMigration('', '0001_x')).toContain('0001_x: the generated file is empty');
    expect(lintMigration('select 1;', '0001_x')).toContain(
      '0001_x: file does not end with a newline',
    );
    expect(lintMigration('select 1;\n', '0001_x')).toEqual([]);
  });

  test('rejects two transaction headers', () => {
    const sql = '-- tsir:transaction=off\n-- tsir:transaction=on\nselect 1;\n';
    expect(lintMigration(sql, '0002_y')).toContain('0002_y: more than one tsir:transaction header');
  });
});

describe('--connection (MIG-015)', () => {
  test('refuses the flag when the entry exports no registry', async () => {
    await project();
    const output = capture();

    const code = await migrateStatusCommand(['--connection=reporting', '--json']);

    expect(code).toBe(2);
    expect(output.text()).toContain('needs a registry');
  });

  test('a status run names the connection and the folder it read', async () => {
    await project();
    const output = capture();

    expect(await migrateStatusCommand(['--json'])).toBe(0);
    const parsed = JSON.parse(output.text()) as { connection: string; folder: string };

    // The single-connection case still answers with a name — the name is what a
    // multi-connection deploy will be told apart by.
    expect(parsed.connection).toBe('default');
    expect(parsed.folder.endsWith('drizzle')).toBe(true);
  });
});

describe('db:seed --connection (SED-011)', () => {
  test('a seeder that declares another connection is refused before any write', async () => {
    const { dir } = await project();
    // Same fixture, one declaration added: the seeder belongs to `reporting`.
    await writeFile(
      join(dir, 'src', 'app.ts'),
      `import { defineApp } from '@tsir/core';
import { createDatabase, createD1Driver } from '@tsir/database';
import { defineSeeder } from '@tsir/seed';

const binding = (globalThis as { __binding?: unknown }).__binding;

export const database = createDatabase({
  driver: createD1Driver({ binding: binding as never }),
});

export const seeders = [
  defineSeeder({
    name: 'ReportingSeeder',
    order: 10,
    idempotent: true,
    environments: ['development', 'test'],
    connections: ['reporting'],
    run: async () => undefined,
  }),
];

export default defineApp({ name: 'acme', config: {}, modules: [] });
`,
    );

    const output = capture();
    const code = await dbSeedCommand(['--json']);

    expect(code).toBe(1);
    expect(output.text()).toContain('SED_UNDECLARED_CONNECTION');
  });
});
