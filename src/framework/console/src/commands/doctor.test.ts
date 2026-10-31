import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDependencies, checkPort } from './doctor.ts';

// CLI-005: the dependency, version and port checks. Each runs against a scratch project so the
// result is decided by the fixture, not by the machine the tests run on.

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tsir-doctor-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function installPackage(name: string, version: string): void {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
}

function declare(deps: Record<string, string>): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }));
}

describe('dependencies', () => {
  test('no package.json is a warning, not a crash', () => {
    const [check] = checkDependencies(root);
    expect(check).toMatchObject({ name: 'dependencies', status: 'warn' });
  });

  test('a declared @tsir package that is not installed fails, with the fix', () => {
    declare({ '@tsir/missing-thing': 'workspace:*' });
    const checks = checkDependencies(root);
    const deps = checks.find((check) => check.name === 'dependencies');
    expect(deps?.status).toBe('fail');
    expect(deps?.detail).toContain('@tsir/missing-thing');
    expect(deps?.hint).toContain('bun install');
  });

  test('installed packages at one version pass', () => {
    declare({ '@tsir/core': '*', '@tsir/config': '*' });
    installPackage('@tsir/core', '1.2.0');
    installPackage('@tsir/config', '1.2.0');
    const checks = checkDependencies(root);
    expect(checks.find((check) => check.name === 'dependencies')?.status).toBe('ok');
    expect(checks.find((check) => check.name === 'versions')).toMatchObject({
      status: 'ok',
      detail: '@tsir 1.2.0',
    });
  });

  test('mixed @tsir versions are a warning that lists each one', () => {
    declare({ '@tsir/core': '*', '@tsir/config': '*' });
    installPackage('@tsir/core', '1.2.0');
    installPackage('@tsir/config', '1.1.0');
    const versions = checkDependencies(root).find((check) => check.name === 'versions');
    expect(versions?.status).toBe('warn');
    expect(versions?.detail).toContain('@tsir/core@1.2.0');
    expect(versions?.detail).toContain('@tsir/config@1.1.0');
  });
});

describe('ports', () => {
  test('no port in the configuration means no port check', async () => {
    expect(await checkPort({ DATABASE_URL: '[redacted]' })).toBeUndefined();
  });

  test('a free port passes', async () => {
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const free = probe.port;
    probe.stop(true);
    expect(await checkPort({ PORT: String(free) })).toMatchObject({ name: 'port', status: 'ok' });
  });

  test('a port already in use is a warning with a hint', async () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const check = await checkPort({ PORT: String(holder.port) });
      expect(check?.status).toBe('warn');
      expect(check?.hint).toContain('another port');
    } finally {
      holder.stop(true);
    }
  });

  test('a value that is not a port fails without echoing the value', async () => {
    const check = await checkPort({ PORT: 'not-a-port' });
    expect(check?.status).toBe('fail');
    expect(check?.detail).not.toContain('not-a-port');
  });
});
