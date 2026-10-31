/**
 * The artifact secret scanner (`DPL-012`, `DPL-020`).
 *
 * Two halves, and the second matters more: what it finds, and what it must not. A scanner
 * that flags `wrangler secret put APP_KEY` — the correct generated shape — teaches the team
 * to ignore the scanner, which is how a real leak ships.
 */

import { describe, expect, test } from 'bun:test';

import {
  describeFindings,
  findingContext,
  hasLeak,
  scanSources,
  scanText,
  secretPatterns,
  SECRET_SHAPES,
} from './secrets.ts';

describe('shapes that are a secret wherever they appear', () => {
  test('an AWS access key id is found, with the value removed', () => {
    const findings = scanText(
      ['const a = 1;', 'const b = 2;', 'const key = "AKIAIOSFODNN7EXAMPLE";'].join('\n'),
      'dist/cloudflare/http/index.js',
    );

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.pattern).toBe('aws-access-key-id');
    expect(finding?.line).toBe(3);
    expect(finding?.file).toBe('dist/cloudflare/http/index.js');
    expect(finding?.excerpt).toContain('[redacted]');
    expect(finding?.excerpt).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('a private key header, a GitHub token and a live Stripe key are all caught', () => {
    const text = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
      'sk_live_0123456789abcdef',
      'AIzaSyA0123456789abcdefghijklmnopqrstuv',
      'xoxb-0123456789-abcdefghijkl',
    ].join('\n');
    const patterns = scanText(text, 'bundle.js').map((finding) => finding.pattern);

    // Ordered by line, because a finding is addressed by its line.
    expect(patterns).toEqual([
      'private-key',
      'github-token',
      'stripe-live-key',
      'google-api-key',
      'slack-token',
    ]);
  });

  test('a connection string is a leak; the same string without credentials is not', () => {
    expect(
      scanText('DATABASE_URL=postgres://app:hunter2@db.internal:5432/app', 'x.js'),
    ).toHaveLength(1);
    expect(scanText('DATABASE_URL=postgres://db.internal:5432/app', 'x.js')).toHaveLength(0);
  });
});

describe('names need an assignment', () => {
  const names = ['APP_KEY'];

  test('the generated `wrangler secret put` line is not a leak', () => {
    const toml = [
      'name = "http-example-http"',
      '# Secrets — set these once per environment; never put them in this file:',
      '#   wrangler secret put APP_KEY',
    ].join('\n');

    expect(scanSources([{ file: 'wrangler.http.toml', contents: toml }], names)).toHaveLength(0);
  });

  test('an assigned value is a leak, and the pattern is the binding name', () => {
    const findings = scanText(
      'APP_KEY = "base64:abcdefghijklmnop"',
      'config.js',
      secretPatterns(names),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.pattern).toBe('APP_KEY (value assigned)');
    // The name survives: it is what the reader has to move into `wrangler secret put`.
    expect(findings[0]?.excerpt).toBe('APP_KEY = "[redacted]"');
  });

  test('reading the secret is a use, not a leak', () => {
    const text = [
      'const key = process.env.APP_KEY;',
      'const other = APP_KEY = process.env.APP_KEY',
      'const third = `${APP_KEY}`;',
    ].join('\n');

    expect(scanText(text, 'index.js', secretPatterns(names))).toHaveLength(0);
  });
});

describe('what it must not flag', () => {
  test('a minified bundle with base64-looking constants stays quiet', () => {
    const bundle = `var a="${'A'.repeat(200)}",b="${'Zm9vYmFy'.repeat(40)}",c=0.123456789;`.repeat(
      20,
    );

    expect(scanText(bundle, 'index.js')).toHaveLength(0);
  });

  test('the word "secret" is not a secret', () => {
    const text = [
      '// secrets arrive from wrangler secret put',
      'const secretName = "APP_KEY";',
    ].join('\n');

    expect(scanText(text, 'x.js', secretPatterns(['APP_KEY']))).toHaveLength(0);
  });
});

describe('the report', () => {
  test('findings are sorted by file, line and pattern, once per pattern per line', () => {
    const findings = scanSources([
      { file: 'b.js', contents: 'AKIAIOSFODNN7EXAMPLE ghp_0123456789abcdefghijklmnopqrstuvwxyz' },
      { file: 'a.js', contents: 'AKIAIOSFODNN7EXAMPLE' },
    ]);

    expect(
      findings.map((finding) => `${finding.file}:${String(finding.line)}:${finding.pattern}`),
    ).toEqual(['a.js:1:aws-access-key-id', 'b.js:1:aws-access-key-id', 'b.js:1:github-token']);
  });

  test('a very long line is truncated, and still redacted', () => {
    const padding = 'x'.repeat(400);
    const findings = scanText(`${padding} AKIAIOSFODNN7EXAMPLE ${padding}`, 'b.js');

    expect(findings[0]?.excerpt.length).toBeLessThanOrEqual(160);
    expect(findings[0]?.excerpt).toContain('[redacted]');
  });

  test('the human report is safe to paste, and says so when empty', () => {
    expect(describeFindings([])).toBe('  no secret values in the artifacts\n');

    const report = describeFindings(scanText('AKIAIOSFODNN7EXAMPLE', 'dist/index.js'));
    expect(report).toContain('dist/index.js:1');
    expect(report).toContain('aws-access-key-id');
    expect(report).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  test('hasLeak and findingContext are the contract the CLI builds on', () => {
    const findings = scanText('AKIAIOSFODNN7EXAMPLE', 'dist/index.js');

    expect(hasLeak(findings)).toBe(true);
    expect(hasLeak([])).toBe(false);
    expect(findingContext(findings[0]!)).toEqual({
      file: 'dist/index.js',
      line: 1,
      pattern: 'aws-access-key-id',
    });
  });

  test('the shape list is exported and every entry is a global-safe regex', () => {
    for (const shape of SECRET_SHAPES) {
      expect(shape.name.length).toBeGreaterThan(0);
      expect(shape.pattern.flags).not.toContain('g');
    }
  });

  test('named patterns are deduplicated and sorted', () => {
    expect(
      secretPatterns(['b', 'a', 'b'])
        .slice(0, 2)
        .map((pattern) => pattern.name),
    ).toEqual(['a (value assigned)', 'b (value assigned)']);
  });
});
