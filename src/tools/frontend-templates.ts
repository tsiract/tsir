/**
 * The frontend templates a distribution ships.
 *
 * `make dist` shipped a backend and nothing else while the wizard offered three frontends — a
 * configuration option that produced no files. This module is the missing half: for every frontend
 * the distribution is configured to support it writes a complete, installable, typechecking SPA
 * into `dist/templates/<framework>/`.
 *
 * Three rules shape it:
 *
 *   1. **The backend is shared, not copied.** A template is a *frontend in front of the same Tsir
 *      application*. It publishes an HTTP contract (`src/api.ts`), Vite proxies `/api` to
 *      `tsir dev`, and the template contains no server code, no database and no second router.
 *      `tsir new` remains the only thing that creates a backend.
 *   2. **Vite conventions, Tsir integration.** `index.html`, `src/main.ts`, `vite.config.ts` and a
 *      strict `tsconfig.json` — the layout a Vite developer expects — plus the one Tsir-specific
 *      thing: the API base comes from a typed module, and the only environment variable a
 *      frontend reads is a `VITE_`-prefixed, non-secret one.
 *   3. **Nothing is written that is not asked for.** An empty `frontends` list writes nothing.
 *      Styling is opt-in per template (Tailwind, DaisyUI on top of it, or plain CSS), and client
 *      routing is opt-in (`router`) rather than assumed.
 *
 * Versions are pinned to the majors the plugin APIs here are written against, because a template is
 * a starting point somebody will read: one that resolves differently every month is not reproducible.
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderStub } from '../framework/console/src/stub.ts';

export type Frontend = 'svelte' | 'react' | 'vue';
export type Styling = 'tailwind' | 'daisyui' | 'plain';
export type RouterChoice = 'native' | 'router' | 'none';

export interface FrontendIntegration {
  readonly framework: Frontend;
  readonly styling: readonly Styling[];
  readonly router: RouterChoice;
}

/** What one emitted template contains, for the build summary and `manifest.json`. */
export interface EmittedTemplate {
  readonly framework: Frontend;
  readonly files: number;
  readonly bytes: number;
  readonly styling: readonly Styling[];
  readonly router: RouterChoice;
}

/** A `package.json` dependency: `['svelte', '^5.57.3']`. Tuples, so a scoped name cannot be split. */
type Dependency = readonly [name: string, range: string];

/**
 * The versions this repository resolved against the registry while writing the templates.
 *
 * Pinned to a major (or a caret on the exact resolved patch) because a template is a starting
 * point that must install the same way twice.
 */
export const FRONTEND_VERSIONS = {
  svelte: '^5.57.3',
  sveltePlugin: '@sveltejs/vite-plugin-svelte',
  sveltePluginRange: '^6.2.4',
  svelteRouter: ['svelte-spa-router', '^4.0.2'] as Dependency,
  svelteTsconfig: ['@tsconfig/svelte', '^5'] as Dependency,
  react: '^19.3.1',
  reactPlugin: ['@vitejs/plugin-react', '^5'] as Dependency,
  reactTypes: [
    ['@types/react', '^19'],
    ['@types/react-dom', '^19'],
  ] as readonly Dependency[],
  reactRouter: ['react-router-dom', '^7.18.5'] as Dependency,
  vue: '^3.5.45',
  vuePlugin: ['@vitejs/plugin-vue', '^6'] as Dependency,
  vueRouter: ['vue-router', '^4.6.4'] as Dependency,
  vueTsc: ['vue-tsc', '^2'] as Dependency,
  vite: ['vite', '^7.3.7'] as Dependency,
  typescript: ['typescript', '^5'] as Dependency,
  tailwind: [
    ['tailwindcss', '^4.3.5'],
    ['@tailwindcss/vite', '^4'],
  ] as readonly Dependency[],
  daisyui: ['daisyui', '^5.7.50'] as Dependency,
} as const;

/** Dev-server port per template, so two templates can run side by side. */
/** The dev port each template's `vite.config.ts` defaults to. One source of truth: the README and the
 * template must not disagree about where `bun run dev` lands. */
export const FRONTEND_PORTS: Readonly<Record<Frontend, number>> = {
  svelte: 5173,
  react: 5174,
  vue: 5175,
};

const PORTS = FRONTEND_PORTS;

/** The entry file name `index.html` must reference, per framework. */
const ENTRY: Readonly<Record<Frontend, string>> = {
  svelte: 'src/main.ts',
  react: 'src/main.tsx',
  vue: 'src/main.ts',
};

const has = (styling: readonly Styling[], value: Styling): boolean => styling.includes(value);

/** The one dependency list a template's `package.json` gets, deduplicated and ordered. */
function manifest(
  framework: Frontend,
  styling: readonly Styling[],
  router: RouterChoice,
): {
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
} {
  const dependencies: Dependency[] = [];
  const devDependencies: Dependency[] = [FRONTEND_VERSIONS.vite, FRONTEND_VERSIONS.typescript];

  if (framework === 'svelte') {
    dependencies.push(['svelte', FRONTEND_VERSIONS.svelte]);
    devDependencies.push([FRONTEND_VERSIONS.sveltePlugin, FRONTEND_VERSIONS.sveltePluginRange]);
    devDependencies.push(FRONTEND_VERSIONS.svelteTsconfig);
    if (router === 'router') dependencies.push(FRONTEND_VERSIONS.svelteRouter);
  } else if (framework === 'react') {
    dependencies.push(['react', FRONTEND_VERSIONS.react], ['react-dom', FRONTEND_VERSIONS.react]);
    devDependencies.push(FRONTEND_VERSIONS.reactPlugin, ...FRONTEND_VERSIONS.reactTypes);
    if (router === 'router') dependencies.push(FRONTEND_VERSIONS.reactRouter);
  } else {
    dependencies.push(['vue', FRONTEND_VERSIONS.vue]);
    devDependencies.push(FRONTEND_VERSIONS.vuePlugin, FRONTEND_VERSIONS.vueTsc);
    if (router === 'router') dependencies.push(FRONTEND_VERSIONS.vueRouter);
  }

  if (has(styling, 'tailwind')) devDependencies.push(...FRONTEND_VERSIONS.tailwind);
  // DaisyUI is a Tailwind plugin; `dist-config.ts` refuses the pair without Tailwind, so reaching
  // here with `daisyui` means Tailwind is present too.
  if (has(styling, 'daisyui')) devDependencies.push(FRONTEND_VERSIONS.daisyui);

  const toRecord = (entries: readonly Dependency[]): Record<string, string> =>
    Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
  return { dependencies: toRecord(dependencies), devDependencies: toRecord(devDependencies) };
}

/**
 * Builds one template's files.
 *
 * Pure: a path → contents map, and the filesystem is untouched. The split exists so the file set
 * can be asserted without writing anything, and so a template can never be left half-emitted by a
 * failure in the middle of a loop.
 */
export function templateFiles(integration: FrontendIntegration): ReadonlyMap<string, string> {
  const { framework, styling, router } = integration;
  const files = new Map<string, string>();
  const tailwind = has(styling, 'tailwind');
  const pluginCall =
    framework === 'svelte' ? 'svelte()' : framework === 'react' ? 'react()' : 'vue()';
  const pluginModule =
    framework === 'svelte'
      ? `import { svelte } from '${FRONTEND_VERSIONS.sveltePlugin}';`
      : framework === 'react'
        ? `import react from '${FRONTEND_VERSIONS.reactPlugin[0]}';`
        : `import vue from '${FRONTEND_VERSIONS.vuePlugin[0]}';`;

  files.set(
    'index.html',
    renderStub('frontend/index.html', {
      name: `tsir ${framework} frontend`,
      entry: `/${ENTRY[framework]}`,
    }),
  );
  files.set(
    'vite.config.ts',
    renderStub('frontend/vite.config.ts', {
      pluginImport: `${pluginModule}${tailwind ? "\nimport tailwindcss from '@tailwindcss/vite';" : ''}`,
      pluginCall,
      tailwindPlugin: tailwind ? ', tailwindcss()' : '',
      port: String(PORTS[framework]),
    }),
  );
  files.set(
    'tsconfig.json',
    renderStub('frontend/tsconfig.json', {
      svelteInclude: framework === 'svelte' ? ', "src/**/*.svelte"' : '',
      // JSX is a compiler flag, not a convention: without these three React's `.tsx` files are
      // parsed as TypeScript and every element is `TS17004: Cannot use JSX unless '--jsx' is provided`.
      jsx: framework === 'react' ? '\n    "jsx": "react-jsx",' : '',
      // The templates import `./api.ts` with its extension (Bun and Vite both resolve it, and it
      // keeps the file honest under `verbatimModuleSyntax`), which TypeScript only allows with this.
      allowImportingTsExtensions: '\n    "allowImportingTsExtensions": true,',
    }),
  );
  files.set('src/api.ts', API_MODULE);
  files.set('README.md', readme(framework, styling, router));

  // The stylesheet exists only when there is a styling step, so a plain-CSS template has no
  // import of a file nobody generated.
  if (tailwind) {
    files.set(
      'src/app.css',
      has(styling, 'daisyui')
        ? '@import "tailwindcss";\n@plugin "daisyui" {\n  themes: nord, abyss;\n}\n'
        : '@import "tailwindcss";\n',
    );
  }

  for (const [path, contents] of frameworkFiles(framework, styling, router))
    files.set(path, contents);

  const { dependencies, devDependencies } = manifest(framework, styling, router);
  files.set(
    'package.json',
    `${JSON.stringify(
      {
        name: `tsir-${framework}-frontend`,
        private: true,
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'vite build',
          preview: 'vite preview',
          typecheck: framework === 'vue' ? 'vue-tsc --noEmit' : 'tsc --noEmit',
        },
        dependencies,
        devDependencies,
      },
      null,
      2,
    )}\n`,
  );
  return files;
}

/** Emits every configured template under `<dist>/templates/`, and reports what was written. */
export async function emitFrontendTemplates(
  dist: string,
  integrations: readonly FrontendIntegration[],
): Promise<readonly EmittedTemplate[]> {
  const emitted: EmittedTemplate[] = [];
  for (const integration of integrations) {
    const root = join(dist, 'templates', integration.framework);
    const files = templateFiles(integration);
    for (const [path, contents] of files) {
      const target = join(root, path);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, contents);
    }
    let bytes = 0;
    let count = 0;
    for (const path of await walk(root)) {
      bytes += (await stat(path)).size;
      count += 1;
    }
    emitted.push({
      framework: integration.framework,
      files: count,
      bytes,
      styling: integration.styling,
      router: integration.router,
    });
  }
  return emitted;
}

/** Every file under `dir`, recursively. */
async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

/**
 * The API client every template shares.
 *
 * One typed module instead of a `fetch` call in every component: a template that scatters request
 * shapes teaches the wrong habit, and the base URL has exactly one right answer per environment.
 */
const API_MODULE = `/**
 * The application's HTTP contract, in one place.
 *
 * The only environment variable a frontend may read is a \`VITE_\`-prefixed one, and the only one
 * here is a URL. Everything else — database passwords, signing keys — belongs to the backend, and
 * a server secret inside a bundle is a leaked secret.
 *
 * The default base is empty, so requests go to the dev-server origin and \`vite.config.ts\`'s
 * \`server.proxy\` forwards \`/api\` to the Tsir application. Point \`VITE_API_BASE_URL\` at the
 * deployed backend to build for production.
 */
const BASE: string = import.meta.env['VITE_API_BASE_URL'] ?? '';

export interface ApiError {
  readonly status: number;
  readonly message: string;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(\`\${BASE}\${path}\`, {
    headers: { accept: 'application/json', ...init.headers },
    ...init,
  });
  if (!response.ok) {
    const error: ApiError = {
      status: response.status,
      message: \`\${init.method ?? 'GET'} \${path} failed\`,
    };
    throw error;
  }
  return (await response.json()) as T;
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', ...(signal === undefined ? {} : { signal }) });
}

export function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The greeting the scaffolded backend serves at \`/api/welcome\`. */
export const fetchWelcome = (signal?: AbortSignal): Promise<{ readonly message: string }> =>
  getJson<{ readonly message: string }>('/api/welcome', signal);
`;

function frameworkFiles(
  framework: Frontend,
  styling: readonly Styling[],
  router: RouterChoice,
): readonly (readonly [string, string])[] {
  const useRouter = router === 'router';
  const theme = has(styling, 'daisyui') ? 'bg-base-100 text-base-content' : '';
  const themeAttr = theme === '' ? '' : ` data-theme="nord"`;
  if (framework === 'svelte') {
    return [
      ['src/main.ts', SVELTE_MAIN],
      [
        'src/App.svelte',
        SVELTE_APP.replaceAll('{{theme}}', theme).replaceAll('{{themeAttr}}', themeAttr),
      ],
      ...(useRouter ? ([['src/routes.ts', SVELTE_ROUTES]] as const) : []),
    ];
  }
  if (framework === 'react') {
    return [
      ['src/main.tsx', REACT_MAIN],
      [
        'src/App.tsx',
        REACT_APP.replaceAll('{{theme}}', theme).replaceAll('{{themeAttr}}', themeAttr),
      ],
      ...(useRouter ? ([['src/pages/Home.tsx', REACT_HOME]] as const) : []),
    ];
  }
  return [
    [
      'src/main.ts',
      VUE_MAIN.replaceAll(
        '{{routerImport}}',
        useRouter ? "import { router } from './router.ts';" : '',
      ).replaceAll('{{routerUse}}', useRouter ? 'app.use(router);\n' : ''),
    ],
    ['src/App.vue', VUE_APP.replaceAll('{{theme}}', theme).replaceAll('{{themeAttr}}', themeAttr)],
    ...(useRouter ? ([['src/router.ts', VUE_ROUTER]] as const) : []),
  ];
}

function readme(framework: Frontend, styling: readonly Styling[], router: RouterChoice): string {
  const style = styling.length === 0 ? 'plain CSS' : styling.join(' + ');
  return `# Tsir ${framework} frontend

A single-page ${framework} application in front of a Tsir backend. It is a template the
distribution ships, not a backend: the API it calls is a separate Tsir application.

\`\`\`bash
bun install
bun run dev          # http://localhost:${String(PORTS[framework])} — proxies /api to tsir dev
bun run typecheck
bun run build
\`\`\`

| | |
| --- | --- |
| Styling | ${style} |
| Client routing | ${router === 'none' ? 'none (one page)' : router} |
| API contract | \`src/api.ts\` — \`VITE_API_BASE_URL\`, empty by default |

Start the backend with \`tsir dev\` in your application directory before \`bun run dev\` here; the
proxy targets \`http://127.0.0.1:3000\`. Point \`VITE_API_BASE_URL\` at a deployed backend to build
for production.
`;
}

const SVELTE_MAIN = `import { mount } from 'svelte';

import App from './App.svelte';
{{cssImport}}

// \`mount\` is the Svelte 5 entrypoint; the Svelte 4 \`new App({ target })\` form is gone.
const app = mount(App, { target: document.getElementById('app') as HTMLElement });

export default app;
`.replace('{{cssImport}}', '');

const SVELTE_APP = `<script lang="ts">
  import { fetchWelcome } from './api.ts';

  // The template fetches once and shows three states, because a frontend that only renders the
  // happy path hides the two cases that actually break in development: no backend yet, and a
  // backend that answered with an error.
  let message: string | null = null;
  let error: string | null = null;

  const load = async (): Promise<void> => {
    error = null;
    try {
      message = (await fetchWelcome()).message;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  };

  void load();
</script>

<main class="{{theme}}"{{themeAttr}}>
  <h1>Tsir frontend</h1>
  {#if message !== null}
    <p>{message}</p>
  {:else if error !== null}
    <p role="alert">{error} — is \`tsir dev\` running?</p>
  {:else}
    <p>loading…</p>
  {/if}
</main>

<style>
  main {
    font-family: system-ui, sans-serif;
    margin: 4rem auto;
    max-width: 40rem;
    padding: 0 1.5rem;
  }
  h1 {
    font-size: 1.75rem;
  }
</style>
`;

const SVELTE_ROUTES = `import type { Component } from 'svelte';

import Home from './App.svelte';

/**
 * The route table for \`svelte-spa-router\`. Adding a page is a component plus a line here; a
 * page that is never listed is a page with no URL, which is the one thing a router exists to fix.
 */
export const routes: Readonly<Record<string, Component>> = {
  '/': Home,
};
`;

const REACT_MAIN = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';

const container = document.getElementById('app');
if (container === null) throw new Error('index.html has no #app element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

const REACT_APP = `import { useEffect, useState } from 'react';

import { fetchWelcome } from './api.ts';

/**
 * The welcome screen. Three states, because "no backend yet" and "the backend failed" are the two
 * things a frontend developer hits first and neither looks like the happy path.
 */
export default function App(): React.JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchWelcome(controller.signal)
      .then((body) => {
        setMessage(body.message);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <main className="{{theme}}"{{themeAttr}}>
      <h1>Tsir frontend</h1>
      {message !== null ? (
        <p>{message}</p>
      ) : error !== null ? (
        <p role="alert">
          {error} — is <code>tsir dev</code> running?
        </p>
      ) : (
        <p>loading…</p>
      )}
    </main>
  );
}
`;

const REACT_HOME = `export default function Home(): React.JSX.Element {
  return <p>Home page. Add a route in \`App.tsx\` for every page you add here.</p>;
}
`;

const VUE_MAIN = `import { createApp } from 'vue';

import App from './App.vue';
{{routerImport}}

const app = createApp(App);
{{routerUse}}
app.mount('#app');
`;

const VUE_APP = `<script setup lang="ts">
  import { onMounted, ref } from 'vue';

  import { fetchWelcome } from './api.ts';

  const message = ref<string | null>(null);
  const error = ref<string | null>(null);

  onMounted(async () => {
    try {
      message.value = (await fetchWelcome()).message;
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  });
</script>

<template>
  <main class="{{theme}}"{{themeAttr}}>
    <h1>Tsir frontend</h1>
    <p v-if="message !== null">{{ message }}</p>
    <p v-else-if="error !== null" role="alert">{{ error }} — is \`tsir dev\` running?</p>
    <p v-else>loading…</p>
  </main>
</template>

<style scoped>
main {
  font-family: system-ui, sans-serif;
  margin: 4rem auto;
  max-width: 40rem;
  padding: 0 1.5rem;
}
</style>
`;

const VUE_ROUTER = `import { createRouter, createWebHistory } from 'vue-router';

import App from './App.vue';

/**
 * Every page is a line here, and a page is a component. \`App.vue\` is the shell the app mounts,
 * so the root path renders it directly until there are more pages.
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: App }],
});
`;
