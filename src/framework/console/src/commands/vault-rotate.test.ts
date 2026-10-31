/**
 * `vault:rotate` and `vault:rotate:status` end to end (`VLT-020`, `VLT-022`).
 *
 * The fixture is a real project on disk: `tsir.js`, an entry that exports both the
 * database and the vault, and a SQLite file behind the D1 binding shape. The
 * command is invoked exactly as the binary would invoke it — same `cwd`, same
 * module loading — so what is asserted is the wiring, not a hand-built call into
 * `runRotation`. The SQL itself is covered by `@tsir/database`'s own suites.
 */

import { Database as Sqlite } from 'bun:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createKeyring, createVault, formatKeySpec, generateKey, type Vault } from '@tsir/vault';

import { runCli } from '../index.ts';
import { vaultRotateCommand, vaultRotateStatusCommand } from './vault.ts';

const ROOT = join(import.meta.dir, '..', '..', 'node_modules', '.cache', 'tsir-cli-vault');
const originalCwd = process.cwd();
const temporary: string[] = [];

/** The D1 binding the fixture's entry builds over `bun:sqlite`. */
const BINDING = `
const sqlite = new Sqlite(process.env.TSIR_TEST_DB ?? ':memory:');

function prepare(sql: string, params: readonly unknown[] = []) {
  return {
    sql,
    bind: (...values: readonly unknown[]) => prepare(sql, [...params, ...values]),
    all: async () => {
      if (!/^\\s*(select|with)\\b/i.test(sql)) {
        const run = sqlite.prepare(sql).run(...(params as never[]));
        return { success: true, results: [], meta: { changes: run.changes } };
      }
      return { success: true, results: sqlite.prepare(sql).all(...(params as never[])), meta: {} };
    },
    run: async () => {
      const run = sqlite.prepare(sql).run(...(params as never[]));
      return { success: true, meta: { changes: run.changes } };
    },
  };
}
`;

interface Fixture {
  readonly dir: string;
  readonly file: string;
  readonly v1: string;
  readonly v2: string;
  readonly oldVault: Vault;
  readonly newVault: Vault;
  readonly sqlite: Sqlite;
}

const COLUMN = { table: 'invoices', column: 'tax_id' } as const;

async function project(options: { readonly exported?: boolean } = {}): Promise<Fixture> {
  await mkdir(ROOT, { recursive: true });
  const dir = await mkdtemp(join(ROOT, 'project-'));
  temporary.push(dir);

  const v1 = formatKeySpec(generateKey('aes-256-gcm', 'v1'));
  const v2 = formatKeySpec(generateKey('aes-256-gcm', 'v2'));
  const oldVault = await createVault({ keyring: createKeyring({ now: v1 }) });
  const newVault = await createVault({ keyring: createKeyring({ now: v1, next: v2 }) });

  const file = join(dir, 'app.db');
  const sqlite = new Sqlite(file);
  sqlite.run('create table invoices (id text primary key, tax_id text not null)');
  for (const id of ['a', 'b', 'c']) {
    sqlite.run('insert into invoices (id, tax_id) values (?, ?)', [
      id,
      await oldVault.encrypt(COLUMN, `tax-${id}`),
    ]);
  }

  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'tsir.js'),
    'export default { app: { name: "acme", entry: "./src/app.ts" } };\n',
  );
  await writeFile(
    join(dir, 'src', 'app.ts'),
    `import { Database as Sqlite } from 'bun:sqlite';
import { defineApp } from '@tsir/core';
import { createDatabase, createD1Driver } from '@tsir/database';
import { createKeyring, createVault } from '@tsir/vault';
${BINDING}
export const database = createDatabase({ logging: 'off', driver: createD1Driver({ binding: {
  prepare: (sql: string) => prepare(sql),
  batch: async (statements: readonly { all: () => Promise<unknown> }[]) => {
    const results = [];
    for (const entry of statements) results.push(await entry.all());
    return results;
  },
  exec: async () => ({ count: 0, duration: 0 }),
} }) });

${
  options.exported === false
    ? '// deliberately not exported: resolveVault must say so instead of guessing'
    : `export const vault = await createVault({
  keyring: createKeyring({ now: ${JSON.stringify(v1)}, next: ${JSON.stringify(v2)} }),
});`
}

export default defineApp({ name: 'acme', config: {}, modules: [] });
`,
  );

  return { dir, file, v1, v2, oldVault, newVault, sqlite };
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

async function command(
  run: (argv: readonly string[]) => Promise<number>,
  argv: readonly string[],
): Promise<{ readonly code: number; readonly out: string }> {
  const output = capture();
  try {
    return { code: await run(argv), out: output.text() };
  } catch (error: unknown) {
    output.text();
    throw error;
  }
}

let fixture: Fixture;

beforeEach(async () => {
  fixture = await project();
  process.env['TSIR_TEST_DB'] = fixture.file;
  process.chdir(fixture.dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env['TSIR_TEST_DB'];
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const TARGET = ['--table', 'invoices', '--column', 'tax_id'] as const;

describe('tsir vault:rotate (VLT-020)', () => {
  test('rewrites every row onto the active key and says so', async () => {
    const { code, out } = await command(vaultRotateCommand, TARGET);

    expect(code).toBe(0);
    expect(out).toContain('3 row(s) re-encrypted');

    const rows = fixture.sqlite.prepare('select id, tax_id from invoices order by id').all() as {
      id: string;
      tax_id: string;
    }[];
    for (const row of rows) {
      expect(row.tax_id.split(':')[2]).toBe('v2');
      expect(await fixture.newVault.decrypt(COLUMN, row.tax_id)).toBe(`tax-${row.id}`);
    }
  });

  test('--json is the documented shape', async () => {
    const { code, out } = await command(vaultRotateCommand, [...TARGET, '--json']);
    const body = JSON.parse(out) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(body['ok']).toBe(true);
    expect(body['activeKeyId']).toBe('v2');
    expect(body['rotated']).toBe(3);
    expect(body['failed']).toBe(0);
    expect(body['remaining']).toBe(0);
    // Nothing left to estimate: the ETA is zero, and `null` is reserved for
    // "no throughput has been measured yet".
    expect(body['etaMs']).toBe(0);
    expect(body['locked']).toBe(false);
    expect(body['failures']).toEqual([]);
    expect(body['target']).toEqual({ table: 'invoices', column: 'tax_id', keyColumn: 'id' });
  });

  test('a second run is a no-op, not a second rewrite', async () => {
    await command(vaultRotateCommand, TARGET);
    const { code, out } = await command(vaultRotateCommand, TARGET);

    expect(code).toBe(0);
    expect(out).toContain('nothing to do');
  });

  test('--dry-run reports the backlog and writes nothing', async () => {
    const { code, out } = await command(vaultRotateCommand, [...TARGET, '--dry-run']);

    expect(code).toBe(0);
    expect(out).toContain('3 row(s) left');

    const row = fixture.sqlite.prepare("select tax_id from invoices where id = 'a'").get() as {
      tax_id: string;
    };
    expect(row.tax_id.split(':')[2]).toBe('v1');
  });

  test('--batch bounds are a usage error, not a surprise 0-row run', async () => {
    expect(vaultRotateCommand([...TARGET, '--batch', '0'])).rejects.toThrow(
      /--batch must be a whole number/,
    );
    expect(vaultRotateCommand([...TARGET, '--batch', '10.5'])).rejects.toThrow(
      /--batch must be a whole number/,
    );
  });

  test('the target is required: the AAD binds both table and column', async () => {
    const output = capture();
    const code = await runCli(['vault:rotate', '--table', 'invoices']);
    const out = output.text();

    expect(code).toBe(2);
    expect(out).toContain('needs --table <table> --column <column>');
  });

  test('a project that exports no vault gets a message, not a re-derived keyring', async () => {
    const bare = await project({ exported: false });
    process.env['TSIR_TEST_DB'] = bare.file;
    process.chdir(bare.dir);

    const output = capture();
    const code = await runCli(['vault:rotate', ...TARGET]);
    const out = output.text();

    expect(code).toBe(3);
    expect(out).toContain('no vault found');
    expect(out).toContain('export const vault = await createVault');
  });
});

describe('tsir vault:rotate:status (VLT-022)', () => {
  test('reports the backlog before and the empty set after a rotation', async () => {
    const before = await command(vaultRotateStatusCommand, [...TARGET, '--json']);
    const first = JSON.parse(before.out) as {
      ok: boolean;
      activeKeyId: string;
      remaining: number;
      targets: { percent: number | null; remaining: number }[];
    };

    expect(before.code).toBe(0);
    expect(first.ok).toBe(true);
    expect(first.activeKeyId).toBe('v2');
    expect(first.remaining).toBe(3);
    // No denominator is known, so the CLI reports `null` rather than a made-up
    // percentage — the same honesty as `etaMs`.
    expect(first.targets[0]?.percent).toBe(null);

    await command(vaultRotateCommand, TARGET);

    const after = JSON.parse(
      (await command(vaultRotateStatusCommand, [...TARGET, '--json'])).out,
    ) as { remaining: number; targets: { percent: number | null }[] };
    expect(after.remaining).toBe(0);
    expect(after.targets[0]?.percent).toBe(null);
  });

  test('status never writes', async () => {
    await command(vaultRotateStatusCommand, TARGET);

    const row = fixture.sqlite.prepare("select tax_id from invoices where id = 'b'").get() as {
      tax_id: string;
    };
    expect(row.tax_id.split(':')[2]).toBe('v1');
    expect(await fixture.oldVault.decrypt(COLUMN, row.tax_id)).toBe('tax-b');
  });
});

describe('tsir vault:key:retire (VLT-017)', () => {
  async function manifest(): Promise<string> {
    const path = join(fixture.dir, 'keyring.json');
    await writeFile(
      path,
      JSON.stringify({
        keys: [
          { id: 'v1', alg: 'aes-256-gcm', state: 'decrypt-only' },
          { id: 'v2', alg: 'aes-256-gcm', state: 'active' },
        ],
        materials: { v1: fixture.v1, v2: fixture.v2 },
      }),
    );
    return path;
  }

  const RETIRE = ['--key', 'v1', '--table', 'invoices', '--column', 'tax_id'] as const;

  test('refuses while rows still reference the key, and names the count', async () => {
    const path = await manifest();
    const output = capture();
    const code = await runCli(['vault:key:retire', ...RETIRE, '--manifest', path]);
    const out = output.text();

    expect(code).toBe(1);
    expect(out).toContain('VLT_STALE_KEY');
    expect(out).toContain('3 row(s)');
  });

  test('--force without the key id typed again is a usage error', async () => {
    const path = await manifest();
    const output = capture();
    const code = await runCli(['vault:key:retire', ...RETIRE, '--manifest', path, '--force']);
    const out = output.text();

    expect(code).toBe(2);
    expect(out).toContain('--confirm <key id>');
  });

  test('after a rotation the key retires, and its material leaves the manifest', async () => {
    await command(vaultRotateCommand, TARGET);
    const path = await manifest();

    const output = capture();
    const code = await runCli(['vault:key:retire', ...RETIRE, '--manifest', path, '--json']);
    const body = JSON.parse(output.text()) as {
      ok: boolean;
      fromState: string;
      remaining: number;
      forced: boolean;
      manifest: { id: string; state: string }[];
      materials: string[];
      written: boolean;
    };

    expect(code).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.fromState).toBe('decrypt-only');
    expect(body.remaining).toBe(0);
    expect(body.forced).toBe(false);
    expect(body.manifest.find((entry) => entry.id === 'v1')?.state).toBe('retired');
    expect(body.materials).toEqual(['v2']);
    // Never written: the operator deploys it.
    expect(body.written).toBe(false);
  });

  test('--force with the right confirmation goes ahead and says what it strands', async () => {
    const path = await manifest();
    const output = capture();
    const code = await runCli([
      'vault:key:retire',
      ...RETIRE,
      '--manifest',
      path,
      '--force',
      '--confirm',
      'v1',
    ]);
    const out = output.text();

    expect(code).toBe(0);
    expect(out).toContain('retired');
    expect(out).toContain('VLT_UNKNOWN_KEY');
    expect(out).toContain('3 row(s) become unreadable');
  });

  test('the writer cannot be retired', async () => {
    const path = await manifest();
    const output = capture();
    const code = await runCli([
      'vault:key:retire',
      '--key',
      'v2',
      '--table',
      'invoices',
      '--column',
      'tax_id',
      '--manifest',
      path,
    ]);
    const out = output.text();

    expect(code).toBe(1);
    expect(out).toContain('VLT_KEY_STILL_ACTIVE');
  });

  test('without a manifest there is nothing to retire from', async () => {
    const output = capture();
    const code = await runCli(['vault:key:retire', ...RETIRE]);
    const out = output.text();

    expect(code).toBe(3);
    expect(out).toContain('needs the deployed manifest');
  });
});
