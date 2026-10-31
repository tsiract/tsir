/**
 * `tsir notify:*` (`CAP-NOTIFY`).
 *
 * Run as a **subprocess**, one process per command, for the same reason `mail:*` and `storage:*`
 * are: `notify:test` is the check a deploy pipeline runs, and a check that passed in-process and
 * failed on the machine would be checking the test rather than the project.
 *
 * The fixture declares two channels — `memory` (records, cannot deliver) and a `webhook` on the
 * allowlist pointing at a host nothing listens on — plus two notifications, one of which is
 * `queued: false`. That combination makes every interesting path reachable without a provider: a
 * channel that reaches nobody, a channel that fails for real, and an inline send with no queue.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { type CliRun, runCliInProcess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'notify-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliInProcess(args, { cwd });
}

async function copy(
  edit?: (parts: { config: string; entry: string }) => { config?: string; entry?: string },
): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-notify-'));
  cleanup.push(dir);
  await cp(FIXTURE, join(dir, 'app'), { recursive: true });

  if (edit !== undefined) {
    const configPath = join(dir, 'app', 'tsir.js');
    const entryPath = join(dir, 'app', 'src', 'app.ts');
    const next = edit({
      config: await readFile(configPath, 'utf8'),
      entry: await readFile(entryPath, 'utf8'),
    });
    if (next.config !== undefined) await writeFile(configPath, next.config, 'utf8');
    if (next.entry !== undefined) await writeFile(entryPath, next.entry, 'utf8');
  }
  return join(dir, 'app');
}

// ─── notify:channels ────────────────────────────────────────────────────────

describe('tsir notify:channels', () => {
  test('prints every channel, what it carries, and who uses it', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:channels'], cwd);

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('webhook');
    expect(result.stdout).toContain('alerts');
    expect(result.stdout).toContain('memory');
    expect(result.stdout).toContain('delivers:');
    expect(result.stdout).toContain('order.shipped');
    expect(result.stdout).toContain('registry:');
    // `memory` reaches nobody, and a notification uses it: that is a warning, not a footnote.
    expect(result.output).toContain('does not deliver');
  });

  test('--json is one document with the capabilities intact', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:channels', '--json'], cwd);

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      channels: { name: string; driver: string; capabilities: { delivers: boolean } }[];
      missing: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.missing).toEqual([]);
    const memory = parsed.channels.find((channel) => channel.name === 'memory');
    expect(memory?.capabilities.delivers).toBe(false);
    const webhook = parsed.channels.find((channel) => channel.name === 'webhook');
    expect(webhook?.driver).toBe('webhook');
    // A project-chosen name over the same driver is a different destination, not a duplicate.
    const alerts = parsed.channels.find((channel) => channel.name === 'alerts');
    expect(alerts?.driver).toBe('webhook');
  });

  test('a notification that names a channel nobody declared fails the command', async () => {
    const cwd = await copy(({ config }) => ({
      // Removing the channel from the config is the state a rename leaves behind: the notification
      // still names it, and nothing reaches it.
      config: config.replace(
        `      alerts: {
        driver: 'webhook',
        allowHosts: ['alerts.tsir.local'],
        allowHttp: true,
      },
`,
        '',
      ),
    }));
    const result = await runCli(['notify:channels', '--json'], cwd);

    expect(result.code).toBe(EXIT.failure);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; missing: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.missing).toEqual(['alerts']);
  });

  test('an app that exports no notifications is a usage error, not a crash', async () => {
    const cwd = await copy(({ entry }) => ({
      entry: entry.replace('export const notifications = [orderShipped, digest];', ''),
    }));
    const result = await runCli(['notify:channels'], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('exports no notifications');
  });
});

// ─── notify:preview ─────────────────────────────────────────────────────────

describe('tsir notify:preview', () => {
  test('renders every channel from the sample, without sending anything', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:preview', 'order.shipped'], cwd);

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('order.shipped');
    expect(result.stdout).toContain('ord_1');
    expect(result.stdout).toContain('TRK-1');
    expect(result.stdout).toContain('(queued)');
    // Nothing was delivered: preview is a render.
    expect(result.output).not.toContain('delivery');
  });

  test('--data replaces the sample, and --channel narrows the render', async () => {
    const cwd = await copy();
    const result = await runCli(
      [
        'notify:preview',
        'order.shipped',
        '--channel',
        'webhook',
        '--data',
        '{"id":"ord_9","tracking":"TRK-9"}',
        '--json',
      ],
      cwd,
    );

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.stdout) as {
      channels: { channel: string; driver: string; payload: { event: string; body: unknown } }[];
    };
    expect(parsed.channels).toHaveLength(1);
    expect(parsed.channels[0]?.channel).toBe('webhook');
    expect(parsed.channels[0]?.payload.event).toBe('order.shipped');
    expect(parsed.channels[0]?.payload.body).toEqual({ id: 'ord_9', tracking: 'TRK-9' });
  });

  test('an unknown notification lists the registered ones', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:preview', 'order.lost'], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('unknown notification "order.lost"');
    expect(result.output).toContain('order.shipped');
  });

  test('a notification with no sample needs --data, and says so', async () => {
    const cwd = await copy(({ entry }) => ({
      entry: entry.replace("  sample: { id: 'ord_1', tracking: 'TRK-1' },\n", ''),
    }));
    const result = await runCli(['notify:preview', 'order.shipped'], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('has no `sample`');
  });

  test('--data that is not JSON is a usage error', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:preview', 'order.shipped', '--data', 'nope'], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('--data is not JSON');
  });

  test('a channel the notification does not declare is refused', async () => {
    const cwd = await copy();
    const result = await runCli(
      ['notify:preview', 'digest.weekly', '--channel', 'webhook', '--data', '{"count":2}'],
      cwd,
    );

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('does not send on "webhook"');
  });
});

// ─── notify:test ────────────────────────────────────────────────────────────

describe('tsir notify:test', () => {
  test('delivers inline, prints per channel, and fails on the channel that cannot arrive', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:test', 'order.shipped', '--to', 'ana@example.com'], cwd);

    // The `memory` channel accepts; both webhooks have no receiver, so the command fails — which is
    // exactly what a deploy pipeline wants to know.
    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('memory accepted it');
    expect(result.output).toContain('webhook refused it');
  });

  test('--channel runs one channel, so a project can check the ones that can work', async () => {
    const cwd = await copy();
    const result = await runCli(
      ['notify:test', 'order.shipped', '--channel', 'memory', '--json'],
      cwd,
    );

    expect(result.code).toBe(EXIT.ok);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      delivered: { channel: string; accepted: boolean; deliveryId: string }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.delivered).toHaveLength(1);
    expect(parsed.delivered[0]?.accepted).toBe(true);
    expect(parsed.delivered[0]?.deliveryId).toMatch(/^.+:memory$/u);
  });

  test('a `queued: false` notification needs no queue', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:test', 'digest.weekly', '--to', 'u1'], cwd);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('memory accepted it');
  });

  test('a missing notification is a usage error with the list', async () => {
    const cwd = await copy();
    const result = await runCli(['notify:test'], cwd);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('notify:test needs a notification');
  });
});
