/**
 * Runs the worked example of every package that has written prose (DOC-010).
 *
 * An example is the first ```ts block under `## Example` in `src/docs/packages/prose/<name>.md`.
 * It imports `@tsir/<name>`; this test points that import at the package's own source, so the
 * example is checked against the code it documents, not against a published copy. It must run
 * to completion with exit code 0. A wrong method name, a changed signature or a missing export
 * fails here, not in a reader's terminal.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PROSE_DIR = join(ROOT, 'src/docs/packages/prose');
const SCRATCH = join(ROOT, 'build/doc-examples');

/** The first ```ts block under the `## Example` heading, or undefined. */
export function exampleOf(prose: string): string | undefined {
  const start = prose.indexOf('## Example');
  if (start === -1) return undefined;
  const rest = prose.slice(start);
  const next = rest.indexOf('\n## ', 1);
  const section = next === -1 ? rest : rest.slice(0, next);
  const match = /```ts\n([\s\S]*?)```/u.exec(section);
  return match?.[1];
}

/**
 * Point `@tsir/<name>` and `@tsir/<name>/<subpath>` at the entry the package's own `exports` map
 * names, so the example runs against the code in this tree, subpaths included.
 */
export function resolveWorkspaceImports(code: string, root: string = ROOT): string {
  return code.replace(
    /from '@tsir\/([a-z-]+)(\/[a-z/-]+)?'/gu,
    (whole, dir: string, sub?: string) => {
      const manifest = join(root, 'src/framework', dir, 'package.json');
      if (!existsSync(manifest)) return whole;
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        exports?: Record<string, string | { default?: string; types?: string; import?: string }>;
      };
      const entry = parsed.exports?.[sub === undefined ? '.' : `.${sub}`];
      const target =
        typeof entry === 'string' ? entry : (entry?.default ?? entry?.types ?? entry?.import);
      if (target === undefined) return whole;
      return `from '${join(root, 'src/framework', dir, target)}'`;
    },
  );
}

const files = existsSync(PROSE_DIR) ? readdirSync(PROSE_DIR).filter((f) => f.endsWith('.md')) : [];

describe('package examples run (DOC-010)', () => {
  test('every package with written prose has an example', () => {
    for (const file of files) {
      const code = exampleOf(readFileSync(join(PROSE_DIR, file), 'utf8'));
      expect({ file, hasExample: code !== undefined }).toEqual({ file, hasExample: true });
    }
  });

  for (const file of files) {
    const dir = file.replace(/\.md$/u, '');
    test(`@tsir/${dir} example exits 0`, () => {
      const code = exampleOf(readFileSync(join(PROSE_DIR, file), 'utf8'));
      if (code === undefined) throw new Error(`no ts example in prose/${file}`);
      mkdirSync(SCRATCH, { recursive: true });
      const script = join(SCRATCH, `${dir}.ts`);
      writeFileSync(script, resolveWorkspaceImports(code));
      const run = Bun.spawnSync([process.execPath, script], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = new TextDecoder().decode(run.stderr);
      rmSync(script, { force: true });
      if (run.exitCode !== 0) {
        throw new Error(
          `@tsir/${dir} example exited ${String(run.exitCode)}: ${stderr.slice(0, 500)}`,
        );
      }
      const stdout = new TextDecoder().decode(run.stdout);
      expect(stdout.trim().length).toBeGreaterThan(0);
    });
  }
});
