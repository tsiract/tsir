/**
 * Git hook installation (FND-015).
 *
 * Commit messages are validated by `commitlint`, but only if something runs it.
 * Running it in CI alone means the author finds out after the review; running it
 * locally means the commit never enters history in the wrong shape.
 *
 * `bun install` invokes this through the `prepare` script. It does nothing — and
 * says nothing — outside a git checkout, because a tarball install has no hooks
 * to install and no business printing noise.
 */

import { existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = `#!/bin/sh
# Installed by src/tools/install-hooks.ts — do not edit, re-install instead.
# Rejects a commit message that does not follow commitlint.config.mjs.
exec bun x --bun @commitlint/cli@19 --edit "$1"
`;

if (!existsSync('.git')) {
  process.exit(0);
}

const hooks = join('.git', 'hooks');
mkdirSync(hooks, { recursive: true });
const file = join(hooks, 'commit-msg');
writeFileSync(file, HOOK);
chmodSync(file, 0o755);
process.stdout.write('  · commit-msg hook installed (commitlint)\n');
