/**
 * The HTTP example application.
 *
 * Two things worth noticing:
 *
 * 1. The route table is *generated* (`tsir route:compile`) and imported, not
 *    compiled from decorator metadata at boot. `routes.gen.ts` imports the
 *    controllers it needs, so the same code runs — without the discovery and
 *    validation step that produced the file. `make route-compile --check` keeps
 *    it honest, and `app.test.ts` asserts the generated table and a freshly
 *    compiled one are equivalent.
 * 2. The app itself is still a plain `defineApp`: configuration, modules, a
 *    manifest. HTTP does not get a special boot path.
 * 3. Routes belong to modules. `users` and `media`
 *    each own a registry, so `harness.routes('media')` in a test returns the
 *    uploads and nothing else.
 */

import { defineApp } from '@tsir/core';
import { defineConfig, env } from '@tsir/config';
import { type Guard, createFetchHandler } from '@tsir/http';
import { readMultipart } from '@tsir/http/multipart';

import { media } from './media/index.ts';
import { users } from './users/index.ts';
import { routes } from './routes.gen.ts';

// Importing the generated table is what registers every controller: it imports
// them, the decorators run, and each one lands in its own module's registry.

export const spec = defineConfig({
  APP_ENV: env.enum(['development', 'test', 'production'], { default: 'development' }),
  APP_NAME: env.string({ default: 'http-example' }),
});

/**
 * The application declares modules; it does not declare routes.
 *
 * `users` and `media` own their registries (`routes.ts` in each module), so the
 * app cannot accidentally describe a route set that no module contains. The
 * generated table is still what ships — modules decide *who owns* a route,
 * `routes.gen.ts` decides *what boot reads*.
 */
export default defineApp({
  name: 'http-example',
  config: spec,
  modules: [users.module, media.module],
});

/** What a Worker/Lambda adapter exports: a plain fetch handler, no globals. */
/**
 * A guard, not middleware: it returns a `Principal` or `null`, and the pipeline
 * turns `null` into a 401. It cannot "pass through" a request it did not
 * authenticate, which is the property that makes `principal` safe to bind.
 */
const auth: Guard = (ctx) => {
  const header = ctx.request.headers.get('authorization');
  if (header === null) return null;
  const subject = header.replace(/^Bearer\s+/i, '').trim();
  if (subject === '') return null;
  return { subject, data: { plan: 'free' } };
};

// `routes` is a plain array; the handler takes a table. Wrapping it here is the
// whole adapter — no compile step, no registry read.
export const handler = createFetchHandler(
  { routes },
  {
    guards: { auth },
    // Uploads are opt-in: this import is the whole cost of supporting them, and
    // a service that never accepts a file never bundles it.
    multipart: readMultipart,
  },
);
