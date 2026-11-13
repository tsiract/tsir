/**
 * Per-target driver defaults: what a capability converges on when the project does not say.
 *
 * The rule this encodes, and the reason it exists at all:
 *
 *   · **Cloudflare is the default target, so its services are the default drivers.** A startup
 *     deploying to Workers gets KV, D1, Queues, R2 and Email without choosing anything; the
 *     cheaper plan is the one that needs no second vendor.
 *   · **Every default here is durable.** `memory` is never a default on Cloudflare or Lambda,
 *     because both are stateless: the isolate is gone in seconds and an in-memory store is a
 *     cache that silently loses writes, a session that logs everyone out, and a queue that drops
 *     jobs under load. Those drivers still exist — as an explicit `dev` choice and inside tests,
 *     where their `sent()`/`last()` accessors are the point.
 *   · **A default names a driver, and a driver needs values.** Where the value cannot be derived
 *     from the binding a Cloudflare project already declares, `requires` says so, and boot
 *     refuses with that sentence rather than failing at the first write.
 *
 * This is data, not a second registry. `@tsir/cache` still owns `CACHE_DRIVERS` and the switch
 * that turns a name into code; this table only says which name to try first, and what the
 * framework will tell you when that driver cannot be built without a value only you can supply.
 */

import type { DeployTarget } from './capabilities.ts';

/** The capability keys this table covers. One per port that resolves a driver from config. */
export type DefaultedCapability =
  | 'cache'
  | 'queue'
  | 'storage'
  | 'mail'
  | 'database'
  | 'sessions'
  | 'broadcast'
  | 'search'
  | 'media'
  | 'notifications'
  | 'featureFlags';

export interface DriverDefault {
  /** The driver name, exactly as `tsir.js` writes it. */
  readonly driver: string;
  /**
   * What the project must supply for this driver to build, in the words of the error it gets.
   *
   * Empty for a driver that is complete on its own (`memory`, `null`, `sync`). One entry per
   * missing value, so boot can report all of them at once rather than one per restart.
   */
  readonly requires: readonly string[];
  /** One line, for `tsir doctor` and `--json`. */
  readonly why: string;
}

const memory = (why: string): DriverDefault => ({ driver: 'memory', requires: [], why });

/**
 * The Cloudflare-first row set.
 *
 * `cache` is deliberately **not** KV. KV has no atomic increment, one write per second per key,
 * and up to 60 s of eventual consistency — a cache port with `increment` maps onto it in a way
 * that compiles and is wrong (`15-capabilities.md § 3.3`). D1 has all three solved, so the default
 * is the one durable store a Workers project already has.
 */
const CLOUDFLARE: Readonly<Record<DefaultedCapability, DriverDefault>> = {
  cache: {
    driver: 'cloudflare-kv',
    requires: ['bindings.kv — the KV namespace binding', 'ttlMs ≥ 60 000'],
    why: 'KV is durable and free on Workers, and a cache tolerates its 60 s convergence; the database store is the answer for anything that must read its own writes',
  },
  queue: {
    driver: 'cloudflare-queues',
    requires: ['bindings.queues — the [[queues.producers]] binding', 'outbox: true'],
    why: 'native at-least-once delivery with a DLQ and no egress; the outbox is mandatory because a broker cannot be atomic with the business write',
  },
  storage: {
    driver: 's3',
    requires: [
      'bucket',
      'credentials.accessKeyId',
      'credentials.secretAccessKey',
      'endpoint — the R2 endpoint',
    ],
    why: 'R2 speaks the S3 API, so the s3 driver with an R2 endpoint is the R2 driver: zero egress, no second vendor',
  },
  mail: {
    driver: 'resend',
    requires: ['apiKey — { fromEnv: RESEND_API_KEY }', 'from'],
    why: 'Cloudflare Email Sending is still beta with a 50-recipient cap and a Workers Paid requirement, and it needs a verified destination before a domain is onboarded — Resend is the top-DX pick, 3 000/month free, and one fetch; `cloudflare` stays selectable',
  },
  database: {
    driver: 'd1',
    requires: ['bindings.DB — the [[d1_databases]] binding'],
    why: 'Cloudflare-native SQLite, in-process, no connection to manage and no Hyperdrive in front of it',
  },
  sessions: {
    driver: 'database',
    requires: ['a SQL port (D1 satisfies it)'],
    why: 'a stateless isolate forgets an in-memory session on every cold start, which is a logout',
  },
  broadcast: {
    driver: 'durable-object',
    requires: ['bindings.realtime — the Durable Object namespace binding'],
    why: 'the platform has no process to hold a listener list, so the fan-out point is a Durable Object (one per channel); `websocket` cannot work here for that reason',
  },
  search: {
    driver: 'typesense',
    requires: ['host — the cluster URL', 'apiKey — { fromEnv }', 'collection'],
    why: 'Cloudflare has no search product; D1 FTS5 (`sqlite`) is the free start and Typesense is the cheapest hosted step up — flat node pricing instead of per query',
  },
  media: {
    driver: 'cloudflare',
    requires: ['accountId', 'apiToken'],
    why: 'Cloudflare Images and Stream — image variability and video transcoding with no subprocess',
  },
  notifications: {
    driver: 'database',
    requires: ['a SQL port (D1 satisfies it)', 'a mailer — the mail channel composes one'],
    why: 'an inbox in the store the project already has, so a notification survives the isolate that sent it',
  },
  featureFlags: {
    driver: 'database',
    requires: ['a SQL port (D1 satisfies it)', 'a `features` table — `featureTableDdl`'],
    why: 'a flag has to be the same on every instance and the same tomorrow; D1 is the store the project already has and `memory` resets every rollout on deploy',
  },
};

/**
 * The AWS/Lambda row set.
 *
 * Same principle, different vendor: every row is a durable AWS service, never an in-memory one.
 * The database stays **Postgres** rather than a Cloudflare binding, because Lambda has no binding
 * to receive and a Postgres URL is the portable answer — and because Aurora/RDS is what a startup
 * on AWS already has when it has anything.
 */
const LAMBDA: Readonly<Record<DefaultedCapability, DriverDefault>> = {
  cache: {
    driver: 'redis',
    requires: ['bindings.redis — a Redis client'],
    why: 'ElastiCache or Upstash over the app-supplied client; a stateless function cannot cache in memory between invocations',
  },
  queue: {
    driver: 'sqs',
    requires: ['bindings.sqs — the SDK client', 'queueUrl', 'outbox: true'],
    why: 'native at-least-once delivery with a DLQ; the outbox is mandatory for the same reason as on Workers',
  },
  storage: {
    driver: 's3',
    requires: ['bucket', 'region', 'credentials.accessKeyId', 'credentials.secretAccessKey'],
    why: 'S3 directly; the same driver as R2 with a different endpoint and region',
  },
  mail: {
    driver: 'ses',
    requires: ['region', 'credentials.accessKeyId', 'credentials.secretAccessKey', 'from'],
    why: 'SES v2, which is the mail service the account already has',
  },
  database: {
    driver: 'postgres',
    requires: ['url — the connection URL, as { fromEnv: DATABASE_URL }', 'driver: postgres'],
    why: 'RDS or Aurora; Postgres, not D1, because there is no binding to hand a function',
  },
  sessions: {
    driver: 'database',
    requires: ['a SQL port (the Postgres driver satisfies it)'],
    why: 'a function that scales to zero forgets an in-memory session on every cold start',
  },
  broadcast: {
    driver: 'redis',
    requires: ['bindings.redis — a Redis client (ElastiCache or Upstash)'],
    why: 'API Gateway WebSocket only routes frames, so the fan-out point is a shared broker; Redis pub/sub is the one every `ws` unit can reach, and it is the same driver the Bun target uses for multi-process',
  },
  search: {
    driver: 'postgres',
    requires: ['a query function (the Postgres driver satisfies it)'],
    why: 'Postgres full-text search needs no cluster; OpenSearch is there when relevance outgrows it, and Typesense or Meilisearch are the hosted options the `typesense`/`meilisearch`/`algolia` drivers cover',
  },
  media: {
    driver: 'sharp',
    requires: ['a sharp layer in the Lambda image'],
    why: 'the function has a filesystem and a subprocess budget, so image work happens in-process instead of at a third party',
  },
  notifications: {
    driver: 'database',
    requires: [
      'a SQL port (the Postgres driver satisfies it)',
      'a mailer — the mail channel composes one',
    ],
    why: 'an inbox in Postgres, so a notification outlives the invocation that sent it',
  },
  featureFlags: {
    driver: 'database',
    requires: [
      'a query function (the Postgres driver satisfies it)',
      'a `features` table — `featureTableDdl`',
    ],
    why: 'Postgres is already there; a flag in an in-process store is reset by every deploy and disagrees between concurrent functions',
  },
};

/**
 * Locally: `bun` is a real long-lived process, so `memory` is honest — it is not a lie about
 * durability, it is the absence of a service to configure. `make dev` must need no cloud account
 * and no Docker, and that is only true if the development row set is the one that assumes nothing.
 *
 * `database` is still the better choice for anything a developer wants to survive a restart, which
 * is why the generated `config/*.ts` points at it wherever a local Postgres exists.
 */
const BUN: Readonly<Record<DefaultedCapability, DriverDefault>> = {
  cache: memory(
    'development default: a cache that dies with the process is a cache in development',
  ),
  queue: {
    driver: 'sync',
    requires: [],
    why: 'a job runs inline, so a developer sees its failure in the request that queued it',
  },
  storage: {
    driver: 'local',
    requires: ['root — the directory, relative to the project'],
    why: 'files on disk, visible in an editor, with no bucket to create first',
  },
  mail: {
    driver: 'log',
    requires: [],
    why: 'the message is printed, and nothing is sent to a real address from a laptop',
  },
  database: {
    driver: 'postgres',
    requires: ['url — the connection URL, as { fromEnv: DATABASE_URL }'],
    why: 'the engine the migrations and the SQLite/D1 differences are tested against; `make db-up` provides one',
  },
  sessions: memory('development default: restarting the dev server logging you out is correct'),
  broadcast: memory(
    'development default: one process, so one process-wide listener list is the truth',
  ),
  search: {
    driver: 'memory',
    requires: [],
    why: 'a search index that is rebuilt on boot cannot go stale against the data',
  },
  media: {
    driver: 'sharp',
    requires: [],
    why: 'in-process image work, no account and no upload during development',
  },
  notifications: {
    driver: 'memory',
    requires: [],
    why: 'every delivery is kept so a test can assert on it, and nothing leaves the process',
  },
  featureFlags: {
    driver: 'database',
    requires: ['a SQL port (SQLite satisfies it)', 'a `features` table — `featureTableDdl`'],
    why: 'the bun target has a real process and a real file, so flags belong in it rather than in a map that a restart forgets',
  },
};

/** The default driver per capability, per target. `tsir doctor` prints the row it resolved. */
export const DRIVER_DEFAULTS: Readonly<
  Record<DeployTarget, Readonly<Record<DefaultedCapability, DriverDefault>>>
> = {
  bun: BUN,
  cloudflare: CLOUDFLARE,
  lambda: LAMBDA,
};

/** Every capability this table has a default for. Sorted, so output is stable. */
export const DEFAULTED_CAPABILITIES: readonly DefaultedCapability[] = (
  Object.keys(CLOUDFLARE) as DefaultedCapability[]
).sort();

/**
 * The default for one capability on one target.
 *
 * Throws rather than returning `undefined`: a capability in `DefaultedCapability` that has no row
 * is a missing case in this file, and a silent `undefined` default would surface as "the memory
 * driver is magically the default in production" — the exact failure this table exists to prevent.
 */
export function driverDefaultFor(
  target: DeployTarget,
  capability: DefaultedCapability,
): DriverDefault {
  const row = DRIVER_DEFAULTS[target][capability];
  if (row === undefined) {
    // eslint-disable-next-line no-restricted-syntax -- a lookup miss is a bug in this module, not a user-facing value; ERR-003 wants a codified error for anything an application can observe
    throw new Error(
      `no driver default for ${capability} on ${target} — add the row to DRIVER_DEFAULTS`,
    );
  }
  return row;
}

/**
 * A driver that must never be a default on a stateless target.
 *
 * Cloudflare and Lambda both stop the isolate when the request or invocation ends. An in-memory
 * store there is not a smaller cache; it is a store whose contents are a function of which isolate
 * happened to receive the write. This predicate exists so a config that names one explicitly can
 * still be warned about in `tsir doctor`, and so a future default cannot quietly be one of these.
 */
export const EPHEMERAL_DRIVERS: readonly string[] = ['memory', 'null', 'sync', 'log'];

/** True when `target` keeps an isolate alive between requests, so memory is a real choice. */
export function targetKeepsIsolate(target: DeployTarget): boolean {
  return target === 'bun';
}
