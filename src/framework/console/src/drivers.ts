/**
 * `drivers.gen.ts` (`CAP-003`).
 *
 * The problem this solves is a bundle-size one, and it only becomes visible when it is too late
 * to fix: a project that declares two `memory` cache stores and nothing else must not ship
 * `redis`, `cloudflare-kv` and the whole SQL driver in its Worker. The registry (`createCaches`,
 * `createQueues`) imports every driver it can build, because it has to be able to *name* them in
 * an error message. The generated module is the other half: it imports only the drivers the
 * configuration actually uses, **once each**, no matter how many stores sit on top.
 *
 * ```
 *   cache.stores: { app: memory, sessions: memory, pages: database }
 *                     │                 │              │
 *   drivers.gen.ts:   └──────── one `memory` import ────┴── one `database` import
 * ```
 *
 * Two rules are enforced here rather than documented:
 *
 *   · **one import per driver**, deduplicated by driver name — two stores on one driver is the
 *     normal case (ADR-0019 § 2), not an edge case;
 *   · **a store naming a driver this build does not ship fails the build**, naming the store, the
 *     driver and the ones that do exist. A generated module that quietly omitted a driver would
 *     compile and then fail at boot in production, which is the worst of both.
 */

import { CACHE_DRIVERS } from '@tsir/cache';
import { QUEUE_DRIVERS } from '@tsir/queue';

/** Which subpath each shipped driver lives on. Adding a driver means adding a line here. */
const CACHE_MODULES: Readonly<Record<string, string>> = {
  memory: '@tsir/cache/memory',
  null: '@tsir/cache/null',
  database: '@tsir/cache/database',
  redis: '@tsir/cache/redis',
  'cloudflare-kv': '@tsir/cache/cloudflare-kv',
};

const QUEUE_MODULES: Readonly<Record<string, string>> = {
  memory: '@tsir/queue/memory',
  sync: '@tsir/queue/sync',
  database: '@tsir/queue/database',
  'cloudflare-queues': '@tsir/queue/cloudflare-queues',
  sqs: '@tsir/queue/sqs',
};

/** What each driver's module exports, so the generated file can bind a name without guessing. */
const CACHE_EXPORTS: Readonly<Record<string, string>> = {
  memory: 'memoryDriver',
  null: 'nullDriver',
  database: 'databaseDriver',
  redis: 'redisDriver',
  'cloudflare-kv': 'cloudflareKvDriver',
};

const QUEUE_EXPORTS: Readonly<Record<string, string>> = {
  memory: 'memoryQueueDriver',
  sync: 'syncQueueDriver',
  database: 'databaseQueueDriver',
  'cloudflare-queues': 'cloudflareQueuesDriver',
  sqs: 'sqsDriver',
};

export type PortName = 'cache' | 'queue';

/** One port's declaration, as much of it as driver planning needs. */
export interface PortConfig {
  readonly driver: string;
  readonly connection?: string | undefined;
  readonly stores?: Readonly<Record<string, { readonly driver: string }>> | undefined;
  readonly connections?: Readonly<Record<string, { readonly driver: string }>> | undefined;
}

export interface DriverUse {
  readonly port: PortName;
  readonly driver: string;
  /** The `tsir.js` names on this driver — every one of them, because the message names them. */
  readonly names: readonly string[];
  readonly module: string;
  readonly symbol: string;
}

export interface DriverProblem {
  readonly port: PortName;
  readonly name: string;
  readonly driver: string;
  readonly message: string;
}

export interface DriverPlan {
  readonly uses: readonly DriverUse[];
  readonly problems: readonly DriverProblem[];
}

interface RegistrySpec {
  readonly port: PortName;
  readonly declarations: readonly { name: string; driver: string }[];
  readonly shipped: readonly string[];
  readonly modules: Readonly<Record<string, string>>;
  readonly symbols: Readonly<Record<string, string>>;
}

function declarationsOf(
  block:
    | {
        readonly stores?: Readonly<Record<string, { driver: string }>> | undefined;
        readonly connections?: Readonly<Record<string, { driver: string }>> | undefined;
      }
    | undefined,
): { name: string; driver: string }[] {
  const record = block?.stores ?? block?.connections;
  return Object.entries(record ?? {})
    .map(([name, entry]) => ({ name, driver: entry.driver }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function planFor(spec: RegistrySpec): DriverPlan {
  const byDriver = new Map<string, string[]>();
  const problems: DriverProblem[] = [];

  for (const declaration of spec.declarations) {
    if (!spec.shipped.includes(declaration.driver)) {
      problems.push({
        port: spec.port,
        name: declaration.name,
        driver: declaration.driver,
        message:
          `${spec.port} "${declaration.name}" names driver "${declaration.driver}", ` +
          `which this build does not ship (shipped: ${spec.shipped.join(', ')})`,
      });
      continue;
    }
    const names = byDriver.get(declaration.driver) ?? [];
    names.push(declaration.name);
    byDriver.set(declaration.driver, names);
  }

  // Sorted by driver name so the generated file is stable across runs: a diff means a change in
  // configuration, never a change in `Object.keys` order.
  const uses: DriverUse[] = [...byDriver.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([driver, names]) => ({
      port: spec.port,
      driver,
      names,
      module: spec.modules[driver] ?? '',
      symbol: spec.symbols[driver] ?? '',
    }));

  return { uses, problems };
}

/**
 * What the configuration needs, and what is wrong with it.
 *
 * Pure: the caller decides what to do with `problems`, which is what lets `tsir build` refuse
 * while a test can assert on the plan without writing a file.
 */
export function planDrivers(input: {
  readonly cache?:
    | { readonly stores?: Readonly<Record<string, { readonly driver: string }>> | undefined }
    | undefined;
  readonly queue?:
    | { readonly connections?: Readonly<Record<string, { readonly driver: string }>> | undefined }
    | undefined;
}): DriverPlan {
  const cache = planFor({
    port: 'cache',
    declarations: declarationsOf(input.cache),
    shipped: CACHE_DRIVERS,
    modules: CACHE_MODULES,
    symbols: CACHE_EXPORTS,
  });
  const queue = planFor({
    port: 'queue',
    declarations: declarationsOf(input.queue),
    shipped: QUEUE_DRIVERS,
    modules: QUEUE_MODULES,
    symbols: QUEUE_EXPORTS,
  });

  return {
    uses: [...cache.uses, ...queue.uses],
    problems: [...cache.problems, ...queue.problems],
  };
}

/**
 * The module text.
 *
 * It exports **factories, not instances**: a generated file cannot know the SQL client or the
 * Redis client an app would pass, and guessing one is how a generated file becomes a second
 * configuration. The app calls the factory with its own bindings.
 */
export function renderDriversModule(plan: DriverPlan): string {
  const lines: string[] = [
    '// Generated by `tsir build` (CAP-003). Do not edit: the next build rewrites it.',
    '//',
    '// One import per driver, no matter how many stores or connections use it, so a bundle',
    '// carries the drivers this project declares and nothing else.',
    '',
  ];

  for (const use of plan.uses) {
    lines.push(`import { ${use.symbol} } from '${use.module}';`);
  }

  if (plan.uses.length > 0) lines.push('');

  for (const port of ['cache', 'queue'] as const) {
    const uses = plan.uses.filter((use) => use.port === port);
    const entries = uses.map((use) => `  ${use.driver}: ${use.symbol},`);
    lines.push(`/** ${port} drivers this project declares, by the name \`tsir.js\` writes. */`);
    lines.push(`export const ${port}Drivers = {`);
    lines.push(...entries);
    lines.push('} as const;');
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** The relative path `tsir build` writes, for the message it prints. */
export const DRIVERS_MODULE = 'drivers.gen.ts';

export { CACHE_DRIVERS, QUEUE_DRIVERS };
