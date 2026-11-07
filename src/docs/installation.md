# Installation

Tsir is a pre-alpha TypeScript backend framework. This guide takes you from the distributed
`tsir` command to a running HTTP application. The packages are **not published to npm yet**;
use a matching Tsir distribution rather than a registry install.

## Prerequisites

You need Bun 1.2 or newer, a POSIX shell, and `tar` on macOS or Linux. Installing dependencies
also requires access to the npm registry for third-party packages. Windows has not yet been
verified for this distribution launcher.

## Install the Tsir command

Obtain the `tsir-<version>-dist.tar.gz` archive from a project release if one is available.
Extract it into a stable directory and install its dependencies (replace the archive path):

```sh
mkdir -p "$HOME/tsir-dist"
tar -xzf /path/to/tsir-0.0.0-dist.tar.gz -C "$HOME/tsir-dist"
cd "$HOME/tsir-dist"
bun install --ignore-scripts
export PATH="$HOME/tsir-dist/bin:$PATH"
tsir --help
```

Run `tsir --help` to explore the available commands. Add the `export PATH=...` line to your shell
profile if you want it in future terminals. Keep the distribution directory in place: generated
applications refer to its framework packages as a Bun workspace, so it must remain writable and
installed. If you move it, update the `workspaces` path in your app's `package.json` and run
`bun install` again. Treat the archive and packages as trusted code. `--ignore-scripts` avoids
running dependency install scripts; some optional integrations may need their own setup.

If a release archive is not available, a framework contributor can build `dist/` from a checkout
using the [contributor build guide](./guides/make.md). A fresh `make dist` installs its dependencies,
so `./dist/tsir --help` works immediately. Use that `dist/` in place of `$HOME/tsir-dist`.
Application developers do not need the repository Makefile.

## What the distribution contains

When built from a checkout, the output lives at `<checkout>/dist/`. If you extracted an archive
using the commands above, it lives at `$HOME/tsir-dist/` instead. The layout is:

```text
dist/                              # or $HOME/tsir-dist/ after extraction
├── tsir                           # run directly: ./tsir --help
├── bin/tsir                       # add this directory to PATH for `tsir`
├── apps/
│   ├── admin.product.com/         # bundled admin application (RBAC, i18n, mail)
│   │   ├── tsir.js
│   │   ├── app.ts                 # app, module imports, and fetch handler
│   │   ├── config/                # split configuration (app, database, deploy, …)
│   │   ├── modules/               # auth, users, rbac, i18n, mail, setup
│   │   └── migrations/            # D1 / SQLite schema migrations
│   └── frontpage/                 # static marketing site
├── framework/                     # compiled @tsir/* framework packages
├── package.json  bun.lock         # distribution workspace and lockfile
├── manifest.json                  # package build information
└── README.md  LICENSE
```

`node_modules/` is installed by `make dist` or by `bun install` after extraction; it is not in the
release archive. The apps under `apps/` are runnable examples, **not your application**. Framework
packages in `framework/` are different from application modules such as `users/`.

To explore the bundled admin app from the checkout:

```sh
cd dist/apps/admin.product.com
../../tsir route:list
../../tsir test
../../tsir dev
```

The build replaces `dist/` on each run. Do not keep changes there: `tsir new` refuses to create
apps inside the distribution. Create your own project outside it.

## Create an application

In a directory **outside** the distribution, create and install an application:

```sh
cd "$HOME"
tsir new hello
cd hello
bun install --ignore-scripts
tsir dev
```

`tsir dev` boots the app and serves the exported fetch handler at `http://127.0.0.1:3000`. Visit that address to see `{"message":"Welcome to Tsir"}`.
Stop it with Ctrl+C. Change the bind address or port with `tsir dev --host 127.0.0.1 --port 3001`;
use `--host 0.0.0.0` only when you intend to expose the server to your network. There is no
built-in file watcher: restart the command after changing code.

## Your application structure

A new `hello` application is a **separate directory** at the location where you ran
`tsir new hello`, for example `$HOME/hello/`:

```text
hello/
├── tsir.js                        # CLI project configuration and app entry
├── package.json  bun.lock         # app dependencies and lockfile after install
├── .env.example  .gitignore
├── ract                           # optional project command runner
├── app.ts                         # imports and registers modules; exports handler
├── config.ts                      # typed environment variables
├── home/                          # a module
│   ├── index.ts                   # module public surface
│   ├── routes.ts                  # module-owned registry and module definition
│   └── http/
│       └── home.controller.ts
└── test/app.test.ts
```

## How Tsir boots your app

Tsir does **not** scan your filesystem for controllers, jobs, or listeners. There is no
auto-discovery, no glob import, and no convention-based loader. Instead, `app.ts` is your
**composition root**: the single file where you import everything that should run.

The file is the contract: a controller's routes only exist because you imported its file, and a
module only runs because you listed it in `defineApp`. Skip the import and the route simply won't
exist — there is no "my route vanished" because a file was moved or a glob didn't match.

When you run `tsir dev` or `tsir start`, two things happen in order:

1. **Side-effect imports run decorators.** A line like
   `import './shop/http/order.controller.ts';` executes the `@Controller` decorator, which
   appends that controller's routes to its module's registry. Skip the import and the routes
   simply won't exist — there is no "my route vanished" because a file was moved or a glob
   didn't match.
2. **`modules: [...]` registers lifecycle.** `defineApp({ modules: [...] })` tells Tsir which
   modules make up this app. Skip a module and its routes, jobs, schedules, and listeners
   won't run.

Both are necessary. The generators create files but do **not** edit `app.ts`, so you always
control exactly what boots. `tsir route:list` shows the routes that actually registered; if a
route is missing, its import was skipped.

An application without an exported `handler` boots its lifecycle but does not listen for HTTP.
`tsir build` writes a manifest, and `tsir start` boots with it in production mode and serves the
handler; this is not a standalone bundled binary.

## Your first controller

From the application directory, run:

```sh
tsir make:module shop
tsir make:controller order shop
tsir make:model order shop
```

The commands create `shop/http/order.controller.ts` and `shop/models/order.model.ts` in the
explicitly named module. The module generator also creates a starter controller. Neither generator
edits `app.ts`, creates a database connection, or applies migrations. Generated controller and model
tests fail until replaced. Follow [the controller guide](./guides/controllers.md) for the complete
file tree and registration, and [models and queries](./guides/database.md) for Drizzle setup.
Run `tsir route:list` to inspect registered routes.

## Configuration and next steps

Edit `config.ts` to declare environment variables; `.env` is ignored by the starter. Read
[configuration and secrets](./guides/configuration.md) before adding credentials. Continue with
[controllers](./guides/controllers.md), [models and queries](./guides/database.md),
[queues](./guides/queues.md), [caching](./guides/caching.md), or the
[Cloudflare-to-AWS guide](./guides/providers.md). The [package references](./packages/core.md)
document API details and limitations.

`tsir --help` lists commands. `tsir test` runs Bun's test runner; `tsir lint` and
`tsir typecheck` run the corresponding scripts **if you add them** to your application's
`package.json`—the starter does not configure those tools for you. `ract` is an optional
project command runner; `tsir` is the primary entry point.
