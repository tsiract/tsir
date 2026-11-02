import { describe, expect, test } from 'bun:test';
import { rewriteLinks, renderPage } from './docs-site.ts';

const exists = (target: string): boolean =>
  ['errors.md', 'packages/queue.md', 'api-surface.json', 'assets/logo.svg'].includes(target);

describe('rewriteLinks (DOC-009)', () => {
  test('a Markdown link becomes a clean directory URL, relative to the page', () => {
    const { html, broken } = rewriteLinks(
      '<a href="../errors.md">e</a>',
      'packages/queue.md',
      exists,
    );
    expect(html).toBe('<a href="../../errors/">e</a>');
    expect(broken).toEqual([]);
  });

  test('a fragment survives the rewrite', () => {
    const { html } = rewriteLinks('<a href="errors.md#codes">e</a>', 'index.md', exists);
    expect(html).toBe('<a href="errors/#codes">e</a>');
  });

  test('a link that resolves to nothing fails the build', () => {
    const { broken } = rewriteLinks('<a href="missing.md">m</a>', 'index.md', exists);
    expect(broken).toEqual(['index.md → missing.md']);
  });

  test('a link out of the docs folder is refused, not followed', () => {
    const { broken } = rewriteLinks(
      '<a href="../../src/framework/x">x</a>',
      'packages/queue.md',
      exists,
    );
    expect(broken).toHaveLength(1);
    expect(broken[0]).toContain('leaves the docs folder');
  });

  test('absolute URLs, root paths and bare fragments are left alone', () => {
    const html = '<a href="https://example.com">a</a><a href="/x">b</a><a href="#top">c</a>';
    const out = rewriteLinks(html, 'index.md', exists);
    expect(out.html).toBe(html);
    expect(out.broken).toEqual([]);
  });

  test('a copied file is linked as-is', () => {
    const { html, broken } = rewriteLinks(
      '<a href="api-surface.json">s</a>',
      'compatibility.md',
      exists,
    );
    expect(html).toBe('<a href="../api-surface.json">s</a>');
    expect(broken).toEqual([]);
  });
});

describe('renderPage (DOC-009)', () => {
  test('a rendered page has no external resources and marks the current page', () => {
    const pages = [
      { path: 'errors.md', title: 'Error codes', html: '<h1>Error codes</h1>' },
      { path: 'packages/queue.md', title: '@tsir/queue', html: '<h1>q</h1>' },
    ];
    const out = renderPage(pages[1]!, pages);
    expect(out).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|src="http/u);
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('data-theme="nord"');
    expect(out).toContain('[data-theme=abyss]');
    expect(out).toContain('theme-toggle');
    expect(out).toContain('href="../../errors/"');
  });

  test('wide code and tables remain keyboard-scrollable on mobile', () => {
    const page = {
      path: 'x.md',
      title: 'Code',
      html: '<pre><code>x</code></pre><table><tr><td>x</td></tr></table>',
    };
    const out = renderPage(page, [page]);
    expect(out).toContain('<pre tabindex="0" role="region" aria-label="Code example">');
    expect(out).toContain('class="table-scroll" tabindex="0"');
  });

  test('titles are escaped', () => {
    const page = { path: 'x.md', title: '<b>x</b>', html: '' };
    expect(renderPage(page, [page])).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

test('navigation starts with installation and orders the application guides', () => {
  const pages = [
    { path: 'guides/providers.md', title: 'Providers', html: '' },
    { path: 'guides/controllers.md', title: 'Controllers', html: '' },
    { path: 'installation.md', title: 'Installation', html: '' },
  ];
  const out = renderPage(pages[2]!, pages);
  expect(out.indexOf('Getting started')).toBeLessThan(out.indexOf('Guides'));
  expect(out.indexOf('Controllers')).toBeLessThan(out.indexOf('Providers'));
});
