import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATABASE_ENGINES } from '@tsir/database';

import { checkProjectFile } from '@tsir/config';

import { EXIT } from '../output.ts';
import { UsageError } from '../output.ts';
import { declaredD1Bindings, entryFor, KINDS, makeConnectionCommand } from './make-connection.ts';

const BASE = `// The project file. The comment below must survive every edit.
export default {
  app: { name: 'demo', entry: './src/app.ts' },
  database: {
    default: 'primary',
    connections: {
      // primary is the only real connection today.
      primary: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } },
    },
  },
  cache: {
    default: 'app',
    stores: {
      app: { driver: 'memory' },
    },
  },
};
`;

const WRANGLER = `name = "demo"

[[d1_databases]]
binding = "DB"
database_name = "demo"
database_id = "00000000-0000-0000-0000-000000000000"

[[kv_namespaces]]
binding = "CACHE"
id = "x"
`;

let root = '';
let previous = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsir-connection-'));
  previous = process.cwd();
  process.chdir(root);
  writeFileSync(join(root, 'tsir.js'), BASE);
});

afterEach(() => {
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
});

function config(): string {
  return readFileSync(join(root, 'tsir.js'), 'utf8');
}

async function errorOf(fn: () => Promise<number>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Imports the written file and runs the same validation the loader runs. */
async function validNow(): Promise<Record<string, unknown>> {
  const module: unknown = await import(
    `${pathToFileURL(join(root, 'tsir.js')).href}?t=${String(Date.now())}`
  );
  const exported = (module as { default: Record<string, unknown> }).default;
  checkProjectFile(exported);
  return exported;
}

describe('declaredD1Bindings', () => {
  test('reads binding only inside [[d1_databases]] tables', () => {
    expect(declaredD1Bindings(WRANGLER)).toEqual(['DB']);
    expect(
      declaredD1Bindings('[[d1_databases]]\nbinding = "A"\n[[d1_databases]]\nbinding = "B"'),
    ).toEqual(['A', 'B']);
    expect(declaredD1Bindings('[[kv_namespaces]]\nbinding = "CACHE"')).toEqual([]);
  });
});

describe('make:connection (CLI-017)', () => {
  test('a D1 binding wrangler.toml does not declare is refused, and nothing is written', async () => {
    writeFileSync(join(root, 'wrangler.toml'), WRANGLER);
    const error = await errorOf(() =>
      makeConnectionCommand([
        'reports',
        '--kind',
        'database',
        '--driver',
        'd1',
        '--binding',
        'NOPE',
      ]),
    );
    expect(error).toBeInstanceOf(UsageError);
    if (error instanceof UsageError)
      expect(error.message).toContain('does not declare the D1 binding "NOPE"');
    expect(config()).toBe(BASE);
  });

  test('a D1 binding with no wrangler.toml at all is refused', async () => {
    const error = await errorOf(() =>
      makeConnectionCommand(['reports', '--kind', 'database', '--driver', 'd1', '--binding', 'DB']),
    );
    expect(error).toBeInstanceOf(UsageError);
    if (error instanceof UsageError) expect(error.message).toContain('no wrangler.toml');
  });

  test('a declared D1 binding writes one entry, keeps the comment, and the file still validates', async () => {
    writeFileSync(join(root, 'wrangler.toml'), WRANGLER);
    expect(
      await makeConnectionCommand([
        'reports',
        '--kind',
        'database',
        '--driver',
        'd1',
        '--binding',
        'DB',
      ]),
    ).toBe(EXIT.ok);
    const text = config();
    expect(text).toContain('// primary is the only real connection today.');
    expect(text).toMatch(/\/\/ ── managed:database\.connections:start/u);
    expect(text).toContain("reports: {\n        driver: 'd1',\n        binding: 'DB',\n      },");
    const exported = await validNow();
    const database = exported['database'] as { connections: Record<string, unknown> };
    expect(Object.keys(database.connections)).toEqual(['primary', 'reports']);
  });

  test('a second entry lands in the same region, not a second one', async () => {
    writeFileSync(join(root, 'wrangler.toml'), WRANGLER);
    await makeConnectionCommand([
      'reports',
      '--kind',
      'database',
      '--driver',
      'd1',
      '--binding',
      'DB',
    ]);
    await makeConnectionCommand([
      'audit',
      '--kind',
      'database',
      '--driver',
      'postgres',
      '--url-env',
      'AUDIT_URL',
    ]);
    const text = config();
    expect(text.match(/managed:database\.connections:start/gu)?.length).toBe(1);
    expect(text).toContain(
      "audit: {\n        driver: 'postgres',\n        url: {\n          fromEnv: 'AUDIT_URL',\n        },\n      },",
    );
    await validNow();
  });

  test('a cache store is added to cache.stores', async () => {
    await makeConnectionCommand([
      'sessions',
      '--kind',
      'cache',
      '--driver',
      'redis',
      '--connection',
      'primary',
    ]);
    const exported = await validNow();
    const cache = exported['cache'] as { stores: Record<string, unknown> };
    expect(cache.stores['sessions']).toEqual({ driver: 'redis', connection: 'primary' });
  });

  test('a storage disk and a mailer each land in their own registry', async () => {
    // Add the sections the command needs, in the layout it reads.
    const withSections = config().replace(
      '};\n',
      "  storage: {\n    default: 'local',\n    disks: {\n      local: { driver: 'fs' },\n    },\n  },\n  mail: {\n    default: 'smtp',\n    mailers: {\n      smtp: { driver: 'smtp' },\n    },\n  },\n};\n",
    );
    writeFileSync(join(root, 'tsir.js'), withSections);
    await makeConnectionCommand(['uploads', '--kind', 'storage', '--driver', 's3']);
    await makeConnectionCommand(['ops', '--kind', 'mail', '--driver', 'ses']);
    const exported = await validNow();
    expect((exported['storage'] as { disks: Record<string, unknown> }).disks['uploads']).toEqual({
      driver: 's3',
    });
    expect((exported['mail'] as { mailers: Record<string, unknown> }).mailers['ops']).toEqual({
      driver: 'ses',
    });
  });

  test('a name that already exists is refused', async () => {
    const error = await errorOf(() =>
      makeConnectionCommand([
        'primary',
        '--kind',
        'database',
        '--driver',
        'postgres',
        '--url-env',
        'X',
      ]),
    );
    expect(error).toBeInstanceOf(UsageError);
    if (error instanceof UsageError) expect(error.message).toContain('already has "primary"');
  });

  test('a registry the file does not declare says exactly what to add', async () => {
    writeFileSync(
      join(root, 'tsir.js'),
      "export default { app: { name: 'demo', entry: './src/app.ts' } };\n",
    );
    const error = await errorOf(() =>
      makeConnectionCommand([
        'reports',
        '--kind',
        'database',
        '--driver',
        'postgres',
        '--url-env',
        'X',
      ]),
    );
    expect(error).toBeInstanceOf(UsageError);
    if (error instanceof UsageError) expect(error.hint).toContain('database: { default');
  });

  test('--dry-run writes nothing', async () => {
    expect(
      await makeConnectionCommand([
        'audit',
        '--kind',
        'database',
        '--driver',
        'postgres',
        '--url-env',
        'X',
        '--dry-run',
      ]),
    ).toBe(EXIT.ok);
    expect(config()).toBe(BASE);
  });

  test('a postgres connection without --url-env is refused', async () => {
    const error = await errorOf(() =>
      makeConnectionCommand(['audit', '--kind', 'database', '--driver', 'postgres']),
    );
    expect(error).toBeInstanceOf(UsageError);
  });
});

describe('make:connection · the driver list is the registry, not a copy', () => {
  test('every kind lists the drivers its own package accepts', () => {
    // The bug this covers: this table said `mysql` while `DATABASE_ENGINES` had only `d1` and
    // `postgres`, so the command wrote a `tsir.js` the schema refused at boot. A copy of a list
    // drifts; reading the exported constant cannot.
    expect(KINDS['database']?.drivers).toEqual([...DATABASE_ENGINES]);
    expect(KINDS['cache']?.drivers).toContain('cloudflare-kv');
    expect(KINDS['queue']?.drivers).toContain('sqs');
    expect(KINDS['storage']?.drivers).toContain('s3');
    expect(KINDS['mail']?.drivers).toContain('ses');
  });

  test('a driver that is not in the registry is refused, by kind, before anything is written', () => {
    // `mysql` was this fixture until it shipped, which is the trap: a negative fixture names a
    // driver that does not exist *yet*, and the day it lands the test fails for the right reason
    // in the wrong place. `oracle` is not on any roadmap here.
    expect(() => entryFor('database', 'oracle', { urlEnv: 'DATABASE_URL' })).toThrow(
      /is not a database driver/u,
    );
    expect(() => entryFor('cache', 'memcached', {})).toThrow(/is not a cache driver/u);
    expect(() => entryFor('queue', 'rabbitmq', {})).toThrow(/is not a queue driver/u);
  });

  test('a newly shipped driver is accepted the moment it is in the constant', () => {
    // The positive half of the same rule: `mysql` and `sqlite` are drivers now, so the command
    // must write them without this file being edited.
    expect(entryFor('database', 'mysql', { urlEnv: 'MYSQL_HTTP_URL' })).toEqual({
      driver: 'mysql',
      url: { fromEnv: 'MYSQL_HTTP_URL' },
    });
  });

  test('a driver that is in the registry is accepted', () => {
    expect(entryFor('cache', 'redis', {})).toEqual({ driver: 'redis' });
    expect(entryFor('storage', 'local', {})).toEqual({ driver: 'local' });
  });
});
