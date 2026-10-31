// The app exports its cache registry, the same way it exports `database` (ADR-0019).
import { cachesFromConfig } from '@tsir/cache';
import { defineApp } from '@tsir/core';
import { defineConfig } from '@tsir/config';

export const spec = defineConfig({});

export default defineApp({
  name: 'cache-app',
  config: spec,
  modules: [],
});

export const caches = cachesFromConfig({
  cache: {
    default: 'app',
    stores: {
      app: { driver: 'memory', ttlMs: 60_000 },
      sessions: { driver: 'memory', required: true },
    },
  },
});

export const handler = (): Response => new Response('ok');
