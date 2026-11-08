/**
 * The distribution build configuration: what `make dist` is allowed to ship.
 *
 * This is the contract between the wizard (which asks) and the assembler (which builds). It exists
 * as data so that a build is reproducible, reviewable and automatable:
 *
 * ```text
 *   make dist                       interactive wizard, or the saved file when there is one
 *   make dist DIST_YES=1            reuse the saved file, change nothing
 *   make dist FRONTEND=none         reuse the saved file with one answer overridden
 * ```
 *
 * The file lives at `tsir.dist.config.json` in the repository root and is **committed**. A
 * distribution is a product decision — which frontends it supports, which package manager its apps
 * get — and a decision that only exists in someone's terminal history cannot be reviewed.
 *
 * Every field has a default, so a fresh checkout builds the same distribution without the wizard
 * ever running. The wizard's job is to *change* those defaults, deliberately and visibly.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The path, relative to the repository root. */
export const DIST_CONFIG_FILE = 'tsir.dist.config.json';

export const FRONTENDS = ['svelte', 'react', 'vue'] as const;
export type Frontend = (typeof FRONTENDS)[number];

export const PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const STYLINGS = ['tailwind', 'daisyui', 'plain'] as const;
export type Styling = (typeof STYLINGS)[number];

export const ROUTERS = ['native', 'router', 'none'] as const;
export type RouterChoice = (typeof ROUTERS)[number];

export const TEST_TOOLING = ['vitest', 'playwright', 'eslint', 'prettier'] as const;
export type TestTool = (typeof TEST_TOOLING)[number];

/**
 * Runtimes a generated application may target.
 *
 * Only what the framework actually implements: `bun` (a long-running server), `cloudflare-workers`
 * (fetch handler + D1) and `aws-lambda` (a handler per unit). Anything else would be a promise the
 * deploy packages cannot keep, so it is not offered.
 */
export const RUNTIMES = ['bun', 'cloudflare-workers', 'aws-lambda'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export interface FrontendIntegration {
  readonly framework: Frontend;
  /** Build tooling shipped with the template. Vite for all three; recorded, not assumed. */
  readonly bundler: 'vite';
  /** Strict TypeScript for the frontend too — the framework's own rule, applied to templates. */
  readonly typescript: 'strict';
  readonly styling: readonly Styling[];
  /** `none` means the template ships no client router: one page, no deep links. */
  readonly router: RouterChoice;
}

export interface DistConfig {
  /** Bumped when the meaning of a field changes, so an old file is rejected rather than misread. */
  readonly version: 1;
  /** Empty means a backend-only distribution: no frontend templates are shipped. */
  readonly frontends: readonly FrontendIntegration[];
  /** One manager per application. A distribution ships instructions for all three, but apps pick one. */
  readonly packageManagers: readonly PackageManager[];
  /** The manager a generated application gets unless `tsir new` is told otherwise. */
  readonly defaultPackageManager: PackageManager;
  readonly testing: readonly TestTool[];
  /** Runtimes the generated applications are configured for. */
  readonly runtimes: readonly Runtime[];
  /** Ship `openapi:generate` / `proto:generate` support (docs + fixtures for both). */
  readonly apiTooling: { readonly openapi: boolean; readonly protobuf: boolean };
  /** Ship the React/Svelte/Vue development-time type packages in generated apps. */
  readonly includeFrontendTypes: boolean;
}

/**
 * A fresh build's answers.
 *
 * Backend-only with Bun and no frontend: the smallest distribution that is still complete. A
 * frontend is a template decision, and shipping three unused SPA scaffolds by default would make
 * every distribution larger than the app it builds.
 */
export const DEFAULT_DIST_CONFIG: DistConfig = {
  version: 1,
  frontends: [],
  packageManagers: ['bun', 'npm', 'pnpm'],
  defaultPackageManager: 'bun',
  testing: ['eslint', 'prettier'],
  runtimes: ['bun', 'cloudflare-workers', 'aws-lambda'],
  apiTooling: { openapi: true, protobuf: true },
  includeFrontendTypes: false,
};

export interface ConfigProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * Validates a config read from disk or built from flags.
 *
 * Hand-written rather than schema-generated on purpose: the messages reference the *wizard's*
 * questions, and a config file a person edited by hand should say "defaultPackageManager must be one
 * of packageManagers" rather than print a Zod path.
 */
export function validateDistConfig(value: unknown): { config?: DistConfig; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  if (typeof value !== 'object' || value === null) {
    return { problems: [{ field: '', message: 'expected an object' }] };
  }
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1) {
    problems.push({
      field: 'version',
      message: `expected 1, found ${JSON.stringify(record['version'])} — delete the file to start from defaults`,
    });
  }

  const oneOf = <T extends string>(
    field: string,
    allowed: readonly T[],
    input: unknown,
  ): readonly T[] => {
    if (input === undefined) return [];
    if (!Array.isArray(input)) {
      problems.push({ field, message: 'expected an array' });
      return [];
    }
    return input.flatMap((entry) => {
      if (typeof entry !== 'string' || !(allowed as readonly string[]).includes(entry)) {
        problems.push({ field, message: `${JSON.stringify(entry)} is not one of ${allowed.join(', ')}` });
        return [];
      }
      return [entry as T];
    });
  };

  // Frontends: the interesting validation is that a template's parts agree with each other.
  const rawFrontends = record['frontends'];
  const frontends: FrontendIntegration[] = [];
  if (rawFrontends !== undefined) {
    if (!Array.isArray(rawFrontends)) {
      problems.push({ field: 'frontends', message: 'expected an array' });
    } else {
      for (const [index, entry] of rawFrontends.entries()) {
        const field = `frontends[${String(index)}]`;
        if (typeof entry !== 'object' || entry === null) {
          problems.push({ field, message: 'expected an object' });
          continue;
        }
        const item = entry as Record<string, unknown>;
        const framework = item['framework'];
        if (typeof framework !== 'string' || !(FRONTENDS as readonly string[]).includes(framework)) {
          problems.push({ field: `${field}.framework`, message: `expected one of ${FRONTENDS.join(', ')}` });
          continue;
        }
        if (frontends.some((existing) => existing.framework === framework)) {
          problems.push({ field: `${field}.framework`, message: `duplicate template for ${framework}` });
          continue;
        }
        const styling = oneOf(`${field}.styling`, STYLINGS, item['styling']);
        // daisyui is a Tailwind plugin. Offering it without Tailwind produces a stylesheet that
        // references classes nothing generates, so it is refused here rather than broken later.
        if (styling.includes('daisyui') && !styling.includes('tailwind')) {
          problems.push({ field: `${field}.styling`, message: 'daisyui requires tailwind' });
        }
        const router = item['router'] ?? 'none';
        if (typeof router !== 'string' || !(ROUTERS as readonly string[]).includes(router)) {
          problems.push({ field: `${field}.router`, message: `expected one of ${ROUTERS.join(', ')}` });
        }
        frontends.push({
          framework: framework as Frontend,
          bundler: 'vite',
          typescript: 'strict',
          styling,
          router: (typeof router === 'string' && (ROUTERS as readonly string[]).includes(router)
            ? router
            : 'none') as RouterChoice,
        });
      }
    }
  }

  const packageManagers = oneOf('packageManagers', PACKAGE_MANAGERS, record['packageManagers']);
  const defaultPackageManager = record['defaultPackageManager'] ?? 'bun';
  if (
    typeof defaultPackageManager !== 'string' ||
    !(PACKAGE_MANAGERS as readonly string[]).includes(defaultPackageManager)
  ) {
    problems.push({
      field: 'defaultPackageManager',
      message: `expected one of ${PACKAGE_MANAGERS.join(', ')}`,
    });
  } else if (packageManagers.length > 0 && !packageManagers.includes(defaultPackageManager as PackageManager)) {
    // The default must be one of the supported managers, or `tsir new` would emit instructions for
    // a manager this distribution did not ship.
    problems.push({
      field: 'defaultPackageManager',
      message: `${defaultPackageManager} is not in packageManagers (${packageManagers.join(', ')})`,
    });
  }

  const testing = oneOf('testing', TEST_TOOLING, record['testing']);
  const runtimes = oneOf('runtimes', RUNTIMES, record['runtimes']);
  if (runtimes.length === 0 && record['runtimes'] !== undefined) {
    problems.push({ field: 'runtimes', message: 'at least one runtime is required' });
  }

  const apiTooling = record['apiTooling'];
  const api = {
    openapi: true,
    protobuf: true,
  };
  if (apiTooling !== undefined) {
    if (typeof apiTooling !== 'object' || apiTooling === null) {
      problems.push({ field: 'apiTooling', message: 'expected an object' });
    } else {
      const tooling = apiTooling as Record<string, unknown>;
      api.openapi = tooling['openapi'] === undefined ? true : tooling['openapi'] === true;
      api.protobuf = tooling['protobuf'] === undefined ? true : tooling['protobuf'] === true;
    }
  }

  if (problems.length > 0) return { problems };

  const supplied = (key: keyof DistConfig): boolean => record[key] !== undefined;
  const config: DistConfig = {
    version: 1,
    frontends,
    packageManagers: supplied('packageManagers')
      ? packageManagers
      : DEFAULT_DIST_CONFIG.packageManagers,
    defaultPackageManager: defaultPackageManager as PackageManager,
    testing: supplied('testing') ? testing : DEFAULT_DIST_CONFIG.testing,
    runtimes: supplied('runtimes') ? runtimes : DEFAULT_DIST_CONFIG.runtimes,
    apiTooling: api,
    includeFrontendTypes:
      record['includeFrontendTypes'] === undefined
        ? frontends.length > 0
        : record['includeFrontendTypes'] === true,
  };
  return { config, problems };
}

export interface LoadedDistConfig {
  readonly config: DistConfig;
  /** True when the file was read, false when the defaults were used. */
  readonly fromFile: boolean;
  readonly path: string;
}

/** Reads the committed config, or falls back to the defaults with `fromFile: false`. */
export function loadDistConfig(root: string): { value?: LoadedDistConfig; problems: ConfigProblem[] } {
  const path = join(root, DIST_CONFIG_FILE);
  if (!existsSync(path)) {
    return { value: { config: DEFAULT_DIST_CONFIG, fromFile: false, path }, problems: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    return {
      problems: [
        {
          field: '',
          message: `${DIST_CONFIG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  const { config, problems } = validateDistConfig(parsed);
  if (config === undefined) return { problems };
  return { value: { config, fromFile: true, path }, problems: [] };
}

export function writeDistConfig(root: string, config: DistConfig): string {
  const path = join(root, DIST_CONFIG_FILE);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/**
 * Applies command-line overrides to a config.
 *
 * These are the same answers the wizard collects, which is what makes `--no-interactive` mode a
 * first-class path rather than a degraded one: every question has a flag.
 */
export function applyOverrides(
  config: DistConfig,
  overrides: {
    readonly frontend?: string;
    readonly packageManager?: string;
    readonly styling?: string;
  },
): { config?: DistConfig; problems: ConfigProblem[] } {
  const next: Record<string, unknown> = { ...config };
  if (overrides.packageManager !== undefined) {
    next['packageManagers'] = [overrides.packageManager];
    next['defaultPackageManager'] = overrides.packageManager;
  }
  if (overrides.frontend !== undefined) {
    if (overrides.frontend === 'none') {
      next['frontends'] = [];
    } else {
      const styling = (overrides.styling ?? 'plain').split(',');
      next['frontends'] = [
        { framework: overrides.frontend, bundler: 'vite', typescript: 'strict', styling, router: 'none' },
      ];
    }
  }
  return validateDistConfig(next);
}

/** A one-screen summary of the config, for the wizard's review step and for the build's log. */
export function describeDistConfig(config: DistConfig): readonly (readonly [string, string])[] {
  return [
    [
      'frontends',
      config.frontends.length === 0
        ? 'none (backend only)'
        : config.frontends
            .map((frontend) => {
              const parts: string[] = [frontend.framework, ...frontend.styling];
              if (frontend.router !== 'none') parts.push(`${frontend.router} router`);
              return parts.join(' + ');
            })
            .join(', '),
    ],
    ['package managers', config.packageManagers.join(', ') || 'none'],
    ['default manager', config.defaultPackageManager],
    ['testing', config.testing.join(', ') || 'none'],
    ['runtimes', config.runtimes.join(', ')],
    [
      'api tooling',
      [config.apiTooling.openapi ? 'openapi' : undefined, config.apiTooling.protobuf ? 'protobuf' : undefined]
        .filter((value): value is string => value !== undefined)
        .join(', ') || 'none',
    ],
  ];
}
