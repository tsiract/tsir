/**
 * `drivers.gen.ts` (`CAP-003`).
 *
 * The acceptance is two sentences, and both are about *not* being clever:
 *
 *   · two stores on one driver produce **one** import — the normal case, since a project with
 *     an `app` and a `sessions` store both on `database` is what ADR-0019 § 2 describes;
 *   · a store naming a driver the build does not ship **fails `tsir build`**, loudly, before
 *     anything is written. A generated module that silently dropped it would compile and then
 *     fail at boot in production.
 *
 * The generated file is checked as text, because that is what it is: a module whose whole job is
 * to be small, stable, and readable in a diff.
 */

import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { planDrivers, renderDriversModule } from './drivers.ts';
import { EXIT } from './output.ts';
import { runCliSubprocess } from '../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'commands', 'fixtures', 'cache-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function copy(edit?: (config: string) => string): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'commands', 'fixtures', '.tmp-drivers-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });
  await rm(join(dir, 'app', '.tsir'), { recursive: true, force: true });

  if (edit !== undefined) {
    const configPath = join(dir, 'app', 'tsir.js');
    await writeFile(configPath, edit(await readFile(configPath, 'utf8')), 'utf8');
  }
  return join(dir, 'app');
}

describe('planDrivers', () => {
  test('two stores on one driver are one entry, and both names are kept', async () => {
    const plan = planDrivers({
      cache: { stores: { app: { driver: 'memory' }, sessions: { driver: 'memory' } } },
    });

    expect(plan.problems).toEqual([]);
    expect(plan.uses).toHaveLength(1);
    expect(plan.uses[0]?.names).toEqual(['app', 'sessions']);
    expect(plan.uses[0]?.module).toBe('@tsir/cache/memory');
  });

  test('cache and queue are planned separately, even on the same driver name', async () => {
    const plan = planDrivers({
      cache: { stores: { app: { driver: 'memory' } } },
      queue: { connections: { default: { driver: 'memory' } } },
    });

    expect(plan.uses.map((use) => `${use.port}:${use.driver}`)).toEqual([
      'cache:memory',
      'queue:memory',
    ]);
    expect(plan.uses[1]?.module).toBe('@tsir/queue/memory');
  });

  test('an unknown driver is a problem naming the store, the driver, and what ships', async () => {
    const plan = planDrivers({ cache: { stores: { pages: { driver: 'memcached' } } } });

    expect(plan.uses).toEqual([]);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]?.message).toContain('cache "pages" names driver "memcached"');
    expect(plan.problems[0]?.message).toContain(
      'shipped: memory, null, database, redis, cloudflare-kv',
    );
  });

  test('one unknown driver does not hide the drivers that are fine', async () => {
    const plan = planDrivers({
      queue: { connections: { default: { driver: 'beanstalkd' }, heavy: { driver: 'database' } } },
    });

    expect(plan.problems.map((problem) => problem.driver)).toEqual(['beanstalkd']);
    expect(plan.uses.map((use) => use.driver)).toEqual(['database']);
    // The message has to be actionable, not a shrug.
    expect(plan.problems[0]?.message).toContain('which this build does not ship');
  });

  test('both broker drivers are in the generated module, on their own subpaths', async () => {
    const plan = planDrivers({
      queue: {
        connections: {
          default: { driver: 'cloudflare-queues' },
          heavy: { driver: 'sqs' },
        },
      },
    });

    expect(plan.problems).toEqual([]);
    const module = renderDriversModule(plan);
    expect(module).toContain(
      "import { cloudflareQueuesDriver } from '@tsir/queue/cloudflare-queues';",
    );
    expect(module).toContain("import { sqsDriver } from '@tsir/queue/sqs';");
  });

  test('no capability configuration at all is an empty plan, not an error', async () => {
    expect(planDrivers({})).toEqual({ uses: [], problems: [] });
  });
});

describe('renderDriversModule', () => {
  test('one import per driver, sorted, and factories rather than instances', async () => {
    const module = renderDriversModule(
      planDrivers({
        cache: {
          stores: {
            pages: { driver: 'database' },
            app: { driver: 'memory' },
            sessions: { driver: 'memory' },
          },
        },
        queue: { connections: { default: { driver: 'database' } } },
      }),
    );

    expect(module.match(/^import /gmu)).toHaveLength(3);
    expect(module).toContain("import { memoryDriver } from '@tsir/cache/memory';");
    expect(module).toContain("import { databaseDriver } from '@tsir/cache/database';");
    expect(module).toContain("import { databaseQueueDriver } from '@tsir/queue/database';");
    // No client is invented: a generated file that picked one would be a second configuration.
    expect(module).not.toContain('databaseDriver({');
    expect(module).toContain('export const cacheDrivers = {');
    expect(module).toContain('export const queueDrivers = {');
  });

  test('the output is stable: same configuration, byte-identical module', async () => {
    const build = (): string =>
      renderDriversModule(
        planDrivers({
          cache: { stores: { b: { driver: 'redis' }, a: { driver: 'memory' } } },
        }),
      );

    expect(build()).toBe(build());
    // Sorted by driver, so a diff in this file always means a change in configuration.
    expect(build().indexOf('memory')).toBeLessThan(build().indexOf('redis'));
  });

  test('an inline-style store entry does not trip the plan', async () => {
    // `tsir.js` is user data: the schema allows extra keys, and the planner must read only
    // `driver` rather than assuming a shape.
    const stores = { app: { driver: 'memory', ttlMs: 60_000 } };
    const plan = planDrivers({ cache: { stores } });
    expect(plan.problems).toEqual([]);
    expect(plan.uses[0]?.driver).toBe('memory');
  });
});

describe('tsir build writes and refuses', () => {
  test('the fixture declares two memory stores and gets one import', async () => {
    const app = await copy();

    const result = runCliSubprocess(['build'], app);
    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('1 import(s)');
    expect(result.output).toContain('drivers.gen.ts');

    const module = await readFile(join(app, '.tsir', 'drivers.gen.ts'), 'utf8');
    expect(module.match(/^import /gmu)).toHaveLength(1);
    expect(module).toContain("import { memoryDriver } from '@tsir/cache/memory';");
  });

  test('a store naming an uninstalled driver fails the build and writes nothing', async () => {
    const app = await copy((config) => config.replace("driver: 'memory'", "driver: 'memcached'"));

    const result = runCliSubprocess(['build'], app);

    expect(result.code).not.toBe(EXIT.ok);
    expect(result.output).toContain('names driver "memcached"');
    expect(result.output).toContain('nothing was written');
    expect(readdir(join(app, '.tsir'))).rejects.toThrow(/ENOENT/u);
  });

  test('--json reports the imports, so a pipeline can diff them', async () => {
    const app = await copy();

    const result = runCliSubprocess(['build', '--json'], app);
    const parsed = JSON.parse(result.output) as {
      drivers: { path: string; imports: { port: string; driver: string; names: string[] }[] };
    };

    expect(parsed.drivers.path).toBe('./.tsir/drivers.gen.ts');
    expect(parsed.drivers.imports).toHaveLength(1);
    expect(parsed.drivers.imports[0]?.port).toBe('cache');
    expect(parsed.drivers.imports[0]?.names).toEqual(['app', 'sessions']);
  });
});
