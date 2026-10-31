// The smallest application that still has a deployable unit: a name, a config, a handler.
// No routes, because the unit comes from `deploy.units` — this fixture is about bytes.

import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';

export const spec = defineConfig({});

export default defineApp({
  name: 'budget-app',
  config: spec,
  modules: [],
});

export const handler = (): Response => new Response('ok');
