import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { templateFiles, type FrontendIntegration } from './frontend-templates.ts';
import { BUILD_DIR, configuredTemplates, typecheckScript } from './verify-templates.ts';

const ROOT = resolve(import.meta.dir, '..', '..');

describe('tools · templates are verified by running them (Q71 follow-up)', () => {
  test('the configuration names the templates the gate will install and build', () => {
    const integrations = configuredTemplates(
      readFileSync(join(ROOT, 'tsir.dist.config.json'), 'utf8'),
    );
    expect(integrations.length).toBeGreaterThan(0);
    expect(integrations.map((integration) => integration.framework).sort()).toEqual([
      'react',
      'svelte',
      'vue',
    ]);
  });

  test('a configuration without frontends verifies nothing rather than failing', () => {
    expect(configuredTemplates('{"version":1}')).toEqual([]);
  });

  test('Vue types through vue-tsc, because only its compiler reads a single-file component', () => {
    expect(typecheckScript('vue')).toBe('vue-tsc --noEmit');
    for (const framework of ['svelte', 'react']) {
      expect(typecheckScript(framework)).toBe('tsc --noEmit');
    }
  });

  test('every configured template declares the scripts the gate runs', () => {
    // A missing script fails as `error: script "typecheck" not found`, which reads like a typo in the
    // gate rather than a missing script in the template. Asserting it here names the real cause.
    const integrations = configuredTemplates(
      readFileSync(join(ROOT, 'tsir.dist.config.json'), 'utf8'),
    );
    for (const integration of integrations) {
      const files = templateFiles(integration);
      const manifest = JSON.parse(files.get('package.json') ?? '{}') as {
        scripts?: Record<string, string>;
      };
      expect(manifest.scripts?.['build']).toBe('vite build');
      expect(manifest.scripts?.['typecheck']).toBe(typecheckScript(integration.framework));
      expect(files.has('vite.config.ts')).toBe(true);
    }
  });

  test('the build output the gate looks for is the one Vite writes', () => {
    expect(BUILD_DIR).toBe('dist');
  });

  test('a template with frontend types on has a tsconfig for the gate to typecheck', () => {
    const integration: FrontendIntegration = {
      framework: 'react',
      styling: ['tailwind'],
      router: 'router',
    };
    const tsconfig = JSON.parse(templateFiles(integration).get('tsconfig.json') ?? '{}') as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions?.['jsx']).toBe('react-jsx');
    expect(tsconfig.compilerOptions?.['allowImportingTsExtensions']).toBe(true);
  });
});
