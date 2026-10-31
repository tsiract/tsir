/**
 * The configuration schema as data (`CFG-116`): keys, required, secret, and no secret default.
 */

import { describe, expect, test } from 'bun:test';

import { defineConfig, env } from './define.ts';
import { configSchemaDocument } from './schema-doc.ts';

describe('configSchemaDocument (CFG-116)', () => {
  test('lists every field by key with its required and secret flags', () => {
    const spec = defineConfig({
      PORT: env.int({ default: 3000, description: 'http port' }),
      QUEUE: env.required(),
      API_KEY: { ...env.secret(), hasDefault: true, defaultInput: 'dev-only' },
    });
    const doc = configSchemaDocument(spec);
    expect(doc.fields.map((field) => field.key)).toEqual(['API_KEY', 'PORT', 'QUEUE']);
    expect(doc.fields.find((field) => field.key === 'PORT')).toEqual({
      key: 'PORT',
      required: false,
      secret: false,
      overridable: true,
      description: 'http port',
      // The input form: env fields declare their default as the string the environment would carry.
      default: '3000',
    });
    expect(doc.fields.find((field) => field.key === 'QUEUE')?.required).toBe(true);
  });

  test('a secret default is never published', () => {
    const doc = configSchemaDocument(
      defineConfig({ API_KEY: { ...env.secret(), hasDefault: true, defaultInput: 'dev-only' } }),
    );
    const [field] = doc.fields;
    expect(field?.secret).toBe(true);
    expect(field && 'default' in field).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('dev-only');
  });
});
