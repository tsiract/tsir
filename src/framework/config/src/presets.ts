/**
 * Presets (`CFG-102`, `CFG-103`, `CFG-118`): named, composable defaults for `tsir.js`.
 *
 * A preset is a named value that carries a partial project configuration (its *layer*). Presets
 * are applied left to right, and the project's own values are applied last, so:
 *
 *   · a preset only **adds** defaults. A value the project sets is never removed or replaced
 *     by a preset (`CFG-103`).
 *   · scalars and objects follow ordinary override rules: later wins, objects merge key by key.
 *   · arrays are **replaced** by default, so a later layer cannot silently drop what an earlier
 *     one contributed. A list that should accumulate is declared with `appendList`, and the
 *     result keeps the first occurrence of each item, in order.
 *   · a third-party preset must declare a `name` and a `version` (`CFG-118`). The applied list is
 *     recorded by `presetRecords`, so a configuration can say which presets shaped it.
 *
 * This module is pure. Checking that a preset's modules are installed needs the filesystem, so
 * that check lives with the loader (`presetModuleError` builds the error; the caller decides
 * what is installed).
 */

import type { TsirError } from '@tsir/container';

import { configError } from './errors.ts';

/** A partial project configuration as a preset returns it. */
export type ProjectLayer = Readonly<Record<string, unknown>>;

const APPEND: unique symbol = Symbol('tsir.preset.append');
const PRESET: unique symbol = Symbol('tsir.preset');

/** The version recorded for the presets this package ships. Matches `status.json`. */
export const BUILTIN_PRESET_VERSION = '0.0.0';

/** A list that accumulates across layers instead of replacing what came before. */
export interface AppendList<T> {
  readonly [APPEND]: true;
  readonly items: readonly T[];
}

/** Declares a list that accumulates across presets and the project (`CFG-103`). */
export function appendList<T>(items: readonly T[]): AppendList<T> {
  return { [APPEND]: true, items: [...items] };
}

/** A named preset with its version and the configuration layer it contributes. */
export interface Preset {
  readonly [PRESET]: true;
  readonly name: string;
  readonly version: string;
  readonly source: 'builtin' | 'third-party';
  readonly layer: ProjectLayer;
}

/** The entry `presetRecords` returns for each applied preset (`CFG-118`). */
export interface PresetRecord {
  readonly name: string;
  readonly version: string;
  readonly source: 'builtin' | 'third-party';
}

function isAppend(value: unknown): value is AppendList<unknown> {
  return typeof value === 'object' && value !== null && APPEND in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isAppend(value);
}

function isPreset(value: unknown): value is Preset {
  return typeof value === 'object' && value !== null && PRESET in value;
}

function dedupe(items: readonly unknown[]): unknown[] {
  return [...new Set(items)];
}

function mergeTwo(
  base: Readonly<Record<string, unknown>>,
  over: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const prior = out[key];
    if (isAppend(value)) {
      const priorItems: readonly unknown[] = Array.isArray(prior)
        ? (prior as readonly unknown[])
        : [];
      out[key] = dedupe([...priorItems, ...value.items]);
    } else if (isPlainObject(value)) {
      // Recursing even into an empty target resolves any nested appendList in this layer.
      out[key] = mergeTwo(isPlainObject(prior) ? prior : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Merges layers left to right; later layers win (`CFG-103`). Pure: no input is mutated. */
export function mergeLayers(layers: readonly ProjectLayer[]): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const layer of layers) merged = mergeTwo(merged, layer);
  return merged;
}

/**
 * Defines a preset. Third-party presets call this too, and must give a non-empty `name` and
 * `version` (`CFG-118`); a preset without a version cannot be recorded, so it is refused.
 */
export function definePreset(input: {
  readonly name: string;
  readonly version: string;
  readonly layer: ProjectLayer;
  readonly source?: 'builtin' | 'third-party';
}): Preset {
  if (input.name.trim() === '' || input.version.trim() === '') {
    throw configError(
      'CFG_INVALID',
      'a preset must declare a non-empty name and version',
      'export { name, version } from the preset package, e.g. version: "1.0.0"',
    );
  }
  return {
    [PRESET]: true,
    name: input.name,
    version: input.version,
    source: input.source ?? 'third-party',
    layer: input.layer,
  };
}

function builtin(name: string, layer: ProjectLayer): Preset {
  return definePreset({ name, version: BUILTIN_PRESET_VERSION, layer, source: 'builtin' });
}

/**
 * The built-in presets. `modules` names the `@tsir/*` packages a preset expects to be installed,
 * and `deploy.targets` is a record keyed by platform, as the project schema defines it.
 */
export const preset = {
  /** `core` only: library-ish services and tests. */
  minimal: (): Preset => builtin('minimal', { modules: appendList(['@tsir/core']) }),

  /**
   * The default API service: http, console, database, vault and validate. The database
   * default is the name `primary`; the project declares that connection and its driver.
   */
  standard: (): Preset =>
    builtin('standard', {
      modules: appendList([
        '@tsir/core',
        '@tsir/http',
        '@tsir/console',
        '@tsir/database',
        '@tsir/vault',
        '@tsir/validate',
      ]),
      database: { default: 'primary' },
    }),

  /** A public API with role-based access: standard, plus auth and policy. */
  api: (): Preset =>
    builtin('api', {
      modules: appendList([
        '@tsir/core',
        '@tsir/http',
        '@tsir/console',
        '@tsir/database',
        '@tsir/vault',
        '@tsir/validate',
        '@tsir/auth',
        '@tsir/policy',
      ]),
      database: { default: 'primary' },
    }),

  /** Background processing: http, queue, events, schedule and pulse. */
  worker: (): Preset =>
    builtin('worker', {
      modules: appendList([
        '@tsir/core',
        '@tsir/http',
        '@tsir/queue',
        '@tsir/events',
        '@tsir/schedule',
        '@tsir/pulse',
      ]),
    }),

  /** An edge-first service: http, REST links and pulse, deployed to Cloudflare as separate units. */
  edge: (): Preset =>
    builtin('edge', {
      modules: appendList(['@tsir/core', '@tsir/http', '@tsir/link', '@tsir/pulse']),
      deploy: { topology: 'separate', targets: { cloudflare: {} } },
    }),

  /** A classic Lambda API: http and REST links, deployed to Lambda. */
  serverless: (): Preset =>
    builtin('serverless', {
      modules: appendList(['@tsir/core', '@tsir/http', '@tsir/link']),
      deploy: { targets: { lambda: {} } },
    }),

  /** Everything the framework ships as a module. For examples and evaluation. */
  full: (): Preset =>
    builtin('full', {
      modules: appendList([
        '@tsir/core',
        '@tsir/http',
        '@tsir/console',
        '@tsir/database',
        '@tsir/vault',
        '@tsir/validate',
        '@tsir/auth',
        '@tsir/policy',
        '@tsir/queue',
        '@tsir/events',
        '@tsir/schedule',
        '@tsir/pulse',
        '@tsir/link',
        '@tsir/cache',
        '@tsir/mail',
        '@tsir/notify',
        '@tsir/storage',
      ]),
      database: { default: 'primary' },
    }),
} as const;

/** The module names a list of presets asks for, in order, without duplicates. */
export function presetModules(presets: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const entry of presets) {
    if (!isPreset(entry)) continue;
    const modules = entry.layer['modules'];
    if (isAppend(modules)) names.push(...(modules.items as readonly string[]));
  }
  return [...new Set(names)];
}

/** The presets a project applied, with name, version and source, in order (`CFG-118`). */
export function presetRecords(presets: readonly unknown[]): PresetRecord[] {
  return presets.filter(isPreset).map((entry) => ({
    name: entry.name,
    version: entry.version,
    source: entry.source,
  }));
}

/**
 * Applies a project's `presets` list and returns the effective configuration (`CFG-102`).
 *
 * Presets go first, in the order given. The project's own keys go last, so they win. Its
 * `modules` is appended rather than replacing the presets'. The `presets` key itself is removed
 * from the result; `presetRecords` reads it when the applied list is needed.
 */
export function applyPresets(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { presets, ...own } = raw;
  const layers: ProjectLayer[] = [];
  if (presets !== undefined) {
    if (!Array.isArray(presets)) {
      throw configError(
        'CFG_INVALID',
        '`presets` must be a list of preset.*() values',
        'write presets: [preset.standard()]',
      );
    }
    for (const entry of presets as unknown[]) {
      if (!isPreset(entry)) {
        throw configError(
          'CFG_INVALID',
          'a preset entry is not a preset value',
          'call the preset: preset.standard(), not preset.standard',
        );
      }
      layers.push(entry.layer);
    }
  }
  const ownLayer: Record<string, unknown> = { ...own };
  if (Array.isArray(own['modules'])) {
    ownLayer['modules'] = appendList(own['modules'] as readonly unknown[]);
  }
  return mergeLayers([...layers, ownLayer]);
}

/**
 * The error for preset modules that are not installed (`CFG_PRESET_MODULE_MISSING`). The hint
 * is the exact `bun add` line, so the fix is a copy and paste.
 */
export function presetModuleError(missing: readonly string[]): TsirError {
  return configError(
    'CFG_PRESET_MODULE_MISSING',
    `a preset needs ${missing.length === 1 ? 'a module' : 'modules'} that ${missing.length === 1 ? 'is' : 'are'} not installed: ${missing.join(', ')}`,
    `bun add ${missing.join(' ')}`,
  );
}
