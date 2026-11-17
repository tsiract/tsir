/**
 * The frontend templates: what they contain, and the two rules that make them templates.
 *
 * These tests are deliberately about the *file set* rather than about a browser. Whether a template
 * builds is proved elsewhere, by installing and running `vite build` over the emitted tree
 * (`make dist-check` reports it); what can be asserted cheaply here is the structure that makes the
 * build possible at all — the entry file `index.html` names, the compiler flags the framework
 * needs, and the boundary that stops a template becoming a second application.
 */

import { describe, expect, test } from 'bun:test';

import {
  emitFrontendTemplates,
  FRONTEND_VERSIONS,
  templateFiles,
  type FrontendIntegration,
} from './frontend-templates.ts';

const integration = (
  framework: FrontendIntegration['framework'],
  styling: FrontendIntegration['styling'] = [],
  router: FrontendIntegration['router'] = 'none',
): FrontendIntegration => ({ framework, styling, router });

describe('frontend templates', () => {
  test('each framework emits the files a Vite project needs', () => {
    for (const framework of ['svelte', 'react', 'vue'] as const) {
      const files = templateFiles(integration(framework));
      for (const required of [
        'index.html',
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'src/api.ts',
      ]) {
        expect(files.has(required)).toBe(true);
      }
      // The entry `index.html` names must exist, or the dev server serves a 404 on first run.
      const html = files.get('index.html') ?? '';
      const entry = /src="\/([^"]+)"/u.exec(html)?.[1];
      expect(entry).toBeDefined();
      expect(files.has(entry ?? '')).toBe(true);
      // The proxy is the whole Tsir integration: without it the frontend cannot reach the backend
      // without CORS configuration, which a generated project should never need.
      expect(files.get('vite.config.ts')).toContain("'/api'");
      expect(files.get('vite.config.ts')).toContain('changeOrigin: true');
    }
  });

  test('a template depends on no @tsir package: it is a frontend, not an application', () => {
    for (const framework of ['svelte', 'react', 'vue'] as const) {
      const manifest = JSON.parse(
        templateFiles(integration(framework)).get('package.json') ?? '{}',
      ) as {
        private?: boolean;
        dependencies?: Record<string, string>;
      };
      expect(manifest.private).toBe(true);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        expect(dependency.startsWith('@tsir/')).toBe(false);
      }
    }
  });

  test('React gets the JSX compiler flags, and every template may import a .ts path', () => {
    const react = JSON.parse(templateFiles(integration('react')).get('tsconfig.json') ?? '{}') as {
      compilerOptions?: Record<string, unknown>;
    };
    // Without these a `.tsx` file is parsed as TypeScript: `TS17004: Cannot use JSX unless
    // '--jsx' is provided`, one error per element.
    expect(react.compilerOptions?.['jsx']).toBe('react-jsx');
    expect(react.compilerOptions?.['allowImportingTsExtensions']).toBe(true);

    const svelte = templateFiles(integration('svelte')).get('tsconfig.json') ?? '';
    expect(svelte).toContain('src/**/*.svelte');
    expect(JSON.parse(svelte).compilerOptions.jsx).toBeUndefined();
  });

  test('styling is opt-in, and DaisyUI brings its Tailwind plugin', () => {
    const plain = templateFiles(integration('svelte'));
    expect(plain.has('src/app.css')).toBe(false);
    expect(plain.get('vite.config.ts')).not.toContain('tailwindcss');

    const tailwind = templateFiles(integration('svelte', ['tailwind']));
    expect(tailwind.get('src/app.css')).toBe('@import "tailwindcss";\n');
    expect(tailwind.get('vite.config.ts')).toContain('tailwindcss()');
    expect(tailwind.get('package.json')).toContain('@tailwindcss/vite');

    const daisy = templateFiles(integration('svelte', ['daisyui', 'tailwind']));
    expect(daisy.get('src/app.css')).toContain('@plugin "daisyui"');
    expect(daisy.get('package.json')).toContain('daisyui');
  });

  test('client routing is opt-in and brings exactly one router', () => {
    for (const framework of ['svelte', 'react', 'vue'] as const) {
      const withoutRouter = templateFiles(integration(framework, [], 'none'));
      const withRouter = templateFiles(integration(framework, [], 'router'));
      expect([...withRouter.keys()].length).toBeGreaterThan([...withoutRouter.keys()].length);
      const manifest = JSON.parse(withRouter.get('package.json') ?? '{}') as {
        dependencies?: Record<string, string>;
      };
      const routers = Object.keys(manifest.dependencies ?? {}).filter((name) =>
        name.includes('router'),
      );
      expect(routers).toHaveLength(1);
      const plain = JSON.parse(withoutRouter.get('package.json') ?? '{}') as {
        dependencies?: Record<string, string>;
      };
      expect(
        Object.keys(plain.dependencies ?? {}).filter((name) => name.includes('router')),
      ).toEqual([]);
    }
  });

  test('versions are pinned to the majors the plugins are written against', () => {
    // A caret or a bare major, never `latest`: a template is a starting point that must install the
    // same way twice.
    for (const framework of ['svelte', 'react', 'vue'] as const) {
      const manifest = JSON.parse(
        templateFiles(integration(framework)).get('package.json') ?? '{}',
      ) as {
        devDependencies?: Record<string, string>;
      };
      for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
        expect(`${name}@${range}`).not.toContain('latest');
        expect(range.startsWith('^'));
      }
    }
    expect(FRONTEND_VERSIONS.vite[1]).toMatch(/^\^7/u);
  });

  test('emitting nothing configured writes nothing', async () => {
    const emitted = await emitFrontendTemplates('/tmp/tsir-templates-empty', []);
    expect(emitted).toEqual([]);
  });
});
