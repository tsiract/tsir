# Controllers and HTTP routes

Controllers group related HTTP actions in plain classes. Every controller belongs to a module and
registers routes with that module's registry. Start with [installation](../installation.md) and
run the commands below from the root of an application created by `tsir new`.

## Create a module and controller

```sh
tsir make:module shop
tsir make:controller order shop
tsir make:controller user-settings shop
```

The first positional argument is the resource; the second is the existing owning module. The
commands create this structure:

```text
shop/
├── index.ts                              # exports shop (public surface)
├── routes.ts                             # module registry and deploy unit
├── shop.test.ts                          # starter module test
└── http/
    ├── shop.controller.ts                # starter ShopController, GET /shop if imported
    ├── order.controller.ts               # OrderController, GET /api/order
    ├── order.controller.test.ts          # intentionally fails until replaced
    ├── user-settings.controller.ts       # UserSettingsController, GET /api/user-settings
    └── user-settings.controller.test.ts  # intentionally fails until replaced
```

Names are normalized to kebab-case files and PascalCase classes. `shop` must already exist; the
controller command will not infer or create a module. `make:module` also creates a starter
controller, so avoid generating another with the module's name unless you deliberately use `--force`.
Generating files does **not** edit `app.ts`. Import the starter `http/shop.controller.ts` too if
you want its `/shop` route.

## Why you register controllers explicitly

Tsir does **not** scan your filesystem for controllers. There is no auto-discovery, no glob
import, and no convention-based auto-loader. You import each controller in `app.ts` yourself.

This is deliberate: **the route table is a contract, not a side effect of which files happen to exist**.
The imports that run at startup determine exactly which routes register. When you restart the server, the same set of routes always
registers, in the same order, regardless of which files were created or renamed. There is no "my route vanished" because a file was moved or a glob pattern didn't match.

A side-effect import (`import './shop/http/order.controller.ts'`) is what runs the
`@Controller` decorator, which appends the controller's routes to the module's registry.
Without that import, the decorator never runs and the routes are not registered.

## Register the module and controller

For a fresh starter, update `app.ts` to import the module's public index and each controller,
then add the module definition to `defineApp`:

```ts
import { defineApp } from '@tsir/core';
import { createFetchHandler } from '@tsir/http';
import { collectRouteEntries, compileRoutes } from '@tsir/router';
import { spec } from './config.ts';
import { home } from './home/index.ts';
import './home/http/home.controller.ts';
import { shop } from './shop/index.ts';
import './shop/http/order.controller.ts';
import './shop/http/user-settings.controller.ts';

export default defineApp({
  name: 'hello', // use the name supplied to tsir new
  config: spec,
  modules: [home.module, shop.module],
});

export const handler = createFetchHandler(compileRoutes(collectRouteEntries()));
```

Two things happen at startup:

1. The side-effect imports run the `@Controller` decorators, which register routes into each module's
   registry. Skip an import and that controller's routes simply won't exist.
2. `modules: [...]` lists the modules this application is built from, and with them the lifecycle
   hooks each one runs. A module left out of that list contributes no routes, jobs, or schedules.

Both are necessary; the generators do not edit `app.ts` for you. Restart the server after edits:

```sh
tsir route:list
tsir dev
# In a second terminal:
curl http://127.0.0.1:3000/api/order
```

`route:list` should include `GET /api/order` owned by `OrderController.list`; the generated action
returns `{"data":[]}`. `tsir dev` does not watch files. `tsir route:compile` generates a route table,
but the starter still compiles its imported controllers at startup unless you change its handler.

## Replace the generated test

`order.controller.test.ts` fails on purpose so an unfinished skeleton is not mistaken for completed
behavior. Replace it with an assertion, for example:

```ts
import { expect, test } from 'bun:test';
import { OrderController } from './order.controller.ts';

test('lists orders', () => {
  expect(new OrderController().list()).toEqual({ data: [] });
});
```

Replace the other pending tests too, then run `tsir test`. Replace placeholder actions and tests
with your real behavior before relying on them.

## Options and existing modules

The `home` module already exists in a fresh app:

```sh
tsir make:controller about home --path /about
```

Add `import './home/http/about.controller.ts';` to `app.ts`, replace its failing test, and
restart `tsir dev`. You do not need to register `home` twice. A target module must have `index.ts`
and `routes.ts`, and the latter must export `registry`. `--path /prefix` changes the route prefix.
Routes inherit the module's deploy unit; `--unit billing` overrides it for a controller. `--dry-run`
shows planned paths and `--force` overwrites only the controller and its test. Incomplete modules
are refused. For compatibility, `--module shop` is accepted instead of the positional module, but
not alongside it. Run `tsir make:controller --help` for flags.

Older builds could infer and create a module or put controllers directly under the module root.
The current command requires a module and writes controllers to `<module>/http/`. It does not move
old files; move them deliberately, update imports and verify routes and tests before deleting old
copies.

## Other module-owned files

```sh
tsir make:model order shop
tsir make:service order shop
tsir make:middleware audit shop
tsir make:guard auth shop
tsir make:job send-receipt shop
tsir make:event order-placed shop
tsir make:listener send-receipt shop --event order-placed
tsir make:policy order update shop
tsir make:seeder order shop
tsir make:migration create-orders shop
tsir make:link-client billing shop
```

These write within the named module; migrations live in its `migrations/` journal. A module-local listener looks for its event in the
same module. Policy has both a resource and an action before the module. Existing one-argument
service, middleware, guard, job, event, seeder and client commands remain project-wide for
compatibility; a policy without a module is project-wide too. These skeletons still require
explicit registration where applicable. The [model guide](./database.md) covers schema dialects, and the [migration and seeder runbook](../migrations.md) explains generation and execution.

## Declare and exercise a controller

This complete example creates an isolated registry, declares two routes, and calls the handler
with a web-standard `Request`. It requires no server. Save it in your application and run it
with `bun run <file>.ts`.

```ts verify
import { Controller, Get, Post, RouteRegistry, compileRoutes } from '@tsir/router';
import { createFetchHandler } from '@tsir/http';
import { z } from '@tsir/validate';
import { IntParam } from '@tsir/validate/http';

const registry = new RouteRegistry();
export const UserId = z.object({ id: IntParam });
export const CreateUser = z.object({ name: z.string().min(1) });

@Controller(registry, '/api/users')
class UsersController {
  @Get('/:id', { params: UserId })
  find({ params }: { params: { id: number } }) {
    return { id: params.id };
  }

  @Post('/', { body: CreateUser, status: 201 })
  create({ body }: { body: z.infer<typeof CreateUser> }) {
    return { id: 1, name: body.name };
  }
}
void UsersController; // the decorator registers it

const handler = createFetchHandler(compileRoutes(registry.entries()));
const response = await handler(new Request('https://example.test/api/users/42'));
if (response.status !== 200) throw new Error('Unexpected HTTP status');
console.log(await response.json()); // { id: 42 }
```

Decorators use the standard ECMAScript model: there are no parameter decorators. Validation is
explicit in route metadata and the method receives one context object. Invalid inputs produce
validation problems; returning a plain object serializes it as JSON. Do not trust client-provided
identity: configure a guard and bind `principal` where authentication is required.

Constructor dependencies need explicit container providers; registration, request scope, guards,
policies, and response validation are described in the package references. This isolated example is
in-memory; connect a repository before treating its POST as a persistent write.
