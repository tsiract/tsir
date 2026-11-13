/**
 * `production: true`, derived from `APP_ENV` the same way in every bootstrap (`CAP-007`).
 *
 * Every capability package implements its production guard and keys it on `options.production` —
 * and for a while **nothing passed it**. The guards existed, the refusals were written, the tests
 * covered them, and an application that deployed with `memory` for its cache and `log` for its
 * mail worked exactly as before. A guard nobody can reach is a comment.
 *
 * The reason it was missed is that there was no shared answer to "am I production": `defineApp`
 * knows the mode, but the service modules that build caches and mailers are imported from the app
 * entry, where the mode is not in scope. This function is that answer, in one place, so the
 * thirteenth bootstrap cannot get it wrong differently from the first twelve.
 *
 * ## Why the default is *not* production
 *
 * `isProduction()` with no argument reads `APP_ENV` and answers `false` when it is unset. That is
 * deliberate and it is the one arguable choice here: a missing `APP_ENV` on a real deployment
 * silently disables every guard. The alternative — assume production when unset — breaks every
 * test, every `tsir` command and every fresh clone, which is how a guard gets an escape hatch
 * added to it. So the default is development, and the deployer is responsible for setting
 * `APP_ENV=production`; `tsir deploy:build` writes it into the target's vars, which is what makes
 * that a fact rather than a hope.
 *
 * The values are matched case-insensitively and `staging` counts: a staging environment with a
 * `memory` cache is the same lost write as production, one day earlier, which is exactly the
 * environment where it is cheapest to find out.
 */

/** The environments that get production guards. `staging` is included on purpose. */
export const PRODUCTION_ENVIRONMENTS: readonly string[] = ['production', 'staging'];

/** The environment name, read from `APP_ENV` (`APP_MODE` is the older spelling, still honoured). */
export function environmentName(
  env: Readonly<Record<string, string | undefined>> = typeof process === 'undefined'
    ? {}
    : process.env,
): string {
  return (env['APP_ENV'] ?? env['APP_MODE'] ?? '').trim().toLowerCase();
}

/**
 * True when this process must refuse ephemeral drivers.
 *
 * ```ts
 * import { isProduction } from '@tsir/core';
 *
 * export const { caches } = createCacheBootstrap({
 *   cache: appConfig,
 *   production: isProduction(),
 * });
 * ```
 *
 * Passing `env` explicitly is for the CLI, which resolves `APP_ENV` from `.env.<name>` rather than
 * from its own `process.env` — a `tsir` command runs on a developer's machine whatever the target
 * is, so its answer must come from the file it is acting on.
 */
export function isProduction(
  env: Readonly<Record<string, string | undefined>> = typeof process === 'undefined'
    ? {}
    : process.env,
): boolean {
  return PRODUCTION_ENVIRONMENTS.includes(environmentName(env));
}
