import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import { controllerTemplate } from './make-controller.ts';

let dir = '';
let cwd = '';
let stderr = '';
let stdout = '';
const realErr = process.stderr.write.bind(process.stderr);
const realOut = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'tsir-scoped-'));
  process.chdir(dir);
  stderr = '';
  stdout = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += String(chunk);
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += String(chunk);
    return true;
  };
});
afterEach(() => {
  process.stderr.write = realErr;
  process.stdout.write = realOut;
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});
const read = (path: string): string => readFileSync(join(dir, path), 'utf8');

describe('explicit module generators', () => {
  test('controller template uses its module registry and supports a unit override', () => {
    expect(controllerTemplate('OrderController', 'order', '/api/order')).toContain(
      "@Controller(registry, '/api/order')",
    );
    expect(controllerTemplate('OrderController', 'order', '/order', 'billing')).toContain(
      "@Controller(registry, '/order', { unit: 'billing' })",
    );
  });
  test('the exact shop workflow uses explicit ownership and kebab case', async () => {
    expect(await runCli(['make:module', 'shop'])).toBe(EXIT.ok);
    expect(read('shop/http/shop.controller.ts')).toContain('class ShopController');
    expect(await runCli(['make:controller', 'order', 'shop'])).toBe(EXIT.ok);
    expect(read('shop/http/order.controller.ts')).toContain('class OrderController');
    expect(read('shop/http/order.controller.ts')).toContain("@Controller(registry, '/api/order')");
    expect(read('shop/http/order.controller.test.ts')).toContain('throw new Error');
    expect(await runCli(['make:controller', 'user-settings', 'shop'])).toBe(EXIT.ok);
    expect(read('shop/http/user-settings.controller.ts')).toContain('class UserSettingsController');
    expect(await runCli(['make:model', 'order', 'shop'])).toBe(EXIT.ok);
    expect(read('shop/models/order.model.ts')).toContain("_table('shop_order'");
    expect(read('shop/models/order.model.ts')).toContain('export type Order');
    expect(read('shop/models/order.model.test.ts')).toContain('throw new Error');
    expect(await runCli(['make:model', 'text', 'shop'])).toBe(EXIT.ok);
    expect(read('shop/models/text.model.ts')).toContain('text as _text');
    expect(read('shop/models/text.model.ts')).toContain('export const text = _table');
    expect(await runCli(['make:model', 'user-settings', 'shop', '--dialect', 'postgres'])).toBe(
      EXIT.ok,
    );
    expect(read('shop/models/user-settings.model.ts')).toContain("_table('shop_user_settings'");
    expect(read('shop/models/user-settings.model.ts')).toContain("from 'drizzle-orm/pg-core'");
    expect(read('shop/models/user-settings.model.ts')).toContain('export const userSettings');
  });
  test('kebab module exports and starter controller are valid symbols', async () => {
    expect(await runCli(['make:module', 'user-settings'])).toBe(EXIT.ok);
    expect(read('user-settings/index.ts')).toContain('userSettings');
    expect(await runCli(['make:module', 'route-module'])).toBe(EXIT.ok);
    expect(read('route-module/routes.ts')).toContain('routeModule as _routeModule');
    expect(read('route-module/routes.ts')).toContain('export const routeModule = _routeModule');
    expect(await runCli(['make:module', 'test'])).toBe(EXIT.ok);
    expect(read('test/test.test.ts')).toContain('test as _module');
    expect(read('user-settings/http/user-settings.controller.ts')).toContain(
      'class UserSettingsController',
    );
  });
  test('kebab names with numeric segments retain their exact paths', async () => {
    expect(await runCli(['make:module', 'shop-2'])).toBe(EXIT.ok);
    expect(await runCli(['make:controller', 'order-1', 'shop-2'])).toBe(EXIT.ok);
    expect(await runCli(['make:service', 'order-1', 'shop-2'])).toBe(EXIT.ok);
    expect(await runCli(['make:event', 'order-1', 'shop-2'])).toBe(EXIT.ok);
    expect(await runCli(['make:listener', 'notify-1', 'shop-2', '--event', 'order-1'])).toBe(
      EXIT.ok,
    );
    expect(read('shop-2/listeners/notify-1.listener.ts')).toContain(
      "from '../events/order-1.event.ts'",
    );
    expect(existsSync(join(dir, 'shop-2/services/order-1.service.ts'))).toBe(true);
  });
  test('requires explicit existing module, never creates or modifies it', async () => {
    expect(await runCli(['make:controller', 'order'])).toBe(EXIT.usage);
    expect(await runCli(['make:model', 'order'])).toBe(EXIT.usage);
    expect(await runCli(['make:controller', 'order', 'shop'])).toBe(EXIT.failure);
    expect(stderr).toContain('tsir make:module shop');
    expect(await runCli(['make:model', 'order', 'shop'])).toBe(EXIT.failure);
    expect(existsSync(join(dir, 'shop'))).toBe(false);
    const base = join(dir, 'shop');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'routes.ts'), '// keep');
    expect(await runCli(['make:controller', 'order', 'shop', '--force'])).toBe(EXIT.failure);
    expect(await runCli(['make:model', 'order', 'shop', '--force'])).toBe(EXIT.failure);
    expect(read('shop/routes.ts')).toBe('// keep');
  });
  test('legacy explicit --module remains supported without rewriting module files', async () => {
    await runCli(['make:module', 'shop']);
    const routes = read('shop/routes.ts');
    expect(
      await runCli(['make:controller', 'order', '--module', 'shop', '--unit', 'billing']),
    ).toBe(EXIT.ok);
    expect(read('shop/http/order.controller.ts')).toContain("{ unit: 'billing' }");
    expect(read('shop/routes.ts')).toBe(routes);
  });
  test('dry run and conflict detection are safe', async () => {
    await runCli(['make:module', 'shop']);
    expect(await runCli(['make:controller', 'order', 'shop', '--dry-run'])).toBe(EXIT.ok);
    expect(stdout).toContain('order.controller.ts');
    expect(existsSync(join(dir, 'shop/http/order.controller.ts'))).toBe(false);
    await runCli(['make:controller', 'order', 'shop']);
    expect(await runCli(['make:controller', 'order', 'shop'])).toBe(EXIT.failure);
    expect(await runCli(['make:controller', 'order', 'shop', '--force'])).toBe(EXIT.ok);
    expect(await runCli(['make:model', 'order', 'shop', '--dry-run'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'shop/models/order.model.ts'))).toBe(false);
    await runCli(['make:model', 'order', 'shop']);
    expect(await runCli(['make:model', 'order', 'shop'])).toBe(EXIT.failure);
    expect(await runCli(['make:model', 'order', 'shop', '--force'])).toBe(EXIT.ok);
  });
  test.each(
    (
      [
        ['make:controller', '../oops', 'shop'],
        ['make:controller', 'order', '../oops'],
        ['make:controller', 'order', 'shop', 'extra'],
        ['make:controller', 'order', 'shop', '--module', 'other'],
        ['make:model', 'order', 'shop', '--dialect', 'mysql'],
        ['make:model', 'order', 'shop', 'extra'],
        ['make:module', '../shop'],
        ['make:module', 'new'],
        ['make:module', 'registry'],
      ] as string[][]
    ).map((args): [string[]] => [args]),
  )('invalid arguments %j are rejected', async (args: string[]) => {
    expect(await runCli(args)).toBe(EXIT.usage);
    expect(existsSync(join(dir, 'shop'))).toBe(false);
  });
  test('module-scoped service, middleware, guard, job, event, and listener', async () => {
    await runCli(['make:module', 'shop']);
    const moduleFiles: Record<string, string> = {
      service: 'services',
      middleware: 'middleware',
      guard: 'guards',
      job: 'queues',
      event: 'events',
    };
    for (const kind of ['service', 'middleware', 'guard', 'job', 'event']) {
      expect(await runCli([`make:${kind}`, 'user-settings', 'shop'])).toBe(EXIT.ok);
      expect(existsSync(join(dir, `shop/${moduleFiles[kind]}/user-settings.${kind}.ts`))).toBe(
        true,
      );
    }
    expect(
      await runCli(['make:listener', 'send-receipt', 'shop', '--event', 'user-settings']),
    ).toBe(EXIT.ok);
    expect(read('shop/listeners/send-receipt.listener.ts')).toContain(
      "from '../events/user-settings.event.ts'",
    );
    for (const [kind, name, ext, subdir] of [
      ['seeder', 'order-items', 'seeder', 'seeders'],
      ['link-client', 'billing-api', 'client', 'clients'],
    ] as const) {
      expect(await runCli([`make:${kind}`, name, 'shop'])).toBe(EXIT.ok);
      expect(existsSync(join(dir, `shop/${subdir}/${name}.${ext}.ts`))).toBe(true);
    }
    expect(await runCli(['make:policy', 'order', 'update', 'shop'])).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'shop/policies/order-update.policy.ts'))).toBe(true);
    expect(await runCli(['make:service', 'order', 'shop', '--dir', 'elsewhere'])).toBe(EXIT.usage);
    expect(await runCli(['make:job', 'order', 'shop', 'extra'])).toBe(EXIT.usage);
  });
});
