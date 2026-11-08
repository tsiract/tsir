/**
 * The `make dist` configuration wizard.
 *
 * `make dist` does not compile and copy; it configures *what the distribution offers* and then
 * builds it. This module is the configuration half: nine steps, each with a default, every answer
 * revisitable, and a review screen before anything is written.
 *
 * Three properties matter more than the screen:
 *
 *   1. **Nothing changes until the end.** Answers accumulate in memory and are written once, after
 *      the review confirms them. An abandoned wizard leaves the committed file untouched.
 *   2. **A rerun reports what it found.** Running `make dist` when a configuration exists says so
 *      and offers to keep it; it never silently replaces a product decision with a default.
 *   3. **Every step has a flag.** `--frontend`, `--package-manager`, `--styling` answer the same
 *      questions, so a CI build and a person's wizard produce the same file.
 */

import type { DistConfig, Frontend, PackageManager, Styling } from './dist-config.ts';
import { DEFAULT_DIST_CONFIG, DIST_CONFIG_FILE, validateDistConfig } from './dist-config.ts';
import { type Palette, createPalette, frameworkVersion } from '../framework/tui/src/index.ts';
import { banner } from '../framework/tui/src/branding.ts';
import {
  confirm,
  multiSelect,
  PromptCancelled,
  select,
  type CliRenderer,
} from '../framework/tui/src/ui.ts';

export type WizardOutcome =
  | { readonly kind: 'configured'; readonly config: DistConfig }
  | { readonly kind: 'kept'; readonly config: DistConfig }
  | { readonly kind: 'cancelled' };

export interface WizardOptions {
  readonly renderer: CliRenderer;
  /** The configuration already committed, if any. */
  readonly existing: { readonly config: DistConfig; readonly fromFile: boolean } | undefined;
  readonly palette?: Palette;
}

/** One line describing a choice, used in the review screen and the options themselves. */
const FRONTEND_DESCRIPTIONS: Readonly<Record<Frontend, string>> = {
  svelte: 'Svelte 5 + Vite. Compiled output, no virtual DOM.',
  react: 'React 19 + Vite, with JSX configured for strict TypeScript.',
  vue: 'Vue 3 + Vite. Single-file components.',
};

/**
 * Runs the wizard and returns what the build should do.
 *
 * The first question is the only one that can shortcut the rest: keeping an existing configuration
 * ends the wizard immediately, because re-answering eight questions to change nothing is how people
 * learn to stop running `make dist`.
 */
export async function runDistWizard(options: WizardOptions): Promise<WizardOutcome> {
  const { renderer } = options;
  const palette = options.palette ?? createPalette();
  const existing = options.existing;

  if (existing !== undefined && existing.fromFile) {
    const reuse = await select(renderer, {
      palette,
      message: 'This repository already has a distribution configuration',
      hint: `${DIST_CONFIG_FILE} is committed. Rebuilding it with the same answers keeps releases comparable.`,
      options: [
        {
          value: 'keep',
          label: 'Rebuild with the saved configuration',
          description: 'No questions. The file is left as it is.',
        },
        {
          value: 'reconfigure',
          label: 'Reconfigure the distribution',
          description: 'Walk the wizard and overwrite the file.',
        },
      ],
      defaultValue: 'keep',
    });
    if (reuse === 'keep') return { kind: 'kept', config: existing.config };
  }

  // Step 1 — frontend frameworks. Multi-select: a distribution may support several, and each
  // template shares the same backend.
  const frameworks = await multiSelect<Frontend>(renderer, {
    palette,
    message: 'Which frontend frameworks should this distribution support?',
    hint: 'This selects the templates dist/ ships. An application still chooses nothing — it is created with one.',
    options: [
      {
        value: 'svelte',
        label: 'Svelte',
        description: FRONTEND_DESCRIPTIONS.svelte,
        selected: false,
      },
      { value: 'react', label: 'React', description: FRONTEND_DESCRIPTIONS.react },
      { value: 'vue', label: 'Vue', description: FRONTEND_DESCRIPTIONS.vue },
    ],
  });

  // Steps 2–5 — frontend tooling, styling and routing, per framework. Cancelling here returns to the
  // framework list rather than abandoning the wizard, which is what `Esc` promises.
  const frontends: DistConfig['frontends'][number][] = [];
  try {
    for (const framework of frameworks) {
      const chosen = await multiSelect<Styling>(renderer, {
        palette,
        message: `Styling for ${framework}`,
        hint: 'Tailwind 4 compiles a single stylesheet; DaisyUI is a Tailwind plugin.',
        options: [
          {
            value: 'tailwind',
            label: 'Tailwind CSS',
            description: 'Utility classes, one generated stylesheet.',
          },
          {
            value: 'daisyui',
            label: 'DaisyUI',
            description: 'Tailwind plugin. Requires Tailwind.',
          },
          {
            value: 'plain',
            label: 'Plain CSS',
            description: 'No build-time styling. Smallest template.',
          },
        ],
        requireOne: true,
      });
      // The validator refuses this pair, so the wizard completes it rather than letting the build
      // fail later — DaisyUI is a Tailwind plugin, and choosing it *means* choosing Tailwind.
      const styling: Styling[] = [...chosen];
      if (styling.includes('daisyui') && !styling.includes('tailwind')) styling.push('tailwind');
      const router = await select<DistConfig['frontends'][number]['router']>(renderer, {
        palette,
        message: `Client routing for ${framework}`,
        hint: 'A single-page app with no router has no deep links. Server routes are unaffected.',
        options: [
          {
            value: 'none',
            label: 'No client router',
            description: 'One page. The smallest template.',
          },
          {
            value: 'router',
            label: 'Framework router',
            description: 'History-mode routing, client-rendered.',
          },
          {
            value: 'native',
            label: 'Framework-native approach',
            description: "Whatever the framework's ecosystem prefers.",
          },
        ],
        defaultValue: 'none',
      });
      frontends.push({ framework, bundler: 'vite', typescript: 'strict', styling, router });
    }
  } catch (error: unknown) {
    if (error instanceof PromptCancelled) return { kind: 'cancelled' };
    throw error;
  }

  // Step 3 — package managers. The default is what a generated application gets; the list is what
  // the distribution documents and its templates mention.
  const managers = await multiSelect<PackageManager>(renderer, {
    palette,
    message: 'Which package managers should applications support?',
    hint: 'Every application uses exactly one. This list decides what the docs and templates offer.',
    options: [
      {
        value: 'bun',
        label: 'Bun',
        description: 'Default. The runtime the framework is developed on.',
        selected: true,
      },
      { value: 'npm', label: 'npm', description: 'Present everywhere Node is.' },
      { value: 'pnpm', label: 'pnpm', description: 'Strict node_modules, fast installs.' },
    ],
    requireOne: true,
  });
  // `requireOne` on the multi-select means `managers` has at least one entry; `first` expresses that
  // without an assertion, and falls back to the schema default if that ever stops being true.
  const first = managers[0] ?? DEFAULT_DIST_CONFIG.defaultPackageManager;
  const defaultManager: PackageManager =
    managers.length === 1
      ? first
      : await select<PackageManager>(renderer, {
          palette,
          message: 'Which package manager should `tsir new` use by default?',
          options: managers.map((manager) => ({ value: manager, label: manager })),
          defaultValue: managers.includes('bun') ? 'bun' : first,
        });

  // Step 6 — testing and quality.
  const testing = await multiSelect<DistConfig['testing'][number]>(renderer, {
    palette,
    message: 'Testing and code quality for generated applications',
    hint: 'A minimal preset stays minimal: these add dev dependencies and config to every app.',
    options: [
      {
        value: 'eslint',
        label: 'ESLint',
        description: 'Type-aware lint, matching the framework.',
        selected: true,
      },
      { value: 'prettier', label: 'Prettier', description: 'Formatting.', selected: true },
      { value: 'vitest', label: 'Vitest', description: 'Unit tests for frontend code.' },
      { value: 'playwright', label: 'Playwright', description: 'Browser end-to-end tests.' },
    ],
  });

  // Step 8 — runtimes. Only what the deploy packages implement.
  const runtimes = await multiSelect<DistConfig['runtimes'][number]>(renderer, {
    palette,
    message: 'Which runtime targets should generated applications support?',
    hint: 'Only targets with an implementation in @tsir/deploy are listed.',
    options: [
      { value: 'bun', label: 'Bun', description: 'Long-running server.', selected: true },
      {
        value: 'cloudflare-workers',
        label: 'Cloudflare Workers',
        description: 'Fetch handler + D1.',
        selected: true,
      },
      {
        value: 'aws-lambda',
        label: 'AWS Lambda',
        description: 'One handler per deploy unit.',
        selected: true,
      },
    ],
    requireOne: true,
  });

  // Step 7 — API tooling.
  const apiTooling = await multiSelect<'openapi' | 'protobuf'>(renderer, {
    palette,
    message: 'API description tooling',
    hint: 'Ships the generator commands and their documentation in this distribution.',
    options: [
      {
        value: 'openapi',
        label: 'OpenAPI',
        description: '`tsir openapi:generate` from your route contracts.',
        selected: true,
      },
      {
        value: 'protobuf',
        label: 'Protocol Buffers',
        description: 'Application-owned .proto files.',
        selected: true,
      },
    ],
  });

  const candidate: DistConfig = {
    version: 1,
    frontends,
    packageManagers: managers,
    defaultPackageManager: defaultManager,
    testing,
    runtimes,
    apiTooling: {
      openapi: apiTooling.includes('openapi'),
      protobuf: apiTooling.includes('protobuf'),
    },
    includeFrontendTypes: frontends.length > 0,
  };

  const validation = validateDistConfig(candidate);
  if (validation.config === undefined) {
    // The wizard cannot construct an invalid configuration: it asks each question with valid
    // options. If this throws, the wizard itself has a bug, and failing loudly beats writing a file
    // the build will reject later.
    throw new Error(
      `the wizard produced an invalid configuration: ${validation.problems
        .map((problem) => `${problem.field}: ${problem.message}`)
        .join('; ')}`,
    );
  }

  // Step 9 — review, then confirm.
  const accepted = await reviewAndConfirm(renderer, validation.config, palette);
  if (!accepted) return { kind: 'cancelled' };
  return { kind: 'configured', config: validation.config };
}

/**
 * The review screen.
 *
 * Drawn as a prompt body rather than as text so it appears where the questions appeared: the
 * developer reads the summary in the same place they answered, and `n` returns them to the start
 * rather than dropping them back into a shell with nothing written.
 */
async function reviewAndConfirm(
  renderer: CliRenderer,
  config: DistConfig,
  palette: Palette,
): Promise<boolean> {
  const rows = describe(config);
  const body = rows.map(([label, value]) => `${label.padEnd(18)}${value}`);
  const confirmed = await confirm(renderer, {
    palette,
    message: 'Generate the distribution with these settings?',
    hint: body.join('\n'),
    defaultValue: true,
  });
  return confirmed;
}

function describe(config: DistConfig): readonly (readonly [string, string])[] {
  const frontends =
    config.frontends.length === 0
      ? 'none (backend only)'
      : config.frontends
          .map(
            (frontend) =>
              `${frontend.framework}${frontend.styling.length > 0 ? ` + ${frontend.styling.join(' + ')}` : ''}`,
          )
          .join(', ');
  return [
    ['frontends', frontends],
    ['package managers', config.packageManagers.join(', ')],
    ['default manager', config.defaultPackageManager],
    ['testing', config.testing.join(', ') || 'none'],
    ['runtimes', config.runtimes.join(', ')],
    [
      'api tooling',
      [
        config.apiTooling.openapi ? 'openapi' : undefined,
        config.apiTooling.protobuf ? 'protobuf' : undefined,
      ]
        .filter((value): value is string => value !== undefined)
        .join(', ') || 'none',
    ],
  ];
}

/** The header the wizard opens with. Kept here so `make dist` looks like `make dev`. */
export function wizardBanner(palette: Palette = createPalette()): string {
  return banner({
    palette,
    title: 'tsir',
    subtitle: 'Distribution configuration',
    version: frameworkVersion(new URL('../../framework/tui/src/index.ts', import.meta.url).href),
    notes: [
      'Answers are written to tsir.dist.config.json and committed. Nothing is built until you confirm.',
    ],
  });
}

/** The distribution a wizard run would produce without asking anything. Exported for tests. */
export const HEADLESS_DEFAULTS = DEFAULT_DIST_CONFIG;
