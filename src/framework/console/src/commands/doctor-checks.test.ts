/** `tsir doctor` checks that do not need a running project (CLI-005, CLI-006). */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { checkDependencies, checkPort } from './doctor.ts';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectWith(manifest: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tsir-doctor-'));
  cleanup.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

describe('checkPort', () => {
  test('no port configured is no check at all, not a pass', async () => {
    expect(await checkPort({ APP_NAME: 'x' })).toBeUndefined();
  });

  test('a port outside 1–65535 fails, and names the variable to fix', async () => {
    const check = await checkPort({ PORT: '70000' });
    expect(check).toMatchObject({
      name: 'port',
      status: 'fail',
      detail: 'PORT is not a valid port',
    });
  });

  test('a non-numeric HTTP_PORT fails with the variable it came from', async () => {
    const check = await checkPort({ HTTP_PORT: 'eighty' });
    expect(check?.detail).toBe('HTTP_PORT is not a valid port');
    expect(check?.hint).toBe('set HTTP_PORT to 1–65535');
  });

  test('a port nothing listens on is reported as usable', async () => {
    // Port 1 needs root to bind, so it is never in use by a dev server, and it is also not
    // bindable here; a free high port is the one to probe.
    const free = await new Promise<number>((resolve) => {
      const server = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: { data() {}, open() {}, close() {} },
      });
      const port = server.port;
      server.stop(true);
      resolve(port);
    });
    const check = await checkPort({ PORT: String(free) });
    expect(check?.status).toBe('ok');
  });
});

describe('checkDependencies', () => {
  test('no package.json at the root is a warning, not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tsir-doctor-empty-'));
    cleanup.push(dir);
    expect(checkDependencies(dir)).toEqual([
      { name: 'dependencies', status: 'warn', detail: 'no package.json at the project root' },
    ]);
  });

  test('a project that declares no @tsir packages reports that it checked none', async () => {
    const dir = await projectWith({ dependencies: { hono: '^4.0.0' } });
    expect(checkDependencies(dir)).toEqual([
      { name: 'dependencies', status: 'ok', detail: '0 @tsir packages resolve' },
    ]);
  });

  test('a declared @tsir package that is not installed fails, and says to install', async () => {
    const dir = await projectWith({ dependencies: { '@tsir/not-installed-anywhere': '1.0.0' } });
    expect(checkDependencies(dir)).toEqual([
      {
        name: 'dependencies',
        status: 'fail',
        detail: 'not installed: @tsir/not-installed-anywhere',
        hint: 'run `bun install` in the project root',
      },
    ]);
  });
});
