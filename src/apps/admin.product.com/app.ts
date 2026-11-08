/**
 * Tsir admin application entry.
 *
 * Composition root. Imports every module so its controllers register into
 * per-module registries, builds the route table, boots the `@tsir/container`
 * container, and exposes the `handler` the platform (Bun, Cloudflare, Lambda)
 * calls.
 *
 * There are no module-level singletons for application services. Infrastructure
 * (db, drizzle, caches, …) is built here and registered as value providers;
 * services and controllers are resolved from the container per request.
 *
 *   boot()  →  createApp()  →  container  →  request scope  →  controller
 *
 * The route table is compiled from `collectRouteEntries()` at boot; for a
 * production build, run `tsir route:compile` to emit `routes.gen.ts` and import
 * that instead (see `routes.gen.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { defineApp } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';
import { createFetchHandler } from '@tsir/http';
import { collectRouteEntries, compileRoutes } from '@tsir/router';
import type { ControllerClass } from '@tsir/router';
import type { Token } from '@tsir/container';

import { runtimeBindings } from './database.ts';
import { consoleLogger } from './modules/system/services/pulse.ts';

// consoleLogger is always configured in this app; assert it for type safety.
const _log = consoleLogger;
if (_log === undefined) {
  throw new Error('consoleLogger is required — pulse bootstrap must include consoleLogger config');
}
const log: NonNullable<typeof _log> = _log;

// Re-export the database registry so the CLI (`tsir migrate`, `tsir db:seed`)
// can find it on the app entry. `runtimeBindings` and `MIGRATIONS_DIR` are
// exposed for the dev server (`serve.ts`) so it can supply a local binding and
// run migrations in-process.
export { databases, runtimeBindings, MIGRATIONS_DIR } from './database.ts';

// Re-export the infrastructure the CLI commands need on the app entry:
//   · `seeders`  — `tsir db:seed`
//   · `queues`   — `tsir queue:work`, `tsir queue:failed`
//   · `events`   — the event bus (its `.jobs()` feeds the queue worker)
//   · `jobs`     — standalone jobs (not derived from event listeners)
//   · `mailers`  — `tsir mail:preview`
export { queues, events } from './modules/system/index.ts';
// A re-export is not a local binding, and `scheduled` below needs one to drain.
import { queues } from './modules/system/index.ts';
export { mailers } from './modules/mail/index.ts';

// Standalone jobs — ones not derived from event listeners. The queue worker
// merges these with `events.jobs()` so every declared job is runnable.
import { SendWelcomeEmailJob } from './modules/system/index.ts';
export const jobs = [SendWelcomeEmailJob] as const;

// Seeders — `tsir db:seed` runs these in `order` order.
import { RolesAndPermissionsSeeder } from './modules/rbac/seeders/roles-and-permissions.seeder.ts';
export const seeders = [RolesAndPermissionsSeeder] as const;

// ── Scheduled work ────────────────────────────────────────────────────────────
//
// `config/queue.ts` declares a `database` connection, and the deploy graph turns every
// connection into a unit: `queue:database`, triggered by a one-minute cron (`QUEUE-17`,
// `CAP-004`). A cron-triggered unit is only deployable if its entry exports `scheduled`,
// so this is the export that makes the declaration true rather than inert.
//
// The core is one line — `drainOnce()` reserves a bounded batch and returns what happened.
// That is deliberately *not* a poll loop: a platform cron has a hard wall-clock budget, and a
// `start()` loop inside it would be killed mid-lease. `batchSize` bounds the work per tick,
// which is the "bounded batch" the capability table promises for Workers and Lambda.
const DRAIN_BATCH = 10;

// `config/queue.ts` is always present in this app, but the type is honest about the general case
// (`@tsir/events` builds no registry when no `queue` block was supplied), so assert it the same way
// `consoleLogger` is asserted above rather than reaching through a non-null assertion at the call
// site — a cron that throws on its first tick is worse than one that refuses to load.
if (queues === undefined) {
  throw new Error('queues is required — config/queue.ts must declare a connection to drain');
}
const queueRegistry: NonNullable<typeof queues> = queues;

/**
 * Both platform shapes accept this signature, so one export serves Workers and Lambda.
 *
 * Workers: `scheduled(controller, env)` with `{ scheduledTime, cron }`.
 * Lambda:  `scheduled(event, context)` with `{ source, detail, time, signal }`.
 * The first argument is only read for a fire time (or, failing that, "now"), so the two
 * shapes collapse to one parameter object — no per-target entry file, no duplicated handler.
 *
 * `env` is copied into `runtimeBindings` exactly as the HTTP handler does, because the
 * `database` driver needs the D1 binding to reach the `queue_jobs` table.
 */
export const scheduled = async (
  event: { readonly scheduledTime?: number; readonly time?: string } = {},
  env?: Record<string, unknown>,
): Promise<void> => {
  if (env !== undefined) Object.assign(runtimeBindings, env);

  const at =
    event.scheduledTime ?? (event.time === undefined ? Date.now() : Date.parse(event.time));

  const results = await queueRegistry.worker('database', { batchSize: DRAIN_BATCH }).drainOnce();

  const counts = { completed: 0, retried: 0, dead: 0 };
  for (const result of results) counts[result.outcome] += 1;

  // Silence on an idle tick: a cron fires every minute, and a log line per empty tick is
  // 1 440 lines a day that say nothing. Failures are the news, so they are what gets logged.
  if (counts.dead > 0 || counts.retried > 0) {
    log.warn('queue.drain', { at, drained: results.length, ...counts });
  }
};

// ── Modules (route tables + providers) ────────────────────────────────────────
import { createAuthModule } from './modules/auth/index.ts';
import { setup } from './modules/setup/index.ts';
import { users } from './modules/users/index.ts';
import { rbac } from './modules/rbac/index.ts';
import { i18n } from './modules/i18n/index.ts';
import { createMailModule } from './modules/mail/index.ts';
import { system } from './modules/system/index.ts';

// ── Controllers + their tokens (for the class → token map) ────────────────────
import { AuthController, authControllerToken } from './modules/auth/http/auth.controller.ts';
import { SetupController, setupControllerToken } from './modules/setup/http/setup.controller.ts';
import { UsersController, usersControllerToken } from './modules/users/http/users.controller.ts';
import {
  RolesController,
  rolesControllerToken,
  PermissionsController,
  permissionsControllerToken,
} from './modules/rbac/http/roles.controller.ts';
import { GroupsController, groupsControllerToken } from './modules/rbac/http/groups.controller.ts';
import { I18nController, i18nControllerToken } from './modules/i18n/http/i18n.controller.ts';
import { MailController, mailControllerToken } from './modules/mail/http/mail.controller.ts';
import {
  SystemController,
  systemControllerToken,
} from './modules/system/http/system.controller.ts';
import {
  RequestLogController,
  requestLogControllerToken,
} from './modules/system/http/request-log.controller.ts';
import { QueueController, queueControllerToken } from './modules/system/http/queue.controller.ts';
import {
  FeatureFlagsController,
  featureFlagsControllerToken,
} from './modules/system/http/feature-flags.controller.ts';
import {
  SearchController,
  searchControllerToken,
} from './modules/system/http/search.controller.ts';
import { requestLoggerToken } from './modules/system/services/request-logger.ts';

// The session guard is resolved from the container at boot.
import { guardToken, createSuperAdminGuard } from './modules/auth/index.ts';
import type { App } from '@tsir/core';
import type { Scope } from '@tsir/container';
import type { Guard } from '@tsir/auth';
import type { AuthPrincipal } from './modules/auth/services/auth.service.ts';

const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  BASE_PATH: env.string({ default: '/' }),
  APP_URL: env.string({ default: 'http://localhost:3000' }),
  CAPTCHA_DISABLED: env.bool({ default: false }),
  CAPTCHA_SECRET: env.string({ default: '' }),
  SOCIALIZE_STATE_SECRET: env.string({ default: '' }),
  SOCIALIZE_GOOGLE_CLIENT_ID: env.string({ default: '' }),
  SOCIALIZE_GOOGLE_CLIENT_SECRET: env.string({ default: '' }),
  SOCIALIZE_GOOGLE_REDIRECT_URI: env.string({ default: '' }),
  SOCIALIZE_GITHUB_CLIENT_ID: env.string({ default: '' }),
  SOCIALIZE_GITHUB_CLIENT_SECRET: env.string({ default: '' }),
  SOCIALIZE_GITHUB_REDIRECT_URI: env.string({ default: '' }),
});

const appSpec = defineApp({
  name: 'admin',
  config: spec,
  modules: (config) => [
    createAuthModule(config).module,
    setup.module,
    users.module,
    rbac.module,
    i18n.module,
    createMailModule(config).module,
    system.module,
  ],
});

export default appSpec;

// ── Controller class → token map ──────────────────────────────────────────────
//
// `createFetchHandler` hands us the controller *class*; we map it to its DI
// token and resolve an instance from the current request scope.
const controllerTokens = new WeakMap<ControllerClass, Token<unknown>>();
controllerTokens.set(AuthController, authControllerToken);
controllerTokens.set(SetupController, setupControllerToken);
controllerTokens.set(UsersController, usersControllerToken);
controllerTokens.set(RolesController, rolesControllerToken);
controllerTokens.set(PermissionsController, permissionsControllerToken);
controllerTokens.set(GroupsController, groupsControllerToken);
controllerTokens.set(I18nController, i18nControllerToken);
controllerTokens.set(MailController, mailControllerToken);
controllerTokens.set(SystemController, systemControllerToken);
controllerTokens.set(RequestLogController, requestLogControllerToken);
controllerTokens.set(QueueController, queueControllerToken);
controllerTokens.set(FeatureFlagsController, featureFlagsControllerToken);
controllerTokens.set(SearchController, searchControllerToken);

// ── Boot ──────────────────────────────────────────────────────────────────────

interface Booted {
  app: App;
  basePath: string;
  apiHandler: ReturnType<typeof createFetchHandler>;
  guard: Guard<AuthPrincipal>;
}

let booted: Promise<Booted> | null = null;

/** Holds the request scope so `resolveController` can find it. */
const requestScope = new AsyncLocalStorage<Scope>();

/**
 * Boot the application: load config, create the container, compose providers,
 * resolve the session guard, and build the HTTP handler. Idempotent.
 */
async function boot(): Promise<Booted> {
  if (booted !== null) return booted;
  booted = (async () => {
    const app = await appSpec.createApp();
    const guard = app.container.resolve(guardToken);
    const superAdminGuard = createSuperAdminGuard();

    const apiHandler = createFetchHandler(compileRoutes(collectRouteEntries()), {
      guards: { session: guard, superAdmin: superAdminGuard },
      resolveController: (controllerClass: ControllerClass) => {
        const tok = controllerTokens.get(controllerClass);
        if (tok === undefined) {
          throw new Error(`no DI token registered for controller ${controllerClass.name}`);
        }
        const scope = requestScope.getStore();
        if (scope === undefined) {
          throw new Error('resolveController called outside a request scope');
        }
        return scope.resolve(tok);
      },
      onError: (error) => {
        log.error('http.error', error);
        return undefined;
      },
    });

    const basePath = normalizeBasePath(
      (app.config as { values: { BASE_PATH: string } }).values.BASE_PATH,
    );

    return { app, basePath, apiHandler, guard };
  })();
  return booted;
}

/**
 * Normalise a base path to a leading-slash, no-trailing-slash form (or `''`
 * for the root). `'/admin/'`, `'admin'`, and `'/admin'` all become `/admin`.
 */
function normalizeBasePath(raw: string): string {
  let base = raw.trim();
  if (base === '' || base === '/') return '';
  if (!base.startsWith('/')) base = `/${base}`;
  if (base.endsWith('/')) base = base.slice(0, -1);
  return base;
}

// ── Static file serving ───────────────────────────────────────────────────────

const PUBLIC_DIR = join(import.meta.dir, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(pathname: string): Response | null {
  const safe = normalize(pathname).replace(/^\/+/u, '');
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return null;
  if (!existsSync(file)) return null;
  if (statSync(file).isDirectory()) return null;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  return new Response(readFileSync(file), {
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  });
}

function serveIndex(basePath: string): Response {
  const raw = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const html = raw.replaceAll('__BASE_PATH__', basePath);
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * The app handler.
 *
 * Cloudflare passes the environment (bindings) as the second argument. The D1
 * binding (`env.DB`) is copied into `runtimeBindings`, where the framework's
 * deferred D1 driver finds it on the first query.
 *
 * Each request gets its own container scope; controllers are resolved from it
 * via `resolveController`.
 */
export const handler = async (
  request: Request,
  env?: Record<string, unknown>,
): Promise<Response> => {
  const { app, basePath, apiHandler, guard } = await boot();

  if (env !== undefined) {
    Object.assign(runtimeBindings, env);
  }

  const url = new URL(request.url);

  if (basePath !== '' && url.pathname === basePath) {
    return new Response(null, {
      status: 308,
      headers: { location: `${basePath}/${url.search}` },
    });
  }

  const pathname =
    basePath !== '' && url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || '/'
      : url.pathname;

  const rewritten = new URL(request.url);
  rewritten.pathname = pathname;
  const routed = new Request(rewritten.toString(), request);

  const isApi = pathname.startsWith('/api/');

  const scope = app.createScope('request', crypto.randomUUID());
  const startedAt = performance.now();
  let status = 500;
  try {
    const response = await requestScope.run(scope, async () => {
      // Resolve the request logger from the scope.
      const requestLogger = scope.resolve(requestLoggerToken);

      // Resolve the principal for the audit trail. Failures to authenticate are
      // logged as anonymous (null subject).
      let principalSubject: string | undefined;
      try {
        const principal = await guard({ request: routed });
        if (principal !== null) principalSubject = principal.subject;
      } catch {
        principalSubject = undefined;
      }

      let innerResponse: Response;
      try {
        // Non-GET requests always go through the API handler.
        if (routed.method !== 'GET') {
          innerResponse = await apiHandler(routed);
        } else if (!isApi) {
          const staticResponse = serveStatic(pathname);
          if (staticResponse !== null) innerResponse = staticResponse;
          else {
            const apiResponse = await apiHandler(routed);
            innerResponse = apiResponse.status !== 404 ? apiResponse : serveIndex(basePath);
          }
        } else {
          innerResponse = await apiHandler(routed);
        }
      } catch (error) {
        status = 500;
        // Mirror the onError behaviour in createFetchHandler.
        log.error('http.error', error);
        innerResponse = new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }

      status = innerResponse.status;

      // Fire-and-forget the request log; do not let it delay the response.
      const connectingIp = routed.headers.get('cf-connecting-ip');
      const userAgent = routed.headers.get('user-agent');
      void requestLogger
        .record({
          method: routed.method,
          path: pathname,
          status,
          durationMs: Math.round(performance.now() - startedAt),
          ...(principalSubject !== undefined ? { principalSubject } : {}),
          ...(connectingIp !== null ? { ip: connectingIp } : {}),
          ...(userAgent !== null ? { userAgent } : {}),
        })
        .catch((err: unknown) => log.error('request-log.persist_failed', err));

      return innerResponse;
    });

    return response;
  } finally {
    await scope.dispose();
  }
};
