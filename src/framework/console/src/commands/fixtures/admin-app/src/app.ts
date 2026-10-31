// Two units, one handler: the shape a real app has when health and metrics live beside the
// API but must not be reachable from the internet.

import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';

export const spec = defineConfig({});

export default defineApp({
  name: 'admin-app',
  config: spec,
  modules: [],
});

export const handler = (request: Request): Response =>
  new Response(JSON.stringify({ path: new URL(request.url).pathname }), {
    headers: { 'content-type': 'application/json' },
  });
