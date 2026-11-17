/**
 * Stub (slug) rendering for code generators.
 *
 * Stubs are text files with a `.slug` extension living in `stubs/`. They use
 * `{{variable}}` placeholders that are replaced at generation time. The `.slug`
 * extension lets editors associate the file with its output language for syntax
 * highlighting (e.g. `app.ts.slug` → TypeScript).
 *
 *   renderStub('new/app.ts', { name: 'shop-api' })
 *   // reads the stub body, replaces {{name}}, returns the .ts contents
 *
 * A missing variable throws rather than rendering `{{name}}` literally, so
 * typos in stub placeholders are caught at generation time.
 *
 * ## Where the body comes from
 *
 * The obvious implementation — `readFileSync(join(import.meta.dir, 'stubs', …))` — works in a
 * source run and fails in **every other layout the CLI ships in**:
 *
 *   · `make dist` emits `framework/console/index.js`, a bundle; the stub directory is not beside it.
 *   · `bun build --compile` produces one file; `import.meta.dir` points into `/$bunfs`, and there is
 *     no stub directory at all. The failure was `ENOENT: … /$bunfs/root/stubs/new/project.ts.slug`
 *     from `tsir new` — the first command a developer runs.
 *
 * The templates therefore reach the bundle through `stub-text.ts`, which imports each one with
 * `with { type: 'text' }`: the `.slug` file stays the editable source of truth, and its bytes are
 * inlined at build time. The filesystem is still read first, because a distribution on disk is
 * *supposed* to carry `stubs/` and a developer editing one there should see the edit — the bundle map
 * is the fallback for the layouts that have no directory, not a replacement for the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TsirError } from '@tsir/container';

import { STUBS } from './stub-text.ts';

const STUBS_DIR = join(import.meta.dir, 'stubs');

/** Placeholder pattern: `{{identifier}}`. */
const PLACEHOLDER = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

/**
 * The raw text of one stub.
 *
 * Exported so `stub.test.ts` can assert that every stub on disk is reachable: a new `.slug` file
 * that nobody added to `stub-text.ts` would work in a source run and fail in the compiled CLI, which
 * is the drift worth catching.
 */
export function stubContents(stubPath: string): string {
  const fullPath = join(STUBS_DIR, `${stubPath}.slug`);
  try {
    return readFileSync(fullPath, 'utf8');
  } catch (error: unknown) {
    const bundled = STUBS.get(`${stubPath}.slug`);
    if (bundled !== undefined) return bundled;
    throw new TsirError('CLI_STUB_MISSING', `stub "${stubPath}" is not shipped with this build`, {
      kind: 'internal',
      hint: 'add the stub to stubs/ and to stub-text.ts, which is what puts it in the bundle',
      cause: error,
    });
  }
}

/**
 * Render a stub file.
 *
 * @param stubPath — path relative to `stubs/`, without the `.slug` extension
 *                   (e.g. `'new/app.ts'` → `stubs/new/app.ts.slug`).
 * @param vars     — key-value pairs substituted into `{{name}}` placeholders.
 */
export function renderStub(stubPath: string, vars: Record<string, string> = {}): string {
  const contents = stubContents(stubPath);
  return contents.replace(PLACEHOLDER, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new TsirError(
        'CLI_STUB_MISSING_VAR',
        `stub "${stubPath}": missing variable {{${key}}}`,
        { kind: 'internal', hint: 'the stub references a variable not passed to renderStub()' },
      );
    }
    return value;
  });
}
