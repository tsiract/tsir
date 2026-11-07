/**
 * Lockstep versioning (FND-011).
 *
 * Every package in this workspace shares one version. That is a deliberate
 * simplification (ADR-0011): the packages are released together, from one
 * `dist/` tree and one tarball set, so a version skew between `@tsir/core` and
 * `@tsir/http` cannot exist to be reasoned about.
 *
 * A changeset is a markdown file describing one change to the public surface. It
 * carries the bump it requires. `apply` consumes every pending changeset,
 * computes the largest bump, rewrites all manifests together, and prepends an
 * entry to `CHANGELOG.md`.
 *
 *   bun src/tools/version.ts changeset "Add @tsir/router" --bump minor
 *   bun src/tools/version.ts apply
 *   bun src/tools/version.ts check     # manifests agree (runs in `make check`)
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Bump = 'patch' | 'minor' | 'major';

const ORDER: readonly Bump[] = ['patch', 'minor', 'major'];
const CHANGESET_DIR = '.changeset';

export interface Changeset {
  readonly summary: string;
  readonly bump: Bump;
}

/** `1.2.3` + `minor` → `1.3.0`. Rejects anything that is not `x.y.z`. */
export function bumpVersion(version: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new TypeError(`version: "${version}" is not in x.y.z form`);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (bump === 'major') return `${String(major + 1)}.0.0`;
  if (bump === 'minor') return `${String(major)}.${String(minor + 1)}.0`;
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
}

/** The largest bump any pending changeset asks for. */
export function highestBump(changesets: readonly Changeset[]): Bump | undefined {
  let highest: Bump | undefined;
  for (const { bump } of changesets) {
    if (highest === undefined || ORDER.indexOf(bump) > ORDER.indexOf(highest)) highest = bump;
  }
  return highest;
}

export function parseChangeset(name: string, text: string): Changeset {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(text.trim());
  if (match === null) throw new TypeError(`changeset ${name}: missing --- frontmatter`);
  const front = match[1] ?? '';
  const bumpMatch = /^bump:\s*(patch|minor|major)\s*$/m.exec(front);
  if (bumpMatch === null) {
    throw new TypeError(`changeset ${name}: frontmatter needs \`bump: patch|minor|major\``);
  }
  return { bump: bumpMatch[1] as Bump, summary: (match[2] ?? '').trim() };
}

function changesetFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => join(dir, file));
}

function manifests(): readonly string[] {
  const paths: string[] = ['package.json'];
  for (const group of ['src/framework', 'src/apps/frontpage', 'src/apps']) {
    if (!existsSync(group)) continue;
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const direct = join(group, entry.name, 'package.json');
      if (existsSync(direct)) paths.push(direct);
      // `src/apps/<name>/package.json` — examples sit one level deeper.
      for (const inner of readdirSync(join(group, entry.name), { withFileTypes: true })) {
        if (!inner.isDirectory()) continue;
        const nested = join(group, entry.name, inner.name, 'package.json');
        if (existsSync(nested)) paths.push(nested);
      }
    }
  }
  return paths;
}

function readVersion(path: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
  return manifest.version ?? '0.0.0';
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'check') {
    const versions = new Map<string, string[]>();
    for (const path of manifests()) {
      const version = readVersion(path);
      versions.set(version, [...(versions.get(version) ?? []), path]);
    }
    if (versions.size > 1) {
      for (const [version, paths] of versions) {
        process.stderr.write(`  ${version}: ${paths.join(', ')}\n`);
      }
      process.stderr.write('\nversion: manifests are not in lockstep\n');
      process.exit(1);
    }
    process.stdout.write(
      `✓ versions in lockstep (${String(manifests().length)} manifests at ${String([...versions.keys()][0])})\n`,
    );
    process.exit(0);
  }

  if (command === 'changeset') {
    // The summary is the first positional, and a flag's value is not one: `--bump minor` must not
    // make "minor" the summary.
    const summary = rest.find(
      (arg, index) => !arg.startsWith('--') && rest[index - 1] !== '--bump',
    );
    // An empty SUMMARY (`make changeset` with no argument) is no summary at all: it would
    // write a changeset with nothing to say.
    const summaryIsBlank = summary === undefined || !/[a-z0-9]/iu.test(summary);
    const bumpIndex = rest.indexOf('--bump');
    const bump = (bumpIndex === -1 ? 'patch' : rest[bumpIndex + 1]) as Bump | undefined;

    if (summary === undefined || summaryIsBlank || bump === undefined || !ORDER.includes(bump)) {
      process.stderr.write(
        'usage: bun src/tools/version.ts changeset "<summary>" [--bump patch|minor|major]\n',
      );
      process.exit(1);
    }

    const slug = summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
    const file = join(CHANGESET_DIR, `${slug === '' ? 'change' : slug}.md`);
    if (existsSync(file)) {
      process.stderr.write(`version: ${file} already exists\n`);
      process.exit(1);
    }
    writeFileSync(file, `---\nbump: ${bump}\n---\n\n${summary}\n`);
    process.stdout.write(`✓ wrote ${file}\n`);
    process.exit(0);
  }

  if (command === 'apply') {
    const pending = changesetFiles(CHANGESET_DIR).map((file) =>
      parseChangeset(file, readFileSync(file, 'utf8')),
    );
    const bump = highestBump(pending);
    if (bump === undefined) {
      process.stdout.write('version: no pending changesets\n');
      process.exit(0);
    }

    const from = readVersion('package.json');
    const to = bumpVersion(from, bump);
    for (const path of manifests()) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      manifest['version'] = to;
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const entry = `## ${to} — ${date}\n\n${pending.map((change) => `- ${change.summary}`).join('\n')}\n\n`;
    const changelog = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '';
    writeFileSync('CHANGELOG.md', `${entry}${changelog}`);

    for (const file of changesetFiles(CHANGESET_DIR)) rmSync(file);
    process.stdout.write(
      `✓ ${from} → ${to} (${bump}) across ${String(manifests().length)} manifests, ${String(pending.length)} changeset(s) consumed\n`,
    );
    process.exit(0);
  }

  process.stderr.write('usage: bun src/tools/version.ts <check|changeset|apply>\n');
  process.exit(1);
}
