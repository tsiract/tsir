import { defineApp } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';
import { createFetchHandler } from '@tsir/http';

import { tasks } from './tasks/index.ts';
import { routes } from './routes.gen.ts';

export const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  APP_NAME: env.string({ default: 'todo-app-example' }),
});

export default defineApp({
  name: 'todo-app-example',
  config: spec,
  modules: [tasks.module],
});

export const handler = createFetchHandler({ routes });
