/**
 * `wrangler.*.toml` generation (`DPL-009`, `DPL-010`).
 *
 * The generated config is **committed and reviewable**, which
 * decides most of what follows:
 *
 *   · **Deterministic bytes.** Bindings are emitted in a fixed order, sections in a fixed
 *     order, and nothing carries a timestamp. Regenerating an unchanged config writes the
 *     same file, so `--check` means something.
 *   · **Least privilege is structural.** A unit only gets the bindings it declared; a unit
 *     with no queue binding has no `[[queues.producers]]` section at all. The config is
 *     derived from the graph, not from a template a human keeps in sync by hand.
 *   · **Secrets are named, never inlined.** A `secret` binding becomes a comment listing
 *     `wrangler secret put <NAME>`, so the operator sees what to set and the artefact
 *     never contains a value (`DPL-012`, `DPL_SECRET_LEAK`).
 *   · **Durable Objects are a pair.** A `durable-object` binding emits both the binding
 *     and a `[[migrations]]` entry — a binding without a migration is a deploy that fails,
 *     and a migration without `new_sqlite_classes` is a class the runtime will not host.
 */

import { invalidDeployConfig } from './errors.ts';
import type { BindingKind, BindingRef, Unit } from './units.ts';

/** Where a binding's concrete resource lives. Supplied by `deploy.targets.cloudflare`. */
export interface BindingResource {
  /** KV namespace id, D1 database id, Hyperdrive id. */
  readonly id?: string | undefined;
  /** Queue name (`[[queues.producers]]`). */
  readonly queue?: string | undefined;
  /** R2 bucket name. */
  readonly bucket?: string | undefined;
  /** D1 database name (the `id` is separate in Cloudflare's format). */
  readonly database?: string | undefined;
  /** Durable Object class name — must match the class the bundle exports. */
  readonly className?: string | undefined;
}

/**
 * The default `compatibility_date`.
 *
 * Pinned to a date this framework was tested against, never `today`: a compatibility date
 * that moves with the clock changes runtime behaviour without a diff
 * . Projects override it in `deploy.targets.cloudflare`.
 */
export const DEFAULT_COMPATIBILITY_DATE = '2026-09-01';

export interface WranglerOptions {
  /** Default `<app>-<unit>`, which is what a human expects to see in the dashboard. */
  readonly name?: string | undefined;
  /** Default `index.js`: the emitter writes one bundle per unit directory. */
  readonly main?: string | undefined;
  /** `compatibility_date` is pinned, never defaulted to today. */
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[] | undefined;
  readonly observability?: boolean | undefined;
  /** Non-secret configuration. Secrets are bindings, and they are not here. */
  readonly vars?: Readonly<Record<string, string>> | undefined;
  /** Concrete ids/names per binding name, from `deploy.targets.cloudflare.bindings`. */
  readonly resources?: Readonly<Record<string, BindingResource>> | undefined;
  /** Migration tag for Durable Object classes. Bumped only when a class is added. */
  readonly migrationTag?: string | undefined;
}

const ORDER: readonly BindingKind[] = ['hyperdrive', 'd1', 'kv', 'r2', 'queue', 'durable-object'];

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function requireResource(
  binding: BindingRef,
  resources: Readonly<Record<string, BindingResource>> | undefined,
  field: keyof BindingResource,
  what: string,
): string {
  const value = resources?.[binding.name]?.[field];
  if (value === undefined) {
    throw invalidDeployConfig(
      `binding "${binding.name}" needs a ${what} for wrangler; declare it in deploy.targets.cloudflare.bindings.${binding.name}.${field}`,
      { binding: binding.name, field },
    );
  }
  return value;
}

/** One binding, as the TOML sections Cloudflare expects. */
function bindingSections(
  binding: BindingRef,
  options: WranglerOptions,
): { readonly body: string[]; readonly secret?: string } {
  const resources = options.resources;

  switch (binding.kind) {
    case 'hyperdrive':
      return {
        body: [
          '[[hyperdrive]]',
          `binding = ${tomlString(binding.name)}`,
          `id = ${tomlString(requireResource(binding, resources, 'id', 'Hyperdrive id'))}`,
          '',
        ],
      };
    case 'd1':
      return {
        body: [
          '[[d1_databases]]',
          `binding = ${tomlString(binding.name)}`,
          `database_id = ${tomlString(requireResource(binding, resources, 'id', 'D1 database id'))}`,
          `database_name = ${tomlString(requireResource(binding, resources, 'database', 'D1 database name'))}`,
          '',
        ],
      };
    case 'kv':
      return {
        body: [
          '[[kv_namespaces]]',
          `binding = ${tomlString(binding.name)}`,
          `id = ${tomlString(requireResource(binding, resources, 'id', 'KV namespace id'))}`,
          '',
        ],
      };
    case 'r2':
      return {
        body: [
          '[[r2_buckets]]',
          `binding = ${tomlString(binding.name)}`,
          `bucket_name = ${tomlString(requireResource(binding, resources, 'bucket', 'R2 bucket name'))}`,
          '',
        ],
      };
    case 'queue':
      return {
        body: [
          '[[queues.producers]]',
          `binding = ${tomlString(binding.name)}`,
          `queue = ${tomlString(requireResource(binding, resources, 'queue', 'queue name'))}`,
          '',
        ],
      };
    case 'durable-object':
      return {
        body: [
          '[[durable_objects.bindings]]',
          `name = ${tomlString(binding.name)}`,
          `class_name = ${tomlString(requireResource(binding, resources, 'className', 'Durable Object class name'))}`,
          '',
        ],
      };
    case 'secret':
      // Named in a comment, never as a value: `wrangler secret put` is the only way a
      // secret reaches a Worker, and the artifact must not contain one (`DPL-012`).
      return { body: [], secret: binding.name };
    case 'var':
      // `[vars]` is a section, not a repeated block; collected by the caller.
      return { body: [] };
    default: {
      const exhaustive: never = binding.kind;
      throw invalidDeployConfig(`unknown binding kind "${String(exhaustive)}"`);
    }
  }
}

/**
 * The config for one unit.
 *
 * `unit.bindings` is already validated against the target (`checkGraph`), so the only new
 * failures here are *incomplete* resources — a binding declared without the id wrangler
 * needs — which is exactly the mistake a generated config should catch before `wrangler
 * deploy --dry-run` does.
 */
export function wranglerToml(unit: Unit, appName: string, options: WranglerOptions): string {
  const name = options.name ?? `${appName}-${unit.name}`;
  const main = options.main ?? 'index.js';
  const flags = options.compatibilityFlags ?? [];

  const lines: string[] = [
    `# Generated by \`tsir deploy:build\` for unit "${unit.name}" — do not edit.`,
    `# Secrets are not here: ${unit.bindings.some((binding) => binding.kind === 'secret') ? 'see the list at the bottom' : 'this unit declares none'}.`,
    '',
    `name = ${tomlString(name)}`,
    `main = ${tomlString(main)}`,
    // Pinned, not "today": a compatibility date that moves under you is a deploy that
    // changes behaviour without a diff.
    `compatibility_date = ${tomlString(options.compatibilityDate)}`,
  ];

  if (unit.private) {
    // `DPL-022`: `workers_dev = false` is the mechanism Cloudflare actually honours — no
    // `*.workers.dev` subdomain and no route, so "admin is private" survives `wrangler deploy`
    // instead of being a comment in a graph nobody deploys from.
    lines.push('# private unit: no workers.dev URL and no routes (DPL-022)', 'workers_dev = false');
  }

  if (flags.length > 0) {
    lines.push(`compatibility_flags = [${flags.map(tomlString).join(', ')}]`);
  }
  lines.push('');

  if (options.observability !== false) {
    lines.push('[observability]', 'enabled = true', '');
  }

  const secrets: string[] = [];
  const vars: Record<string, string> = { ...(options.vars ?? {}) };

  const ordered = [...unit.bindings].sort((a, b) => {
    const byKind = ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind);
    return byKind !== 0 ? byKind : a.name.localeCompare(b.name);
  });

  for (const binding of ordered) {
    const section = bindingSections(binding, options);
    lines.push(...section.body);
    if (section.secret !== undefined) secrets.push(section.secret);
  }

  if (Object.keys(vars).length > 0) {
    lines.push('[vars]');
    for (const key of Object.keys(vars).sort()) {
      lines.push(`${key} = ${tomlString(vars[key] ?? '')}`);
    }
    lines.push('');
  }

  // `DPL-010`: the room model (`createRoom`) needs the class exported and migrated.
  if (unit.kind === 'ws' || ordered.some((binding) => binding.kind === 'durable-object')) {
    const classes = ordered
      .filter((binding) => binding.kind === 'durable-object')
      .map((binding) => options.resources?.[binding.name]?.className)
      .filter((className): className is string => className !== undefined);

    if (classes.length > 0) {
      lines.push(
        '[[migrations]]',
        `tag = ${tomlString(options.migrationTag ?? 'v1')}`,
        `new_sqlite_classes = [${[...new Set(classes)].sort().map(tomlString).join(', ')}]`,
        '',
      );
    }
  }

  // Queue consumers (`CAP-004`). A `queue` trigger that is not declared here is a unit the
  // dashboard shows and Cloudflare never calls — and `wrangler deploy` will not warn, because
  // nothing about the bundle says a queue was expected.
  for (const trigger of unit.triggers) {
    if (trigger.kind !== 'queue') continue;
    for (const queue of trigger.detail) {
      lines.push(
        '[[queues.consumers]]',
        `queue = ${tomlString(queue)}`,
        // The platform's own batch size, spelled out rather than inherited: an unset value is a
        // default that can move between platform releases.
        'max_batch_size = 10',
        'max_batch_timeout = 5',
        // Retries are the driver's decision (`queue.ts`), so the platform's redrive is off:
        // two retry schedules on one message is two delays on one job.
        'max_retries = 3',
        // The platform's DLQ is the backstop for messages the *platform* gives up on; the
        // application's own dead-letter table (`queue_dead`) is what `queue:retry` reads.
        `dead_letter_queue = ${tomlString(`${queue}-dlq`)}`,
        '',
      );
    }
  }

  // Cron triggers: a drain connection is polled, and the poll *is* the trigger.
  const crons = unit.triggers
    .filter((trigger) => trigger.kind === 'cron')
    .flatMap((trigger) => trigger.detail)
    .sort();
  if (crons.length > 0) {
    lines.push('[triggers]', `crons = [${crons.map(tomlString).join(', ')}]`, '');
  }

  if (secrets.length > 0) {
    lines.push('# Secrets — set these once per environment; never put them in this file:');
    for (const secret of [...new Set(secrets)].sort()) {
      lines.push(`#   wrangler secret put ${secret}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Every unit's config, keyed by filename. The emitter writes these next to the bundles. */
export function wranglerConfigs(
  units: readonly Unit[],
  appName: string,
  options: WranglerOptions,
): ReadonlyMap<string, string> {
  const configs = new Map<string, string>();
  for (const unit of units) {
    configs.set(`wrangler.${unit.name}.toml`, wranglerToml(unit, appName, options));
  }
  return configs;
}
