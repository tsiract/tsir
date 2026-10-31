/**
 * Presets (`CFG-102`, `CFG-103`): what each preset contributes, how layers merge, and what
 * the project's own values do to them.
 */

import { describe, expect, test } from 'bun:test';

import { TsirError } from '@tsir/container';

import {
  appendList,
  applyPresets,
  definePreset,
  mergeLayers,
  preset,
  presetModuleError,
  presetModules,
  presetRecords,
} from './presets.ts';

describe('preset.* (CFG-102)', () => {
  test('standard is http, console, database, vault and validate on top of core', () => {
    expect(presetModules([preset.standard()])).toEqual([
      '@tsir/core',
      '@tsir/http',
      '@tsir/console',
      '@tsir/database',
      '@tsir/vault',
      '@tsir/validate',
    ]);
  });

  test('api is standard plus auth and policy', () => {
    const modules = presetModules([preset.api()]);
    expect(modules).toEqual(expect.arrayContaining(presetModules([preset.standard()])));
    expect(modules).toEqual(expect.arrayContaining(['@tsir/auth', '@tsir/policy']));
  });

  test('edge deploys to cloudflare as separate units; serverless to lambda', () => {
    expect(applyPresets({ presets: [preset.edge()] })['deploy']).toEqual({
      topology: 'separate',
      targets: { cloudflare: {} },
    });
    expect(applyPresets({ presets: [preset.serverless()] })['deploy']).toEqual({
      targets: { lambda: {} },
    });
  });

  test('every preset names core, so no preset can boot without the kernel', () => {
    for (const make of Object.values(preset)) {
      expect(presetModules([make()])).toContain('@tsir/core');
    }
  });
});

describe('merge rules (CFG-103)', () => {
  test('later scalars win', () => {
    expect(mergeLayers([{ a: 1 }, { a: 2 }])).toEqual({ a: 2 });
  });

  test('objects merge key by key', () => {
    expect(
      mergeLayers([{ deploy: { topology: 'separate' } }, { deploy: { targets: ['bun'] } }]),
    ).toEqual({
      deploy: { topology: 'separate', targets: ['bun'] },
    });
  });

  test('a plain array replaces what came before', () => {
    expect(mergeLayers([{ units: ['a', 'b'] }, { units: ['c'] }])).toEqual({ units: ['c'] });
  });

  test('an appendList accumulates, keeping the first occurrence, in order', () => {
    expect(mergeLayers([{ m: appendList(['x', 'y']) }, { m: appendList(['y', 'z']) }])).toEqual({
      m: ['x', 'y', 'z'],
    });
  });

  test('order is significant: the same layers in the other order give the other answer', () => {
    const forward = mergeLayers([{ a: 1 }, { a: 2 }]);
    const backward = mergeLayers([{ a: 2 }, { a: 1 }]);
    expect(forward).toEqual({ a: 2 });
    expect(backward).toEqual({ a: 1 });
  });

  test('merging never mutates its inputs', () => {
    const layer = { m: appendList(['x']) };
    mergeLayers([layer, { m: appendList(['y']) }]);
    expect(layer.m.items).toEqual(['x']);
  });
});

describe('applyPresets: the project wins', () => {
  test('presets are applied left to right, and the project comes last', () => {
    const out = applyPresets({
      presets: [preset.minimal(), preset.edge()],
      modules: ['@tsir/queue'],
      deploy: { topology: 'single' },
    });
    expect(out['deploy']).toEqual({ topology: 'single', targets: { cloudflare: {} } });
    expect(out['modules']).toEqual([
      '@tsir/core',
      '@tsir/http',
      '@tsir/link',
      '@tsir/pulse',
      '@tsir/queue',
    ]);
  });

  test('the presets key is not in the effective configuration', () => {
    expect(applyPresets({ presets: [preset.minimal()] })).not.toHaveProperty('presets');
  });

  test('a project target is merged with a preset target, not used instead', () => {
    expect(
      applyPresets({ presets: [preset.serverless()], deploy: { targets: { bun: {} } } })['deploy'],
    ).toEqual({ targets: { lambda: {}, bun: {} } });
  });

  test('presets set as a non-list, or an entry that is not a preset value, are refused', () => {
    expect(() => applyPresets({ presets: 'standard' })).toThrow(TsirError);
    expect(() => applyPresets({ presets: [() => ({})] })).toThrow(TsirError);
  });

  test('no presets key leaves the project unchanged', () => {
    expect(applyPresets({ app: { name: 'x' } })).toEqual({ app: { name: 'x' } });
  });
});

describe('presetModuleError (CFG_PRESET_MODULE_MISSING)', () => {
  test('the hint is the exact bun add line for every missing module', () => {
    const error = presetModuleError(['@tsir/queue', '@tsir/events']);
    expect(error.code).toBe('CFG_PRESET_MODULE_MISSING');
    expect(error.hint).toBe('bun add @tsir/queue @tsir/events');
  });

  test('a single missing module is named in the singular', () => {
    expect(presetModuleError(['@tsir/auth']).message).toContain('a module that is not installed');
  });
});

describe('third-party presets and the record (CFG-118)', () => {
  test('a third-party preset must declare a name and a version', () => {
    expect(() =>
      definePreset({ name: 'acme', version: '', layer: { modules: appendList(['@acme/x']) } }),
    ).toThrow(TsirError);
    expect(() => definePreset({ name: '  ', version: '1.0.0', layer: {} })).toThrow(TsirError);
  });

  test('a plain object is not a preset, even if it looks like a layer', () => {
    expect(() => applyPresets({ presets: [{ modules: ['@tsir/core'] }] })).toThrow(TsirError);
  });

  test('a third-party preset applies like a built-in one', () => {
    const acme = definePreset({
      name: 'acme-tsir-preset',
      version: '1.2.0',
      layer: { modules: appendList(['@acme/billing']) },
    });
    const effective = applyPresets({ presets: [preset.minimal(), acme] });
    expect(effective['modules']).toEqual(['@tsir/core', '@acme/billing']);
  });

  test('presetRecords lists each applied preset with its version and source, in order', () => {
    const acme = definePreset({ name: 'acme', version: '1.2.0', layer: {} });
    expect(presetRecords([preset.minimal(), acme])).toEqual([
      { name: 'minimal', version: '0.0.0', source: 'builtin' },
      { name: 'acme', version: '1.2.0', source: 'third-party' },
    ]);
  });
});

describe('the registry shape (CFG-122)', () => {
  test('a built-in preset names a default connection and never a driver', () => {
    for (const make of Object.values(preset)) {
      const database = make().layer['database'];
      if (database === undefined) continue;
      expect(Object.keys(database as object)).toEqual(['default']);
    }
  });

  test('the modules that use a database name the primary connection by default', () => {
    expect(applyPresets({ presets: [preset.standard()] })['database']).toEqual({
      default: 'primary',
    });
    expect(applyPresets({ presets: [preset.minimal()] })).not.toHaveProperty('database');
  });

  test('the project chooses the driver and may change the default name', () => {
    const effective = applyPresets({
      presets: [preset.standard()],
      database: {
        default: 'reports',
        connections: { reports: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } } },
      },
    });
    expect(effective['database']).toEqual({
      default: 'reports',
      connections: { reports: { driver: 'postgres', url: { fromEnv: 'DATABASE_URL' } } },
    });
  });
});
