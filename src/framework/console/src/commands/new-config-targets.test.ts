/**
 * `CAP-008` — `tsir new --target` writes the config `DRIVER_DEFAULTS` describes.
 *
 * The interesting assertions are not "a file was written" but "the file is the one the table
 * says", because a starter that writes a plausible wrong driver is worse than one that writes
 * nothing: it looks configured.
 */
import { describe, expect, test } from 'bun:test';

import { DRIVER_DEFAULTS, type DeployTarget } from '@tsir/core';

import { newCommand } from './generate.ts';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TARGETS: readonly DeployTarget[] = ['cloudflare', 'lambda', 'bun'];

/** Scaffold into a temp directory and return its `config/` directory. */
async function scaffold(target: DeployTarget, name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `tsir-new-${target}-`));
  const previous = process.cwd();
  process.chdir(root);
  try {
    const code = await newCommand([name, '--target', target, '--no-interactive']);
    expect(code).toBe(0);
  } finally {
    process.chdir(previous);
  }
  return join(root, 'apps', name);
}

describe('tsir new --target (CAP-008)', () => {
  for (const target of TARGETS) {
    test(`${target} writes the driver the table names, for every capability`, async () => {
      const dir = await scaffold(target, `shop-${target}`);
      try {
        const cases: readonly [string, string, keyof (typeof DRIVER_DEFAULTS)['bun']][] = [
          ['config/database.ts', 'database', 'database'],
          ['config/cache.ts', 'cache', 'cache'],
          ['config/queue.ts', 'queue', 'queue'],
          ['config/storage.ts', 'storage', 'storage'],
          ['config/mail.ts', 'mail', 'mail'],
          ['config/broadcast.ts', 'broadcast', 'broadcast'],
          ['config/search.ts', 'search', 'search'],
          ['config/media.ts', 'media', 'media'],
        ];
        for (const [file, , capability] of cases) {
          const text = readFileSync(join(dir, file), 'utf8');
          const expected = DRIVER_DEFAULTS[target][capability].driver;
          // The driver name appears as `driver: '<name>'` inside the entry.
          expect(text).toContain(`driver: '${expected}'`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('the lambda starter writes Postgres, not D1', async () => {
    // The regression that motivated the task: `tsir new` hardcoded `d1`, so a lambda app shipped a
    // Worker's database config. D1 in a function is a binding that nothing injects.
    const dir = await scaffold('lambda', 'lambda-db');
    try {
      const text = readFileSync(join(dir, 'config/database.ts'), 'utf8');
      expect(text).toContain("driver: 'postgres'");
      expect(text).not.toContain("driver: 'd1'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a generated config names the variables it needs in .env.example', async () => {
    // A starter that writes `resend` with no key produces an app that refuses to boot. That refusal
    // is right; arriving at it on first `tsir dev` is not. The variable is a reference, and the
    // variable is listed where a person looks.
    const dir = await scaffold('cloudflare', 'env-doc');
    try {
      const env = readFileSync(join(dir, '.env.example'), 'utf8');
      expect(env).toContain('RESEND_API_KEY=');
      expect(env).toContain('TYPESENSE_API_KEY=');
      expect(env).toContain('CF_IMAGES_TOKEN=');
      // Every reference in a config is documented: the two lists cannot drift apart, because the
      // scaffold derives both from the same entry.
      for (const [file, variable] of [
        ['config/mail.ts', 'RESEND_API_KEY'],
        ['config/search.ts', 'TYPESENSE_API_KEY'],
      ] as const) {
        expect(readFileSync(join(dir, file), 'utf8')).toContain(`fromEnv: '${variable}'`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the bun starter writes no section for sessions', async () => {
    // `sessions`, `api keys`, `feature flags` and the lock have no `tsir.js` section yet. Writing a
    // block nothing reads is worse than writing none: it looks configured.
    const dir = await scaffold('bun', 'bun-app');
    try {
      expect(existsSync(join(dir, 'config/sessions.ts'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown target is a usage error, not a silent fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tsir-new-bad-'));
    const previous = process.cwd();
    process.chdir(root);
    try {
      let message = '';
      try {
        await newCommand(['bad', '--target', 'vercel', '--no-interactive']);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // The message names what was typed. A fallback to `cloudflare` here would be a silently
      // wrong target for an entire application, discovered when the first binding is missing.
      expect(message).toContain('vercel');
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
