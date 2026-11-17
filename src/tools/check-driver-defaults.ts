/**
 * Driver defaults must name drivers their packages actually ship.
 *
 * `@tsir/core` holds `DRIVER_DEFAULTS` — what each capability converges on per target — but it
 * cannot import `@tsir/cache`, `@tsir/queue` and the rest to check itself: the package graph in
 * `check-boundaries` forbids it, and granting core ten reverse edges to validate a data table would
 * be the tail wagging the dog. So core asserts what core can know, and the cross-package half
 * lives here, where reading every package is the whole job.
 *
 * Two failures this catches, both of which would otherwise reach a user as a confusing boot error:
 *
 *   1. **A default names a driver that does not exist.** `driver: 'r2'` would build nothing and
 *      report "driver missing: `r2`" — a message about the user's config for a bug in our table.
 *   2. **A default names a driver that exists but is refused in production.** Defaulting
 *      `cloudflare` to `memory` is not a smaller cache; it is a store whose contents depend on
 *      which isolate took the write, and the boot guard would then refuse the framework's own
 *      default.
 *
 *   bun src/tools/check-driver-defaults.ts        # gate (CI, `make check`)
 */

// Relative `src/` imports, not `@tsir/*`: `src/tools` is outside the workspace, so a package
// specifier does not resolve here. The gate reads the packages it checks, which is exactly what
// a framework script is allowed to do and an application is not.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROADCAST_DRIVERS } from '../framework/broadcast/src/broadcaster.ts';
import { CACHE_DRIVERS } from '../framework/cache/src/config.ts';
import { MEDIA_DRIVERS } from '../framework/media/src/config.ts';
import {
  DRIVER_DEFAULTS,
  EPHEMERAL_DRIVERS,
  driverDefaultFor,
} from '../framework/core/src/index.ts';
import type { DeployTarget } from '../framework/core/src/index.ts';
import { DATABASE_ENGINES } from '../framework/database/src/config.ts';
import { MAIL_DRIVERS } from '../framework/mail/src/config.ts';
import { CHANNEL_DRIVERS } from '../framework/notify/src/config.ts';
import { QUEUE_DRIVERS } from '../framework/queue/src/config.ts';
import { SEARCH_DRIVERS } from '../framework/scout/src/scout.ts';
import { STORAGE_DRIVERS } from '../framework/storage/src/config.ts';

/** The registry a capability's default must be a member of. `undefined` = constructor-only. */
const REGISTRIES: Readonly<Record<string, readonly string[] | undefined>> = {
  cache: CACHE_DRIVERS,
  queue: QUEUE_DRIVERS,
  mail: MAIL_DRIVERS,
  storage: STORAGE_DRIVERS,
  database: DATABASE_ENGINES,
  notifications: CHANNEL_DRIVERS,
  broadcast: BROADCAST_DRIVERS,
  search: SEARCH_DRIVERS,
  media: MEDIA_DRIVERS,
  // `CAP-006`: the last constructor-only ports. Each gains an entry here the day its registry
  // lands, and the omission stays visible rather than remembered — which is the same reason this
  // file exists instead of a comment in core.
  sessions: undefined,
};

export interface Problem {
  readonly target: DeployTarget;
  readonly capability: string;
  readonly driver: string;
  readonly reason: string;
}

const ROOT = join(import.meta.dir, '..', '..');

const TARGETS: readonly DeployTarget[] = ['bun', 'cloudflare', 'lambda'];

/**
 * A target that stops its isolate between requests cannot default to a store that lives in one.
 *
 * `bun` is exempt on purpose: a long-lived process is the one place memory outlives the request,
 * and refusing it there would make `make dev` need a database to render a page.
 */
const STATELESS: readonly DeployTarget[] = ['cloudflare', 'lambda'];

export function problems(): readonly Problem[] {
  const found: Problem[] = [];

  for (const target of TARGETS) {
    for (const capability of Object.keys(DRIVER_DEFAULTS[target])) {
      const row = driverDefaultFor(target, capability as never);

      if (STATELESS.includes(target) && EPHEMERAL_DRIVERS.includes(row.driver)) {
        found.push({
          target,
          capability,
          driver: row.driver,
          reason: `\`${target}\` stops its isolate, so \`${row.driver}\` would be a store whose contents depend on which isolate took the write`,
        });
        continue;
      }

      const registry = REGISTRIES[capability];
      if (registry !== undefined && !registry.includes(row.driver)) {
        found.push({
          target,
          capability,
          driver: row.driver,
          reason: `not one of ${registry.join(', ')} — the default names a driver no package ships`,
        });
      }
    }
  }

  return found;
}

/** Guide row label → the `DRIVER_DEFAULTS` key it documents. */
const GUIDE_ROWS: Readonly<Record<string, string>> = {
  Cache: 'cache',
  Queue: 'queue',
  Mail: 'mail',
  Storage: 'storage',
  Notifications: 'notifications',
  Broadcast: 'broadcast',
  Search: 'search',
  Media: 'media',
  Sessions: 'sessions',
  Database: 'database',
  'Feature flags': 'featureFlags',
  'Scheduler lock': 'scheduleLock',
};

/**
 * The guide's "Default: Cloudflare → AWS → bun" column, checked against the table it documents.
 *
 * `DRIVER_DEFAULTS` is the source of truth and
 * [`drivers.md`](../docs/guides/drivers.md) paraphrases it by hand in a table that reaches production
 * readers. It had already drifted: two rows named `memory` where every target says `database`, and
 * the scheduler lock still advertised "none yet" after `CAP-006` shipped the registry. Nothing
 * compared the two, so nothing noticed.
 *
 * Only this one column is compared. The other columns describe capabilities prose cannot derive —
 * what a driver needs, when it refuses to boot — and a gate that guessed at those would be worse
 * than the drift.
 */
export function guideDrift(markdown: string): readonly string[] {
  const drift: string[] = [];
  for (const [label, capability] of Object.entries(GUIDE_ROWS)) {
    const line = markdown.split('\n').find((l) => l.startsWith('|') && l.includes(`**${label}**`));
    if (line === undefined) {
      drift.push(`no row for \`${label}\``);
      continue;
    }
    const documented = (line.split('|')[3] ?? '').replace(/[`\s]/gu, '');
    // The guide's column order is "Cloudflare → AWS → bun", not `TARGETS`' order.
    const actual = (['cloudflare', 'lambda', 'bun'] as const)
      .map(
        (target) =>
          (DRIVER_DEFAULTS[target] as Readonly<Record<string, { driver: string }>>)[capability]
            ?.driver,
      )
      .join('→');
    // `storage` documents "s3 + R2 endpoint" for the Cloudflare target: R2 is S3 with a different
    // endpoint, so the driver is `s3` and the annotation is a fact about the service, not a driver.
    if (documented.replace(/\+R2endpoint/u, '') !== actual) {
      drift.push(`\`${label}\`: guide says \`${documented}\`, DRIVER_DEFAULTS says \`${actual}\``);
    }
  }
  return drift;
}

function main(): void {
  const found = problems();
  const guide = guideDrift(readFileSync(join(ROOT, 'src/docs/guides/drivers.md'), 'utf8'));

  if (guide.length > 0) {
    process.stderr.write(`\ndriver guide drift (${String(guide.length)})\n\n`);
    for (const line of guide) process.stderr.write(`  ✗ ${line}\n`);
    process.stderr.write('\nThe table documents `DRIVER_DEFAULTS`; update `drivers.md`.\n\n');
    process.exitCode = 1;
  }

  if (found.length === 0 && guide.length === 0) {
    const rows = TARGETS.reduce(
      (total, target) => total + Object.keys(DRIVER_DEFAULTS[target]).length,
      0,
    );
    process.stdout.write(
      `✓ driver defaults name shipped drivers (${String(rows)} rows across ${String(TARGETS.length)} targets; no stateless target defaults to an ephemeral driver)\n`,
    );
    return;
  }

  // Only when there are problems: this footer used to print on the success path too, so a green
  // gate finished by naming a file it had no complaint about, which reads like a warning.
  if (found.length > 0) {
    process.stderr.write(`\ndriver default problems (${String(found.length)})\n\n`);
    for (const problem of found) {
      process.stderr.write(`  ✗ ${problem.target} · ${problem.capability} → ${problem.driver}\n`);
      process.stderr.write(`      ${problem.reason}\n`);
    }
    process.stderr.write('\nSee `src/framework/core/src/driver-defaults.ts`.\n\n');
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
