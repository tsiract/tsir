import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { Database as SQLite } from 'bun:sqlite';

import type { D1ResultLike, D1StatementLike } from '@tsir/database';

import {
  dbSeedCommand,
  lintMigration,
  makeMigrationCommand,
  migrateCommand,
  migrateRollbackCommand,
  migrateStatusCommand,
  migrateVerifyCommand,
} from './db.ts';
import { makeSeederCommand } from './make-seeder.ts';

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

/** A real in-memory SQLite database behind the D1 subset used by the CLI. */
function sqliteBinding(sqlite: SQLite) {
  return {
    prepare(sql: string) {
      let params: readonly unknown[] = [];
      const statement = {
        bind: (...values: readonly unknown[]) => {
          params = values;
          return statement;
        },
        all: async <T = Record<string, unknown>>(): Promise<D1ResultLike<T>> => ({
          // coercion-ok: tests bind only SQLite-compatible values from the framework.
          results: sqlite
            .query(sql)
            .all(...(params as (string | number | bigint | Uint8Array | null)[])) as T[],
          success: true,
        }),
        run: async (): Promise<D1ResultLike<never>> => {
          // coercion-ok: tests bind only SQLite-compatible values from the framework.
          const result = sqlite
            .query(sql)
            .run(...(params as (string | number | bigint | Uint8Array | null)[]));
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
    async batch<T = Record<string, unknown>>(
      statements: readonly D1StatementLike[],
    ): Promise<readonly D1ResultLike<T>[]> {
      sqlite.run('begin');
      try {
        const results: D1ResultLike<T>[] = [];
        for (const entry of statements) results.push(await entry.run());
        sqlite.run('commit');
        return results;
      } catch (error) {
        sqlite.run('rollback');
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.run(sql);
      return { count: 0, duration: 0 };
    },
  };
}

async function moduleJournal(dir: string, moduleName: string, sql: string): Promise<void> {
  const moduleDir = join(dir, moduleName);
  const folder = join(moduleDir, 'migrations');
  await mkdir(join(folder, 'meta'), { recursive: true });
  await writeFile(join(moduleDir, 'index.ts'), '// module\n');
  await writeFile(join(moduleDir, 'routes.ts'), '// routes\n');
  await writeFile(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [
        { idx: 0, version: '6', when: 1_700_000_000_000, tag: '0000_init', breakpoints: true },
      ],
    }),
  );
  await writeFile(join(folder, '0000_init.sql'), sql);
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

  await mkdir(join(dir, 'drizzle', 'meta'), { recursive: true });

  await writeFile(
    join(dir, 'tsir.js'),
    'export default { app: { name: "acme", entry: "./app.ts" } };\n',
  );

  // The entry is TypeScript, like a real project: the CLI imports it directly.
  await writeFile(
    join(dir, 'app.ts'),
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

async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return '';
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
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

describe('module-local migration journals', () => {
  test('two modules and the project journal remain isolated, including rollback and drift', async () => {
    const { dir } = await project();
    const sqlite = new SQLite(':memory:');
    (globalThis as { __binding?: unknown }).__binding = sqliteBinding(sqlite);
    try {
      await moduleJournal(dir, 'shop', 'create table "shop_orders" ("id" integer);\n');
      await moduleJournal(dir, 'sales', 'create table "sales_orders" ("id" integer);\n');
      await writeFile(
        join(dir, 'shop/migrations/0000_init.down.sql'),
        'drop table "shop_orders";\n',
      );
      expect(await quiet(() => migrateCommand(['shop']))).toBe(0);
      expect(await quiet(() => migrateCommand(['sales']))).toBe(0);
      expect(await quiet(() => migrateCommand([]))).toBe(0);
      expect(await quiet(() => migrateCommand(['shop']))).toBe(0);
      const output = capture();
      expect(await migrateStatusCommand(['sales', '--json'])).toBe(0);
      const status = JSON.parse(output.text()) as {
        module: string;
        applied: string[];
        pending: string[];
      };
      expect(status.module).toBe('sales');
      expect(status.applied).toEqual(['0000_init']);
      expect(status.pending).toEqual([]);
      // Drizzle timestamps are intentionally identical; distinct bookkeeping prevents collision.
      const count = sqlite
        .query(
          "select name from sqlite_master where type='table' and name like '__tsir_module_%_journal'",
        )
        .all();
      expect(count).toHaveLength(2);
      expect(
        await quiet(() =>
          migrateRollbackCommand([
            'shop',
            '--to',
            'empty',
            '--allow-destructive',
            '--confirm',
            '0000_init',
          ]),
        ),
      ).toBe(0);
      const names = sqlite.query("select name from sqlite_master where type='table'").all() as {
        name: string;
      }[];
      expect(names.some((row) => row.name === 'shop_orders')).toBe(false);
      expect(names.some((row) => row.name === 'sales_orders')).toBe(true);
      expect(names.some((row) => row.name === 'users')).toBe(true);
      await writeFile(
        join(dir, 'sales/migrations/0000_init.sql'),
        'create table "sales_orders" ("id" text);\n',
      );
      expect(await quiet(() => migrateStatusCommand(['sales']))).toBe(1);
      expect(await quiet(() => migrateVerifyCommand(['sales']))).toBe(3);
    } finally {
      sqlite.close();
    }
  });
  test('status reports an orphaned applied row and fails', async () => {
    const { dir } = await project();
    const sqlite = new SQLite(':memory:');
    (globalThis as { __binding?: unknown }).__binding = sqliteBinding(sqlite);
    try {
      await moduleJournal(dir, 'shop', 'create table "shop_orders" ("id" integer);\n');
      expect(await quiet(() => migrateCommand(['shop']))).toBe(0);
      await writeFile(
        join(dir, 'shop/migrations/meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'sqlite',
          entries: [
            { idx: 0, version: '6', when: 1700000000001, tag: '0000_other', breakpoints: true },
          ],
        }),
      );
      await writeFile(
        join(dir, 'shop/migrations/0000_other.sql'),
        'create table other (id integer);\n',
      );
      const output = capture();
      expect(await migrateStatusCommand(['shop', '--json'])).toBe(1);
      const status = JSON.parse(output.text()) as { ok: boolean; orphaned: string[] };
      expect(status.ok).toBe(false);
      expect(status.orphaned).toEqual(['1700000000000']);
    } finally {
      sqlite.close();
    }
  });

  test('generates with a module-local schema and separate journal, rejecting unsafe schema paths', async () => {
    const { dir } = await project();
    await moduleJournal(dir, 'shop', 'create table "shop_orders" ("id" integer);\n');
    await writeFile(join(dir, 'shop/order.model.ts'), '// schema fixture\n');
    const journal = join(dir, 'shop/migrations/meta/_journal.json');
    await writeFile(journal, (await readFile(journal, 'utf8')).replace('sqlite', 'postgresql'));
    let calls = 0;
    const runner = async (command: readonly string[], cwd: string) => {
      calls += 1;
      expect(cwd).toBe(dir);
      expect(command).toEqual([
        'generate',
        '--name',
        'add-orders',
        '--dialect',
        'postgresql',
        '--schema',
        join(dir, 'shop/order.model.ts'),
        '--out',
        join(dir, 'shop/migrations'),
      ]);
      return { exitCode: 0, stdout: 'No schema changes, nothing to migrate', stderr: '' };
    };
    const output = capture();
    expect(
      await makeMigrationCommand(
        [
          'add-orders',
          'shop',
          '--dialect',
          'postgres',
          '--schema',
          'shop/order.model.ts',
          '--json',
        ],
        runner,
      ),
    ).toBe(0);
    const result = JSON.parse(output.text()) as { tag: string | null; folder: string };
    expect(result.tag).toBeNull();
    expect(result.folder).toBe(join(dir, 'shop/migrations'));
    expect(calls).toBe(1);
    expect(await quiet(() => makeMigrationCommand(['add-orders', 'shop'], runner))).toBe(2);
    expect(
      await quiet(() =>
        makeMigrationCommand(['add-orders', 'shop', '--schema', '../elsewhere.model.ts'], runner),
      ),
    ).toBe(2);
    expect(
      await quiet(() =>
        makeMigrationCommand(['add-orders', 'shop', '--schema', 'shop/does-not-exist.ts'], runner),
      ),
    ).toBe(1);
    expect(await quiet(() => makeMigrationCommand(['add-orders', 'missing'], runner))).toBe(1);
    expect(calls).toBe(1);
  });

  test('the default schema glob finds a model where `make:model` actually writes it', async () => {
    // Regression: `make:model order shop` writes `shop/models/order.model.ts`, but the default
    // glob here was `shop/*.model.ts` — so the documented pair (`make:model`, then
    // `make:migration`) failed with "no schema files found" even though the model was right there.
    // The release journey is what caught it, because it runs the pair in order.
    const { dir } = await project();
    await moduleJournal(dir, 'shop', 'create table "shop_order" (\"id\" integer);\n');
    await mkdir(join(dir, 'shop/models'), { recursive: true });
    await writeFile(join(dir, 'shop/models/order.model.ts'), '// schema fixture\n');
    let seenSchema = '';
    const runner = async (command: readonly string[], cwd: string) => {
      expect(cwd).toBe(dir);
      seenSchema = command[command.indexOf('--schema') + 1] ?? '';
      return { exitCode: 0, stdout: 'no changes', stderr: '' };
    };
    expect(await quiet(() => makeMigrationCommand(['create-orders', 'shop'], runner))).toBe(0);
    // The CLI hands drizzle-kit a **glob**, not a resolved file: `generate` takes a schema pattern.
    // What matters is that the pattern reaches into `models/`, which is where `make:model` writes.
    expect(seenSchema).toBe(join(dir, 'shop', '**', '*.model.ts'));
  });

  test('named connections select distinct module folders and database bookkeeping', async () => {
    const { dir } = await project();
    const sqlite = new SQLite(':memory:');
    (globalThis as { __binding?: unknown }).__binding = sqliteBinding(sqlite);
    try {
      await moduleJournal(dir, 'shop', 'create table "default_orders" ("id" integer);\n');
      const folder = join(dir, 'shop/migrations');
      const reporting = join(folder, 'reporting');
      await mkdir(join(reporting, 'meta'), { recursive: true });
      await writeFile(
        join(reporting, 'meta/_journal.json'),
        await readFile(join(folder, 'meta/_journal.json'), 'utf8'),
      );
      await writeFile(
        join(reporting, '0000_init.sql'),
        'create table "reporting_orders" ("id" integer);\n',
      );
      await writeFile(join(dir, 'shop/order.model.ts'), '// schema fixture\n');
      const app = join(dir, 'app.ts');
      await writeFile(
        app,
        (await readFile(app, 'utf8')) +
          `\nexport const databases = { default: 'app', names: ['app', 'reporting'], connection: () => database };\n`,
      );
      let generatedOut = '';
      const run = async (command: readonly string[]) => {
        generatedOut = command[command.indexOf('--out') + 1] ?? '';
        return { exitCode: 0, stdout: 'no changes', stderr: '' };
      };
      expect(
        await quiet(() => makeMigrationCommand(['check', 'shop', '--connection', 'app'], run)),
      ).toBe(0);
      expect(generatedOut).toBe(folder);
      expect(
        await quiet(() =>
          makeMigrationCommand(['check', 'shop', '--connection', 'reporting'], run),
        ),
      ).toBe(0);
      expect(generatedOut).toBe(reporting);
      expect(
        await quiet(() => makeMigrationCommand(['check', 'shop', '--connection', 'unknown'], run)),
      ).toBe(2);
      expect(await quiet(() => migrateCommand(['shop']))).toBe(0);
      expect(await quiet(() => migrateCommand(['shop', '--connection', 'app']))).toBe(0);
      expect(await quiet(() => migrateCommand(['shop', '--connection', 'reporting']))).toBe(0);
      const tables = sqlite
        .query(
          "select name from sqlite_master where type='table' and name like '__tsir_module_%_journal'",
        )
        .all();
      expect(tables).toHaveLength(2);
      const out = capture();
      expect(await migrateStatusCommand(['shop', '--connection', 'reporting', '--json'])).toBe(0);
      const status = JSON.parse(out.text()) as { folder: string; applied: string[] };
      expect(status.folder).toBe(reporting);
      expect(status.applied).toEqual(['0000_init']);
    } finally {
      sqlite.close();
    }
  });

  test('module seeders are explicitly registered and selected by class', async () => {
    const { dir } = await project();
    await moduleJournal(dir, 'shop', 'create table "shop_orders" ("id" integer);\n');
    expect(await quiet(() => makeSeederCommand(['order', 'shop']))).toBe(0);
    const path = join(dir, 'shop/seeders/order.seeder.ts');
    expect(await readFile(path, 'utf8')).toContain('export const OrderSeeder');
    const app = join(dir, 'app.ts');
    await writeFile(
      app,
      (await readFile(app, 'utf8')).replace(
        'export const seeders = [',
        "import { OrderSeeder } from './shop/seeders/order.seeder.ts';\nexport const seeders = [OrderSeeder,",
      ),
    );
    expect(await quiet(() => dbSeedCommand(['--class', 'OrderSeeder']))).toBe(0);
  });

  test('refuses extra positionals rather than silently selecting a different journal', async () => {
    await project();
    expect(await rejection(migrateCommand(['shop', 'sales']))).toContain('too many arguments');
    expect(await rejection(migrateStatusCommand(['shop', 'sales']))).toContain(
      'too many arguments',
    );
    expect(await rejection(migrateVerifyCommand(['shop', 'sales']))).toContain(
      'too many arguments',
    );
    expect(await rejection(migrateRollbackCommand(['shop', 'sales']))).toContain(
      'too many arguments',
    );
    expect(await rejection(makeMigrationCommand(['create', 'shop', 'sales']))).toContain(
      'too many arguments',
    );
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

    expect(await rejection(makeMigrationCommand([]))).toContain('needs a name');
    expect(await rejection(makeMigrationCommand(['Add Users!']))).toContain(
      'not a usable migration name',
    );
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
      join(dir, 'app.ts'),
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
