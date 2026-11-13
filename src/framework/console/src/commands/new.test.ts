import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  test('creates the application in apps/<name>, with tsir.js and .env.example', async () => {
    expect(await newCommand(['shop-api'])).toBe(EXIT.ok);
    const root = join(parent, 'apps', 'shop-api');
    // The application workspace is `apps/` — never `app/`, never the invocation directory itself.
    expect(existsSync(join(parent, 'app'))).toBe(false);
    expect(existsSync(join(parent, 'app.ts'))).toBe(false);
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
    // The project file is an assembly point: sections live in `config/`, merged by `configDir()`.
    // The name and entry belong to the app section, which is where a reader looks for them.
    expect(readFileSync(join(root, 'tsir.js'), 'utf8')).toContain('configDir');
    expect(readFileSync(join(root, 'config', 'app.ts'), 'utf8')).toContain("name: 'shop-api'");
    expect(readFileSync(join(root, 'config', 'app.ts'), 'utf8')).toContain("entry: './app.ts'");
    // `CAP-008`: every capability whose driver `tsir.js` can name now gets a section, and the
    // driver in it is the row for the target (cloudflare, when `--target` is not given). Before
    // that, the starter wrote only `database` — and hardcoded `d1` into it, which `--target lambda`
    // could not correct.
    expect(readdirSync(join(root, 'config')).sort()).toEqual([
      'app.ts',
      'broadcast.ts',
      'cache.ts',
      'database.ts',
      'mail.ts',
      'media.ts',
      'notify.ts',
      'queue.ts',
      'search.ts',
      'storage.ts',
    ]);
    expect(readFileSync(join(root, 'config', 'cache.ts'), 'utf8')).toContain(
      "driver: 'cloudflare-kv'",
    );
  });

  test('CLI-018: the scaffold ships an executable extensionless ract that runs tsir commands', async () => {
    await newCommand(['shop-api']);
    const ract = join(parent, 'apps', 'shop-api', 'ract');
    expect(existsSync(ract)).toBe(true);
    expect(statSync(ract).mode & 0o777).toBe(0o755);
    expect(readFileSync(ract, 'utf8').startsWith('#!/usr/bin/env bun\n')).toBe(true);
    expect(readFileSync(ract, 'utf8')).toContain('runProjectCommand');
  });

  test('CLI-018: the script runs the file by path, and prettier ignores ract by name', async () => {
    await newCommand(['shop-api']);
    const pkg = JSON.parse(
      readFileSync(join(parent, 'apps', 'shop-api', 'package.json'), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    // `bun ract` in the script would resolve to this same script: Bun prefers a package script to a file.
    expect(pkg.scripts['ract']).toBe('bun ./ract');
    expect(readFileSync(join(parent, 'apps', 'shop-api', '.prettierignore'), 'utf8')).toBe(
      'ract\n',
    );
  });

  test('points at the distribution with link:, so there is one copy of each package', async () => {
    // The scaffold only has a distribution to point at when the CLI came from one, which is how
    // it is invoked in practice (`dist/tsir` exports `TSIR_DIST`). Stand in a minimal one.
    const dist = join(parent, 'dist');
    for (const part of ['console', 'router', 'schedule']) {
      mkdirSync(join(dist, 'framework', part), { recursive: true });
      writeFileSync(join(dist, 'framework', part, 'package.json'), '{}\n');
    }
    const previous = process.env['TSIR_DIST'];
    process.env['TSIR_DIST'] = dist;
    try {
      await newCommand(['shop-api']);
    } finally {
      if (previous === undefined) delete process.env['TSIR_DIST'];
      else process.env['TSIR_DIST'] = previous;
    }
    const pkg = JSON.parse(
      readFileSync(join(parent, 'apps', 'shop-api', 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    // `file:` is *copied* into node_modules once per dependent, so the framework's process-local
    // registries (routes, controllers, container) end up duplicated and stop agreeing with each
    // other. `link:` resolves every reference to the one package directory.
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      if (name.startsWith('@tsir/')) expect(range).toStartWith('link:../../dist/framework/');
    }
    for (const range of Object.values(pkg.overrides))
      expect(range).toStartWith('link:../../dist/framework/');
    // Every shipped package is covered, not only the ones the app imports directly — a
    // transitive range with no override is looked up on a registry that has no @tsir packages.
    // (The stand-in distribution above ships three packages; a real one ships all of them, which
    // this scans rather than hard-coding.)
    expect(Object.keys(pkg.overrides)).toEqual(
      ['console', 'router', 'schedule'].map((part) => `@tsir/${part}`),
    );
  });

  test('.env.example carries keys and defaults only, never a secret value', async () => {
    await newCommand(['shop-api']);
    const example = readFileSync(join(parent, 'apps', 'shop-api', '.env.example'), 'utf8');
    const assignments = example
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    // `CAP-008`: a generated config references its secrets as `{ fromEnv }`, so the variables are
    // listed — a name and an empty value. The property under test is unchanged: no value, ever.
    expect(assignments).toContain('APP_ENV=development');
    // `APP_ENV` is the one assignment that carries a value, and `development` is not a secret.
    expect(assignments.filter((line) => !line.endsWith('='))).toEqual(['APP_ENV=development']);
    expect(example).toContain('Never commit real secrets');
  });

  test('a name that is not kebab-case is refused, and an existing directory needs --force', async () => {
    expect(await rejectionOf(newCommand(['Shop_API']))).toContain('not a valid app name');

    await newCommand(['shop-api']);
    expect(await rejectionOf(newCommand(['shop-api']))).toContain('already exists');

    writeFileSync(join(parent, 'apps', 'shop-api', 'config', 'app.ts'), '// edited by hand\n');
    expect(await newCommand(['shop-api', '--force'])).toBe(EXIT.ok);
    expect(readFileSync(join(parent, 'apps', 'shop-api', 'config', 'app.ts'), 'utf8')).toContain(
      "name: 'shop-api'",
    );
  });

  test('refuses to create an application inside the generated distribution', async () => {
    const previous = process.env['TSIR_DIST'];
    try {
      process.env['TSIR_DIST'] = parent;
      expect(await rejectionOf(newCommand(['shop-api']))).toContain(
        'outside the generated distribution',
      );
      expect(existsSync(join(parent, 'apps', 'shop-api'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['TSIR_DIST'];
      else process.env['TSIR_DIST'] = previous;
    }
  });

  test('--dry-run writes nothing', async () => {
    expect(await newCommand(['shop-api', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(parent, 'apps', 'shop-api'))).toBe(false);
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
      cwd: join(parent, 'apps', 'shop-api'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
