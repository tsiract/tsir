import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { EXIT } from '../output.ts';
import { newCommand } from './generate.ts';

// CLI-016: `tsir new <app>` creates the application, its `tsir.js` and its `.env.example`. The
// scaffold is also booted in place: the `@tsir/*` imports only resolve from inside the repository,
// so the project is created under the console's fixtures folder and removed afterwards.

const FIXTURES = join(import.meta.dir, 'fixtures');

let parent = '';
let originalCwd = '';

beforeEach(() => {
  originalCwd = process.cwd();
  mkdirSync(FIXTURES, { recursive: true });
  parent = mkdtempSync(join(FIXTURES, '.new-'));
  process.chdir(parent);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(parent, { recursive: true, force: true });
});

async function rejectionOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('tsir new', () => {
  test('creates the application, tsir.js and .env.example', async () => {
    expect(await newCommand(['shop-api'])).toBe(EXIT.ok);
    const root = join(parent, 'shop-api');
    for (const file of [
      'tsir.js',
      '.env.example',
      'app.ts',
      'config.ts',
      'home/index.ts',
      'home/routes.ts',
      'home/http/home.controller.ts',
      'test/app.test.ts',
    ]) {
      expect(existsSync(join(root, file))).toBe(true);
    }
    expect(readFileSync(join(root, 'tsir.js'), 'utf8')).toContain("name: 'shop-api'");
    expect(readFileSync(join(root, 'tsir.js'), 'utf8')).toContain("entry: './app.ts'");
  });

  test('CLI-018: the scaffold ships an executable extensionless ract that runs tsir commands', async () => {
    await newCommand(['shop-api']);
    const ract = join(parent, 'shop-api', 'ract');
    expect(existsSync(ract)).toBe(true);
    expect(statSync(ract).mode & 0o777).toBe(0o755);
    expect(readFileSync(ract, 'utf8').startsWith('#!/usr/bin/env bun\n')).toBe(true);
    expect(readFileSync(ract, 'utf8')).toContain('runProjectCommand');
  });

  test('CLI-018: the script runs the file by path, and prettier ignores ract by name', async () => {
    await newCommand(['shop-api']);
    const pkg = JSON.parse(readFileSync(join(parent, 'shop-api', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // `bun ract` in the script would resolve to this same script: Bun prefers a package script to a file.
    expect(pkg.scripts['ract']).toBe('bun ./ract');
    expect(readFileSync(join(parent, 'shop-api', '.prettierignore'), 'utf8')).toBe('ract\n');
  });

  test('.env.example carries keys and defaults only, never a secret value', async () => {
    await newCommand(['shop-api']);
    const example = readFileSync(join(parent, 'shop-api', '.env.example'), 'utf8');
    const assignments = example
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(assignments).toEqual(['APP_ENV=development']);
    expect(example).toContain('Never commit real secrets');
  });

  test('a name that is not kebab-case is refused, and an existing directory needs --force', async () => {
    expect(await rejectionOf(newCommand(['Shop_API']))).toContain('not a valid app name');

    await newCommand(['shop-api']);
    expect(await rejectionOf(newCommand(['shop-api']))).toContain('already exists');

    writeFileSync(join(parent, 'shop-api', 'tsir.js'), '// edited by hand\n');
    expect(await newCommand(['shop-api', '--force'])).toBe(EXIT.ok);
    expect(readFileSync(join(parent, 'shop-api', 'tsir.js'), 'utf8')).toContain("name: 'shop-api'");
  });

  test('refuses to create an application inside the generated distribution', async () => {
    const previous = process.env['TSIR_DIST'];
    try {
      process.env['TSIR_DIST'] = parent;
      expect(await rejectionOf(newCommand(['shop-api']))).toContain(
        'outside the generated distribution',
      );
      expect(existsSync(join(parent, 'shop-api'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['TSIR_DIST'];
      else process.env['TSIR_DIST'] = previous;
    }
  });

  test('--dry-run writes nothing', async () => {
    expect(await newCommand(['shop-api', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(parent, 'shop-api'))).toBe(false);
  });

  test('the scaffold boots in development and reports ready', async () => {
    await newCommand(['shop-api']);
    // The full suite shares route registries in this process. A real app runs in
    // its own process, so exercise its boot without unrelated test controllers.
    const source = join(import.meta.dir, '..', 'project.ts');
    const script = `import { loadProject, bootProject } from ${JSON.stringify(source)};
      const project = await loadProject(process.cwd());
      const { app } = await bootProject(project, { mode: 'development' });
      if (app.state.kind !== 'ready') process.exit(1);
      await app.shutdown('signal');
      if (app.state.kind !== 'stopped') process.exit(1);`;
    const result = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: join(parent, 'shop-api'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
