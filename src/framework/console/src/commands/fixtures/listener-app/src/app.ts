import { defineConfig } from '@tsir/config';
import { defineApp } from '@tsir/core';

import { orders } from './modules/orders/index.ts';

const spec = defineConfig({});

/**
 * The listener fixture's whole app.
 *
 * The entry contract is a **default export** of `defineApp(…)`, and its modules declare a
 * listener-bearing controller — the only thing that should be needed to get a deployable
 * `notify` unit out of `deploy:build`.
 */
export default defineApp({
  name: 'listener-example',
  config: spec,
  modules: () => [orders.module],
});
