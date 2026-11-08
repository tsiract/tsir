import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyOverrides,
  DEFAULT_DIST_CONFIG,
  describeDistConfig,
  DIST_CONFIG_FILE,
  loadDistConfig,
  validateDistConfig,
  writeDistConfig,
} from './dist-config.ts';

const FRONTEND = {
  framework: 'svelte',
  bundler: 'vite',
  typescript: 'strict',
  styling: ['tailwind'],
  router: 'none',
} as const;

describe('the default distribution', () => {
  test('is valid with no file at all', () => {
    // A fresh checkout must build without the wizard ever running; otherwise `make dist` in CI
    // depends on someone having clicked through a menu.
    const { config, problems } = validateDistConfig(DEFAULT_DIST_CONFIG);
    expect(problems).toEqual([]);
    expect(config).toBeDefined();
  });

  test('ships no frontend template and one default manager', () => {
    expect(DEFAULT_DIST_CONFIG.frontends).toEqual([]);
    expect(DEFAULT_DIST_CONFIG.defaultPackageManager).toBe('bun');
  });
});

describe('validation', () => {
  test('refuses daisyui without tailwind, because the stylesheet would reference nothing', () => {
    const { problems } = validateDistConfig({
      version: 1,
      frontends: [{ ...FRONTEND, styling: ['daisyui'] }],
    });
    expect(problems).toEqual([{ field: 'frontends[0].styling', message: 'daisyui requires tailwind' }]);
  });

  test('refuses two templates for the same framework', () => {
    const { problems } = validateDistConfig({
      version: 1,
      frontends: [FRONTEND, FRONTEND],
    });
    expect(problems.map((problem) => problem.message)).toContain('duplicate template for svelte');
  });

  test('refuses a default manager that the distribution does not ship', () => {
    const { problems } = validateDistConfig({
      version: 1,
      packageManagers: ['npm'],
      defaultPackageManager: 'bun',
    });
    expect(problems).toEqual([
      { field: 'defaultPackageManager', message: 'bun is not in packageManagers (npm)' },
    ]);
  });

  test('refuses an unknown runtime rather than silently dropping it', () => {
    const { problems } = validateDistConfig({ version: 1, runtimes: ['bun', 'heroku'] });
    expect(problems).toEqual([{ field: 'runtimes', message: '"heroku" is not one of bun, cloudflare-workers, aws-lambda' }]);
  });

  test('a version bump is refused, not guessed at', () => {
    const { problems } = validateDistConfig({ version: 2 });
    expect(problems[0]?.field).toBe('version');
    expect(problems[0]?.message).toContain('delete the file to start from defaults');
  });

  test('frontend types follow the templates unless stated', () => {
    const withFrontend = validateDistConfig({ version: 1, frontends: [FRONTEND] });
    expect(withFrontend.config?.includeFrontendTypes).toBe(true);
    const explicit = validateDistConfig({ version: 1, frontends: [FRONTEND], includeFrontendTypes: false });
    expect(explicit.config?.includeFrontendTypes).toBe(false);
  });
});

describe('persistence', () => {
  test('a missing file yields the defaults, and says so', () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-config-'));
    try {
      const { value } = loadDistConfig(root);
      expect(value?.fromFile).toBe(false);
      expect(value?.config).toEqual(DEFAULT_DIST_CONFIG);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('what is written is what is read back', () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-config-'));
    try {
      // `includeFrontendTypes` is a *derived* default: it follows the templates unless the file says
      // otherwise, so what round-trips is the explicit value, not the one that was inferred.
      const config = {
        ...DEFAULT_DIST_CONFIG,
        frontends: [{ ...FRONTEND, styling: ['tailwind', 'daisyui'] as const }],
        includeFrontendTypes: true,
      };
      writeDistConfig(root, config);
      const { value, problems } = loadDistConfig(root);
      expect(problems).toEqual([]);
      expect(value?.fromFile).toBe(true);
      expect(value?.config.frontends[0]?.framework).toBe('svelte');
      expect(value?.config.includeFrontendTypes).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a hand-edited file that is not JSON is reported by name, not thrown', () => {
    const root = mkdtempSync(join(tmpdir(), 'dist-config-'));
    try {
      writeFileSync(join(root, DIST_CONFIG_FILE), '{ nope');
      const { value, problems } = loadDistConfig(root);
      expect(value).toBeUndefined();
      expect(problems[0]?.message).toContain(DIST_CONFIG_FILE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('overrides', () => {
  test('--package-manager narrows support to the one manager chosen', () => {
    const { config } = applyOverrides(DEFAULT_DIST_CONFIG, { packageManager: 'pnpm' });
    expect(config?.packageManagers).toEqual(['pnpm']);
    expect(config?.defaultPackageManager).toBe('pnpm');
  });

  test('--frontend none clears the templates', () => {
    const withFrontend = { ...DEFAULT_DIST_CONFIG, frontends: [FRONTEND] };
    const { config } = applyOverrides(withFrontend, { frontend: 'none' });
    expect(config?.frontends).toEqual([]);
    expect(config?.includeFrontendTypes).toBe(false);
  });

  test('--frontend with --styling builds a template that validates', () => {
    const { config, problems } = applyOverrides(DEFAULT_DIST_CONFIG, {
      frontend: 'react',
      styling: 'tailwind,daisyui',
    });
    expect(problems).toEqual([]);
    expect(config?.frontends[0]?.styling).toEqual(['tailwind', 'daisyui']);
  });

  test('an invalid pairing from the command line is refused with the same rule as the wizard', () => {
    const { problems } = applyOverrides(DEFAULT_DIST_CONFIG, { frontend: 'vue', styling: 'daisyui' });
    expect(problems.map((problem) => problem.message)).toContain('daisyui requires tailwind');
  });
});

describe('summary', () => {
  test('names a backend-only distribution as such, not as an empty list', () => {
    const rows = describeDistConfig(DEFAULT_DIST_CONFIG);
    expect(rows.find(([label]) => label === 'frontends')?.[1]).toBe('none (backend only)');
  });

  test('shows a template with its styling and router', () => {
    const rows = describeDistConfig({
      ...DEFAULT_DIST_CONFIG,
      frontends: [{ ...FRONTEND, styling: ['tailwind', 'daisyui'], router: 'router' }],
    });
    expect(rows.find(([label]) => label === 'frontends')?.[1]).toBe(
      'svelte + tailwind + daisyui + router router',
    );
  });
});
