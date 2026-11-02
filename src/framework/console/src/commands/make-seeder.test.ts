import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { EXIT } from '../output.ts';
import { makeSeederCommand, seederNames, seederTemplate } from './make-seeder.ts';

// CLI-012: `make:seeder` writes one `defineSeeder({...})` file. The generated file imports
// `@tsir/seed`, which a scratch project outside the repository cannot resolve, so the runtime
// test rewrites that single specifier to the repository's source. Everything else is generated.

const SEED_SRC = resolve(import.meta.dir, '..', '..', '..', 'seed', 'src', 'index.ts');

/** The message a rejected promise carries, or '' when it resolves. */
async function rejectionOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let dir = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-seeder-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('names', () => {
  test('the suffix is optional and the class always ends in Seeder', () => {
    expect(seederNames('Users')).toEqual({ className: 'UsersSeeder', stem: 'users' });
    expect(seederNames('UsersSeeder')).toEqual({ className: 'UsersSeeder', stem: 'users' });
    expect(seederNames('BlogPost')).toEqual({ className: 'BlogPostSeeder', stem: 'blog-post' });
  });

  test('a name that is not an identifier is refused', () => {
    expect(() => seederNames('my-users')).toThrow('not a valid seeder name');
  });
});

describe('template', () => {
  test('development and test only by default, with a promise of idempotency', () => {
    const text = seederTemplate('UsersSeeder', { order: '100', reference: false });
    expect(text).toContain("environments: ['development', 'test'],");
    expect(text).not.toContain('production: true');
    expect(text).toContain('idempotent: true');
  });

  test('--reference adds staging and production, and marks the seeder as reference data', () => {
    const text = seederTemplate('CountriesSeeder', { order: '5', reference: true });
    expect(text).toContain("'production'");
    expect(text).toContain('production: true,');
  });
});

describe('generated file', () => {
  test('is a real defineSeeder that validates and runs with the contract', async () => {
    expect(await makeSeederCommand(['Users'])).toBe(EXIT.ok);
    const path = join(dir, 'seeders', 'users.seeder.ts');
    expect(existsSync(path)).toBe(true);

    const source = readFileSync(path, 'utf8').replace("'@tsir/seed'", `'${SEED_SRC}'`);
    const scratch = join(dir, 'loaded.ts');
    writeFileSync(scratch, source);
    const mod = (await import(scratch)) as {
      UsersSeeder: { name: string; order: number; idempotent: boolean; environments: string[] };
    };

    expect(mod.UsersSeeder.name).toBe('UsersSeeder');
    expect(mod.UsersSeeder.order).toBe(100);
    expect(mod.UsersSeeder.idempotent).toBe(true);
    expect(mod.UsersSeeder.environments).toEqual(['development', 'test']);
  });

  test('--order sets the order and rejects a non-integer', async () => {
    expect(await makeSeederCommand(['Users', '--order', '7'])).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'seeders', 'users.seeder.ts'), 'utf8')).toContain(
      'order: 7,',
    );
    expect(await rejectionOf(makeSeederCommand(['Posts', '--order', 'first']))).toContain(
      '--order must be a non-negative integer',
    );
  });

  test('refuses to overwrite without --force, and --dry-run writes nothing', async () => {
    await makeSeederCommand(['Users']);
    expect(await rejectionOf(makeSeederCommand(['Users']))).toContain('refusing to overwrite');

    expect(await makeSeederCommand(['Posts', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'seeders', 'posts.seeder.ts'))).toBe(false);
  });

  test('a missing name is a usage error', async () => {
    expect(await rejectionOf(makeSeederCommand([]))).toContain('needs a name');
  });
});
