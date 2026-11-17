import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A bundle for a Worker must not contain the Bun and Node builtins that only the CLI can use.
 *
 * This is a regression test for a real breakage: `@tsir/database` statically imported
 * `bun:sqlite` for a **CLI-only** fallback, so any app that imported the package at all could not
 * be bundled for Cloudflare — `Bun.build` rejects a Bun builtin under the `browser` target. The
 * failure surfaced as `DPL_CONFIG_INVALID: bundle failed: Browser build cannot import Bun builtin`,
 * several steps away from the import that caused it.
 *
 * It bundles the real package through the same `Bun.build` the deployer uses, with the same
 * `workerd`/`browser` conditions, so the assertion is about the actual module graph rather than
 * about source text (a `grep` would pass for a builtin imported through a re-export).
 *
 * The scratch entry lives **inside the repository** on purpose: `@tsir/*` are workspace packages,
 * and a temp directory under `/tmp` has no `node_modules` above it, so the import would fail to
 * resolve for a reason that has nothing to do with what is being asserted.
 */

const SCRATCH = join(import.meta.dir, '.bundle-targets.scratch');
describe('a workerd bundle of @tsir/database', () => {
  test('does not pull bun:sqlite into the graph', async () => {
    const dir = await mkdtemp(SCRATCH);
    try {
      const entry = join(dir, 'entry.ts');
      // Import the package the way an app does, and touch the bootstrap so it cannot be
      // tree-shaken away as an unused re-export.
      await writeFile(
        entry,
        [
          "import { createDatabaseBootstrap } from '@tsir/database';",
          'export const boot = createDatabaseBootstrap;',
          '',
        ].join('\n'),
      );

      const result = await Bun.build({
        entrypoints: [entry],
        outdir: join(dir, 'out'),
        target: 'browser',
        format: 'esm',
        conditions: ['workerd', 'browser', 'default'],
        throw: false,
      });

      const messages = result.logs.map((log) => log.message).join('\n');
      expect(messages).not.toContain('bun:sqlite');
      expect(result.success).toBe(true);

      // `bun:sqlite` was only half the graph. `bootstrap.ts` also imported `node:fs` and `node:path`
      // at module scope, which no browser-targeted build can resolve — the bundle succeeded and the
      // Worker failed at load. Asserting the emitted text, not the build log, catches a specifier
      // that a `conditions` list happened to keep external.
      const emitted = await Promise.all(result.outputs.map((output) => output.text()));
      const text = emitted.join('\n');
      // A specifier in a comment is an explanation; a specifier in an import is a runtime
      // requirement the Worker cannot satisfy. `String.raw` keeps the regex readable — inside an
      // ordinary template literal `\\s` is an escaped backslash followed by `s`, which matches
      // nothing, and the assertion passes for the wrong reason.
      for (const specifier of ['bun:sqlite', 'node:fs', 'node:path']) {
        const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const pattern = new RegExp(
          String.raw`(?:from\s*["']${escaped}["']|import\(\s*["']${escaped}["']\s*\)|require\(\s*["']${escaped}["']\s*\))`,
          'u',
        );
        expect({ specifier, imported: pattern.test(text) }).toEqual({ specifier, imported: false });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('still resolves when only the types are used', async () => {
    // The counter-case: a type-only import must not force the package into the graph at all.
    // Without it, "make everything dynamic" would look like a safe general answer, which it is not.
    const dir = await mkdtemp(SCRATCH);
    try {
      const entry = join(dir, 'entry.ts');
      await writeFile(
        entry,
        ["import type { Database } from '@tsir/database';", 'export type Db = Database;', ''].join(
          '\n',
        ),
      );

      const result = await Bun.build({
        entrypoints: [entry],
        outdir: join(dir, 'out'),
        target: 'browser',
        format: 'esm',
        conditions: ['workerd', 'browser', 'default'],
        throw: false,
      });

      expect(result.success).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
