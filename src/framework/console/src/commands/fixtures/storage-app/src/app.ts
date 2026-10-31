// The storage fixture's entry. It exports `disks`, which is the contract `tsir storage:*` reads
// first — the same shape as `caches` and `queues`: behaviour in exports, wiring in `tsir.js`.
import { defineConfig } from '@tsir/config';
import { defineApp } from '@tsir/core';
import { createDisks, defineDisk, localDriver, memoryDriver } from '@tsir/storage';

export const spec = defineConfig({});

export default defineApp({
  name: 'storage-app',
  config: spec,
  modules: [],
});

export const disks = createDisks({
  disks: {
    assets: defineDisk({ driver: localDriver({ root: '.storage', name: 'assets' }) }),
    scratch: defineDisk({ driver: memoryDriver() }),
  },
  default: 'assets',
});
