#!/usr/bin/env bun
/**
 * The docs site, as static files (DOC-009).
 *
 * Renders every Markdown page under `src/docs/` (and `src/docs/packages/`) to HTML under
 * `build/docs-site/`, with one navigation index. The output has no external stylesheet, script
 * or font, so it reads the same offline, without JavaScript, and in a sandboxed preview.
 *
 * Renderer: `marked` (ADR-0028), a build-time dependency only. It never runs in a bundle.
 *
 * Link rule: a relative link to a Markdown page becomes the matching `.html`. A relative link to
 * any other file must point at something that is copied into the site. A link that resolves to
 * nothing fails the build, so a page cannot ship with a dead link.
 *
 *   bun src/tools/docs-site.ts          # build (make docs-site)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { marked } from 'marked';

const ROOT = process.cwd();
const SOURCE = join(ROOT, 'src/docs');
const OUT = join(ROOT, 'build/docs-site');

/** Non-Markdown files that the pages link to, copied into the site unchanged. */
const COPIED_FILES = ['api-surface.json', 'error-codes.json'];
const COPIED_DIRS = ['assets'];

export interface Page {
  /** Path relative to `src/docs`, with `/` separators, e.g. `packages/queue.md`. */
  readonly path: string;
  readonly title: string;
  readonly html: string;
}

/** Relative links in rendered HTML, `href="…"`. Absolute URLs and fragments are left alone. */
const HREF = /href="([^"#][^"]*)"/gu;

/**
 * Rewrite `x.md` links to `x.html` and report every relative link that resolves to nothing.
 * `pagePath` is the page's own path inside `src/docs`, so a link is resolved from its folder.
 */
export function rewriteLinks(
  html: string,
  pagePath: string,
  exists: (target: string) => boolean,
): { html: string; broken: string[] } {
  const broken: string[] = [];
  const out = html.replace(HREF, (whole, rawHref: string) => {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(rawHref) || rawHref.startsWith('/')) return whole;
    const [pathPart = '', fragment = ''] = rawHref.split('#', 2);
    if (pathPart === '') return whole;
    const resolved = posix.normalize(posix.join(posix.dirname(pagePath), pathPart));
    if (resolved.startsWith('..')) {
      broken.push(`${pagePath} → ${rawHref} (leaves the docs folder)`);
      return whole;
    }
    if (!exists(resolved)) {
      broken.push(`${pagePath} → ${rawHref}`);
      return whole;
    }
    const target = resolved.endsWith('.md') ? `${resolved.slice(0, -3)}.html` : resolved;
    const suffix = fragment === '' ? '' : `#${fragment}`;
    // Keep the path relative to this page, so the site works from any folder depth.
    const relHref = posix.relative(posix.dirname(pagePath), target) || posix.basename(target);
    return `href="${relHref}${suffix}"`;
  });
  return { html: out, broken };
}

const STYLE = `
body{margin:0;font:16px/1.55 system-ui,sans-serif;color:#1d1d1f;background:#fff;display:flex;min-height:100vh}
nav{width:15rem;flex:none;padding:1.25rem;border-right:1px solid #e5e5e5;font-size:14px}
nav h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6e6e73;margin:1.25rem 0 .4rem}
nav ul{list-style:none;margin:0;padding:0}nav li{margin:.2rem 0}
nav a{color:#0b5cad;text-decoration:none}nav a[aria-current=page]{font-weight:600;color:#1d1d1f}
main{padding:2rem 2.5rem;max-width:52rem;min-width:0}
code{font:13px ui-monospace,monospace;background:#f5f5f7;padding:.1em .3em;border-radius:4px}
pre{background:#f5f5f7;padding:1rem;overflow:auto;border-radius:6px}pre code{background:none;padding:0}
table{border-collapse:collapse;margin:1rem 0;font-size:14px}th,td{border:1px solid #d2d2d7;padding:.35rem .6rem;text-align:left}
a{color:#0b5cad}
@media (max-width:720px){body{flex-direction:column}nav{width:auto;border-right:0;border-bottom:1px solid #e5e5e5}}
`;

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/gu,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/** Pages grouped for the navigation: the reference pages first, then one group per package. */
function groupOf(path: string): 'Reference' | 'Packages' {
  return path.startsWith('packages/') ? 'Packages' : 'Reference';
}

export function renderPage(page: Page, all: readonly Page[]): string {
  const current = page.path;
  const groups = new Map<'Reference' | 'Packages', Page[]>([
    ['Reference', []],
    ['Packages', []],
  ]);
  for (const p of all) groups.get(groupOf(p.path))?.push(p);

  const nav = [...groups.entries()]
    .map(([heading, pages]) => {
      const items = pages
        .map((p) => {
          const href = posix.relative(
            posix.dirname(current),
            `${p.path.replace(/\.md$/u, '')}.html`,
          );
          const aria = p.path === current ? ' aria-current="page"' : '';
          return `<li><a href="${escapeHtml(href)}"${aria}>${escapeHtml(p.title)}</a></li>`;
        })
        .join('');
      return `<h2>${heading}</h2><ul>${items}</ul>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} · Tsir docs</title>
<style>${STYLE}</style>
</head>
<body>
<nav aria-label="Documentation">${nav}</nav>
<main>${page.html}</main>
</body>
</html>
`;
}

function listMarkdown(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (COPIED_DIRS.includes(entry.name) && prefix === '') continue;
      // Prose files are inputs to the package pages, not pages of their own.
      if (rel === 'packages/prose') continue;
      out.push(...listMarkdown(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.md') && entry.name !== 'README.md') {
      out.push(rel);
    }
  }
  return out.sort();
}

function titleOf(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/mu.exec(markdown);
  return heading?.[1]?.replace(/[`*_]/gu, '').trim() ?? fallback;
}

function build(): number {
  const paths = listMarkdown(SOURCE);
  const exists = (target: string): boolean => {
    if (paths.includes(target)) return true;
    if (COPIED_FILES.includes(target)) return true;
    return (
      COPIED_DIRS.some((dir) => target === dir || target.startsWith(`${dir}/`)) &&
      existsSync(join(SOURCE, target))
    );
  };

  const pages: Page[] = [];
  const broken: string[] = [];
  for (const path of paths) {
    const markdown = readFileSync(join(SOURCE, path), 'utf8');
    const rendered = marked.parse(markdown, { async: false });
    const fixed = rewriteLinks(rendered, path, exists);
    broken.push(...fixed.broken);
    pages.push({ path, title: titleOf(markdown, path), html: fixed.html });
  }

  if (broken.length > 0) {
    process.stderr.write(`docs site: ${String(broken.length)} broken link(s):\n`);
    for (const line of broken) process.stderr.write(`  ✗ ${line}\n`);
    return 1;
  }

  rmSync(OUT, { recursive: true, force: true });
  for (const page of pages) {
    const target = join(OUT, page.path.replace(/\.md$/u, '.html'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPage(page, pages));
  }
  // The site root: a short page that points at the reference and at every package.
  const index: Page = {
    path: 'index.md',
    title: 'Tsir documentation',
    html: `<h1>Tsir documentation</h1>
<p>Tsir is pre-alpha. Start with the reference pages, then the page for each package. The
<a href="compatibility.html">compatibility policy</a> says what a version number promises.</p>`,
  };
  writeFileSync(join(OUT, 'index.html'), renderPage(index, pages));
  for (const file of COPIED_FILES) {
    copyFileSync(join(SOURCE, file), join(OUT, file));
  }
  for (const dir of COPIED_DIRS) {
    const from = join(SOURCE, dir);
    if (existsSync(from) && statSync(from).isDirectory()) {
      mkdirSync(join(OUT, dir), { recursive: true });
      for (const file of readdirSync(from)) copyFileSync(join(from, file), join(OUT, dir, file));
    }
  }
  process.stdout.write(
    `✓ docs site: ${String(pages.length)} pages written to ${relative(ROOT, OUT)}/\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(build());
