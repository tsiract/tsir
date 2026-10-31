import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// CLI-002: `--json` documents are versioned, and config values are redacted before output.
// Runs the real entry as a subprocess, against a fixture app that declares a secret field.

const CLI = join(import.meta.dir, 'cli.ts');
const SECRET_APP = join(import.meta.dir, 'commands', 'fixtures', 'secret-app');
const SECRET = 'postgres://user:hunter2@db/app';

describe('CLI-002: config:dump --json', () => {
  test('is versioned and never prints a secret value', () => {
    const run = Bun.spawnSync(['bun', CLI, 'config:dump', '--json'], {
      cwd: SECRET_APP,
      env: { ...process.env, DATABASE_URL: SECRET },
    });
    const out = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain(SECRET);
    const parsed = JSON.parse(out) as {
      schemaVersion: number;
      ok: boolean;
      values: Record<string, string>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.values['DATABASE_URL']).toBe('[redacted]');
  });
});
