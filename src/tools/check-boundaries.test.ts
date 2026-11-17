import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDeclaredDependencies } from './check-boundaries.ts';

/**
 * Rule 4 of `check-boundaries` (FND-009).
 *
 * The bug this exists for: `admin.product.com` imported `@tsir/telemetry`, `@tsir/pennant`,
 * `@tsir/scout` and `@tsir/media` without declaring any of them, so CI failed with four
 * `TS2307: Cannot find module` errors while a developer whose `node_modules` predated the change
 * saw a green typecheck. Bun links a workspace dependency **per importer**, so a declaration is
 * what creates the resolution — not the package existing in the repo.
 *
 * The fixture is a synthetic tree rather than this repository, so the test cannot rot when the
 * admin app's imports legitimately change.
 */
function scaffold(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tsir boundaries '));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const manifest = (deps: readonly string[]): string =>
  `${JSON.stringify(
    {
      name: '@tsir/fixture-app',
      dependencies: Object.fromEntries(deps.map((name) => [name, 'workspace:*'])),
    },
    null,
    2,
  )}\n`;

describe('check-boundaries · rule 4 (undeclared app dependencies)', () => {
  test('an imported but undeclared @tsir package is a violation', async () => {
    const root = scaffold({
      'src/apps/app/package.json': manifest(['@tsir/core']),
      'src/apps/app/src/main.ts':
        "import { defineApp } from '@tsir/core';\nimport { createRequestLogger } from '@tsir/telemetry';\n",
    });
    try {
      const violations: Parameters<typeof checkDeclaredDependencies>[0] = [];
      await checkDeclaredDependencies(violations, root);
      const found = violations.filter((violation) => violation.rule === 'undeclared-dependency');
      expect(found).toHaveLength(1);
      expect(found[0]?.specifier).toBe('@tsir/telemetry');
      expect(found[0]?.importer).toBe('@tsir/fixture-app');
      // The message has to name the fix, or a developer re-derives the rule from scratch.
      expect(found[0]?.detail).toContain('"@tsir/telemetry": "workspace:*"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a declared package, a subpath import and a devDependency are all allowed', async () => {
    const root = scaffold({
      'src/apps/app/package.json': `${JSON.stringify(
        {
          name: '@tsir/fixture-app',
          dependencies: { '@tsir/storage': 'workspace:*' },
          devDependencies: { '@tsir/testing': 'workspace:*' },
        },
        null,
        2,
      )}\n`,
      'src/apps/app/src/main.ts':
        "import { s3Driver } from '@tsir/storage';\nimport { memoryDisk } from '@tsir/storage/memory';\nimport { harness } from '@tsir/testing';\n",
    });
    try {
      const violations: Parameters<typeof checkDeclaredDependencies>[0] = [];
      await checkDeclaredDependencies(violations, root);
      expect(violations).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-@tsir, relative and test-file imports are not judged', async () => {
    const root = scaffold({
      'src/apps/app/package.json': manifest([]),
      'src/apps/app/src/main.ts':
        "import { z } from 'zod';\nimport { helper } from './helper.ts';\n",
      'src/apps/app/src/helper.ts': 'export const helper = 1;\n',
      'src/apps/app/src/main.test.ts': "import { thing } from '@tsir/telemetry';\n",
    });
    try {
      const violations: Parameters<typeof checkDeclaredDependencies>[0] = [];
      await checkDeclaredDependencies(violations, root);
      // `zod` is a third-party package (check-deps' job) and a test file is not shipped source.
      expect(violations.filter((violation) => violation.rule === 'undeclared-dependency')).toEqual(
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an example app under src/apps/examples is checked too', async () => {
    const root = scaffold({
      'src/apps/examples/demo.com/package.json': manifest([]),
      'src/apps/examples/demo.com/src/index.ts': "import { createScout } from '@tsir/scout';\n",
    });
    try {
      const violations: Parameters<typeof checkDeclaredDependencies>[0] = [];
      await checkDeclaredDependencies(violations, root);
      expect(violations.map((violation) => violation.specifier)).toContain('@tsir/scout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
