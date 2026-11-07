/**
 * Stub (slug) rendering for code generators.
 *
 * Stubs are text files with a `.slug` extension living in `stubs/`. They use
 * `{{variable}}` placeholders that are replaced at generation time. The `.slug`
 * extension lets editors associate the file with its output language for syntax
 * highlighting (e.g. `app.ts.slug` → TypeScript).
 *
 *   renderStub('new/app.ts', { name: 'shop-api' })
 *   // reads stubs/new/app.ts.slug, replaces {{name}}, returns the .ts contents
 *
 * A missing variable throws rather than rendering `{{name}}` literally, so
 * typos in stub placeholders are caught at generation time.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TsirError } from '@tsir/container';

const STUBS_DIR = join(import.meta.dir, 'stubs');

/** Placeholder pattern: `{{identifier}}`. */
const PLACEHOLDER = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

/**
 * Render a stub file.
 *
 * @param stubPath — path relative to `stubs/`, without the `.slug` extension
 *                   (e.g. `'new/app.ts'` → `stubs/new/app.ts.slug`).
 * @param vars     — key-value pairs substituted into `{{name}}` placeholders.
 */
export function renderStub(stubPath: string, vars: Record<string, string> = {}): string {
  const fullPath = join(STUBS_DIR, `${stubPath}.slug`);
  const contents = readFileSync(fullPath, 'utf8');
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
