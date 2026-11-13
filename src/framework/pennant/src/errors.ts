/**
 * Feature-flag errors.
 *
 * The package had none: a store could only fail with whatever the database said. That is fine for
 * a broken query and wrong for a *configuration* mistake, which is what an unsupported engine is —
 * the answer is one line of config, and it should arrive before the first flag is read.
 */

import { TsirError } from '@tsir/container';

export type PennantErrorCode = 'PENNANT_ENGINE_UNSUPPORTED';

const KIND = 'capability';

/**
 * The connection's engine cannot run this store's upsert (`CAP-009`).
 *
 * `ON CONFLICT (name) DO UPDATE` is SQLite's and Postgres's. MySQL's `ON DUPLICATE KEY UPDATE`
 * would silently do something different with a multi-row statement, and a feature flag that lands
 * half-written is worse than one that fails to save: the next read decides a rollout from it.
 */
export function engineUnsupported(table: string, engine: string): TsirError {
  return new TsirError(
    'PENNANT_ENGINE_UNSUPPORTED',
    `the feature store cannot use a "${engine}" connection: its upsert is \
\`ON CONFLICT (name) DO UPDATE\`, which that engine does not speak`,
    {
      kind: KIND,
      hint: `use a d1, sqlite or postgres connection for \`${table}\`, or a store this engine supports`,
      context: { table, engine },
    },
  );
}
