import { describe, expect, test } from 'bun:test';
import { expectTsirError, createTestApp } from '@tsir/testing';

import app from '../app.ts';

describe('minimal example', () => {
  test('boots through the same path production uses', async () => {
    const harness = await createTestApp(app, { env: { APP_ENV: 'test' } });

    expect(harness.app.state.kind).toBe('ready');
    expect((harness.app.config.values as { APP_NAME: string }).APP_NAME).toBe('minimal');

    await harness.dispose();
    expect(harness.app.state.kind).toBe('stopped');
  });

  test('rejects an invalid environment with every issue at once', async () => {
    const error = await expectTsirError(
      () => app.createApp({ mode: 'test', env: { APP_ENV: 'staging', APP_NAME: 'x'.repeat(41) } }),
      'CFG_INVALID',
    );
    expect(error.message).toContain('APP_ENV');
  });

  test('the manifest describes the same module set the app boots', () => {
    const manifest = app.manifest({ env: { APP_ENV: 'test' } });
    expect(manifest.modules).toEqual(['root']);
    expect(manifest.appName).toBe('minimal');
  });
});
