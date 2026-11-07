import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';
import { createFetchHandler } from '@tsir/http';
import { collectRouteEntries, compileRoutes, routeModule } from '@tsir/router';

import { users } from './modules/users/index.ts';
import { media } from './modules/media/index.ts';

const spec = defineConfig({});

export default defineApp({
  name: 'http-example',
  config: spec,
  modules: () => [users.module, media.module],
});

const table = compileRoutes(collectRouteEntries());

export const handler = createFetchHandler(table);

void routeModule;
