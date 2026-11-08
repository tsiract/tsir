import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml, exampleOf, highlight, renderFrontpage } from './build.ts';
import { packages, renderPackages } from './packages.ts';

const ROOT = process.cwd();

describe('frontpage build (DOC-001, DOC-006, DOC-007)', () => {
  test('every framework package appears once, with a real source and reference', async () => {
    // The inventory is checked against the tree, not a number that has to be remembered each
    // time a package is added: one card per `src/framework/*` directory, and no card without one.
    const framework = readdirSync(join(ROOT, 'src/framework'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect([...new Set(packages.map((pkg) => pkg.name))].sort()).toEqual(framework);
    const html = renderPackages();
    for (const pkg of packages) {
      expect(html.match(new RegExp(`class="pkg">@tsir/${pkg.name}</span>`, 'gu'))).toHaveLength(1);
      expect(Bun.file(join(ROOT, `src/framework/${pkg.name}/package.json`)).size).toBeGreaterThan(
        0,
      );
      expect(Bun.file(join(ROOT, `src/docs/packages/${pkg.name}.md`)).size).toBeGreaterThan(0);
      if (pkg.status === 'partial') expect(pkg.caveat?.length).toBeGreaterThan(20);
    }
  });

  test('code examples come from the same prose exercised by package-examples.test.ts', async () => {
    for (const name of ['http', 'validate', 'database']) {
      const prose = await readFile(join(ROOT, `src/docs/packages/prose/${name}.md`), 'utf8');
      const code = exampleOf(prose);
      expect(code).toContain(`@tsir/${name}`);
      expect(code).not.toContain('```');
    }
    expect(() => exampleOf('# No example')).toThrow('tested TypeScript example');
  });

  test('highlighting escapes source instead of trusting it as HTML', () => {
    expect(escapeHtml('<&"\'>')).toBe('&lt;&amp;&quot;&#39;&gt;');
    const output = highlight("const text = '<script>';\n// A comment");
    expect(output).toContain('&lt;script&gt;');
    expect(output).not.toContain('<script>');
    expect(output).toContain('token-keyword');
    expect(output).toContain('token-comment');
  });

  test('the committed page is reproducible, self-contained and within budget', async () => {
    const html = await renderFrontpage(ROOT);
    const committed = await readFile(join(ROOT, 'src/apps/frontpage/public/index.html'), 'utf8');
    expect(html).toBe(committed);
    expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(html).toContain('data-theme="silk"');
    expect(html).toContain('[data-theme=abyss]');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).not.toMatch(/<(?:script|img)[^>]+(?:src|href)="https?:/u);
    // External link tags are only allowed for canonical/SEO metadata, not stylesheets or assets.
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"[^>]*>/u);
    expect(html).toMatch(/<link[^>]+rel="canonical"[^>]*>/u);
    expect(html).not.toMatch(/__PACKAGES__|__PACKAGE_COUNT__|__SITE_CSS__|__SITE_JS__/u);
    // Runtime metadata is deliberately injected later by dev.ts or dist.ts.
    expect(html).toContain('__TSIR_VERSION__');
    expect(html).toContain('__TSIR_SIZE_CORE__');
  }, 15_000);
});
