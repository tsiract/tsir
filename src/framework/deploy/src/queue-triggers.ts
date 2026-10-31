/**
 * Queue triggers in the deploy graph (`CAP-004`, `QUEUE-17`).
 *
 * The capability table this file implements has the sentence that
 * makes it a build rule rather than advice:
 *
 * > A connection with no trigger on the chosen target fails `tsir build`, and so does a worker
 * > pointed at a connection the target cannot reach.
 *
 * | Driver              | Bun                                  | Workers                                    | Lambda                              |
 * | ------------------- | ------------------------------------ | ------------------------------------------ | ----------------------------------- |
 * | `database`          | `tsir queue:work` drain loop         | `scheduled` handler, bounded batch         | EventBridge schedule → drain        |
 * | `cloudflare-queues` | —                                    | native `queue` handler                     | —                                   |
 * | `sqs`               | poller loop                          | — (needs the SQS HTTP API + a drain)       | native event source mapping         |
 *
 * Two rules that keep this honest:
 *
 *   · **A connection is a unit.** Two connections on one target are two units with two
 *     triggers, each drained by its own handler — the coupling that `DPL` exists to make
 *     visible. They are *not* merged into "the queue unit".
 *   · **A refusal names the cell.** "no trigger" is useless; "`default` (cloudflare-queues) has
 *     no trigger on `lambda`" is a line someone can act on, and the message carries the table
 *     row it came from.
 *
 * The Bun column has no emitter, and that is a decision rather than a gap: this package emits
 * platform artefacts (`wrangler.toml`, a SAM template) and Bun has none. A drain there is a
 * **process** — `tsir queue:work --connection=<name>`, kept alive by the supervisor that also
 * keeps the HTTP process alive (`make dev` and `kill` in development) — so the graph records the
 * trigger (which is what makes `checkGraph` and the console agree with the table) and the run
 * command is the app's, not a generated file's.
 *
 * The outbox rule lives here too, because it is the same kind of statement: a
 * non-transactional driver without an outbox does not fail at run time, it fails *quietly*,
 * and the build is the last place that can notice.
 */

import type { DeployTarget } from '@tsir/core';

import { eventsOutboxMissing, queueTriggerMissing, queueOutboxMissing } from './errors.ts';
import type { Unit, UnitTrigger } from './units.ts';
import type { GraphProblem } from './graph.ts';

/** How a driver is reached on a target: a native trigger, a drain loop, or not at all. */
export type QueueTriggerKind = 'native' | 'drain' | 'unsupported';

export interface QueueConnectionInput {
  /** The connection name from `queue.connections` — the unit is named `queue:<name>`. */
  readonly name: string;
  /** `database`, `cloudflare-queues`, `sqs`, `sync`, `memory`. */
  readonly driver: string;
  /** Whether the connection declares a transactional outbox. */
  readonly outbox?: boolean | undefined;
  /** The queue names it consumes; `[name]` when the project does not say. */
  readonly queues?: readonly string[] | undefined;
  readonly module?: string | undefined;
}

/** The § 4.2 table, as data. */
export const QUEUE_TRIGGER_MATRIX: Readonly<
  Record<string, Partial<Record<DeployTarget, QueueTriggerKind>>>
> = {
  database: { bun: 'drain', cloudflare: 'drain', lambda: 'drain' },
  'cloudflare-queues': { cloudflare: 'native' },
  sqs: { bun: 'drain', lambda: 'native' },
  // Development drivers: they have no trigger anywhere, and that is not a build failure — they
  // are refused in production by `createQueues`, which is the check that belongs to them.
  sync: {},
  memory: {},
};

/** What `tsir build` will emit for one connection on one target. */
export function triggerFor(driver: string, target: DeployTarget): QueueTriggerKind {
  return QUEUE_TRIGGER_MATRIX[driver]?.[target] ?? 'unsupported';
}

/**
 * The triggers a connection's driver can have, as a **union across targets**.
 *
 * A graph is one artefact for every target (`UnitGraph.targets` is a list), so a unit's trigger
 * list cannot depend on which target is being built. The union is the honest answer and it is
 * also the useful one: `sqs` is native on Lambda and drained on Bun, so its unit carries both
 * — and `checkGraph` refuses the pairings that cannot work, per target.
 *
 * `database` is the simple case: a drain everywhere, so one cron. `cloudflare-queues` is a
 * native `queue` handler, so no cron at all.
 */
export function triggersForConnection(connection: QueueConnectionInput): readonly UnitTrigger[] {
  const queues = [...new Set(connection.queues ?? [connection.name])].sort();
  const kinds = new Set(
    Object.values(QUEUE_TRIGGER_MATRIX[connection.driver] ?? {}).filter(
      (kind): kind is QueueTriggerKind => kind !== undefined,
    ),
  );

  const triggers: UnitTrigger[] = [];
  if (kinds.has('native')) triggers.push({ kind: 'queue', detail: queues });
  if (kinds.has('drain')) {
    // One minute is the shortest cron the platforms guarantee, and a tick is the only honest
    // way to say "poll": a drain every minute is a queue with a one-minute floor on its
    // latency, which is a real cost and is written down in § 4.2 rather than hidden.
    triggers.push({ kind: 'cron', detail: ['* * * * *'] });
  }
  return triggers;
}

/** The unit one connection becomes. Target-independent: see `triggersForConnection`. */
export function queueUnitFor(connection: QueueConnectionInput): Unit {
  return {
    name: `queue:${connection.name}`,
    kind: 'queue',
    modules: connection.module === undefined ? [] : [connection.module],
    reasons: [{ source: 'queues', from: `${connection.name} (${connection.driver})` }],
    triggers: triggersForConnection(connection),
    requires: [],
    bindings: [],
    // A worker has no request surface: nothing should be able to call it.
    private: true,
  };
}

/**
 * The refusals: one problem per connection per target that cannot run.
 *
 * Returned rather than thrown, so `deploy:plan` prints every one of them at once — a build that
 * reports one missing trigger per run is a build nobody enjoys.
 */
export function checkQueueConnections(input: {
  readonly connections: readonly QueueConnectionInput[];
  /** Does the app export an events registry? The outbox's writer lives there (`§ 4.5`). */
  readonly events?: boolean | undefined;
  readonly targets: readonly DeployTarget[];
}): readonly GraphProblem[] {
  const problems: GraphProblem[] = [];

  for (const connection of input.connections) {
    // `sync` and `memory` are development drivers: they are refused in production by
    // `createQueues`, and demanding a trigger for them would fail every `make dev` project
    // that declares one. The build's job is the *deployed* drivers.
    if (
      triggerFor(connection.driver, 'bun') === 'unsupported' &&
      QUEUE_TRIGGER_MATRIX[connection.driver] === undefined
    ) {
      continue;
    }
    if (connection.driver === 'sync' || connection.driver === 'memory') continue;

    for (const target of input.targets) {
      if (triggerFor(connection.driver, target) === 'unsupported') {
        const error = queueTriggerMissing({
          connection: connection.name,
          driver: connection.driver,
          target,
          supported: Object.entries(QUEUE_TRIGGER_MATRIX[connection.driver] ?? {})
            .filter(([, kind]) => kind !== 'unsupported')
            .map(([name]) => name),
        });
        problems.push({
          unit: `queue:${connection.name}`,
          code: error.code,
          message: error.message,
          hint: error.hint ?? '',
        });
      }
    }

    const nonTransactional =
      connection.driver === 'cloudflare-queues' || connection.driver === 'sqs';
    if (nonTransactional && connection.outbox !== true) {
      const error = queueOutboxMissing({ connection: connection.name, driver: connection.driver });
      problems.push({
        unit: `queue:${connection.name}`,
        code: error.code,
        message: error.message,
        hint: error.hint ?? '',
      });
    } else if (nonTransactional && input.events !== true) {
      // Both halves or neither: a declared outbox with no writer is a durability claim the
      // project cannot keep, and it is invisible until the first rollback loses a delivery.
      const error = eventsOutboxMissing({ connection: connection.name, driver: connection.driver });
      problems.push({
        unit: `queue:${connection.name}`,
        code: error.code,
        message: error.message,
        hint: error.hint ?? '',
      });
    }
  }

  return problems;
}
