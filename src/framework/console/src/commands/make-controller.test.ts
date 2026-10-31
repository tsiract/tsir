import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import { controllerTemplate } from './make-controller.ts';

// CLI-010: `make:controller` output. The strict-compile evidence is a one-off run recorded in the
// task notes; these tests pin the template and the command's refusals.

let dir = '';
let originalCwd = '';
let captured = '';
let outputs = '';
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-ctrl-'));
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

describe('controllerTemplate', () => {
  test('declares the class, its prefix and its unit, and never uses any', () => {
    const text = controllerTemplate('UsersController', 'users', '/api/users', 'http');
    expect(text).toContain("@Controller('/api/users', { unit: 'http' })");
    expect(text).toContain('export class UsersController {');
    expect(text).toContain("@Get('/', { tags: ['users'], operationId: 'users.list' })");
    expect(text).not.toMatch(/\bany\b/);
  });

  test('a custom unit is written into the decorator', () => {
    const text = controllerTemplate(
      'BillingController',
      'billing',
      '/api/billing',
      'billing-worker',
    );
    expect(text).toContain("{ unit: 'billing-worker' }");
  });
});

describe('make:controller', () => {
  test('writes src/modules/<stem>.controller.ts with the default prefix', async () => {
    expect(await runCli(['make:controller', 'Users'])).toBe(EXIT.ok);
    const text = readFileSync(join(dir, 'src', 'modules', 'users.controller.ts'), 'utf8');
    expect(text).toContain("@Controller('/api/users', { unit: 'http' })");
  });

  test('accepts the name with the Controller suffix', async () => {
    expect(await runCli(['make:controller', 'BillingController'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'src', 'modules', 'billing.controller.ts'))).toBe(true);
  });

  test('refuses an existing controller, names it, and exits 1', async () => {
    await runCli(['make:controller', 'Users']);
    expect(await runCli(['make:controller', 'Users'])).toBe(EXIT.failure);
    expect(captured).toContain('refusing to overwrite');
    expect(captured).toContain('users.controller.ts');
  });

  test('--dry-run writes nothing', async () => {
    expect(await runCli(['make:controller', 'Orders', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'src'))).toBe(false);
    expect(outputs).toContain('would create');
  });

  test('an invalid unit is a usage error (exit 2) and writes nothing', async () => {
    expect(await runCli(['make:controller', 'Users', '--unit', 'Bad Unit'])).toBe(EXIT.usage);
    expect(existsSync(join(dir, 'src'))).toBe(false);
  });

  test('a prefix without a leading slash is a usage error (exit 2)', async () => {
    expect(await runCli(['make:controller', 'Users', '--path', 'api/users'])).toBe(EXIT.usage);
  });

  test('a name that is not an identifier is a usage error (exit 2)', async () => {
    expect(await runCli(['make:controller', 'my-users'])).toBe(EXIT.usage);
  });

  test('no name is a usage error (exit 2)', async () => {
    expect(await runCli(['make:controller'])).toBe(EXIT.usage);
  });
});
