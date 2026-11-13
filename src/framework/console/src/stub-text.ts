/**
 * The stubs, as one module the bundler can see.
 *
 * A code generator needs two things that pull in opposite directions: the templates it renders must
 * be editable as ordinary files (syntax highlighting, reviewable diffs, no escaping around the code
 * they contain), and the CLI must run as a **single-file executable** (`bun build --compile`), where
 * there is no directory to read from — the module graph is inside the binary and `import.meta.dir`
 * points into the bundled filesystem, so every `readFileSync(stubs/…)` fails with ENOENT.
 *
 * Text imports resolve both: `import … with { type: 'text' }` keeps the `.slug` file as the source of
 * truth on disk and inlines its bytes into the bundle at build time. A plain source run reads the
 * same module and gets the same string, so there is one code path, not two.
 *
 * The `.txt` suffix is load-bearing. Bun resolves text imports for extensions it does not load as
 * code (`.txt`, `.md`, `.html`), and its test runner's loader is narrower than its bundler's: it
 * refuses `.slug` outright with "Cannot find module". Keeping the template name and adding `.txt`
 * (`new/app.ts.slug.txt` → `new/app.ts`) means one import form that the runner, the bundler and
 * `bun build --compile` all accept — verified, not assumed.
 *
 * The map is written out rather than generated with a glob: a glob cannot be statically analysed, so
 * the files would not be in the bundle — which is the exact failure this file exists to prevent.
 */

import commandTs from './stubs/command.ts.slug.txt' with { type: 'text' };
import controllerTs from './stubs/controller.ts.slug.txt' with { type: 'text' };
import eventTs from './stubs/event.ts.slug.txt' with { type: 'text' };
import frontendIndexHtml from './stubs/frontend/index.html.slug.txt' with { type: 'text' };
import frontendTsconfigJson from './stubs/frontend/tsconfig.json.slug.txt' with { type: 'text' };
import frontendViteConfigTs from './stubs/frontend/vite.config.ts.slug.txt' with { type: 'text' };
import guardTs from './stubs/guard.ts.slug.txt' with { type: 'text' };
import jobTs from './stubs/job.ts.slug.txt' with { type: 'text' };
import linkClientTs from './stubs/link-client.ts.slug.txt' with { type: 'text' };
import listenerTs from './stubs/listener.ts.slug.txt' with { type: 'text' };
import middlewareTs from './stubs/middleware.ts.slug.txt' with { type: 'text' };
import modelTs from './stubs/model.ts.slug.txt' with { type: 'text' };
import moduleControllerTs from './stubs/module/controller.ts.slug.txt' with { type: 'text' };
import moduleIndexTs from './stubs/module/index.ts.slug.txt' with { type: 'text' };
import moduleRegistryTs from './stubs/module/registry.ts.slug.txt' with { type: 'text' };
import moduleRoutesTs from './stubs/module/routes.ts.slug.txt' with { type: 'text' };
import moduleTestTs from './stubs/module/test.ts.slug.txt' with { type: 'text' };
import newAppTs from './stubs/new/app.ts.slug.txt' with { type: 'text' };
import newConfigTs from './stubs/new/config.ts.slug.txt' with { type: 'text' };
import newConfigAppTs from './stubs/new/config/app.ts.slug.txt' with { type: 'text' };
import newDatabaseTs from './stubs/new/database.ts.slug.txt' with { type: 'text' };
import newHomeHttpHomeControllerTs from './stubs/new/home/http/home.controller.ts.slug.txt' with { type: 'text' };
import newHomeIndexTs from './stubs/new/home/index.ts.slug.txt' with { type: 'text' };
import newHomeRegistryTs from './stubs/new/home/registry.ts.slug.txt' with { type: 'text' };
import newHomeRoutesTs from './stubs/new/home/routes.ts.slug.txt' with { type: 'text' };
import newProjectTs from './stubs/new/project.ts.slug.txt' with { type: 'text' };
import newTestAppTestTs from './stubs/new/test/app.test.ts.slug.txt' with { type: 'text' };
import pendingTestTs from './stubs/pending-test.ts.slug.txt' with { type: 'text' };
import policyTs from './stubs/policy.ts.slug.txt' with { type: 'text' };
import seederTs from './stubs/seeder.ts.slug.txt' with { type: 'text' };
import serviceTs from './stubs/service.ts.slug.txt' with { type: 'text' };

/** Every stub, keyed the way `renderStub()` is called (`'new/app.ts'`). */
export const STUBS: ReadonlyMap<string, string> = new Map([
  ['command.ts.slug', commandTs],
  ['controller.ts.slug', controllerTs],
  ['event.ts.slug', eventTs],
  ['frontend/index.html.slug', frontendIndexHtml],
  ['frontend/tsconfig.json.slug', frontendTsconfigJson],
  ['frontend/vite.config.ts.slug', frontendViteConfigTs],
  ['guard.ts.slug', guardTs],
  ['job.ts.slug', jobTs],
  ['link-client.ts.slug', linkClientTs],
  ['listener.ts.slug', listenerTs],
  ['middleware.ts.slug', middlewareTs],
  ['model.ts.slug', modelTs],
  ['module/controller.ts.slug', moduleControllerTs],
  ['module/index.ts.slug', moduleIndexTs],
  ['module/registry.ts.slug', moduleRegistryTs],
  ['module/routes.ts.slug', moduleRoutesTs],
  ['module/test.ts.slug', moduleTestTs],
  ['new/app.ts.slug', newAppTs],
  ['new/config.ts.slug', newConfigTs],
  ['new/config/app.ts.slug', newConfigAppTs],
  ['new/database.ts.slug', newDatabaseTs],
  ['new/home/http/home.controller.ts.slug', newHomeHttpHomeControllerTs],
  ['new/home/index.ts.slug', newHomeIndexTs],
  ['new/home/registry.ts.slug', newHomeRegistryTs],
  ['new/home/routes.ts.slug', newHomeRoutesTs],
  ['new/project.ts.slug', newProjectTs],
  ['new/test/app.test.ts.slug', newTestAppTestTs],
  ['pending-test.ts.slug', pendingTestTs],
  ['policy.ts.slug', policyTs],
  ['seeder.ts.slug', seederTs],
  ['service.ts.slug', serviceTs],
]);
