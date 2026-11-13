/**
 * Generators.
 *
 * Rules:
 *   · generated code compiles under the strictest config with no suppressions,
 *   · no facades, no hidden dependencies, no `any`,
 *   · never overwrite an existing file without `--force`,
 *   · print the next command to run.
 *
 * Code templates live in `stubs/` as `.slug` files (e.g. `stubs/new/app.ts.slug`).
 * `renderStub()` reads the file and substitutes `{{variable}}` placeholders.
 * Keep the generator logic here and the template content in the slugs —
 * editing a generated file's shape should mean editing its `.slug`, not this
 * module.
 */

import { chmodSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { boolFlag, parseArgs, stringFlag, type ParsedArgs } from '../args.ts';
import { commitWrites, displayPath, type GeneratedFile, type PlannedWrite } from '../generator.ts';
import { CliError, EXIT, info, ok, style, UsageError, warn } from '../output.ts';
import { findConfigFile } from '../project.ts';
import { renderStub } from '../stub.ts';
import { driverDefaultFor, type DefaultedCapability, type DeployTarget } from '@tsir/core';
import { canPrompt, openSession, text as promptText } from '@tsir/tui/ui';
import { RACT_MODE, RACT_TEMPLATE } from './project-command.ts';
import { scopedName, splitAppModule } from './naming.ts';

/**
 * Asks for the application name, validating as it is typed.
 *
 * The same rule the flag path enforces (`^[a-z][a-z0-9-]*$`), asked in the place where a mistake is
 * cheapest to fix: before the directory exists. The hint names why the rule exists — the name
 * becomes a directory, a package name and the app name in `config/app.ts`, so it has to be usable as
 * all three.
 */
async function askForName(): Promise<string> {
  const session = await openSession({ preserveOutput: true });
  try {
    const answer = await promptText(session.renderer, {
      message: 'Application name',
      hint: 'Lowercase kebab-case. It becomes apps/<name>/, the package name and the app name.',
      placeholder: 'billing-api',
      validate: (value) =>
        /^[a-z][a-z0-9-]*$/.test(value)
          ? undefined
          : 'use lowercase letters, digits and dashes, starting with a letter',
    });
    session.close();
    return answer;
  } catch (error: unknown) {
    session.close();
    throw error;
  }
}

/**
 * Every `config/<section>.ts` the starter writes for `target`.
 *
 * One per capability whose driver can be named in `tsir.js` — which is now all but `sessions`,
 * `api keys`, `feature flags` and the lock. The four are absent because they have no section: a
 * generated block nothing reads would be worse than no block, because it looks configured.
 */
function configFiles(target: DeployTarget): {
  readonly files: (readonly [string, string])[];
  readonly env: readonly EnvEntry[];
} {
  const files: (readonly [string, string])[] = [];
  const env: EnvEntry[] = [];
  for (const capability of CONFIG_CAPABILITIES) {
    const section = CAPABILITY_SECTIONS[capability];
    if (section === undefined) continue;
    const generated = configFor(target, capability);
    if (generated === undefined) continue;
    files.push([`config/${section}.ts`, generated.body]);
    for (const variable of generated.env) {
      if (!env.some(([name]) => name === variable[0])) env.push(variable);
    }
  }
  return { files, env };
}

/** The capabilities the starter writes a section for, in the order a person reads them. */
const CONFIG_CAPABILITIES: readonly DefaultedCapability[] = [
  'database',
  'cache',
  'queue',
  'storage',
  'mail',
  'notifications',
  'featureFlags',
  'broadcast',
  'search',
  'media',
];

/** The deploy target `tsir new` scaffolds for. `cloudflare` is the default, not a guess. */
function targetOf(args: ParsedArgs): DeployTarget {
  const raw = stringFlag(args, '--target');
  if (raw === undefined) return 'cloudflare';
  if (raw === 'cloudflare' || raw === 'lambda' || raw === 'bun') return raw;
  throw new UsageError(
    `--target ${String(raw)} is not a deploy target`,
    'use cloudflare, lambda or bun',
  );
}

/**
 * The section a capability's defaults live under, and the key its entries use.
 *
 * `notifications` is `notify` in `tsir.js`, and `sessions` has no section yet — the two places the
 * table's vocabulary and the project file's disagree. Written out rather than derived, because a
 * derived name that is wrong writes a config the loader refuses.
 */
const CAPABILITY_SECTIONS: Readonly<Record<DefaultedCapability, string | undefined>> = {
  cache: 'cache',
  queue: 'queue',
  storage: 'storage',
  mail: 'mail',
  database: 'database',
  sessions: undefined,
  broadcast: 'broadcast',
  search: 'search',
  media: 'media',
  notifications: 'notify',
  featureFlags: 'featureFlags',
};

/** The registry key each section holds its entries under. */
const ENTRY_KEYS: Readonly<Record<string, string>> = {
  cache: 'stores',
  queue: 'connections',
  storage: 'disks',
  mail: 'mailers',
  database: 'connections',
  broadcast: 'connections',
  search: 'engines',
  media: 'adapters',
  notify: 'channels',
  featureFlags: 'stores',
};

/**
 * The value each driver needs, as config writes it — with secrets as `{ fromEnv }`.
 *
 * A scaffold that writes `resend` with no key produces an app that refuses to boot with "the
 * `resend` driver needs an `apiKey`". That is the right refusal and terrible first contact: the
 * person just asked for an app to exist. So the key is written as a *reference* and the variable
 * it names is added to `.env.example`, which turns the refusal into a checklist.
 *
 * Where a value cannot be an env reference (`typesense`'s `host` is a plain string), the entry gets
 * a placeholder naming the variable, because a wrong-but-labelled URL is easier to fix than a boot
 * error that does not say which key is absent.
 */
type EnvEntry = readonly [string, string];

const REQUIRED_VALUES: Readonly<
  Record<string, (driver: string) => { fields: string; env: readonly EnvEntry[] }>
> = {
  cache: (driver) => ({
    fields: driver === 'redis' ? ", connection: 'default'" : '',
    env: driver === 'redis' ? [['REDIS_URL', 'the Redis connection string'] as EnvEntry] : [],
  }),
  queue: (driver) => ({
    fields:
      driver === 'sqs'
        ? ", queueUrl: 'QUEUE_URL', outbox: true"
        : driver === 'cloudflare-queues'
          ? ', outbox: true'
          : '',
    env: driver === 'sqs' ? [['QUEUE_URL', 'the SQS queue URL'] as EnvEntry] : [],
  }),
  storage: (driver) => ({
    fields:
      driver === 's3'
        ? ", bucket: 'BUCKET', credentials: { accessKeyId: { fromEnv: 'S3_ACCESS_KEY_ID' }, secretAccessKey: { fromEnv: 'S3_SECRET_ACCESS_KEY' } }"
        : '',
    env:
      driver === 's3'
        ? [
            ['BUCKET', 'the S3 bucket name'],
            ['S3_ACCESS_KEY_ID', 'the AWS access key'],
            ['S3_SECRET_ACCESS_KEY', 'the AWS secret key'],
          ]
        : [],
  }),
  mail: (driver) => ({
    fields:
      driver === 'resend'
        ? ", apiKey: { fromEnv: 'RESEND_API_KEY' }"
        : driver === 'postmark'
          ? ", apiKey: { fromEnv: 'POSTMARK_TOKEN' }"
          : driver === 'sendgrid'
            ? ", apiKey: { fromEnv: 'SENDGRID_API_KEY' }"
            : driver === 'ses'
              ? ", credentials: { accessKeyId: { fromEnv: 'SES_ACCESS_KEY_ID' }, secretAccessKey: { fromEnv: 'SES_SECRET_ACCESS_KEY' } }"
              : '',
    env:
      driver === 'resend'
        ? [['RESEND_API_KEY', 'the Resend API key']]
        : driver === 'postmark'
          ? [['POSTMARK_TOKEN', 'the Postmark server token']]
          : driver === 'sendgrid'
            ? [['SENDGRID_API_KEY', 'the SendGrid API key']]
            : driver === 'ses'
              ? [
                  ['SES_ACCESS_KEY_ID', 'the AWS access key'],
                  ['SES_SECRET_ACCESS_KEY', 'the AWS secret key'],
                ]
              : [],
  }),
  notifications: (driver) => ({
    fields:
      driver === 'mail'
        ? ", mailer: 'main'"
        : ", connection: 'default', table: 'notification_inbox'",
    env: [],
  }),
  broadcast: (driver) => ({
    fields: driver === 'redis' || driver === 'durable-object' ? ", connection: 'default'" : '',
    env: [],
  }),
  search: (driver) => ({
    fields:
      driver === 'typesense'
        ? ", host: 'https://replace-me.a1.typesense.net', collection: 'main', apiKey: { fromEnv: 'TYPESENSE_API_KEY' }"
        : driver === 'meilisearch'
          ? ", host: 'https://replace-me.meilisearch.io', collection: 'main', apiKey: { fromEnv: 'MEILISEARCH_API_KEY' }"
          : driver === 'algolia'
            ? ", host: 'https://replace-me-dsn.algolia.net', collection: 'main', apiKey: { fromEnv: 'ALGOLIA_API_KEY' }"
            : ", connection: 'main', collection: 'main'",
    env:
      driver === 'typesense'
        ? [['TYPESENSE_API_KEY', 'the Typesense write key']]
        : driver === 'meilisearch'
          ? [['MEILISEARCH_API_KEY', 'the Meilisearch admin key']]
          : driver === 'algolia'
            ? [['ALGOLIA_API_KEY', 'the Algolia write key']]
            : [],
  }),
  media: (driver) => ({
    fields:
      driver === 'cloudflare'
        ? ", accountId: 'ACCOUNT_ID', apiToken: { fromEnv: 'CF_IMAGES_TOKEN' }"
        : driver === 'cloudinary'
          ? ", cloudName: 'CLOUD_NAME', uploadPreset: 'unsigned_default'"
          : driver === 'imagekit'
            ? ", publicKey: 'PUBLIC_KEY', privateKey: { fromEnv: 'IMAGEKIT_PRIVATE_KEY' }, urlEndpoint: 'https://ik.imagekit.io/replace-me'"
            : '',
    env:
      driver === 'cloudflare'
        ? [
            ['ACCOUNT_ID', 'the Cloudflare account id'],
            ['CF_IMAGES_TOKEN', 'the Images API token'],
          ]
        : driver === 'imagekit'
          ? [['IMAGEKIT_PRIVATE_KEY', 'the ImageKit private key']]
          : [],
  }),
  database: (driver) => ({
    fields: '',
    env: driver === 'postgres' ? [['DATABASE_URL', 'the Postgres connection URL']] : [],
  }),
  featureFlags: () => ({ fields: '', env: [] }),
  sessions: () => ({ fields: '', env: [] }),
};

/**
 * A minimal, schema-valid entry for one driver, plus the variables it references.
 *
 * Minimal on purpose: the starter's job is to boot and to be honest about which driver it picked,
 * not to pre-fill values the project has to invent.
 */
function entryFor(
  capability: DefaultedCapability,
  driver: string,
): { readonly entry: string; readonly env: readonly (readonly [string, string])[] } {
  if (capability === 'database') {
    return {
      entry:
        driver === 'd1'
          ? "{ driver: 'd1', binding: 'DB', journal: false }"
          : "{ driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } }",
      env: driver === 'd1' ? [] : [['DATABASE_URL', 'the Postgres connection URL']],
    };
  }
  if (capability === 'sessions') return { entry: `{ driver: '${driver}' }`, env: [] };
  const extra = REQUIRED_VALUES[capability];
  const fields = extra === undefined ? { fields: '', env: [] } : extra(driver);
  return {
    entry: `{ driver: '${driver}'${fields.fields} }`,
    env: fields.env,
  };
}

/**
 * The `config/<capability>.ts` a fresh app starts with, for one target (`CAP-008`).
 *
 * Generated from `DRIVER_DEFAULTS` rather than from a stub per target. A stub is a copy, and a copy
 * drifts: one edit is supposed to change every target, so the starter reading the table is the
 * difference between a documented default and an actual one.
 *
 * Each entry carries its `requires` as a comment. That is the part a person cannot look up: the
 * table knows a Cloudflare cache is `cloudflare-kv` and needs `bindings.kv`, and whoever opens a
 * fresh `config/cache.ts` does not.
 */
function configFor(
  target: DeployTarget,
  capability: DefaultedCapability,
): { readonly body: string; readonly env: readonly EnvEntry[] } | undefined {
  const section = CAPABILITY_SECTIONS[capability];
  if (section === undefined) return undefined;
  const row = driverDefaultFor(target, capability);
  const { entry, env } = entryFor(capability, row.driver);
  const requires =
    row.requires.length === 0
      ? ['//   · nothing — this driver is complete on its own']
      : row.requires.map((need) => `//   · ${need}`);
  const entries = ENTRY_KEYS[section] ?? 'entries';
  const body = [
    `// config/${section}.ts — generated for the ${target} target.`,
    '//',
    `// The default is what ${capability} converges on for ${target}: \`${row.driver}\`.`,
    '//',
    '// It needs:',
    ...requires,
    '//',
    `// Why: ${row.why}`,
    'export default {',
    `  default: 'main',`,
    `  ${entries}: {`,
    `    main: ${entry},`,
    '  },',
    '};',
    '',
  ].join('\n');
  return { body, env };
}

export async function newCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': { type: 'boolean', description: 'overwrite an existing directory' },
    '--dry-run': { type: 'boolean', description: 'print the files that would be written' },
    '--interactive': { type: 'boolean', description: 'ask for the app name if it was not given' },
    '--no-interactive': {
      type: 'boolean',
      description: 'never prompt; fail if an answer is missing',
    },
    '--target': {
      type: 'string',
      description:
        'cloudflare (default), lambda or bun — decides the driver every capability starts on',
    },
  });
  let name = args.positionals[0];
  if (name === undefined) {
    // A missing name is a question, not an error, when a person is watching. With no terminal the
    // answer cannot arrive, so the usage error is the honest response — never a prompt that hangs.
    const requested = boolFlag(args, '--interactive') ? true : undefined;
    if (!canPrompt({ ...(requested === undefined ? {} : { requested }) })) {
      throw new UsageError('tsir new <name>', 'the name becomes the directory and the app name');
    }
    name = await askForName();
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new UsageError(`"${name}" is not a valid app name`, 'use lowercase kebab-case');
  }

  const target = targetOf(args);
  const force = boolFlag(args, '--force');
  // Applications live in `apps/<name>/`. The workspace root is the directory the developer is
  // working in — or, when they are already inside it, the one that owns `apps/`. Without that
  // second case, running `tsir new` from `apps/` produced `apps/apps/<name>` and every relative
  // `file:` reference below was then computed from the wrong place.
  //
  // Never `app/`, never the distribution root (the guard below refuses that), and never a core
  // source tree.
  const here = resolve(process.cwd());
  const workspaceRoot = basename(here) === 'apps' ? resolve(here, '..') : here;
  const appsDir = resolve(workspaceRoot, 'apps');
  const root = resolve(appsDir, name);
  // Distribution builds replace their entire output directory. Do not let a user
  // accidentally create an application where the next build will delete it.
  const distRoot = process.env['TSIR_DIST'];
  if (distRoot !== undefined) {
    // Resolve symlinks so `/tmp` vs `/private/tmp` (macOS) and other logical
    // path differences do not defeat the guard.
    const realDist = realpathSync(resolve(distRoot));
    const realCwd = realpathSync(process.cwd());
    const fromDist = relative(realDist, resolve(realCwd, name));
    if (
      fromDist === '' ||
      (fromDist !== '..' && !fromDist.startsWith(`..${sep}`) && !isAbsolute(fromDist))
    ) {
      throw new CliError(
        'create applications outside the generated distribution directory',
        EXIT.usage,
        `the distribution is replaced by make dist — cd to another directory and run ${resolve(distRoot, 'tsir')} new ${name}`,
      );
    }
  }
  if (existsSync(root) && !force) {
    throw new CliError(
      `${name}/ already exists`,
      EXIT.failure,
      'pass --force to scaffold into it anyway',
    );
  }

  // The pre-publication packages form a Bun workspace. This preserves a single
  // instance of process-local registries across the app and its CLI.
  const dist = process.env['TSIR_DIST'];
  const packages = dist === undefined ? undefined : join(resolve(dist), 'framework');
  if (packages !== undefined && !existsSync(join(packages, 'console', 'package.json'))) {
    throw new CliError('TSIR_DIST is not a valid Tsir distribution', EXIT.environment);
  }
  // How the application reaches the framework.
  //
  // The packages are not on a registry yet, so the application points at the distribution that
  // created it. Two rules make that a contract rather than an accident:
  //
  //   1. **Relative**, not absolute. The old scaffold wrote `"workspaces": ["/abs/path/dist/framework/*"]`
  //      into `package.json`, which named the machine that scaffolded the app: move the
  //      distribution and the application stops resolving. The reference below is derived from the
  //      application's own location (`apps/<name>/` → `../../dist/framework/<pkg>`), so it survives
  //      a moved or renamed checkout.
  //   2. **`link:`**, not `file:`. A `file:` dependency is *copied* (bun hardlinks it into
  //      `node_modules`), and the copy is made once per dependent, so `@tsir/router` ends up
  //      present several times over — `node_modules/@tsir/router` for the application,
  //      `node_modules/@tsir/testing/node_modules/@tsir/router` for the harness, and so on. The
  //      framework keeps process-local registries (routes, controllers, the container), so two
  //      copies are two registries: the application registers a route in one and the harness
  //      looks for it in another, which showed up as `TEST_UNKNOWN_MODULE` in a fresh scaffold.
  //      `link:` symlinks instead, so every reference resolves to the single package directory.
  //   3. **`overrides`**, not a workspace. A `workspace:*` range resolves only inside the
  //      distribution's own Bun workspace, and only while the app lives inside it. An override
  //      applies to the dependency *and* to every transitive `@tsir/*` range, which is what a
  //      standalone `bun install` needs.
  const parts = [
    'console',
    'config',
    'container',
    'core',
    'database',
    'http',
    'migrate',
    'router',
    'testing',
    'validate',
  ] as const;
  const appDir = resolve(workspaceRoot, 'apps', name);
  const frameworkRoot =
    packages === undefined ? undefined : relative(appDir, packages).split(sep).join('/');
  const dependencies = Object.fromEntries(
    parts.map((part) => [
      `@tsir/${part}`,
      frameworkRoot === undefined ? '0.0.0' : `link:${frameworkRoot}/${part}`,
    ]),
  );
  // A `file:` dependency covers what the application imports. It does **not** cover what the
  // framework packages import from each other: those ranges are version strings, and with nothing
  // on a registry `bun install` fails to resolve every transitive `@tsir/*`. Overrides apply to the
  // whole tree, which is what makes a standalone install work while the packages are unpublished.
  // The ranges stay version-shaped (`0.0.0`) so removing this block, once the packages are on a
  // registry, is a one-line change with no other edits.
  const overrides =
    packages === undefined || frameworkRoot === undefined
      ? undefined
      : Object.fromEntries(
          // Every package the distribution ships, not only the ones the application imports
          // directly: the framework packages depend on each other, and a transitive range that is
          // not overridden is looked up on a registry that has no @tsir packages yet.
          readdirSync(packages, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
            .map((dir) => [`@tsir/${dir}`, `link:${frameworkRoot}/${dir}`]),
        );
  // Drizzle is the ORM the database bootstrap exposes; it is not a @tsir package.
  dependencies['drizzle-orm'] = '0.45.4';
  // The tsconfig above names `bun` in `types`, and the generated sources use Bun/Node globals.
  // Shipping the tsconfig without the package it references is what made a fresh scaffold fail to
  // typecheck.
  const devDependencies = { '@types/bun': 'latest' };

  const stubVars = { name };
  // `CAP-008`: config comes from `DRIVER_DEFAULTS` for the chosen target, not from a stub that
  // hardcoded `d1`. A lambda app scaffolded with `d1` was a Worker's config in a function with no
  // binding to receive it, and the mismatch surfaced at first use rather than at creation.
  const config = configFiles(target);
  const files: readonly (readonly [string, string])[] = [
    [
      'package.json',
      // CLI-018: the script names the file by path. A script called `ract` that ran `bun ract` would
      // match itself: Bun resolves a package script before a file of the same name.
      JSON.stringify(
        {
          name,
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: { ract: 'bun ./ract' },
          dependencies,
          devDependencies,
          ...(overrides === undefined ? {} : { overrides }),
        },
        null,
        2,
      ) + '\n',
    ],
    ['tsir.js', renderStub('new/project.ts', stubVars)],
    ['app.ts', renderStub('new/app.ts', stubVars)],
    ['config.ts', renderStub('new/config.ts', stubVars)],
    ['config/app.ts', renderStub('new/config/app.ts', stubVars)],
    ...config.files,
    ['database.ts', renderStub('new/database.ts', stubVars)],
    ['home/index.ts', renderStub('new/home/index.ts', stubVars)],
    ['home/registry.ts', renderStub('new/home/registry.ts', stubVars)],
    ['home/routes.ts', renderStub('new/home/routes.ts', stubVars)],
    ['home/http/home.controller.ts', renderStub('new/home/http/home.controller.ts', stubVars)],
    // Empty migrations directory — `tsir make:migration` adds the first one.
    ['migrations/.gitkeep', ''],
    ['.gitignore', 'node_modules/\n.env\n.tsir/\ndist/\n'],
    [
      'tsconfig.json',
      JSON.stringify(
        {
          // A Bun application needs Bun's globals and Node's builtin types: the generated
          // `app.ts` imports `node:async_hooks`, `database.ts` uses `node:path` and
          // `import.meta.dir`, and `@tsir/database` references `bun:sqlite`. Without `types` and
          // `skipLibCheck` the scaffold failed its own typecheck on a clean machine
          // (`TS2591: Cannot find name 'node:async_hooks'`, `TS2339: Property 'dir' does not exist
          // on type 'ImportMeta'`, and dozens of errors inside `drizzle-orm`'s own `.d.ts` files).
          compilerOptions: {
            target: 'ESNext',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            // Declaration files from dependencies are not this project's to fix.
            skipLibCheck: true,
            types: ['bun'],
          },
        },
        null,
        2,
      ) + '\n',
    ],
    ['ract', RACT_TEMPLATE],
    // CLI-018: `ract` has no extension, so prettier cannot parse it and must ignore it by name.
    ['.prettierignore', 'ract\n'],
    ['test/app.test.ts', renderStub('new/test/app.test.ts', stubVars)],
    [
      '.env.example',
      [
        '# Copy to .env and fill in. Never commit real secrets.',
        'APP_ENV=development',
        ...config.env.map(([name_, why]) => `# ${why}\n${name_}=`),
        '',
      ].join('\n'),
    ],
  ];

  const generated: GeneratedFile[] = files.map(([relativePath, contents]) => ({
    path: join(root, relativePath),
    contents,
  }));
  const dryRun = boolFlag(args, '--dry-run');
  const plan = await commitWrites(generated, { force, dryRun });
  reportPlan(plan, dryRun);
  if (dryRun) return EXIT.ok;
  // CLI-018: `ract` must be executable so `./ract` works after a clone.
  chmodSync(join(root, 'ract'), RACT_MODE);

  info('');
  info(`  created ${style.bold(`apps/${name}`)} — next steps:`);
  info(`    ${style.cyan(`cd apps/${name}`)}`);
  info(`    ${style.cyan('bun install')}   ${style.dim('install the application dependencies')}`);
  info(`    ${style.cyan('tsir dev')}      ${style.dim('serve the application')}`);
  // The distribution ships frontend templates beside its packages. Point at them from the scaffold
  // rather than from a document the developer has not read yet: this is the moment the question
  // "how do I put a UI on this" occurs to someone.
  const templates = distRoot === undefined ? undefined : join(resolve(distRoot), 'templates');
  if (templates !== undefined && existsSync(templates)) {
    const shipped = readdirSync(templates, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (shipped.length > 0) {
      info('');
      info(
        `  ${style.dim('frontends ship with the distribution:')} ${shipped.join(', ')} ${style.dim(`(dist/templates/)`)}`,
      );
      info(
        `    ${style.dim('copy one beside this app, then')} ${style.cyan('bun install && bun run dev')} ${style.dim('— it proxies /api here')}`,
      );
    }
  }
  if (dist === undefined) {
    warn(
      'No distribution was detected. @tsir packages are not yet published; use the distribution launcher to scaffold an installable app.',
    );
  }
  info('');
  return EXIT.ok;
}

/**
 * The files `make:module` writes. A module owns its components in typed
 * subdirectories: `http/` for controllers, `models/` for schemas, etc. The
 * module root holds `routes.ts` (the route registry), `index.ts` (the public
 * surface), and the module's test.
 */
function moduleFiles(
  base: string,
  kebab: string,
): readonly { readonly name: string; readonly contents: string }[] {
  const camel = base.charAt(0).toLowerCase() + base.slice(1);
  const prefix = `/${kebab}`;
  const vars = { base, camel, kebab, prefix };
  return [
    { name: 'registry.ts', contents: renderStub('module/registry.ts', vars) },
    { name: 'routes.ts', contents: renderStub('module/routes.ts', vars) },
    { name: `http/${kebab}.controller.ts`, contents: renderStub('module/controller.ts', vars) },
    { name: 'index.ts', contents: renderStub('module/index.ts', vars) },
    { name: `${kebab}.test.ts`, contents: renderStub('module/test.ts', vars) },
  ];
}

export async function makeModuleCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--force': { type: 'boolean', description: 'overwrite an existing file' },
    '--dry-run': { type: 'boolean', description: 'print the files that would be written' },
  });
  const name = args.positionals[0];
  if (name === undefined || args.positionals.length !== 1)
    throw new UsageError('tsir make:module <name>', 'e.g. tsir make:module shop');

  // `make:module` accepts `<app>/<name>` to create a module in another app.
  const { app, module: moduleName } = splitAppModule(name);
  if (app !== undefined) process.chdir(app);

  // A module only matters inside an application: without a `tsir.js`, the files
  // are written but nothing registers them. Warn rather than refuse — a user
  // may be scaffolding a directory before adding the project file — but make
  // the gap obvious so the output is not mistaken for a working module.
  try {
    findConfigFile(process.cwd());
  } catch {
    warn(
      'no tsir.js found in this directory — the module is written but not registered by any app',
    );
  }

  const raw = moduleName.endsWith('Module') ? moduleName.slice(0, -'Module'.length) : moduleName;
  const { pascal: base, stem } = scopedName(raw, 'module');
  const dir = join(process.cwd(), stem);
  const dryRun = boolFlag(args, '--dry-run');
  const plan = await commitWrites(
    moduleFiles(base, stem).map((file) => ({
      path: join(dir, file.name),
      contents: file.contents,
    })),
    { force: boolFlag(args, '--force'), dryRun },
  );
  reportPlan(plan, dryRun);
  if (dryRun) return EXIT.ok;

  info(
    `  ${style.dim('register it:')} import { ${toCamel(base)} } from './${stem}/index.ts' and add ${toCamel(base)}.module to modules`,
  );
  return EXIT.ok;
}

function toCamel(base: string): string {
  return base.charAt(0).toLowerCase() + base.slice(1);
}

/** One line per file, so a dry run and a real run read the same way. */
function reportPlan(plan: readonly PlannedWrite[], dryRun: boolean): void {
  for (const entry of plan) {
    const verb = dryRun ? 'would ' : '';
    const action = entry.action === 'overwrite' ? `${verb}overwrite` : `${verb}create`;
    if (dryRun) info(`  ${style.dim(action)} ${displayPath(entry.path)}`);
    else ok(`${action === 'overwrite' ? 'overwrote' : 'created'} ${displayPath(entry.path)}`);
  }
}
