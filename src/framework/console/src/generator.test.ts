import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitWrites, planWrites } from './generator.ts';
import { runCli } from './index.ts';
import { EXIT } from './output.ts';

// CLI-009: the generator engine. Each case runs in a scratch directory under the OS temp dir.

let dir = '';
let originalCwd = '';
let captured = '';
let outputs = '';
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-gen-'));
  process.chdir(dir);
  captured = '';
  outputs = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    outputs += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = realErr;
  process.stdout.write = realOut;
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** Awaits a rejection and returns the error, so the assertion below runs against the real failure. */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the operation to be refused');
}

const plain = { force: false, dryRun: false };
const forced = { force: true, dryRun: false };
const dry = { force: false, dryRun: true };

function temps(root: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) found.push(full);
    }
  };
  walk(root);
  return found;
}

describe('refuse before writing', () => {
  test('an existing file is refused, the error names its path, and nothing is written', async () => {
    const existing = join(dir, 'b.ts');
    writeFileSync(existing, 'keep me');
    const files = [
      { path: join(dir, 'a.ts'), contents: 'a' },
      { path: existing, contents: 'b' },
    ];
    const error = await failureOf(commitWrites(files, plain));
    expect(error.message).toMatch(/refusing to overwrite .*b\.ts/);
    expect(existsSync(join(dir, 'a.ts'))).toBe(false);
    expect(readFileSync(existing, 'utf8')).toBe('keep me');
    expect(temps(dir)).toEqual([]);
  });

  test('planWrites reports the path in the thrown error', () => {
    const existing = join(dir, 'x.ts');
    writeFileSync(existing, '');
    expect(() => planWrites([{ path: existing, contents: '' }], plain)).toThrow('x.ts');
  });
});

describe('--force', () => {
  test('replaces an existing file and reports it as an overwrite', async () => {
    const target = join(dir, 'c.ts');
    writeFileSync(target, 'old');
    const plan = await commitWrites([{ path: target, contents: 'new' }], forced);
    expect(plan).toEqual([{ path: target, action: 'overwrite' }]);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });
});

describe('--dry-run', () => {
  test('writes nothing and returns the plan', async () => {
    const created = join(dir, 'deep', 'd.ts');
    const plan = await commitWrites([{ path: created, contents: 'd' }], dry);
    expect(plan).toEqual([{ path: created, action: 'create' }]);
    expect(existsSync(join(dir, 'deep'))).toBe(false);
  });

  test('still refuses an existing file, so a dry run predicts the real run', async () => {
    const target = join(dir, 'e.ts');
    writeFileSync(target, 'x');
    const error = await failureOf(commitWrites([{ path: target, contents: 'y' }], dry));
    expect(error.message).toContain('refusing to overwrite');
  });
});

describe('atomic commit', () => {
  test('creates parent directories and leaves no temporary files behind', async () => {
    const files = [
      { path: join(dir, 'one', 'a.ts'), contents: 'A' },
      { path: join(dir, 'one', 'two', 'b.ts'), contents: 'B' },
    ];
    await commitWrites(files, plain);
    expect(readFileSync(join(dir, 'one', 'a.ts'), 'utf8')).toBe('A');
    expect(readFileSync(join(dir, 'one', 'two', 'b.ts'), 'utf8')).toBe('B');
    expect(temps(dir)).toEqual([]);
  });

  test('a path that cannot be created fails before any file is written', async () => {
    writeFileSync(join(dir, 'blocker'), 'a file, not a directory');
    const files = [
      { path: join(dir, 'ok.ts'), contents: 'ok' },
      { path: join(dir, 'blocker', 'inner.ts'), contents: 'nope' },
    ];
    await failureOf(commitWrites(files, plain));
    expect(existsSync(join(dir, 'ok.ts'))).toBe(false);
    expect(temps(dir)).toEqual([]);
  });
});

describe('commands use the engine', () => {
  test('make:module refuses an existing module, names it, and exits 1', async () => {
    await runCli(['make:module', 'Users']);
    const moduleDir = join(dir, 'users');
    for (const file of ['index.ts', 'routes.ts', 'http/users.controller.ts', 'users.test.ts']) {
      expect(existsSync(join(moduleDir, file))).toBe(true);
    }
    expect(await runCli(['make:module', 'Users'])).toBe(EXIT.failure);
    expect(captured).toContain('refusing to overwrite');
    expect(captured).toContain('users');
  });

  test('make:module --force overwrites, and --dry-run writes nothing', async () => {
    expect(await runCli(['make:module', 'Orders', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'orders'))).toBe(false);
    expect(outputs).toContain('would create');

    await runCli(['make:module', 'Orders']);
    expect(await runCli(['make:module', 'Orders', '--force'])).toBe(EXIT.ok);
  });

  test('make:module writes the house layout: routes, controller, index, and a test', async () => {
    expect(await runCli(['make:module', 'Billing'])).toBe(EXIT.ok);
    const moduleDir = join(dir, 'billing');
    const routes = readFileSync(join(moduleDir, 'routes.ts'), 'utf8');
    expect(routes).toContain('routeModule({');
    expect(routes).toContain("name: 'billing'");
    const controller = readFileSync(join(moduleDir, 'http/billing.controller.ts'), 'utf8');
    expect(controller).toContain("@Controller(registry, '/billing')");
    const index = readFileSync(join(moduleDir, 'index.ts'), 'utf8');
    expect(index).toContain('export { billing, registry }');
    const test = readFileSync(join(moduleDir, 'billing.test.ts'), 'utf8');
    expect(test).toContain('modules: [_module.module]');
  });

  test('new --dry-run lists every scaffold file and writes none', async () => {
    expect(await runCli(['new', 'shop', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'shop'))).toBe(false);
    expect(outputs).toContain('would create');
    expect(outputs).toContain('tsir.js');
  });
});
