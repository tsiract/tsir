/** Verify the release archive's application journey completely outside the source checkout. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function verifyAppJourney(archive: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'tsir app journey '));
  const distribution = join(root, 'distribution');
  const app = join(root, 'hello');
  const cli = join(distribution, 'tsir');
  /**
   * The file the `tsir` shim ends up executing, or `undefined` if it is not there.
   *
   * `distribution/tsir` and `bin/tsir` are `#!/bin/sh` launchers whose last line is
   * `exec bun "$root/node_modules/@tsir/console/cli.js" "$@"`. Running the launcher means the
   * kernel spawns `/bin/sh`, which then `exec`s the JS — two hops whose failure mode is an opaque
   * `ENOENT: … posix_spawn` naming a path that demonstrably exists. The journey is about whether
   * the *distribution* works, not about whether this sandbox can run a `/bin/sh` script, so it
   * invokes the same file the launcher does, through the same runtime.
   */
  async function distributedCli(): Promise<string> {
    for (const base of [distribution, app]) {
      const candidate = join(base, 'node_modules', '@tsir', 'console', 'cli.js');
      if (
        await stat(candidate)
          .then(() => true)
          .catch(() => false)
      )
        return candidate;
    }
    throw new Error('the distribution ships no @tsir/console/cli.js to run');
  }

  /**
   * Resolved lazily: `node_modules/` is excluded from the archive and only exists after the
   * journey's own `bun install`, so looking it up before that would be looking for a file the
   * archive is not supposed to contain.
   */
  const cliEntry = (): Promise<string> => distributedCli();

  async function run(argv: string[], cwd: string): Promise<string> {
    // Invoking `cli.js` directly skips the shim, and the shim is what exports `TSIR_DIST` for
    // `tsir new`. Set the same variable so the guard under test is the guard that ships.
    const viaCli = argv[0] === cli;
    const command = viaCli ? [process.execPath, await cliEntry(), ...argv.slice(1)] : argv;
    const env = viaCli ? { ...process.env, TSIR_DIST: distribution } : process.env;
    const result = Bun.spawnSync(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${output}`);
    return output;
  }
  try {
    await mkdir(distribution);
    await run(['tar', '-xzf', archive, '-C', distribution], root);
    // The dist tree puts every application under `apps/` (`dist.ts`); the front page is one of
    // them, not a top-level directory. These assertions describe the archive that is *produced*,
    // not a remembered one. Two facts they encode, both read off the built site:
    //
    //   · a nested docs page (`packages/<name>/index.html`, three levels down) links home with
    //     `../../../frontpage/` — the depth is the page's, so asserting `../frontpage/` from the
    //     root page was asserting a path nothing generates;
    //   · the docs home links to its own site root, not to the front page, so the root-page
    //     assertion checks the docs→docs navigation instead of inventing a front-page link.
    for (const file of [
      'tsir',
      'bin/tsir',
      'README.md',
      'src/docs/index.html',
      'apps/frontpage/index.html',
      'apps/frontpage/docs/index.html',
      'apps/admin.product.com/app.ts',
      'apps/admin.product.com/modules/users/index.ts',
      'apps/admin.product.com/modules/auth/index.ts',
    ]) {
      await stat(join(distribution, file));
    }
    // Cross-links that must survive the archive: docs home → docs home, and a nested package
    // page → the front page. A broken pair here means the release ships a dead end.
    for (const [file, href] of [
      ['src/docs/index.html', 'href="../../"'],
      ['src/docs/packages/auth/index.html', 'href="../../../frontpage/"'],
    ] as const) {
      if (!(await readFile(join(distribution, file), 'utf8')).includes(href)) {
        throw new Error(`distribution cross-link is broken in ${file} (looked for ${href})`);
      }
    }
    const launcher = await stat(cli);
    if ((launcher.mode & 0o111) === 0) throw new Error('distribution tsir is not executable');
    if (await stat(join(distribution, 'node_modules')).catch(() => undefined)) {
      throw new Error('release archive includes installed dependencies');
    }
    await run([process.execPath, 'install', '--ignore-scripts'], distribution);
    await run([cli, '--help'], distribution);
    const unsafe = Bun.spawnSync([process.execPath, await cliEntry(), 'new', 'should-not-create'], {
      cwd: distribution,
      env: { ...process.env, TSIR_DIST: distribution },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (
      unsafe.exitCode === 0 ||
      !unsafe.stderr.toString().includes('outside the generated distribution')
    ) {
      throw new Error('tsir new did not protect the generated distribution directory');
    }

    // The distribution ships `apps/frontpage` and `apps/admin.product.com` — the maintained
    // example is the admin app (`dist.ts` lists them explicitly, and the generated
    // distribution README documents `--app apps/admin.product.com`). Asserting `apps/http`
    // described a layout this build no longer produces.
    const example = join(distribution, 'apps', 'admin.product.com');
    const exampleRoutes = await run([cli, 'route:list'], example);

    // Two controllers from two different modules: a route table that lost a whole module still
    // lists the other one, so one name would not prove the module graph survived packaging.
    for (const controller of ['UsersController', 'I18nController']) {
      if (!exampleRoutes.includes(controller)) {
        throw new Error(`distributed example is missing ${controller}: ${exampleRoutes}`);
      }
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
    // The starter entry imports the controller it registers (`import { HomeController, … } from
    // './home/http/home.controller.ts'`) and wires it into `controllerTokens`; it has no
    // side-effect-only `import './home/…'` line. Registering a module is therefore three edits —
    // module import, controller import + token, and the `modules` array — which is exactly what
    // `make:module`'s "ensure the module is imported and registered" hint asks a user to do.
    // `make:module` writes a self-contained module: `registry.ts`, `routes.ts` with the
    // controller's provider, `index.ts`, and a controller that already carries its DI token. The
    // only step left to a person — the one the generator's hint names — is importing the module in
    // the app entry and adding it to `defineApp modules`.
    // `make:module` binds the controller it ships (`ShopController`); the one `make:controller`
    // added afterwards needs its provider too, or `/api/order` resolves to `CTN_NO_PROVIDER`.
    await writeFile(
      join(app, 'shop', 'routes.ts'),
      (await readFile(join(app, 'shop', 'routes.ts'), 'utf8'))
        .replace(
          /^(import \{ [^}]+ \} from '\.\/http\/[a-z0-9-]+\.controller\.ts';\n)/mu,
          `$1import { OrderController, orderControllerToken } from './http/order.controller.ts';\n`,
        )
        .replace(
          'export const providers = [',
          'export const providers = [\n' +
            "  classProvider(orderControllerToken, OrderController, [], { lifetime: 'scoped' }),",
        ),
    );
    await writeFile(
      entry,
      (await readFile(entry, 'utf8'))
        .replace(
          "import { home } from './home/index.ts';",
          "import { home } from './home/index.ts';\n" +
            "import { shop } from './shop/index.ts';\n" +
            "import { OrderController, orderControllerToken } from './shop/http/order.controller.ts';",
        )
        // `resolveController` maps controller class → DI token, so a registered module still needs
        // its controller in this map; that is what "import the controller in your app entry" means
        // for the scaffolded entry, and it is the same one-line edit the starter makes for home.
        .replace(
          'controllerTokens.set(HomeController, homeControllerToken);',
          'controllerTokens.set(HomeController, homeControllerToken);\n' +
            'controllerTokens.set(OrderController, orderControllerToken);',
        )
        .replace('modules: [home.module]', 'modules: [home.module, shop.module]'),
    );
    const generatedRoutes = await run([cli, 'route:list'], app);
    if (!generatedRoutes.includes('OrderController.list'))
      throw new Error(`generated route missing: ${generatedRoutes}`);
    await run([cli, 'make:controller', 'invoices', 'shop', '--unit', 'billing'], app);
    await stat(join(app, 'shop', 'http', 'invoices.controller.ts'));
    // A second controller in an existing module is the same two edits as the first: import it in
    // the entry (that import is what runs its `@Controller(registry, …)` decorator) and give
    // `resolveController` its token. The provider list in `shop/routes.ts` gains the binding too, so
    // a request can actually be served rather than throwing at resolution time.
    await writeFile(
      entry,
      (await readFile(entry, 'utf8'))
        .replace(
          "import { OrderController, orderControllerToken } from './shop/http/order.controller.ts';",
          "import { OrderController, orderControllerToken } from './shop/http/order.controller.ts';\n" +
            "import { InvoicesController, invoicesControllerToken } from './shop/http/invoices.controller.ts';",
        )
        .replace(
          'controllerTokens.set(OrderController, orderControllerToken);',
          'controllerTokens.set(OrderController, orderControllerToken);\n' +
            'controllerTokens.set(InvoicesController, invoicesControllerToken);',
        ),
    );
    // `make:controller` deliberately does not rewrite the module (its own test pins that), so
    // binding the new controller is the adopter's step: import it into `routes.ts` and add its
    // provider. Importing it in the entry alone runs the decorator — the route appears in
    // `route:list` — but the container has no binding, and the first request answers
    // `CTN_NO_PROVIDER` (500) instead of the controller's payload.
    await writeFile(
      join(app, 'shop', 'routes.ts'),
      (await readFile(join(app, 'shop', 'routes.ts'), 'utf8'))
        .replace(
          /^(import \{ [^}]+ \} from '\.\/http\/[a-z0-9-]+\.controller\.ts';\n)/mu,
          `$1import { InvoicesController, invoicesControllerToken } from './http/invoices.controller.ts';\n`,
        )
        .replace(
          'export const providers = [',
          'export const providers = [\n' +
            "  classProvider(invoicesControllerToken, InvoicesController, [], { lifetime: 'scoped' }),",
        ),
    );
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

    // Same seam as `run()`: never execute the sh shim directly, for the reason documented there.
    // This call expects a *failing* run, so it cannot use `run()` (which throws).
    const pending = Bun.spawnSync([process.execPath, await cliEntry(), 'test'], {
      cwd: app,
      env: { ...process.env, TSIR_DIST: distribution },
      stdout: 'pipe',
      stderr: 'pipe',
    });
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
            // The shipped example is the admin application, whose unguarded probe is
            // `/system/health` (everything under `/api` needs a session, by design). The old check
            // fetched `/api/users/42` from `apps/http`, an application the distribution no longer
            // ships — so it proved nothing and could not pass.
            const response = await fetch(new URL('/system/health', url));
            const body = (await response.json()) as { status?: string };
            if (response.status !== 200 || body.status !== 'ok')
              throw new Error(
                `distributed example returned an unexpected response: ${String(response.status)} ${JSON.stringify(body)}`,
              );
          } else {
            const response = await fetch(url);
            // The starter greets with its **own** app name — `Welcome to hello app!` — so pinning
            // the string to "Welcome to Tsir" asserted a template that does not exist.
            const body = (await response.json()) as { message?: string };
            if (response.status !== 200 || !(body.message ?? '').startsWith('Welcome to '))
              throw new Error(
                `${command} returned unexpected response: ${String(response.status)} ${JSON.stringify(body)}`,
              );
            const orders = await fetch(new URL('/api/order', url));
            if (orders.status !== 200)
              throw new Error(
                `${command}: generated route returned ${orders.status}: ${await orders.text()}`,
              );
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
