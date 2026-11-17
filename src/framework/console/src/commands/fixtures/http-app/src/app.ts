import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';
import { createFetchHandler } from '@tsir/http';
import { compileRoutes, type ControllerEntry } from '@tsir/router';

import { media } from './modules/media/index.ts';
import { users } from './modules/users/index.ts';

const spec = defineConfig({});

export default defineApp({
  name: 'http-example',
  config: spec,
  modules: () => [users.module, media.module],
});

/**
 * This app's own routes — its modules' registries, never the process-global list.
 *
 * `collectRouteEntries()` with no argument returns every controller registered in the
 * **process**, which is what the CLI reads when it builds one real application. A fixture is
 * not one real application: it is imported inside a test process that also imports
 * `src/apps/examples/http`, whose `UsersController` declares the same `GET /api/users`. Compiling
 * the global list here reported `RTR_DUPLICATE: GET /api/users is declared twice` depending on
 * which test file Bun happened to load first — a suite that passes alone and fails as a whole,
 * which is the worst kind of red CI.
 *
 * Scoping to the modules is also what the real example does (`src/apps/examples/http/app.ts`),
 * so the fixture now exercises the pattern the framework documents instead of a weaker one.
 */
const appEntries = (): readonly ControllerEntry[] => [
  ...users.registry.entries(),
  ...media.registry.entries(),
];

const table = compileRoutes(appEntries());

export const handler = createFetchHandler(table);
