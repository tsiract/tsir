// A deploys-shaped app with nothing to serve: `defineApp` needs a config spec and a name,
// and the graph is resolved from declarations rather than from a booted server.
import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';

export const spec = defineConfig({});

export default defineApp({
  name: 'deploy-fixture',
  config: spec,
  modules: [],
});
