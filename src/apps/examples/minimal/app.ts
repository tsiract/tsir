/**
 * The minimal Tsir application.
 *
 * Three things only: a typed configuration, one module, and the app contract
 * the CLI and test harness both use. Everything else is added by later phases.
 */

import { defineApp, defineModule } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';

export const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  APP_NAME: env.string({ default: 'minimal', maxLength: 40 }),
});

const RootModule = defineModule({
  name: 'root',
  onReady: () => {
    // A real application would start adapters here; the lifecycle is the point.
  },
});

export default defineApp({
  name: 'minimal',
  config: spec,
  modules: [RootModule],
});
