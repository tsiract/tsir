import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { formatKeySpec, generateKey, parseKeySpec } from '@tsir/vault';

import { UsageError } from '../output.ts';
import { vaultKeyActivateCommand, vaultKeyGenerateCommand } from './vault.ts';

const cleanup: string[] = [];
const saved = {
  now: process.env['APP_KEY_NOW'],
  next: process.env['APP_KEY_NEXT'],
  file: process.env['TSIR_KEYRING_FILE'],
};

afterEach(async () => {
  process.env['APP_KEY_NOW'] = saved.now;
  if (saved.next === undefined) delete process.env['APP_KEY_NEXT'];
  else process.env['APP_KEY_NEXT'] = saved.next;
  if (saved.file === undefined) delete process.env['TSIR_KEYRING_FILE'];
  else process.env['TSIR_KEYRING_FILE'] = saved.file;
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capture(): { readonly text: () => string } {
  const chunks: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const absorb = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stdout.write = absorb;
  process.stderr.write = absorb;
  return {
    text: () => {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      return chunks.join('');
    },
  };
}

async function run(argv: readonly string[]): Promise<string> {
  const output = capture();
  await vaultKeyGenerateCommand(argv);
  return output.text();
}

async function runActivate(argv: readonly string[]): Promise<string> {
  const output = capture();
  await vaultKeyActivateCommand(argv);
  return output.text();
}

describe('tsir vault:key:generate (VLT-015)', () => {
  test('prints a usable APP_KEY_NOW and says it was not written', async () => {
    const text = await run([]);

    const match = /APP_KEY_NOW=(\S+)/.exec(text);
    expect(match).not.toBeNull();

    const key = parseKeySpec(match?.[1] ?? '');
    expect(key.alg).toBe('aes-256-gcm');
    expect(key.material).toHaveLength(32);
    expect(text).toContain('shown once');
    expect(text).toContain('not written');
  });

  test('--json carries the spec and reports that nothing was written', async () => {
    const parsed = JSON.parse(await run(['--json'])) as {
      ok: boolean;
      id: string;
      alg: string;
      env: { APP_KEY_NOW: string };
      written: boolean;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.written).toBe(false);
    expect(parsed.alg).toBe('aes-256-gcm');
    expect(parseKeySpec(parsed.env.APP_KEY_NOW).id).toBe(parsed.id);
  });

  test('two runs never produce the same key', async () => {
    const first = /APP_KEY_NOW=(\S+)/.exec(await run([]))?.[1];
    const second = /APP_KEY_NOW=(\S+)/.exec(await run([]))?.[1];
    expect(first).not.toBe(second);
  });

  test('an algorithm without an implementation is a usage error, not a warning', async () => {
    const error = await run(['--alg', 'xchacha20-poly1305']).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(2);
    expect((error as UsageError).message).toContain('xchacha20-poly1305');
  });
});

const OLD = formatKeySpec(generateKey());
const OLD_ID = OLD.split(':')[0] as string;
const NEW = formatKeySpec(generateKey());
const NEW_ID = NEW.split(':')[0] as string;

describe('tsir vault:key:activate (VLT-016)', () => {
  test('prints the promotion without ever printing the new material', async () => {
    process.env['APP_KEY_NOW'] = OLD;
    process.env['APP_KEY_NEXT'] = NEW;

    const text = await runActivate(['--key', NEW_ID]);

    expect(text).toContain(`promote ${NEW_ID} (writing since APP_KEY_NEXT was deployed)`);
    expect(text).toContain(`keep ${OLD_ID} as decrypt-only`);
    // VLT-027 in spirit: the promotion output is ids and states.
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(NEW.split(':')[2] as string);
  });

  test('the manifest it prints is the one the next boot accepts', async () => {
    process.env['APP_KEY_NOW'] = OLD;
    process.env['APP_KEY_NEXT'] = NEW;

    const text = await runActivate(['--key', NEW_ID, '--json']);
    const parsed = JSON.parse(text) as {
      fromKeyId: string;
      toKeyId: string;
      manifest: { id: string; state: string }[];
      env: { APP_KEY_NOW: string };
      applied: boolean;
    };

    expect(parsed.fromKeyId).toBe(OLD_ID);
    expect(parsed.toKeyId).toBe(NEW_ID);
    expect(parsed.applied).toBe(false);
    expect(parsed.env.APP_KEY_NOW).toBe(`<material of ${NEW_ID}>`);

    const states = new Map(parsed.manifest.map((entry) => [entry.id, entry.state]));
    expect(states.get(NEW_ID)).toBe('active');
    expect(states.get(OLD_ID)).toBe('decrypt-only');
  });

  test('a --key that names something else is refused', async () => {
    process.env['APP_KEY_NOW'] = OLD;
    process.env['APP_KEY_NEXT'] = NEW;

    const error = await runActivate(['--key', OLD_ID]).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain(NEW_ID);
  });

  test('nothing staged is an environment failure with the runbook step', async () => {
    process.env['APP_KEY_NOW'] = OLD;
    delete process.env['APP_KEY_NEXT'];

    const error = await runActivate(['--key', NEW_ID]).catch((reason: unknown) => reason);

    expect((error as { code?: string }).code).toBe('VLT_NOT_CONFIGURED');
    expect((error as { message?: string }).message).toContain('APP_KEY_NEXT');
  });

  test('--key is required', async () => {
    process.env['APP_KEY_NOW'] = OLD;
    process.env['APP_KEY_NEXT'] = NEW;

    const error = await runActivate([]).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UsageError);
  });

  test('a deployed manifest keeps its decrypt-only keys through a promotion', async () => {
    const third = formatKeySpec(generateKey());
    const dir = await mkdtemp(join(tmpdir(), 'tsir-vault-'));
    cleanup.push(dir);
    const manifestPath = join(dir, 'keyring.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        keys: [
          { id: OLD_ID, alg: 'aes-256-gcm', state: 'active' },
          { id: third.split(':')[0], alg: 'aes-256-gcm', state: 'decrypt-only' },
        ],
      }),
    );

    process.env['APP_KEY_NOW'] = OLD;
    process.env['APP_KEY_NEXT'] = NEW;

    const parsed = JSON.parse(
      await runActivate(['--key', NEW_ID, '--manifest', manifestPath, '--json']),
    ) as { manifest: { id: string; state: string }[] };

    const states = new Map(parsed.manifest.map((entry) => [entry.id, entry.state]));
    expect(states.get(third.split(':')[0] as string)).toBe('decrypt-only');
  });

  test('a malformed manifest is an environment problem that names the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tsir-vault-'));
    cleanup.push(dir);
    const manifestPath = join(dir, 'keyring.json');
    await writeFile(manifestPath, JSON.stringify({ keys: 'nope' }));

    process.env['APP_KEY_NOW'] = OLD;
    process.env['APP_KEY_NEXT'] = NEW;

    const error = await runActivate(['--key', NEW_ID, '--manifest', manifestPath]).catch(
      (reason: unknown) => reason,
    );

    expect((error as { exitCode?: number }).exitCode).toBe(3);
    expect((error as { message?: string }).message).toContain('keyring.json');
  });
});

describe('materials in the deployed manifest (VLT-010, VLT-027)', () => {
  test('old material is accepted but never printed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tsir-vault-'));
    cleanup.push(dir);
    const manifestPath = join(dir, 'keyring.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        keys: [
          { id: OLD_ID, alg: 'aes-256-gcm', state: 'active' },
          { id: 'k2m4n6p3', alg: 'aes-256-gcm', state: 'decrypt-only' },
        ],
        // A full spec for the older key, as a secret manager would store it.
        materials: {
          k2m4n6p3: formatKeySpec({
            id: 'k2m4n6p3',
            alg: 'aes-256-gcm',
            material: crypto.getRandomValues(new Uint8Array(32)),
          }),
        },
      }),
    );

    process.env['APP_KEY_NOW'] = OLD;
    process.env['APP_KEY_NEXT'] = NEW;

    const text = await runActivate(['--key', NEW_ID, '--manifest', manifestPath]);
    expect(text).toContain('k2m4n6p3');

    const printed = JSON.parse(
      await runActivate(['--key', NEW_ID, '--manifest', manifestPath, '--json']),
    ) as { manifest: unknown[] };
    // The manifest is metadata: ids, algorithms, states. No spec strings.
    expect(JSON.stringify(printed)).not.toContain(':aes-256-gcm:');
  });
});
