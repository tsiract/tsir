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
import { slugify } from './check-links.ts';

const ROOT = process.cwd();

/** Non-Markdown files that the pages link to, copied into the site unchanged. */
const COPIED_FILES = ['api-surface.json', 'error-codes.json'];
const COPIED_DIRS = ['assets'];

/**
 * Compiles and bundles the Svelte 5 docs router into a single inline script.
 *
 * The router is a build-time artifact: it is compiled once, minified, and
 * inlined into every generated page so the docs stay dependency-free at
 * runtime. It powers client-side navigation with the View Transition API and
 * persists the sidebar scroll position between pages.
 */
async function buildRouterScript(root: string): Promise<string> {
  const entry = join(root, 'src/tools/docs-router/main.ts');
  if (!existsSync(entry)) return '';
  // Lazy imports keep the docs build fast when the router is unchanged.
  const { compile } = await import('svelte/compiler');
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    logLevel: 'silent',
    platform: 'browser',
    define: { 'import.meta.env.SSR': 'false' },
    plugins: [
      {
        name: 'svelte',
        setup(build) {
          build.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, 'utf8');
            const compiled = compile(source, {
              filename: args.path,
              generate: 'client',
            });
            return {
              contents: compiled.js.code,
              loader: 'js',
            };
          });
        },
      },
    ],
  });
  const output = result.outputFiles[0]?.text ?? '';
  return output;
}

export interface Page {
  /** Path relative to `src/docs`, with `/` separators, e.g. `packages/queue.md`. */
  readonly path: string;
  readonly title: string;
  readonly html: string;
}

/** Relative links in rendered HTML, `href="…"`. Absolute URLs and fragments are left alone. */
const HREF = /href="([^"#][^"]*)"/gu;

/**
 * The clean URL a page is served at: `guides/x.md` → `guides/x/`, and any `index.md` → its own
 * directory (`index.md` → `./`, `packages/index.md` → `packages/`). Both the emitted file path and
 * every link point use this, so a nested index cannot end up at `packages/index/`.
 */
function urlOf(pagePath: string): string {
  if (pagePath === 'index.md') return './';
  if (pagePath.endsWith('/index.md')) return pagePath.slice(0, -'index.md'.length);
  return `${pagePath.slice(0, -3)}/`;
}

/** The directory a page is served from, which relative links resolve against. */
function dirOf(pagePath: string): string {
  const dir = urlOf(pagePath).replace(/\/$/u, '');
  return dir === '' ? '.' : dir;
}

/**
 * Rewrite `x.md` links to clean directory URLs (`x/`, not `x.html`) and report
 * every relative link that resolves to nothing. `pagePath` is the page's own
 * path inside `src/docs`, so a link is resolved from its folder.
 */
export function rewriteLinks(
  html: string,
  pagePath: string,
  exists: (target: string) => boolean,
): { html: string; broken: string[] } {
  const broken: string[] = [];
  // The page's output lives at `<path-without-.md>/index.html`, so links are
  // resolved from that directory to keep clean URLs at any folder depth.
  // `index.md` is the docs root (`.`), not `index/`.
  const pageDir = dirOf(pagePath);
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
    let target: string;
    if (resolved.endsWith('.md')) {
      // A link to another page becomes its clean directory URL — including an index, which is its
      // directory rather than a subdirectory named after it.
      target = urlOf(resolved);
    } else {
      target = resolved;
    }
    const suffix = fragment === '' ? '' : `#${fragment}`;
    const rel = posix.relative(pageDir, target) || '.';
    // Preserve the trailing slash for directory-style page URLs.
    const relHref = target.endsWith('/') ? `${rel}/` : rel;
    return `href="${relHref}${suffix}"`;
  });
  return { html: out, broken };
}

// Reuse the compiled, self-contained DaisyUI Nord/Abyss stylesheet and progressive
// enhancement from the frontpage. No CDN, font request or client framework.
const FRONT_PAGE = readFileSync(join(ROOT, 'src/apps/frontpage/public/index.html'), 'utf8');
const SITE_STYLE = /<style data-site>([\s\S]*?)<\/style>/u.exec(FRONT_PAGE)?.[1] ?? '';
const SITE_SCRIPT = /<script data-site>([\s\S]*?)<\/script>/u.exec(FRONT_PAGE)?.[1] ?? '';
const THEME_SCRIPT = `try{const t=localStorage.getItem('tsir-theme');document.documentElement.dataset.theme=t==='abyss'||t==='nord'?t:matchMedia('(prefers-color-scheme: dark)').matches?'abyss':'nord'}catch{document.documentElement.dataset.theme='nord'}`;
if (SITE_STYLE === '' || SITE_SCRIPT === '')
  throw new Error('Build the frontpage before the docs site.');
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/gu,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/** Pages grouped for navigation: hands-on guides, reference pages, and package references. */
function groupOf(path: string): 'Getting started' | 'Guides' | 'Reference' | 'Packages' {
  // `index.md` is the docs landing page and the first thing in the sidebar; installation is the
  // first *step*, so it follows the page that tells you the steps exist.
  if (path === 'index.md' || path === 'installation.md') return 'Getting started';
  if (path.startsWith('guides/')) return 'Guides';
  return path.startsWith('packages/') ? 'Packages' : 'Reference';
}

export function renderPage(page: Page, all: readonly Page[], routerScript = ''): string {
  const current = page.path;
  // The page's output directory. `index.md` is the docs root (`./`); every
  // other page lives at `<path-without-.md>/index.html` for clean URLs.
  const currentDir = dirOf(current);
  const groups = new Map<'Getting started' | 'Guides' | 'Reference' | 'Packages', Page[]>([
    ['Getting started', []],
    ['Guides', []],
    ['Reference', []],
    ['Packages', []],
  ]);
  for (const p of all) groups.get(groupOf(p.path))?.push(p);
  // Tutorial order: understand the project (configuration) before generating
  // code (controllers), then layer in persistence, async work, caching,
  // deployment portability, and finally contributor tooling.
  const order = [
    'configuration',
    'controllers',
    'database',
    'queues',
    'caching',
    'providers',
    'make',
  ];
  groups.get('Guides')?.sort((a, b) => {
    const rank = (path: string): number => {
      const i = order.indexOf(posix.basename(path, '.md'));
      return i < 0 ? order.length : i;
    };
    return rank(a.path) - rank(b.path) || a.title.localeCompare(b.title);
  });

  const nav = [...groups.entries()]
    .map(([heading, pages]) => {
      const items = pages
        .map((p) => {
          const targetDir = urlOf(p.path);
          const rel = posix.relative(currentDir, targetDir) || '.';
          const href = `${rel}/`;
          const aria =
            p.path === current || (current === 'index.md' && p.path === 'installation.md')
              ? ' aria-current="page"'
              : '';
          return `<li><a href="${escapeHtml(href)}"${aria}>${escapeHtml(p.title)}</a></li>`;
        })
        .join('');
      return `<h2>${heading}</h2><ul>${items}</ul>`;
    })
    .join('');

  const depth = current.split('/').length - 1;
  // Pages live at <dir>/index.html, so the site root is one level deeper than
  // the old flat layout.
  const home = '../'.repeat(depth + 2);
  const docsHomeRel = posix.relative(currentDir, '.') || '.';
  const docsHome = `${docsHomeRel}/`;
  const logo =
    '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 9h18M16 9v15" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><circle cx="25" cy="24" r="2.5" fill="currentColor"/></svg>';
  const themeButton =
    '<button class="btn btn-ghost btn-square theme-toggle" type="button" aria-label="Switch theme" hidden><svg class="theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2m10-10 2-2"/></svg><svg class="theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/></svg></button>';
  const content = page.html
    .replace(
      /<table>/gu,
      '<div class="table-scroll" tabindex="0" role="region" aria-label="Reference table"><table>',
    )
    .replace(/<\/table>/gu, '</table></div>')
    .replace(/<pre>/gu, '<pre tabindex="0" role="region" aria-label="Code example">');
  const routerTag = routerScript === '' ? '' : `<script type="module">${routerScript}</script>`;
  return `<!doctype html>
<html lang="en" data-theme="nord">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#eceff4">
<title>${escapeHtml(page.title)} · Tsir docs</title>
<script>${THEME_SCRIPT}</script>
<style data-site>${SITE_STYLE}</style>
</head>
<body>
<a class="skip-link" href="#doc-content">Skip to content</a>
<header class="site-header"><div class="wrap header-inner"><a class="docs-header-home" href="${home}" aria-label="Tsir home"><span class="brand">${logo}<span>tsir</span></span><span class="docs-header-label">Documentation</span></a><nav class="desktop-nav" aria-label="Main navigation"><a href="${home}#framework">Framework</a><a href="${home}#ecosystem">Ecosystem</a><a href="${escapeHtml(docsHome)}"${current === 'index.md' ? ' aria-current="page"' : ''}>Documentation</a><a href="${home}#examples">Examples</a></nav><div class="header-actions">${themeButton}<a class="btn btn-neutral btn-sm header-cta" href="${home}#get-started">Get started →</a></div></div></header>
<div class="wrap docs-layout"><details class="docs-mobile-index"><summary>Browse documentation</summary><div class="docs-sidebar"><nav aria-label="Documentation index">${nav}</nav></div></details><aside class="docs-sidebar"><nav aria-label="Documentation">${nav}</nav></aside><main id="doc-content" class="docs-article"><div class="docs-breadcrumb"><a href="${escapeHtml(docsHome)}">Documentation</a><span aria-hidden="true">/</span><span>${escapeHtml(page.title)}</span></div>${content}<div class="docs-bottom"><a href="${home}#ecosystem">← Explore the ecosystem</a><a href="${escapeHtml(docsHome)}">All documentation →</a></div></main></div>
<footer class="site-footer"><div class="wrap footer-bottom"><span>© 2026 Tsir contributors · MIT licensed · Pre-alpha</span><span>Nord light / Abyss dark · Powered by DaisyUI</span><a href="${home}">Back to Tsir ↑</a></div></footer>
<script data-site>${SITE_SCRIPT}</script>
${routerTag}
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

export async function buildDocs(root = ROOT): Promise<number> {
  const source = join(root, 'src/docs');
  const out = join(root, 'build/docs-site');
  const paths = listMarkdown(source);
  const exists = (target: string): boolean => {
    if (paths.includes(target)) return true;
    if (COPIED_FILES.includes(target)) return true;
    return (
      COPIED_DIRS.some((dir) => target === dir || target.startsWith(`${dir}/`)) &&
      existsSync(join(source, target))
    );
  };

  const pages: Page[] = [];
  const broken: string[] = [];
  for (const path of paths) {
    const markdown = readFileSync(join(source, path), 'utf8');
    const rendered = marked
      .parse(markdown, { async: false })
      .replace(
        /<h([1-6])>([\s\S]*?)<\/h\1>/gu,
        (_all, level: string, text: string) =>
          `<h${level} id="${escapeHtml(slugify(text.replace(/<[^>]*>/gu, '')))}">${text}</h${level}>`,
      );
    const fixed = rewriteLinks(rendered, path, exists);
    broken.push(...fixed.broken);
    pages.push({ path, title: titleOf(markdown, path), html: fixed.html });
  }

  if (broken.length > 0) {
    process.stderr.write(`docs site: ${String(broken.length)} broken link(s):\n`);
    for (const line of broken) process.stderr.write(`  ✗ ${line}\n`);
    return 1;
  }

  const routerScript = await buildRouterScript(root);

  rmSync(out, { recursive: true, force: true });
  for (const page of pages) {
    // Directory-style output: `installation.md` → `installation/index.html`
    // so the URL is `/docs/installation/` with no `.html` extension. The landing
    // page is the exception: it is the site root.
    const target = join(out, urlOf(page.path), 'index.html');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPage(page, pages, routerScript));
  }
  // The landing page is a page in the tree, not a copy of another page. It used to be the
  // installation guide rendered twice — so the docs home and every "Documentation" link in the
  // header showed the install instructions, and installation was the one page with no `# Title`
  // of its own to link to.
  const landing = pages.find((page) => page.path === 'index.md');
  if (landing === undefined) throw new Error('Missing docs landing page (src/docs/index.md)');
  for (const file of COPIED_FILES) {
    copyFileSync(join(source, file), join(out, file));
  }
  for (const dir of COPIED_DIRS) {
    const from = join(source, dir);
    if (existsSync(from) && statSync(from).isDirectory()) {
      mkdirSync(join(out, dir), { recursive: true });
      for (const file of readdirSync(from)) copyFileSync(join(from, file), join(out, dir, file));
    }
  }
  process.stdout.write(
    `✓ docs site: ${String(pages.length)} pages written to ${relative(root, out)}/\n`,
  );
  return 0;
}

if (import.meta.main) {
  const code = await buildDocs();
  process.exit(code);
}
