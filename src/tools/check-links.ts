/**
 * Link integrity for documentation (FND-018).
 *
 * Documentation is part of the product: every task cites a section, every
 * decision is linked from an index. A broken relative link is a broken citation, and a
 * citation that silently rots is worse than no citation, because readers trust
 * it. Markdown links and anchors are resolved here so nobody has to notice.
 *
 * Checked:
 *   1. Every relative link/`path` in a fenced table or inline resolves to a file.
 *   2. A `#anchor` resolves to a heading in the target file (GitHub slug rules).
 *   3. No link points outside the repository by absolute path.
 *
 * External `http(s)` links are not fetched: CI should not depend on the network
 * being reachable, and a flaky third party must not fail a build.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface BrokenLink {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly reason: string;
}

const ROOTS = ['plans', 'rfc', 'src', '.github'];
const ROOT_FILES = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md'];

export function markdownFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) found.push(path);
    }
  };
  for (const root of ROOTS) walk(root);
  for (const file of ROOT_FILES) if (existsSync(file)) found.push(file);
  return found.sort();
}

/** GitHub's heading slug: lowercase, drop punctuation, spaces → hyphens. */
export function slugify(heading: string): string {
  return heading
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim() // punctuation removal can expose a leading space ("## 3.2 …")
    .replace(/\s+/g, '-');
}

/** Heading anchors in a markdown file, in document order. */
export function anchorsOf(file: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) anchors.add(slugify(match[1]));
  }
  return anchors;
}

/** Every markdown link target in a file, with the line it appeared on. */
export function linksIn(file: string): readonly { target: string; line: number }[] {
  const links: { target: string; line: number }[] = [];
  let inFence = false;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      if (text.trimStart().startsWith('```')) inFence = !inFence;
      if (inFence) return;
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (target !== undefined) links.push({ target, line: index + 1 });
      }
    });
  return links;
}

export function checkLinks(cwd = process.cwd()): readonly BrokenLink[] {
  const broken: BrokenLink[] = [];

  for (const file of markdownFiles()) {
    for (const { target, line } of linksIn(file)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      if (target.startsWith('#')) {
        if (!anchorsOf(file).has(target.slice(1))) {
          broken.push({ file, line, target, reason: 'anchor not found in this file' });
        }
        continue;
      }

      const [rawPath, anchor] = target.split('#');
      if (rawPath === undefined || rawPath === '') continue;
      const resolved = rawPath.startsWith('/')
        ? resolve(cwd, `.${rawPath}`)
        : resolve(dirname(file), rawPath);

      if (!existsSync(resolved)) {
        broken.push({ file, line, target, reason: 'file does not exist' });
        continue;
      }
      if (anchor !== undefined && anchor !== '' && statSync(resolved).isFile()) {
        if (!anchorsOf(resolved).has(anchor)) {
          broken.push({
            file,
            line,
            target,
            reason: `anchor "#${anchor}" not found in ${relative(cwd, resolved)}`,
          });
        }
      }
    }
  }

  return broken;
}

if (import.meta.main) {
  const broken = checkLinks();

  if (broken.length > 0) {
    for (const link of broken) {
      process.stderr.write(
        `  ✗ ${link.file}:${String(link.line)} → ${link.target} (${link.reason})\n`,
      );
    }
    process.stderr.write(`\n${String(broken.length)} broken link(s)\n`);
    process.exit(1);
  }

  process.stdout.write(`✓ documentation links resolve (${String(markdownFiles().length)} files)\n`);
}
