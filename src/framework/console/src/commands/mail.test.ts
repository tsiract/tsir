/**
 * `tsir mail:*` (`MAIL-10`).
 *
 * Run as a **subprocess**, one process per command, for the same reason `storage:*` and
 * `schedule:*` are: `mail:test` is the check a deploy pipeline runs, and a check that passed
 * in-process and failed on the machine would be checking the test.
 *
 * The fixture declares three mailers — `log`, `memory`, and an `smtp` one pointing at a port
 * nothing listens on — so the interesting cases are all reachable without a provider: a mailer
 * that cannot deliver, a mailer that refuses the probe, and a render that has to escape its data.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { EXIT } from '../output.ts';
import { type CliRun, runCliInProcess } from '../../test-support/in-process.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'mail-app');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  return runCliInProcess(args, { cwd });
}

async function copy(
  edit?: (parts: { config: string; entry: string }) => {
    config?: string;
    entry?: string;
  },
): Promise<string> {
  const dir = await mkdtemp(join(import.meta.dir, 'fixtures', '.tmp-mail-'));
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

describe('mail:mailers', () => {
  test('it lists every mailer with the capability that matters — does it deliver?', async () => {
    const result = await runCli(['mail:mailers'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('log');
    expect(result.output).toContain('collected');
    expect(result.output).toContain('broken');
    expect(result.output).toContain('delivers:');
    // And the warning that a project is about to ship a mailer that prints.
    expect(result.output).toContain('does not deliver');
  });

  test('--json is the same facts, with the default marked and the registry source named', async () => {
    const result = await runCli(['mail:mailers', '--json'], FIXTURE);
    const document = JSON.parse(result.stdout) as {
      default: string;
      source: string;
      mailers: {
        name: string;
        driver: string;
        default: boolean;
        capabilities: { delivers: boolean };
      }[];
    };

    expect(document.default).toBe('log');
    expect(document.source).toContain('tsir.js');
    expect(document.mailers.map((mailer) => [mailer.name, mailer.driver, mailer.default])).toEqual([
      ['log', 'log', true],
      ['collected', 'memory', false],
      ['broken', 'smtp', false],
    ]);
    // `log` and `memory` deliver nothing; `smtp` would, given a server. Both facts are in the table.
    expect(document.mailers.map((mailer) => mailer.capabilities.delivers)).toEqual([
      false,
      false,
      true,
    ]);
  });

  test('an entry that exports `mailers` wins, and the command says which source it read', async () => {
    const cwd = await copy(({ entry }) => ({
      entry:
        entry.replace(
          "import { defineTemplate, html } from '@tsir/mail';",
          "import { createMailer, createMailers, defineTemplate, html, memoryTransport } from '@tsir/mail';",
        ) +
        [
          '',
          'export const mailers = createMailers({',
          "  default: 'entry',",
          "  mailers: { entry: { mailer: createMailer({ transport: memoryTransport(), from: 'a@tsir.local' }) } },",
          '});',
          '',
        ].join('\n'),
    }));

    const result = await runCli(['mail:mailers', '--json'], cwd);
    const document = JSON.parse(result.output) as { default: string; source: string };

    expect(result.code).toBe(EXIT.ok);
    expect(document.default).toBe('entry');
    expect(document.source).toContain('app.ts');
  });
});

describe('mail:test', () => {
  test('a memory mailer accepts the probe and reports the id', async () => {
    const result = await runCli(['mail:test', 'ana@example.com', '--mailer', 'collected'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('collected (memory) accepted it');
    expect(result.output).toContain('id memory-1');
  });

  test('a mailer that cannot reach its server fails the command, and the others still report', async () => {
    const result = await runCli(['mail:test', 'ana@example.com', '--json'], FIXTURE);
    const document = JSON.parse(result.stdout) as {
      ok: boolean;
      results: { mailer: string; ok: boolean; detail?: string }[];
    };

    // `broken` is `smtp` at 127.0.0.1:2525 — connection refused, which is the honest outcome for
    // a mailer whose server is not running.
    expect(result.code).toBe(EXIT.failure);
    expect(document.ok).toBe(false);
    expect(document.results.map((entry) => [entry.mailer, entry.ok])).toEqual([
      ['log', true],
      ['collected', true],
      ['broken', false],
    ]);
    expect(document.results[2]?.detail).toBeString();
  });

  test('the address is required, and the usage message shows the shape', async () => {
    const result = await runCli(['mail:test'], FIXTURE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('mail:test needs an address to send to');
    expect(result.output).toContain('tsir mail:test you@example.com');
  });

  test('an undeclared mailer name is refused, listing the declared ones', async () => {
    const result = await runCli(['mail:test', 'ana@example.com', '--mailer', 'receipts'], FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('unknown mailer "receipts"');
  });

  test('it refuses to send without a valid address before it reaches a transport', async () => {
    const result = await runCli(['mail:test', 'not-an-address', '--mailer', 'collected'], FIXTURE);

    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('MAIL_INVALID_ADDRESS');
  });
});

describe('mail:preview', () => {
  test('it renders the sample, and the HTML is escaped through the template', async () => {
    const result = await runCli(['mail:preview', 'welcome'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.output).toContain('subject: Welcome, Ana');
    expect(result.output).toContain('Hi Ana, confirm your address');
    expect(result.output).toContain('<a href="https://tsir.local/confirm/abc123">');
  });

  test('--data replaces the sample, and a hostile value cannot become markup', async () => {
    const result = await runCli(
      [
        'mail:preview',
        'welcome',
        '--data',
        '{"name":"<script>x</script>","link":"https://a.b/c"}',
        '--json',
      ],
      FIXTURE,
    );
    const document = JSON.parse(result.output) as { subject: string; html: string };

    expect(result.code).toBe(EXIT.ok);
    expect(document.subject).toContain('<script>');
    // The subject is text; the HTML body is where the escaping boundary lives.
    expect(document.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(document.html).not.toContain('<script>');
  });

  test('a single-flavour template is a single part, and a non-ASCII subject is an encoded word', async () => {
    const result = await runCli(['mail:preview', 'receipt', '--mime'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('Content-Type: text/plain; charset=utf-8');
    expect(result.stdout).toContain('Content-Transfer-Encoding: base64');
    // The peso sign cannot travel in a raw header, so it becomes `=?UTF-8?B?…?=`.
    expect(result.stdout).toContain('=?UTF-8?B?');
  });

  test('--mime prints the document a client will parse', async () => {
    const result = await runCli(['mail:preview', 'welcome', '--mime'], FIXTURE);

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('MIME-Version: 1.0');
    // `welcome` has both flavours, so the alternative is the shape a client picks from.
    expect(result.stdout).toContain('Content-Type: multipart/alternative');
  });

  test('an unknown template lists what is registered', async () => {
    const result = await runCli(['mail:preview', 'wellcome'], FIXTURE);

    expect(result.code).toBe(EXIT.usage);
    expect(result.output).toContain('no template "wellcome"');
    expect(result.output).toContain('registered: welcome, receipt');
  });

  test('a template with no sample and no --data is refused rather than rendered empty', async () => {
    const cwd = await copy(({ entry }) => ({
      entry: entry.replace("  sample: { total: '₱1,250.00' },\n", ''),
    }));

    const result = await runCli(['mail:preview', 'receipt'], cwd);
    expect(result.code).toBe(EXIT.failure);
    expect(result.output).toContain('has no `sample`');
  });
});
