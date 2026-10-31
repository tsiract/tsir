/**
 * Tests for the repository tools.
 *
 * These tools gate every other commit, so a bug in one is a bug in the project's
 * definition of "green". They are tested against exported pure functions and
 * temporary directories rather than by shelling out, so a failure names a
 * function instead of an exit code.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anchorsOf, slugify } from './check-links.ts';
import { scaffold } from './new-package.ts';
import { bumpVersion, highestBump, parseChangeset } from './version.ts';
import { surfaceOf } from './api-surface.ts';
import { decide, parseLsof, parseSs, type Listener, type PolicyContext } from './kill-ports.ts';
import { checkSpecifier, type SpecifierContext } from './check-boundaries.ts';
import { checkCoercion, findCoercion } from './check-coercion.ts';

describe('tools · links', () => {
  test('GitHub heading slugs drop punctuation and code ticks', () => {
    expect(slugify('## 3.2 Route codegen')).toBe('32-route-codegen');
    expect(slugify('`defineApp` and friends')).toBe('defineapp-and-friends');
    expect(slugify('§ 9.1 What is implemented')).toBe('91-what-is-implemented');
  });

  test('anchors ignore fenced code blocks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-links-'));
    const file = join(dir, 'doc.md');
    writeFileSync(file, '# Title\n\n```md\n# Not a heading\n```\n\n## Real heading\n');
    const anchors = anchorsOf(file);
    expect([...anchors]).toEqual(['title', 'real-heading']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tools · version', () => {
  test('bumps follow semver, lockstep or not', () => {
    expect(bumpVersion('0.0.0', 'patch')).toBe('0.0.1');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(() => bumpVersion('1.2', 'patch')).toThrow();
  });

  test('the highest pending bump wins', () => {
    expect(
      highestBump([
        { bump: 'patch', summary: 'a' },
        { bump: 'minor', summary: 'b' },
      ]),
    ).toBe('minor');
    expect(highestBump([])).toBeUndefined();
  });

  test('a changeset without frontmatter is rejected, not silently ignored', () => {
    expect(() => parseChangeset('x.md', 'just text')).toThrow(/frontmatter/);
    expect(parseChangeset('x.md', '---\nbump: minor\n---\n\nAdd router\n')).toEqual({
      bump: 'minor',
      summary: 'Add router',
    });
  });
});

describe('tools · new-package', () => {
  test('a scaffolded package is complete: manifest, barrel, test, task stub', () => {
    const files = scaffold({ name: 'http-client', kind: 'framework' });
    expect(Object.keys(files).sort()).toEqual([
      'src/framework/http-client/TASKS.md',
      'src/framework/http-client/package.json',
      'src/framework/http-client/src/http-client.test.ts',
      'src/framework/http-client/src/index.ts',
    ]);

    const manifest = JSON.parse(files['src/framework/http-client/package.json'] ?? '{}') as {
      name: string;
      license: string;
      sideEffects: boolean;
      private: boolean;
    };
    expect(manifest.name).toBe('@tsir/http-client');
    expect(manifest.license).toBe('MIT');
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.private).toBe(true);

    // The generated test must reference what the generated barrel exports.
    expect(files['src/framework/http-client/src/http-client.test.ts']).toContain(
      "import { httpClient } from './index.ts'",
    );
    expect(files['src/framework/http-client/src/index.ts']).toContain(
      "export const httpClient = '@tsir/http-client'",
    );
  });

  test('names that are not kebab-case are refused rather than slugified silently', () => {
    expect(() => scaffold({ name: 'HttpClient' })).toThrow(/kebab-case/);
    expect(() => scaffold({ name: 'http_client' })).toThrow(/kebab-case/);
  });
});

describe('tools · api surface', () => {
  test('named exports are collected through relative re-export chains', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsir-surface-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'impl.ts'),
      'export const alpha = 1;\nexport interface Beta {}\nexport type Gamma = string;\n',
    );
    writeFileSync(join(dir, 'src', 'unused.ts'), 'export const notReachable = 1;\n');
    writeFileSync(
      join(dir, 'src', 'index.ts'),
      "export * from './impl.ts';\nexport type { Gamma } from './impl.ts';\nexport const delta = 2;\n",
    );

    // `Array#sort` is code-unit order: uppercase names precede lowercase ones.
    expect(surfaceOf(dir)).toEqual(['Beta', 'Gamma', 'alpha', 'delta']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the real snapshot matches the packages on disk', () => {
    const snapshot = JSON.parse(readFileSync('src/docs/api-surface.json', 'utf8')) as Record<
      string,
      readonly string[]
    >;
    for (const pkg of ['core', 'router', 'http', 'validate']) {
      expect(snapshot[pkg]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('tools · kill-ports', () => {
  const context: PolicyContext = {
    selfPid: 100,
    parentPid: 99,
    isRoot: false,
    includeInfra: false,
    ownerPids: new Set([200, 201]),
  };

  const listener = (overrides: Partial<Listener> = {}): Listener => ({
    port: 3000,
    address: '0.0.0.0',
    pid: 200,
    command: 'bun',
    ...overrides,
  });

  test('ss output is parsed with and without the process column', () => {
    const withPid =
      'LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:(("bun",pid=4242,fd=18))\n' +
      'LISTEN 0 511 *:5432 *:* users:(("postgres",pid=77,fd=5))\n';
    expect(parseSs(withPid)).toEqual([
      { port: 3000, address: '0.0.0.0', pid: 4242, command: 'bun' },
      { port: 5432, address: '*', pid: 77, command: 'postgres' },
    ]);

    // Without -p (or without permission) the process column is simply absent.
    expect(parseSs('LISTEN 0 100 127.0.0.1:51229 0.0.0.0:*\n')).toEqual([
      { port: 51229, address: '127.0.0.1', pid: undefined, command: '' },
    ]);
  });

  test('lsof output (macOS) is parsed', () => {
    const output = [
      'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
      'bun 4242 user 21u IPv6 0x1234 0t0 TCP *:3000 (LISTEN)',
    ].join('\n');
    expect(parseLsof(output)).toEqual([{ port: 3000, address: '*', pid: 4242, command: 'bun' }]);
  });

  test('whatever is not identifiable is never signalled', () => {
    expect(decide(listener({ pid: undefined, command: '' }), context)).toEqual({
      action: 'keep',
      reason: 'no process visible (another user owns it)',
    });
    expect(decide(listener({ pid: 100 }), context).action).toBe('keep'); // self
    expect(decide(listener({ pid: 99 }), context).action).toBe('keep'); // parent
    expect(decide(listener({ pid: 1 }), context).action).toBe('keep'); // init
    expect(decide(listener({ pid: 300 }), context).action).toBe('keep'); // other user
  });

  test('container runtime processes and ports survive the sweep', () => {
    expect(decide(listener({ pid: 200, command: 'docker-proxy', port: 8080 }), context)).toEqual({
      action: 'keep',
      reason: 'container runtime (docker-proxy)',
    });
    expect(decide(listener({ pid: 200, command: 'containerd-shim' }), context).action).toBe('keep');
    expect(decide(listener({ pid: 200, command: 'com.docker.backend' }), context).action).toBe(
      'keep',
    );

    // A user-owned process on Docker's own API port is still Docker's port.
    expect(decide(listener({ pid: 200, command: 'bun', port: 2375 }), context)).toEqual({
      action: 'keep',
      reason: 'container runtime port',
    });
  });

  test('system ports and data services need an explicit opt-in', () => {
    expect(decide(listener({ port: 22 }), context).action).toBe('keep');
    expect(decide(listener({ port: 5432, command: 'postgres' }), context)).toEqual({
      action: 'keep',
      reason: 'data service (pass --include-infra to free)',
    });
    expect(
      decide(listener({ port: 5432, command: 'postgres' }), { ...context, includeInfra: true }),
    ).toEqual({
      action: 'kill',
      reason: 'postgres',
    });
  });

  test('a developer’s own dev server is freed', () => {
    expect(decide(listener(), context)).toEqual({ action: 'kill', reason: 'bun' });
    expect(decide(listener({ port: 5173, command: 'node' }), context)).toEqual({
      action: 'kill',
      reason: 'node',
    });
  });
});

describe('tools · boundaries (negative cases)', () => {
  const routerContext: SpecifierContext = {
    importer: 'router',
    file: 'src/framework/router/src/index.ts',
    allowed: ['container', 'core', 'validate'],
    runtimeNeutral: true,
    isAdapter: false,
  };

  test('a package may not import a package that is not in its allow list', () => {
    // The gate: the failing import must
    // name both ends of the arrow and the permitted set.
    const violation = checkSpecifier('@tsir/database', routerContext);
    expect(violation?.rule).toBe('forbidden-dependency');
    expect(violation?.detail).toContain('router → database is not permitted');
    expect(violation?.detail).toContain('allowed: container, core, validate');
  });

  test('deep imports are rejected even from an allowed package', () => {
    expect(checkSpecifier('@tsir/core/src/container', routerContext)?.rule).toBe('deep-import');
    expect(checkSpecifier('@tsir/core/dist/index.js', routerContext)?.rule).toBe('deep-import');
    // A declared subpath export is fine.
    expect(checkSpecifier('@tsir/core/errors', routerContext)).toBeUndefined();
  });

  test('runtime built-ins are refused in runtime-neutral packages unless it is an adapter', () => {
    expect(checkSpecifier('node:fs', routerContext)?.rule).toBe('runtime-import');
    expect(checkSpecifier('bun:sqlite', routerContext)?.rule).toBe('runtime-import');
    expect(checkSpecifier('node:fs', { ...routerContext, isAdapter: true })).toBeUndefined();
    expect(checkSpecifier('node:fs', { ...routerContext, runtimeNeutral: false })).toBeUndefined();
  });

  test('unknown packages and self-imports', () => {
    expect(checkSpecifier('@tsir/nonexistent', routerContext)?.rule).toBe('unknown-package');
    expect(checkSpecifier('@tsir/router', routerContext)).toBeUndefined();
    expect(checkSpecifier('./local.ts', routerContext)).toBeUndefined();
    expect(checkSpecifier('zod', routerContext)).toBeUndefined(); // third-party: check-deps owns it
  });
});

describe('tools · coercion guard (VLD-007)', () => {
  test('flags the three ways coercion sneaks in', () => {
    const source = [
      'const a = z.coerce.number();',
      'const b = Number.parseInt(raw, 10);',
      'const c = parseFloat(raw);',
      'const d = Number(raw);',
    ].join('\n');
    const found = findCoercion('x.ts', source);
    expect(found.map((violation) => violation.pattern)).toEqual([
      'z.coerce',
      'parseInt',
      'parseFloat',
      'Number()',
    ]);
    expect(found.map((violation) => violation.line)).toEqual([1, 2, 3, 4]);
  });

  test('does not flag literals, static members, or comments', () => {
    const source = [
      'const max = Number.MAX_SAFE_INTEGER;',
      'const value = Number(42);',
      '// never call parseInt here',
      ' * parseInt is banned',
      "const ok = Number('-3');",
    ].join('\n');
    expect(findCoercion('x.ts', source)).toEqual([]);
  });

  test('an annotation on the line or the two above it opts out', () => {
    const inline = 'const a = Number(raw); // coercion-ok: header-owned';
    const above = ['// coercion-ok: version string', 'const b = Number(raw);'].join('\n');
    const tooFar = ['// coercion-ok: stale note', '', '', 'const c = Number(raw);'].join('\n');
    expect(findCoercion('x.ts', inline)).toEqual([]);
    expect(findCoercion('x.ts', above)).toEqual([]);
    expect(findCoercion('x.ts', tooFar)).toHaveLength(1);
  });

  test('the workspace itself is clean', () => {
    // A failure here means real coercion reached framework source: fix the call,
    // or annotate why it is safe. `make coercion` runs exactly this check.
    expect(checkCoercion(join(import.meta.dir, '..', '..'))).toEqual([]);
  });
});
