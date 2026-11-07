/** Verify the release archive's application journey completely outside the source checkout. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function verifyAppJourney(archive: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'tsir app journey '));
  const distribution = join(root, 'distribution');
  const app = join(root, 'hello');
  const cli = join(distribution, 'tsir');
  async function run(argv: string[], cwd: string): Promise<string> {
    const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} failed:\n${output}`);
    return output;
  }
  try {
    await mkdir(distribution);
    await run(['tar', '-xzf', archive, '-C', distribution], root);
    for (const file of [
      'tsir',
      'bin/tsir',
      'README.md',
      'src/docs/index.html',
      'src/apps/frontpage/index.html',
      'apps/admin.product.com/app.ts',
      'apps/admin.product.com/modules/users/index.ts',
      'apps/admin.product.com/modules/auth/index.ts',
    ]) {
      await stat(join(distribution, file));
    }
    for (const [file, href] of [
      ['src/docs/index.html', '../frontpage/'],
      ['src/docs/packages/core.html', '../../frontpage/'],
    ] as const) {
      if (!(await readFile(join(distribution, file), 'utf8')).includes(`href="${href}"`)) {
        throw new Error(`distribution docs home link is broken in ${file}`);
      }
    }
    const launcher = await stat(cli);
    if ((launcher.mode & 0o111) === 0) throw new Error('distribution tsir is not executable');
    if (await stat(join(distribution, 'node_modules')).catch(() => undefined)) {
      throw new Error('release archive includes installed dependencies');
    }
    await run([process.execPath, 'install', '--ignore-scripts'], distribution);
    await run([cli, '--help'], distribution);
    const unsafe = Bun.spawnSync([cli, 'new', 'should-not-create'], {
      cwd: distribution,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (
      unsafe.exitCode === 0 ||
      !unsafe.stderr.toString().includes('outside the generated distribution')
    ) {
      throw new Error('tsir new did not protect the generated distribution directory');
    }

    const example = join(distribution, 'apps', 'http');
    const exampleRoutes = await run([cli, 'route:list'], example);
    if (
      !exampleRoutes.includes('UsersController') ||
      !exampleRoutes.includes('UploadsController')
    ) {
      throw new Error(`distributed example module routes missing: ${exampleRoutes}`);
    }
    await run([cli, 'test'], example);

    await run([cli, 'new', 'hello'], root);
    await run([process.execPath, 'install', '--ignore-scripts'], app);
    const routes = await run([cli, 'route:list'], app);
    if (!routes.includes('HomeController.index'))
      throw new Error(`starter route missing: ${routes}`);
    await run([cli, 'test'], app);
    await run([process.execPath, 'add', '@tsir/queue@workspace:*', '--ignore-scripts'], app);
    await run([cli, 'make:controller', '--help'], app);
    await run([cli, 'make:module', 'shop'], app);
    await run([cli, 'make:controller', 'order', 'shop'], app);
    await run([cli, 'make:controller', 'user-settings', 'shop'], app);
    await run([cli, 'make:model', 'order', 'shop'], app);
    await run([cli, 'make:seeder', 'order', 'shop'], app);
    await run([cli, 'make:module', 'billing'], app);
    await run([cli, 'make:model', 'invoice', 'billing', '--dialect', 'postgres'], app);
    await run([cli, 'make:model', 'user-settings', 'shop', '--dialect', 'postgres'], app);
    await run(
      [process.execPath, 'add', 'drizzle-orm@0.45.4', '@tsir/seed@workspace:*', '--ignore-scripts'],
      app,
    );
    await run([process.execPath, 'add', '-d', 'drizzle-kit@0.31.11', '--ignore-scripts'], app);
    await run(
      [cli, 'make:migration', 'create-orders', 'shop', '--schema', 'shop/models/order.model.ts'],
      app,
    );
    const migration = await readFile(join(app, 'shop/migrations/0000_create-orders.sql'), 'utf8');
    if (!migration.includes('shop_order'))
      throw new Error('module migration did not contain the model table');
    await stat(join(app, 'shop/migrations/meta/_journal.json'));
    await stat(join(app, 'shop/migrations/meta/0000_snapshot.json'));
    await run([cli, 'make:migration', 'create-invoices', 'billing', '--dialect', 'postgres'], app);
    if (
      !(await readFile(join(app, 'billing/migrations/0000_create-invoices.sql'), 'utf8')).includes(
        'billing_invoice',
      )
    )
      throw new Error('Postgres migration did not contain the model table');
    const pgJournal = JSON.parse(
      await readFile(join(app, 'billing/migrations/meta/_journal.json'), 'utf8'),
    ) as { dialect: string };
    if (pgJournal.dialect !== 'postgresql')
      throw new Error('Postgres migration journal has the wrong dialect');
    for (const file of [
      'shop/index.ts',
      'shop/routes.ts',
      'shop/http/order.controller.ts',
      'shop/http/order.controller.test.ts',
      'shop/http/user-settings.controller.ts',
      'shop/models/user-settings.model.ts',
      'shop/models/order.model.ts',
      'shop/models/order.model.test.ts',
      'shop/seeders/order.seeder.ts',
      'shop/seeders/order.seeder.test.ts',
    ]) {
      await stat(join(app, file));
    }
    const beforeRegistration = await run([cli, 'route:list'], app);
    if (beforeRegistration.includes('OrderController'))
      throw new Error('unimported controller appeared in routes');
    const entry = join(app, 'app.ts');
    await writeFile(
      entry,
      (await readFile(entry, 'utf8'))
        .replace(
          "import './home/http/home.controller.ts';",
          "import './home/http/home.controller.ts';\nimport { shop } from './shop/index.ts';\nimport './shop/http/order.controller.ts';",
        )
        .replace('modules: [home.module]', 'modules: [home.module, shop.module]'),
    );
    const generatedRoutes = await run([cli, 'route:list'], app);
    if (!generatedRoutes.includes('OrderController.list'))
      throw new Error(`generated route missing: ${generatedRoutes}`);
    await run([cli, 'make:controller', 'invoices', 'shop', '--unit', 'billing'], app);
    await stat(join(app, 'shop', 'http', 'invoices.controller.ts'));
    await writeFile(
      entry,
      (await readFile(entry, 'utf8')).replace(
        "import './shop/http/order.controller.ts';",
        "import './shop/http/order.controller.ts';\nimport './shop/http/invoices.controller.ts';",
      ),
    );
    if (!(await run([cli, 'route:list'], app)).includes('InvoicesController.list')) {
      throw new Error('controller in existing module is missing from routes');
    }
    const routeDocument = JSON.parse(await run([cli, 'route:list', '--json'], app)) as {
      routes: { controller: string; unit: string }[];
    };
    if (
      routeDocument.routes.find((route) => route.controller === 'OrderController')?.unit !==
        'http' ||
      routeDocument.routes.find((route) => route.controller === 'InvoicesController')?.unit !==
        'billing'
    ) {
      throw new Error('module unit inheritance or explicit controller unit override failed');
    }

    const pending = Bun.spawnSync([cli, 'test'], { cwd: app, stdout: 'pipe', stderr: 'pipe' });
    if (
      pending.exitCode === 0 ||
      !pending.stderr.toString().includes('OrderController was generated')
    ) {
      throw new Error('the generated controller test was not intentionally failing');
    }
    for (const [file, className] of [
      ['order', 'OrderController'],
      ['user-settings', 'UserSettingsController'],
      ['invoices', 'InvoicesController'],
    ] as const) {
      await writeFile(
        join(app, 'shop', 'http', `${file}.controller.test.ts`),
        `import { expect, test } from 'bun:test';\nimport { ${className} } from './${file}.controller.ts';\ntest('returns data', () => expect(new ${className}().list()).toEqual({data: []}));\n`,
      );
    }
    for (const [file, symbol, table] of [
      ['order', 'order', 'shop_order'],
      ['user-settings', 'userSettings', 'shop_user_settings'],
    ] as const) {
      await writeFile(
        join(app, 'shop', 'models', `${file}.model.test.ts`),
        `import { expect, test } from 'bun:test';\nimport { getTableName } from 'drizzle-orm';\nimport { ${symbol} } from './${file}.model.ts';\ntest('schema table', () => expect(getTableName(${symbol})).toBe('${table}'));\n`,
      );
    }
    await writeFile(
      join(app, 'billing/models/invoice.model.test.ts'),
      `import { expect, test } from 'bun:test';\nimport { getTableName } from 'drizzle-orm';\nimport { invoice } from './invoice.model.ts';\ntest('billing table', () => expect(getTableName(invoice)).toBe('billing_invoice'));\n`,
    );
    await writeFile(
      join(app, 'shop/seeders/order.seeder.test.ts'),
      `import { expect, test } from 'bun:test';\nimport { OrderSeeder } from './order.seeder.ts';\ntest('seeder is registered by name', () => expect(OrderSeeder.name).toBe('OrderSeeder'));\n`,
    );
    await run([cli, 'test'], app);
    await run([cli, 'route:compile'], app);
    await run([cli, 'build'], app);

    for (const [cwd, command] of [
      [example, 'dev'],
      [app, 'dev'],
      [app, 'start'],
    ] as const) {
      const child = Bun.spawn([cli, command, '--port', '0', '--json'], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      try {
        const reader = child.stdout.getReader();
        let output = '';
        let url: string | undefined;
        const timeout = setTimeout(() => child.kill(), 15_000);
        try {
          while (url === undefined) {
            const chunk = await reader.read();
            if (chunk.done)
              throw new Error(
                `${command} exited before listening: ${output} ${await new Response(child.stderr).text()}`,
              );
            output += new TextDecoder().decode(chunk.value);
            url = /"url":\s*"([^"]+)"/.exec(output)?.[1];
          }
          if (cwd === example) {
            const response = await fetch(new URL('/api/users/42', url));
            const body = (await response.json()) as { id?: number };
            if (response.status !== 200 || body.id !== 42)
              throw new Error('distributed example returned an unexpected response');
          } else {
            const response = await fetch(url);
            const body = (await response.json()) as { message?: string };
            if (response.status !== 200 || body.message !== 'Welcome to Tsir')
              throw new Error(`${command} returned unexpected response`);
            const orders = await fetch(new URL('/api/order', url));
            if (orders.status !== 200)
              throw new Error(`${command}: generated route returned ${orders.status}`);
            const invoices = await fetch(new URL('/api/invoices', url));
            if (invoices.status !== 200)
              throw new Error(`${command}: existing-module route returned ${invoices.status}`);
          }
        } finally {
          clearTimeout(timeout);
          reader.releaseLock();
        }
      } finally {
        child.kill('SIGTERM');
        if ((await child.exited) !== 0) throw new Error(`${command} did not shut down cleanly`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
