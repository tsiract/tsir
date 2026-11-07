import { describe, expect, test } from 'bun:test';
import { defineConfig, env } from '@tsir/config';
import { defineApp } from '@tsir/core';
import { createTestApp } from '@tsir/testing';

import { system as _module } from './index.ts';
import './http/system.controller.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'test' }),
});

describe('system module', () => {
  test('boots on its own and serves its route', async () => {
    const app = defineApp({ name: 'system-test', config: spec, modules: [_module.module] });
    const harness = await createTestApp(app, { env: { APP_ENV: 'test' } });
    try {
      const paths = harness.routes().routes.map((route) => route.path);
      expect(paths.some((path) => path.startsWith('/system'))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});
