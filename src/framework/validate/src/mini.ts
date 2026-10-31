/**
 * `@tsir/validate/mini` — the Zod 4 "mini" validator.
 *
 * Zod's `mini` variant ships a functional API (`m.string().check(m.minLength(3))`
 * instead of `z.string().min(3)`) and drops code the full build carries. The trade
 * is smaller bundles for terser error messages and a less ergonomic API; schemas
 * are still Standard Schema, so everything in `@tsir/validate` — `validate`,
 * `validateSync`, `parse`, issue normalization — works on them unchanged.
 *
 * This entry point exists so the workspace keeps its "one package owns zod" rule
 * (ADR-0012): an application imports `@tsir/validate/mini` and never declares
 * `zod` itself.
 *
 *   import * as m from '@tsir/validate/mini';
 *   const Body = m.object({ name: m.string() });
 *
 * Measured difference (see `make verify-dist`): a Workers handler using `mini`
 * is roughly 40 % smaller than the same handler on the full build.
 */
export * from 'zod/mini';
