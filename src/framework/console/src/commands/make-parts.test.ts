import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import { baseName, guardTemplate, middlewareTemplate, serviceTemplate } from './make-parts.ts';

// CLI-011: the generated parts. The generated files import only types, so each one can be loaded
// and called here with plain objects. That tests behaviour, not just the text of the template.

let dir = '';
let originalCwd = '';
let captured = '';
const realErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-parts-'));
  process.chdir(dir);
  captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = realErr;
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('names', () => {
  test('the suffix is optional and stripped once', () => {
    expect(baseName('Audit', 'Service')).toBe('Audit');
    expect(baseName('AuditService', 'Service')).toBe('Audit');
  });

  test('a non-identifier is a usage error', () => {
    expect(() => baseName('my-audit', 'Service')).toThrow();
  });
});

describe('templates use constructor or factory injection only', () => {
  test('the service takes its dependencies in the constructor and never looks them up', () => {
    const text = serviceTemplate('Audit');
    expect(text).toContain('constructor(deps: AuditServiceDeps)');
    expect(text).not.toMatch(/container|resolve\(|inject\(/i);
    expect(text).not.toMatch(/\bany\b/);
  });

  test('the middleware and guard are factories that take a dependency bag', () => {
    expect(middlewareTemplate('Audit')).toContain(
      'export function createAuditMiddleware(deps: AuditMiddlewareDeps)',
    );
    expect(guardTemplate('Token')).toContain(
      'export function createTokenGuard(deps: TokenGuardDeps)',
    );
    expect(guardTemplate('Token')).not.toMatch(/container|resolve\(/i);
  });
});

async function load(path: string): Promise<Record<string, unknown>> {
  return (await import(path)) as Record<string, unknown>;
}

describe('the generated code behaves', () => {
  test('the service returns what its clock returns', async () => {
    const path = join(dir, 'audit.service.ts');
    writeFileSync(path, serviceTemplate('Audit'));
    const mod = await load(path);
    const AuditService = mod['AuditService'] as new (deps: { clock: { now(): Date } }) => {
      now(): Date;
    };
    const fixed = new Date(0);
    expect(new AuditService({ clock: { now: () => fixed } }).now()).toBe(fixed);
  });

  test('the middleware logs the method, path and status after the handler runs', async () => {
    const path = join(dir, 'audit.middleware.ts');
    writeFileSync(path, middlewareTemplate('Audit'));
    const mod = await load(path);
    const lines: string[] = [];
    const create = mod['createAuditMiddleware'] as (deps: {
      log(line: string): void;
    }) => (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
    const middleware = create({ log: (line) => lines.push(line) });
    const response = await middleware(
      { method: 'GET', url: new URL('http://x/users/7') },
      async () => new Response('ok', { status: 201 }),
    );
    expect(response.status).toBe(201);
    expect(lines).toEqual(['GET /users/7 201']);
  });

  test('the guard passes the bearer token to verify and returns its principal', async () => {
    const path = join(dir, 'token.guard.ts');
    writeFileSync(path, guardTemplate('Token'));
    const mod = await load(path);
    const seen: string[] = [];
    const create = mod['createTokenGuard'] as (deps: {
      verify(token: string): Promise<{ subject: string; data: unknown } | null>;
    }) => (ctx: unknown) => Promise<unknown>;
    const guard = create({
      verify: async (token) => {
        seen.push(token);
        return { subject: 'user-1', data: {} };
      },
    });
    const principal = await guard({
      request: new Request('http://x/', { headers: { authorization: 'Bearer abc123' } }),
    });
    expect(seen).toEqual(['abc123']);
    expect(principal).toEqual({ subject: 'user-1', data: {} });
  });

  test('the guard returns null without a bearer token and never calls verify', async () => {
    const path = join(dir, 'token2.guard.ts');
    writeFileSync(path, guardTemplate('Token'));
    const mod = await load(path);
    const create = mod['createTokenGuard'] as (deps: {
      verify(token: string): Promise<null>;
    }) => (ctx: unknown) => Promise<unknown>;
    let called = false;
    const guard = create({
      verify: async () => {
        called = true;
        return null;
      },
    });
    expect(await guard({ request: new Request('http://x/') })).toBeNull();
    expect(
      await guard({ request: new Request('http://x/', { headers: { authorization: 'Basic x' } }) }),
    ).toBeNull();
    expect(called).toBe(false);
  });
});

describe('commands', () => {
  test('make:service writes services/<stem>.service.ts', async () => {
    expect(await runCli(['make:service', 'Audit'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'services', 'audit.service.ts'))).toBe(true);
  });

  test('make:guard refuses an existing guard, names it, and exits 1', async () => {
    await runCli(['make:guard', 'Token']);
    expect(await runCli(['make:guard', 'Token'])).toBe(EXIT.failure);
    expect(captured).toContain('refusing to overwrite');
    expect(readFileSync(join(dir, 'guards', 'token.guard.ts'), 'utf8')).toContain(
      'createTokenGuard',
    );
  });

  test('--dry-run writes nothing', async () => {
    expect(await runCli(['make:middleware', 'Audit', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'middleware'))).toBe(false);
  });

  test('a --dir that escapes the app root is a usage error', async () => {
    expect(await runCli(['make:service', 'Audit', '--dir', '../elsewhere'])).toBe(EXIT.usage);
  });

  test('a missing name is a usage error', async () => {
    expect(await runCli(['make:guard'])).toBe(EXIT.usage);
  });
});
