/**
 * `tsir notify:*` (`CAP-NOTIFY`).
 *
 * Three commands, each answering one question about notifications:
 *
 *   · `notify:channels` — "what can actually reach a recipient, and who uses it?" The capability
 *     columns are the point: a project whose only channel is `memory` has notifications that reach
 *     nobody, and that is worth seeing in a table rather than in a support ticket.
 *   · `notify:preview <notification>` — "what will each channel receive?" Renders every declared
 *     channel's payload from the notification's `sample` (or `--data`), so the email, the inbox row
 *     and the webhook body can be read side by side before anything is sent.
 *   · `notify:test <notification>` — "does it actually arrive?" Delivers once, in-process, through
 *     every channel (or one with `--channel`), prints what each channel said, and exits non-zero if
 *     any of them failed. This is the check a deploy pipeline runs.
 *
 * Where the registry comes from: the app entry's `channels`/`notifications` exports when there are
 * any (the same contract as `mailers`, `disks` and `queues`), otherwise `notify.channels` from
 * `tsir.js` built with the project's mailers. The `database` driver needs a `Database`, which a CLI
 * cannot invent, so it is one of the reasons to export `channels` from the entry.
 */

import { pathToFileURL } from 'node:url';

import {
  channelsFromConfig,
  createChannels,
  createNotifier,
  type Channel,
  type ChannelCapabilities,
  type NotificationDefinition,
} from '@tsir/notify';
import { mailersFromConfig, type Mailers } from '@tsir/mail';

import { boolFlag, parseArgs, stringFlag } from '../args.ts';
import { EXIT, fail, info, ok, style, UsageError, warn, jsonDocument } from '../output.ts';
import { loadProject, type LoadedProject } from '../project.ts';

/** Duck-types an exported channel registry: an array of `{ name, driver, capabilities, send }`. */
function isChannels(value: unknown): value is readonly Channel[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const channel = entry as Partial<Channel>;
      return (
        typeof channel.name === 'string' &&
        typeof channel.driver === 'string' &&
        typeof channel.send === 'function' &&
        typeof channel.capabilities === 'object'
      );
    })
  );
}

/** Duck-types the exported notification list. */
function isNotifications(value: unknown): value is readonly NotificationDefinition<unknown>[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const notification = entry as Partial<NotificationDefinition<unknown>>;
      return (
        typeof notification.name === 'string' &&
        Array.isArray(notification.channels) &&
        typeof notification.build === 'function'
      );
    })
  );
}

interface Resolved {
  readonly channels: readonly Channel[];
  readonly notifications: readonly NotificationDefinition<unknown>[];
  readonly source: string;
}

async function resolveNotify(project: LoadedProject): Promise<Resolved> {
  const module = (await import(pathToFileURL(project.entryPath).href)) as {
    readonly channels?: unknown;
    readonly notifications?: unknown;
    readonly mailers?: unknown;
  };

  if (!isNotifications(module.notifications)) {
    throw new UsageError(
      'this project exports no notifications',
      `export \`notifications\` from ${project.entryPath} — an array of \`defineNotification\` results`,
    );
  }

  if (isChannels(module.channels)) {
    return {
      channels: module.channels,
      notifications: module.notifications,
      source: `${project.entryPath} (channels)`,
    };
  }

  if (project.config.notify === undefined) {
    throw new UsageError(
      'no notification channels are declared',
      `declare \`notify.channels\` in ${project.configPath}, or export \`channels\` from ${project.entryPath}`,
    );
  }

  const mailers: Mailers | undefined =
    project.config.mail === undefined
      ? undefined
      : mailersFromConfig({
          mail: project.config.mail,
          env: process.env,
          log: { write: (text: string) => process.stderr.write(`${text}\n`) },
        });

  return {
    channels: channelsFromConfig({
      notify: project.config.notify,
      ...(mailers === undefined ? {} : { mailers }),
      env: process.env,
    }),
    notifications: module.notifications,
    source: `${project.configPath} (notify.channels)`,
  };
}

function capabilityWords(capabilities: ChannelCapabilities): string {
  const yes = (value: boolean): string => (value ? style.green('yes') : style.dim('no'));
  return [
    `delivers: ${yes(capabilities.delivers)}`,
    `html: ${yes(capabilities.html)}`,
    `attachments: ${yes(capabilities.attachments)}`,
  ].join('  ');
}

function notificationNamed(
  notifications: readonly NotificationDefinition<unknown>[],
  name: string,
): NotificationDefinition<unknown> {
  const found = notifications.find((notification) => notification.name === name);
  if (found === undefined) {
    throw new UsageError(
      `unknown notification "${name}"`,
      `registered: ${notifications.map((notification) => notification.name).join(', ') || 'none'}`,
    );
  }
  return found;
}

/** `--data` wins, then the declaration's `sample`; neither is a usage error naming both. */
function dataFor(notification: NotificationDefinition<unknown>, raw: string | undefined): unknown {
  if (raw !== undefined) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(
        `--data is not JSON: ${raw}`,
        'pass JSON, e.g. --data \'{"id":"ord_1"}\'',
      );
    }
  }
  if (notification.sample !== undefined) return notification.sample;
  throw new UsageError(
    `"${notification.name}" has no \`sample\``,
    'pass --data \'{"…":"…"}\', or add `sample` to the notification so previews work with no arguments',
  );
}

/** What `--to` means: an address when it looks like one, a notifiable id otherwise. */
function notifiableFor(raw: string | undefined): Record<string, string | number> {
  if (raw === undefined) return { id: 'notify:test', email: 'notify:test@tsir.local' };
  if (raw.includes('@')) return { id: raw, email: raw };
  if (raw.startsWith('+')) return { id: raw, phone: raw };
  return { id: raw };
}

// ─── notify:channels ────────────────────────────────────────────────────────

export async function notifyChannelsCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--json': { type: 'boolean', description: 'one JSON document' },
  });
  const json = boolFlag(args, '--json');

  try {
    const project = await loadProject(process.cwd());
    const { channels, notifications, source } = await resolveNotify(project);
    const registry = createChannels(channels);

    const rows = registry.all.map((channel) => ({
      name: channel.name,
      driver: channel.driver,
      capabilities: channel.capabilities,
      notifications: notifications
        .filter((notification) => notification.channels.includes(channel.name))
        .map((notification) => notification.name),
    }));

    // A notification that names a channel nobody declared is a delivery that would throw at send
    // time, so it is reported here — this command's whole job is to be the cheap place to see it.
    const missing = [
      ...new Set(
        notifications.flatMap((notification) =>
          notification.channels.filter((name) => !registry.has(name)),
        ),
      ),
    ].sort((a, b) => a.localeCompare(b));

    if (json) {
      process.stdout.write(
        `${jsonDocument({ ok: missing.length === 0, source, missing, channels: rows })}\n`,
      );
      return missing.length === 0 ? EXIT.ok : EXIT.failure;
    }

    info(style.bold('channels'));
    for (const row of rows) {
      info(`  ${style.bold(row.name)} ${style.dim(`(${row.driver})`)}`);
      info(`    ${capabilityWords(row.capabilities)}`);
      info(
        `    notifications ${row.notifications.length === 0 ? style.dim('none') : row.notifications.join(', ')}`,
      );
    }
    info(style.dim(`  registry: ${source}`));
    info(style.dim(`  notifications: ${notifications.length}`));

    for (const name of missing) {
      warn(
        `a notification declares the channel "${name}", which is not declared — that send would fail`,
      );
    }
    for (const row of rows) {
      if (!row.capabilities.delivers && row.notifications.length > 0) {
        warn(
          `the "${row.name}" channel does not deliver, and ${String(row.notifications.length)} notification(s) use it — fine in development, refused in production`,
        );
      }
    }
    return missing.length === 0 ? EXIT.ok : EXIT.failure;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── notify:preview ─────────────────────────────────────────────────────────

export async function notifyPreviewCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--data': { type: 'string', description: "JSON, instead of the notification's `sample`" },
    '--channel': { type: 'string', description: 'one channel (default: all of them)' },
    '--json': { type: 'boolean', description: 'one JSON document' },
  });
  const json = boolFlag(args, '--json');

  try {
    const name = args.positionals[0];
    if (name === undefined) {
      throw new UsageError(
        'notify:preview needs a notification',
        'run `tsir notify:preview order.shipped`, or `tsir notify:channels` to list them',
      );
    }

    const project = await loadProject(process.cwd());
    const resolved = await resolveNotify(project);
    const notification = notificationNamed(resolved.notifications, name);
    const data = dataFor(notification, stringFlag(args, '--data'));

    const notifier = createNotifier({
      channels: resolved.channels,
      notifications: resolved.notifications,
    });
    const preview = notifier.preview(notification, data, notifiableFor(undefined));

    const only = stringFlag(args, '--channel');
    const chosen = preview.filter((record) => only === undefined || record.channel === only);
    if (chosen.length === 0) {
      throw new UsageError(
        `"${notification.name}" does not send on "${String(only)}"`,
        `declared channels: ${notification.channels.join(', ')}`,
      );
    }

    if (json) {
      process.stdout.write(
        `${jsonDocument({
          ok: true,
          notification: notification.name,
          queued: notification.queued,
          channels: chosen,
        })}\n`,
      );
      return EXIT.ok;
    }

    info(
      style.bold(
        `${notification.name} ${style.dim(`(${notification.queued ? 'queued' : 'inline'})`)}`,
      ),
    );
    for (const record of chosen) {
      info(`  ${style.bold(record.channel)} ${style.dim(`(${record.driver})`)}`);
      for (const line of JSON.stringify(record.payload, null, 2).split('\n')) {
        info(`    ${line}`);
      }
    }
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}

// ─── notify:test ────────────────────────────────────────────────────────────

export async function notifyTestCommand(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    '--to': { type: 'string', description: 'recipient: an email, a +number, or a notifiable id' },
    '--data': { type: 'string', description: "JSON, instead of the notification's `sample`" },
    '--channel': { type: 'string', description: 'one channel (default: all of them)' },
    '--json': { type: 'boolean', description: 'one JSON document' },
  });
  const json = boolFlag(args, '--json');

  try {
    const name = args.positionals[0];
    if (name === undefined) {
      throw new UsageError(
        'notify:test needs a notification',
        'run `tsir notify:test order.shipped --to you@example.com`',
      );
    }

    const project = await loadProject(process.cwd());
    const resolved = await resolveNotify(project);
    const notification = notificationNamed(resolved.notifications, name);
    const data = dataFor(notification, stringFlag(args, '--data'));
    const to = notifiableFor(stringFlag(args, '--to'));

    const notifier = createNotifier({
      channels: resolved.channels,
      notifications: resolved.notifications,
    });

    const only = stringFlag(args, '--channel');
    const report = await notifier.send(notification, data, {
      to,
      immediately: true,
      // One line per channel, not one exception: this command's job is to say *which* channel broke.
      onError: 'collect',
      ...(only === undefined ? {} : { only: [only] }),
    });

    const failed = report.delivered.filter((record) => !record.accepted);
    if (json) {
      process.stdout.write(
        `${jsonDocument({
          ok: failed.length === 0,
          notification: notification.name,
          id: report.id,
          delivered: report.delivered,
        })}\n`,
      );
      return failed.length === 0 ? EXIT.ok : EXIT.failure;
    }

    info(
      style.bold(`${notification.name} → ${String(to.id ?? to.email ?? to.phone ?? 'recipient')}`),
    );
    for (const record of report.delivered) {
      const detail = record.detail === undefined ? '' : style.dim(` — ${record.detail}`);
      if (record.accepted) {
        ok(
          `${record.channel} accepted it${record.id === undefined ? '' : ` (id ${record.id})`}${detail}`,
        );
      } else {
        warn(`${record.channel} refused it${detail}`);
      }
    }
    if (failed.length > 0) {
      return fail(new Error(`${String(failed.length)} channel(s) refused the notification`), false);
    }
    info(style.dim(`  registry: ${resolved.source}`));
    return EXIT.ok;
  } catch (error: unknown) {
    return fail(error, json);
  }
}
